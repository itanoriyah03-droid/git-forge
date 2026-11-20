// MCP: the /mcp endpoint, JSON-RPC 2.0 Streamable HTTP, modern era 2026-07-28
// (`server/discover`, no handshake, no session) with the legacy `initialize` +
// `notifications/initialized` path kept for a client that predates discover. The
// tools act on the same store as REST and GraphQL, so a repository or an issue
// created here is the same object over REST.

import { Store, VIEWER_LOGIN } from './store.ts';

export const MCP_SERVER_NAME = 'git-forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_REVISION = '2026-07-28';

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

/** The tool list, built once: two tools/list calls must answer byte-identical arrays. */
export const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        owner: { type: 'string', description: 'The owner login; defaults to the token owner.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit on its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
]);

export interface McpResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, headers: {} };
}

function rpcResult(id: unknown, result: unknown, headers: Record<string, string> = {}): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result }, headers };
}

function serverInfo(): Record<string, unknown> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function numberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** One tool call's outcome: a result object, or an isError failure. */
type ToolOutcome = { result: Record<string, unknown> } | { error: string };

export class McpHandler {
  private store: Store;
  private token: string;

  constructor(store: Store, token: string) {
    this.store = store;
    this.token = token;
  }

  /** Handle one /mcp request. `headers` are the request's lower-cased headers. */
  handle(method: string, body: Buffer, headers: Record<string, string | undefined>): McpResult {
    if (method === 'DELETE') return { status: 204, body: null, headers: {} };
    if (method !== 'POST') {
      return { status: 405, body: { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Method not allowed' } }, headers: {} };
    }
    const authorization = headers.authorization ?? '';
    if (this.token !== '' && authorization !== `Bearer ${this.token}`) {
      return { status: 401, body: { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, headers: {} };
    }
    let request: unknown;
    try {
      request = JSON.parse(body.toString('utf8'));
    } catch {
      return rpcError(null, PARSE_ERROR, 'Parse error', 400);
    }
    if (!isRecord(request)) {
      return rpcError(null, INVALID_REQUEST, 'Invalid Request');
    }
    const id = request.id ?? null;
    const rpcMethod = typeof request.method === 'string' ? request.method : '';
    const params = isRecord(request.params) ? request.params : {};

    // A notification (no id) gets no JSON-RPC answer: 202, empty.
    const isNotification = !('id' in request) || request.id === undefined;

    switch (rpcMethod) {
      case 'server/discover': {
        const result = {
          supportedVersions: [MCP_REVISION],
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
        };
        if (isNotification) return { status: 202, body: null, headers: {} };
        return rpcResult(id, result, { 'mcp-session-id': 'mcp-session-1' });
      }
      case 'initialize': {
        const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
        const result = {
          protocolVersion: offered,
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
        };
        if (isNotification) return { status: 202, body: null, headers: {} };
        return rpcResult(id, result, { 'mcp-session-id': 'mcp-session-1' });
      }
      case 'notifications/initialized':
        return { status: 202, body: null, headers: {} };
      case 'tools/list': {
        if (isNotification) return { status: 202, body: null, headers: {} };
        return rpcResult(id, { tools: MCP_TOOLS });
      }
      case 'tools/call': {
        if (isNotification) return { status: 202, body: null, headers: {} };
        return this.callTool(id, params);
      }
      default:
        if (isNotification) return { status: 202, body: null, headers: {} };
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${rpcMethod}`);
    }
  }

  private callTool(id: unknown, params: Record<string, unknown>): McpResult {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const tool = MCP_TOOLS.find((candidate) => candidate.name === normalized || candidate.name.replace(/[^a-z0-9]/g, '') === normalized);
    if (tool === undefined) {
      return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
    }
    for (const required of tool.inputSchema.required) {
      if (!(required in args) || args[required] === undefined || args[required] === null || args[required] === '') {
        return rpcError(id, INVALID_PARAMS, `Missing required argument: ${required}`);
      }
    }
    const outcome = this.runTool(tool.name, args);
    if ('error' in outcome) {
      return rpcResult(id, { content: [{ type: 'text', text: outcome.error }], isError: true });
    }
    const text = JSON.stringify(outcome.result);
    return rpcResult(id, { content: [{ type: 'text', text }], structuredContent: outcome.result });
  }

  private runTool(name: string, args: Record<string, unknown>): ToolOutcome {
    switch (name) {
      case 'create_repo': {
        const repoName = stringArg(args, 'name');
        const owner = stringArg(args, 'owner') || VIEWER_LOGIN;
        const description = stringArg(args, 'description');
        const isPrivate = args.private === true;
        let repo = this.store.getRepo(owner, repoName);
        if (repo === undefined) {
          repo = this.store.createRepo(owner, repoName, isPrivate, description) ?? undefined;
        }
        if (repo === undefined) return { error: `Repository ${owner}/${repoName} could not be created` };
        return { result: { name: repo.name, full_name: `${repo.owner}/${repo.name}`, id: repo.id, private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch } };
      }
      case 'get_repo': {
        const owner = stringArg(args, 'owner');
        const repoName = stringArg(args, 'repo');
        const repo = this.store.getRepo(owner, repoName);
        if (repo === undefined) return { error: `Repository ${owner}/${repoName} not found` };
        return { result: { name: repo.name, full_name: `${repo.owner}/${repo.name}`, id: repo.id, private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch, owner: { login: repo.owner } } };
      }
      case 'create_issue': {
        const owner = stringArg(args, 'owner');
        const repoName = stringArg(args, 'repo');
        const repo = this.store.getRepo(owner, repoName);
        if (repo === undefined) return { error: `Repository ${owner}/${repoName} not found` };
        const title = stringArg(args, 'title');
        const body = stringArg(args, 'body');
        const created = this.store.createIssue(repo, title, body, []);
        if ('error' in created) return { error: created.error };
        return { result: { number: created.number, id: created.id, title: created.title, state: created.state, url: `/repos/${owner}/${repoName}/issues/${created.number}` } };
      }
      case 'list_issues': {
        const owner = stringArg(args, 'owner');
        const repoName = stringArg(args, 'repo');
        const repo = this.store.getRepo(owner, repoName);
        if (repo === undefined) return { error: `Repository ${owner}/${repoName} not found` };
        const state = stringArg(args, 'state');
        const issues = repo.issueOrder
          .map((number) => repo.issues.get(number))
          .filter((issue) => issue !== undefined)
          .filter((issue) => state === '' || state === 'all' || issue.state === state)
          .map((issue) => ({ number: issue.number, id: issue.id, title: issue.title, state: issue.state }));
        return { result: { issues } };
      }
      case 'create_pull_request': {
        const owner = stringArg(args, 'owner');
        const repoName = stringArg(args, 'repo');
        const repo = this.store.getRepo(owner, repoName);
        if (repo === undefined) return { error: `Repository ${owner}/${repoName} not found` };
        const title = stringArg(args, 'title');
        const body = stringArg(args, 'body');
        const head = stringArg(args, 'head');
        const base = stringArg(args, 'base');
        const created = this.store.createPull(repo, title, body, head, base);
        if ('error' in created) return { error: created.error };
        return { result: { number: created.number, id: created.id, title: created.title, state: created.state, head: created.headRef, base: created.baseRef, headRefName: created.headRef, baseRefName: created.baseRef } };
      }
      case 'merge_pull_request': {
        const owner = stringArg(args, 'owner');
        const repoName = stringArg(args, 'repo');
        const repo = this.store.getRepo(owner, repoName);
        if (repo === undefined) return { error: `Repository ${owner}/${repoName} not found` };
        const number = numberArg(args, 'pull_number');
        if (number === null) return { error: 'pull_number is required' };
        const pull = repo.pulls.get(number);
        if (pull === undefined) return { error: `Pull request #${number} not found` };
        const result = this.store.mergePull(repo, pull);
        if (typeof result === 'object') return { error: result.error };
        return { result: { merged: true, number, sha: result, message: `Merge pull request #${number} from ${pull.headRef}` } };
      }
      case 'close_issue': {
        const owner = stringArg(args, 'owner');
        const repoName = stringArg(args, 'repo');
        const repo = this.store.getRepo(owner, repoName);
        if (repo === undefined) return { error: `Repository ${owner}/${repoName} not found` };
        const number = numberArg(args, 'issue_number');
        if (number === null) return { error: 'issue_number is required' };
        const issue = repo.issues.get(number);
        if (issue === undefined) return { error: `Issue #${number} not found` };
        issue.state = 'closed';
        issue.updatedAt = this.store.clock.nextIso();
        return { result: { number: issue.number, state: issue.state } };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }
}
