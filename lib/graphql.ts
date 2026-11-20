// GraphQL v4: the /api/graphql surface the checks drive. A small parser for the
// documents gh actually sends (named operations, variables, inline enums and input
// objects, aliases, `... on Type` fragments, batched arrays) and a resolver over the
// same store the REST surface uses, so a mutation's effect is visible on both sides.

import { Store, VIEWER_LOGIN, type Repo, type Issue, type Pull } from './store.ts';
import { b64decodeText, b64encode } from './util.ts';

/* ------------------------------------------------------------------ parser */

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'enum'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

export interface Selection {
  name: string;
  alias: string | null;
  args: Record<string, Value>;
  selections: Selection[] | null;
  /** Set for `... on Type { ... }` fragments. */
  fragmentType: string | null;
}

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { defaultValue?: Value }>;
  selections: Selection[];
}

type Token =
  | { type: 'punct'; value: string }
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'int'; value: number }
  | { type: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():!=$[]@'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ type: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1;
      tokens.push({ type: 'int', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j])) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): Token | null {
    return this.tokens[this.pos++] ?? null;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token?.type !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipDirectives(): void {
    while (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== null) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.type === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value as 'query' | 'mutation';
      this.next();
      const nameToken = this.peek();
      if (nameToken?.type === 'name') {
        name = nameToken.value;
        this.next();
      }
    }
    const variables: Record<string, { defaultValue?: Value }> = {};
    if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (this.peek() !== null && !(this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const varToken = this.next();
        if (varToken?.type === 'punct' && varToken.value === '$') {
          const nameToken = this.next();
          if (nameToken?.type === 'name') {
            this.expectPunct(':');
            this.parseType();
            let defaultValue: Value | undefined;
            if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '=') {
              this.next();
              defaultValue = this.parseValue();
            }
            variables[nameToken.value] = defaultValue !== undefined ? { defaultValue } : {};
          }
        } else {
          this.next();
        }
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    const token = this.next();
    if (token?.type === 'punct' && token.value === '[') {
      this.parseType();
      this.expectPunct(']');
    }
    if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (this.peek() !== null && !(this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token?.type === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.type === 'name' && next.value === 'on') {
        this.next();
        const typeToken = this.next();
        const fragmentType = typeToken?.type === 'name' ? typeToken.value : null;
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        return { name: '', alias: null, args: {}, selections, fragmentType };
      }
      // A named fragment spread: the suite never sends one; skip its name.
      this.next();
      this.skipDirectives();
      return { name: '', alias: null, args: {}, selections: null, fragmentType: null };
    }
    const first = this.next();
    if (first?.type !== 'name') throw new Error('expected a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      const nameToken = this.next();
      if (nameToken?.type !== 'name') throw new Error('expected a field name after an alias');
      name = nameToken.value;
    }
    let args: Record<string, Value> = {};
    if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '(') {
      args = this.parseArguments();
    }
    this.skipDirectives();
    let selections: Selection[] | null = null;
    if (this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { name, alias, args, selections, fragmentType: null };
  }

  private parseArguments(): Record<string, Value> {
    const args: Record<string, Value> = {};
    this.expectPunct('(');
    while (this.peek() !== null && !(this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === ')')) {
      const nameToken = this.next();
      if (nameToken?.type !== 'name') throw new Error('expected an argument name');
      this.expectPunct(':');
      args[nameToken.value] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === null) throw new Error('expected a value');
    if (token.type === 'punct' && token.value === '$') {
      const nameToken = this.next();
      if (nameToken?.type !== 'name') throw new Error('expected a variable name');
      return { kind: 'variable', name: nameToken.value };
    }
    if (token.type === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (this.peek() !== null && !(this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek() !== null && !(this.peek()?.type === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const nameToken = this.next();
        if (nameToken?.type !== 'name') throw new Error('expected an input field name');
        this.expectPunct(':');
        fields[nameToken.value] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'int') return { kind: 'int', value: token.value };
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${JSON.stringify(token)}`);
  }
}

/** Resolve a parsed value against the request variables. */
function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'enum':
      return value.value;
    case 'string':
      return value.value;
    case 'int':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value.fields)) out[key] = resolveValue(field, variables);
      return out;
    }
  }
}

function argsOf(selection: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(selection.args)) out[key] = resolveValue(value, variables);
  return out;
}

/* ------------------------------------------------------------------ schema */

const ISSUE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'author', 'assignees', 'comments',
  'createdAt', 'updatedAt', 'closedAt', 'labels', 'milestone', 'url', 'repository', 'viewerDidAuthor',
];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable',
  'merged', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit',
  'additions', 'deletions', 'changedFiles', 'url', 'repository', 'viewerDidAuthor',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt',
  'updatedAt', 'url', 'isPrivate', 'fork', 'stargazerCount',
];
const SEARCH_TYPE_ENUM_VALUES = ['ISSUE', 'PULL_REQUEST', 'DISCUSSION', 'REPOSITORY', 'USER', 'ORGANIZATION', 'MILESTONE'];

/* ------------------------------------------------------------------ executor */

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function cursorFor(number: number): string {
  return b64encode(`cursor:${number}`);
}

function numberAfter(after: unknown): number | null {
  if (typeof after !== 'string' || after === '') return null;
  const decoded = b64decodeText(after);
  if (decoded === null) return null;
  const match = /^cursor:(\d+)$/.exec(decoded);
  return match === null ? null : Number(match[1]);
}

function resolveSelections(
  executor: Executor,
  typeName: string,
  resolveField: (selection: Selection) => unknown,
  selections: Selection[] | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (selections === null) return out;
  for (const selection of selections) {
    if (selection.fragmentType !== null) {
      // `... on Type { ... }`: the suite only spreads Repository fragments onto nodes.
      const nested = resolveSelections(executor, typeName, resolveField, selection.selections);
      Object.assign(out, nested);
      continue;
    }
    const value = resolveField(selection);
    if (value === undefined) continue; // an unknown field already recorded an error
    out[selection.alias ?? selection.name] = value;
  }
  return out;
}

function unknownField(executor: Executor, typeName: string, field: string): undefined {
  executor.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  return undefined;
}

function resolveIssue(executor: Executor, repo: Repo, issue: Issue, selections: Selection[] | null): Record<string, unknown> {
  return resolveSelections(executor, 'Issue', (selection) => {
    switch (selection.name) {
      case 'id':
        return executor.store.issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueState(issue);
      case 'body':
        return issue.body;
      default:
        return unknownField(executor, 'Issue', selection.name);
    }
  }, selections);
}

function resolvePullRequest(executor: Executor, repo: Repo, pull: Pull, selections: Selection[] | null): Record<string, unknown> {
  return resolveSelections(executor, 'PullRequest', (selection) => {
    switch (selection.name) {
      case 'id':
        return executor.store.pullGlobalId(repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return pull.mergeable;
      case 'files': {
        const args = argsOf(selection, executor.variables);
        const first = typeof args.first === 'number' ? args.first : 10;
        const files = executor.store.pullFiles(repo, pull).slice(0, first);
        return resolveSelections(executor, 'PullRequestChangedFileConnection', (inner) => {
          if (inner.name === 'nodes') {
            return files.map((file) =>
              resolveSelections(executor, 'PullRequestChangedFile', (nodeField) => {
                if (nodeField.name === 'path') return file.filename;
                return unknownField(executor, 'PullRequestChangedFile', nodeField.name);
              }, inner.selections),
            );
          }
          return unknownField(executor, 'PullRequestChangedFileConnection', inner.name);
        }, selection.selections);
      }
      default:
        return unknownField(executor, 'PullRequest', selection.name);
    }
  }, selections);
}

function resolveIssuesConnection(
  executor: Executor,
  repo: Repo,
  issues: Issue[],
  args: Record<string, unknown>,
  selections: Selection[] | null,
): Record<string, unknown> {
  const after = numberAfter(args.after);
  let ordered = [...issues].sort((a, b) => a.number - b.number);
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy !== undefined && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
    ordered = [...issues].sort((a, b) => b.number - a.number);
  }
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    const wanted = new Set(states);
    ordered = ordered.filter((issue) => wanted.has(issueState(issue)));
  }
  if (after !== null) ordered = ordered.filter((issue) => issue.number > after);
  const first = typeof args.first === 'number' ? args.first : ordered.length;
  const page = ordered.slice(0, first);
  const hasNextPage = ordered.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return resolveSelections(executor, 'IssueConnection', (selection) => {
    switch (selection.name) {
      case 'nodes':
        return page.map((issue) => resolveIssue(executor, repo, issue, selection.selections));
      case 'pageInfo':
        return resolveSelections(executor, 'PageInfo', (inner) => {
          if (inner.name === 'hasNextPage') return hasNextPage;
          if (inner.name === 'endCursor') return endCursor;
          return unknownField(executor, 'PageInfo', inner.name);
        }, selection.selections);
      default:
        return unknownField(executor, 'IssueConnection', selection.name);
    }
  }, selections);
}

function resolveRepository(executor: Executor, repo: Repo, selections: Selection[] | null): Record<string, unknown> {
  return resolveSelections(executor, 'Repository', (selection) => {
    switch (selection.name) {
      case 'id':
        return executor.store.repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return resolveSelections(executor, 'User', (inner) => {
          if (inner.name === 'login') return repo.owner;
          return unknownField(executor, 'User', inner.name);
        }, selection.selections);
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return resolveSelections(executor, 'Ref', (inner) => {
          if (inner.name === 'name') return repo.defaultBranch;
          return unknownField(executor, 'Ref', inner.name);
        }, selection.selections);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const args = argsOf(selection, executor.variables);
        const number = typeof args.number === 'number' ? args.number : -1;
        const issue = repo.issues.get(number);
        if (issue === undefined) return null;
        return resolveIssue(executor, repo, issue, selection.selections);
      }
      case 'issues': {
        const args = argsOf(selection, executor.variables);
        const issues = repo.issueOrder.map((number) => repo.issues.get(number) as Issue);
        return resolveIssuesConnection(executor, repo, issues, args, selection.selections);
      }
      case 'pullRequests': {
        const args = argsOf(selection, executor.variables);
        const first = typeof args.first === 'number' ? args.first : repo.pullOrder.length;
        const pulls = repo.pullOrder.map((number) => repo.pulls.get(number) as Pull).slice(0, first);
        return resolveSelections(executor, 'PullRequestConnection', (inner) => {
          if (inner.name === 'nodes') {
            return pulls.map((pull) => resolvePullRequest(executor, repo, pull, inner.selections));
          }
          return unknownField(executor, 'PullRequestConnection', inner.name);
        }, selection.selections);
      }
      case 'pullRequest': {
        const args = argsOf(selection, executor.variables);
        const number = typeof args.number === 'number' ? args.number : -1;
        const pull = repo.pulls.get(number);
        if (pull === undefined) return null;
        return resolvePullRequest(executor, repo, pull, selection.selections);
      }
      default:
        return unknownField(executor, 'Repository', selection.name);
    }
  }, selections);
}

function resolveNode(executor: Executor, id: string, selections: Selection[] | null): Record<string, unknown> | null {
  const resolved = executor.store.resolveGlobalId(id);
  if (resolved.repo === null) return null;
  const repo = resolved.repo;
  if (resolved.kind === 'Repository') {
    return resolveRepository(executor, repo, selections);
  }
  if (resolved.kind === 'Issue' && resolved.number !== null) {
    const issue = repo.issues.get(resolved.number);
    if (issue === undefined) return null;
    return resolveIssue(executor, repo, issue, selections);
  }
  if (resolved.kind === 'PullRequest' && resolved.number !== null) {
    const pull = repo.pulls.get(resolved.number);
    if (pull === undefined) return null;
    return resolvePullRequest(executor, repo, pull, selections);
  }
  return null;
}

function resolveType(executor: Executor, name: string, selections: Selection[] | null): Record<string, unknown> | null {
  const fields = name === 'Issue' ? ISSUE_FIELDS : name === 'PullRequest' ? PULL_REQUEST_FIELDS : name === 'Repository' ? REPOSITORY_FIELDS : null;
  const enumValues = name === 'SearchType' ? SEARCH_TYPE_ENUM_VALUES : null;
  if (fields === null && enumValues === null) return null;
  return resolveSelections(executor, '__Type', (selection) => {
    switch (selection.name) {
      case 'name':
        return name;
      case 'fields':
        return (fields ?? []).map((fieldName) => ({ name: fieldName }));
      case 'enumValues':
        return (enumValues ?? []).map((value) => ({ name: value }));
      default:
        return unknownField(executor, '__Type', selection.name);
    }
  }, selections);
}

function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const executor: Executor = { store, variables, errors: [] };
  const data = resolveSelections(executor, operation.kind === 'mutation' ? 'Mutation' : 'Query', (selection) => {
    const args = argsOf(selection, variables);
    switch (selection.name) {
      case 'viewer':
        return resolveSelections(executor, 'Viewer', (inner) => {
          if (inner.name === 'login') return VIEWER_LOGIN;
          return unknownField(executor, 'Viewer', inner.name);
        }, selection.selections);
      case 'repository': {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const repo = store.getRepo(owner, name);
        if (repo === undefined) return null;
        return resolveRepository(executor, repo, selection.selections);
      }
      case 'node': {
        const id = typeof args.id === 'string' ? args.id : '';
        return resolveNode(executor, id, selection.selections);
      }
      case '__type': {
        const name = typeof args.name === 'string' ? args.name : '';
        return resolveType(executor, name, selection.selections);
      }
      case 'createIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
        const resolved = store.resolveGlobalId(repositoryId);
        if (resolved.repo === null) return { issue: null };
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const created = store.createIssue(resolved.repo, title, body, []);
        if ('error' in created) return { issue: null };
        return resolveSelections(executor, 'CreateIssuePayload', (inner) => {
          if (inner.name === 'issue') {
            return resolveIssue(executor, resolved.repo as Repo, created, inner.selections);
          }
          return unknownField(executor, 'CreateIssuePayload', inner.name);
        }, selection.selections);
      }
      case 'closeIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const issueId = typeof input.issueId === 'string' ? input.issueId : '';
        const resolved = store.resolveGlobalId(issueId);
        if (resolved.repo === null || resolved.number === null) return { issue: null };
        const issue = resolved.repo.issues.get(resolved.number);
        if (issue === undefined) return { issue: null };
        issue.state = 'closed';
        issue.updatedAt = store.clock.nextIso();
        return resolveSelections(executor, 'CloseIssuePayload', (inner) => {
          if (inner.name === 'issue') {
            return resolveIssue(executor, resolved.repo as Repo, issue, inner.selections);
          }
          return unknownField(executor, 'CloseIssuePayload', inner.name);
        }, selection.selections);
      }
      case 'createPullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
        const resolved = store.resolveGlobalId(repositoryId);
        if (resolved.repo === null) return { pullRequest: null };
        const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
        const title = typeof input.title === 'string' ? input.title : '';
        const created = store.createPull(resolved.repo, title, '', headRefName, baseRefName);
        if ('error' in created) return { pullRequest: null };
        return resolveSelections(executor, 'CreatePullRequestPayload', (inner) => {
          if (inner.name === 'pullRequest') {
            return resolvePullRequest(executor, resolved.repo as Repo, created, inner.selections);
          }
          return unknownField(executor, 'CreatePullRequestPayload', inner.name);
        }, selection.selections);
      }
      case 'mergePullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
        const resolved = store.resolveGlobalId(pullRequestId);
        if (resolved.repo === null || resolved.number === null) return { pullRequest: null };
        const pull = resolved.repo.pulls.get(resolved.number);
        if (pull === undefined) return { pullRequest: null };
        const result = store.mergePull(resolved.repo, pull);
        if (typeof result === 'object') {
          executor.errors.push({ message: result.error });
          return { pullRequest: null };
        }
        return resolveSelections(executor, 'MergePullRequestPayload', (inner) => {
          if (inner.name === 'pullRequest') {
            return resolvePullRequest(executor, resolved.repo as Repo, pull, inner.selections);
          }
          return unknownField(executor, 'MergePullRequestPayload', inner.name);
        }, selection.selections);
      }
      case 'addComment': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const resolved = store.resolveGlobalId(subjectId);
        if (resolved.repo === null || resolved.number === null) return { commentEdge: null };
        const comment = store.addComment(resolved.repo, resolved.number, body);
        if (comment === null) return { commentEdge: null };
        return resolveSelections(executor, 'AddCommentPayload', (inner) => {
          if (inner.name === 'commentEdge') {
            return resolveSelections(executor, 'IssueCommentEdge', (edge) => {
              if (edge.name === 'node') {
                return resolveSelections(executor, 'IssueComment', (nodeField) => {
                  if (nodeField.name === 'id') return store.commentGlobalId(resolved.repo as Repo, resolved.number as number, comment.id);
                  if (nodeField.name === 'body') return comment.body;
                  return unknownField(executor, 'IssueComment', nodeField.name);
                }, edge.selections);
              }
              return unknownField(executor, 'IssueCommentEdge', edge.name);
            }, inner.selections);
          }
          return unknownField(executor, 'AddCommentPayload', inner.name);
        }, selection.selections);
      }
      default:
        return unknownField(executor, operation.kind === 'mutation' ? 'Mutation' : 'Query', selection.name);
    }
  }, operation.selections);
  return { data, errors: executor.errors };
}

/* ------------------------------------------------------------------ handler */

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** Handle one POST /api/graphql body (a single operation or a batched array). */
export function handleGraphQL(store: Store, body: Buffer): GraphQLResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body is not valid JSON' }] } };
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const responses: unknown[] = [];
  for (const request of requests) {
    const query = typeof (request as Record<string, unknown>)?.query === 'string' ? ((request as Record<string, unknown>).query as string) : '';
    const variables = ((request as Record<string, unknown>)?.variables ?? {}) as Record<string, unknown>;
    if (query.trim() === '') {
      responses.push({ data: null, errors: [{ message: 'No query was provided' }] });
      continue;
    }
    let operations: Operation[];
    try {
      operations = new Parser(query).parseDocument();
    } catch (err) {
      responses.push({ data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
      continue;
    }
    if (operations.length === 0) {
      responses.push({ data: null, errors: [{ message: 'No operation was provided' }] });
      continue;
    }
    // The suite sends one operation per document; a batch carries one per entry.
    const operation = operations[0];
    const { data, errors } = executeOperation(store, operation, variables);
    responses.push(errors.length > 0 ? { data, errors } : { data });
  }
  return { status: 200, body: Array.isArray(parsed) ? responses : responses[0] };
}
