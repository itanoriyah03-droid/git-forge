// REST v3: the /api/v3 surface the conformance checks drive. Every reply is JSON
// and carries a non-empty X-GitHub-Request-Id; unknown routes are JSON 404s and a
// malformed JSON body is a 400. Authentication is the trial bearer token: without
// it every route answers 401, and a repository name under another owner is 404.

import { Store, VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL, type Repo, type Issue, type Pull } from './store.ts';
import { parseTree } from './git.ts';
import { b64decode, b64encodeBytes, RequestIds } from './util.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3 (['repos', owner, name, ...]). */
  segments: string[];
  query: URLSearchParams;
  /** The raw request body (empty when none was sent). */
  body: Buffer;
  headers: Record<string, string | undefined>;
  /** The entry's own base URL, for absolute Link headers. */
  baseUrl: string;
}

export interface RestResult {
  status: number;
  /** JSON value, or null for a 204 with no body. */
  body: unknown;
  headers: Record<string, string>;
}

export interface RestConfig {
  /** The bearer token the suite presents (MAKEFUN_SHOP_TOKEN). */
  token: string;
  requestIds: RequestIds;
}

const NOT_FOUND = { message: 'Not Found' };

function json(status: number, body: unknown, headers: Record<string, string> = {}): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return json(status, { message });
}

/** Parse a JSON request body; a malformed one is a 400, an empty one is {}. */
function parseBody(req: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; result: RestResult } {
  const text = req.body.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> };
    return { ok: true, value: {} };
  } catch {
    return { ok: false, result: err(400, 'Problems parsing JSON') };
  }
}

function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : repo.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
    git_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    topics: [],
    license: null,
    permissions: { admin: true, push: true, pull: true },
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: (repo.comments.get(issue.number) ?? []).length,
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.mergeable === 'MERGEABLE',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
  };
}

/** Paginate a list the GitHub way; the Link header carries absolute next/last URLs. */
function paginate<T>(items: readonly T[], query: URLSearchParams, baseUrl: string, path: string): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.floor(perPageRaw))) : 30;
  const pageRaw = Number(query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const url = (pageNumber: number): string => `${baseUrl}${path}?per_page=${perPage}&page=${pageNumber}`;
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${url(page + 1)}>; rel="next"`);
    links.push(`<${url(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${url(1)}>; rel="first"`);
    links.push(`<${url(page - 1)}>; rel="prev"`);
  }
  return { page: pageItems, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

export class RestHandler {
  private store: Store;
  private config: RestConfig;

  constructor(store: Store, config: RestConfig) {
    this.store = store;
    this.config = config;
  }

  /** Handle one /api/v3 request. Always answers JSON with a request id. */
  handle(req: RestRequest): RestResult {
    // Authentication first: every route needs the trial bearer token.
    const authorization = req.headers.authorization ?? '';
    if (this.config.token !== '' && authorization !== `Bearer ${this.config.token}`) {
      return this.withRequestId(err(401, 'Requires authentication'));
    }
    const result = this.route(req);
    return this.withRequestId(result);
  }

  private withRequestId(result: RestResult): RestResult {
    return { ...result, headers: { ...result.headers, 'x-github-request-id': this.config.requestIds.next() } };
  }

  private route(req: RestRequest): RestResult {
    const s = req.segments;
    const method = req.method;

    if (s.length === 0) {
      if (method === 'GET') {
        return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      }
      return err(404, NOT_FOUND.message);
    }

    if (s[0] === 'meta' && s.length === 1) {
      if (method === 'GET') return json(200, { installed_version: '1.0.0' });
      return err(404, NOT_FOUND.message);
    }

    if (s[0] === 'user' && s.length === 1) {
      if (method === 'GET') {
        return json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
      }
      return err(404, NOT_FOUND.message);
    }

    if (s[0] === 'user' && s[1] === 'repos' && s.length === 2) {
      if (method === 'GET') return this.listUserRepos(req);
      if (method === 'POST') return this.createRepo(req);
      return err(404, NOT_FOUND.message);
    }

    if (s[0] === 'repos' && s.length >= 3) {
      return this.repoRoute(req, s[1], s[2], s.slice(3));
    }

    return err(404, NOT_FOUND.message);
  }

  private listUserRepos(req: RestRequest): RestResult {
    const repos = this.store.listRepos().filter((repo) => repo.owner === VIEWER_LOGIN);
    const { page, headers } = paginate(
      repos.map((repo) => repoJson(repo, req.baseUrl)),
      req.query,
      req.baseUrl,
      '/api/v3/user/repos',
    );
    return json(200, page, headers);
  }

  private createRepo(req: RestRequest): RestResult {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') return err(422, 'Repository name is required');
    const isPrivate = body.private === true;
    const description = typeof body.description === 'string' ? body.description : '';
    const repo = this.store.createRepo(VIEWER_LOGIN, name, isPrivate, description);
    if (repo === null) return err(422, 'Repository already exists');
    return json(201, repoJson(repo, req.baseUrl));
  }

  /** Resolve a repository by its path owner/name; anything else is a 404, never a 403. */
  private resolve(owner: string, name: string): Repo | null {
    return this.store.getRepo(owner, name) ?? null;
  }

  private repoRoute(req: RestRequest, owner: string, name: string, rest: string[]): RestResult {
    const method = req.method;
    const repo = this.resolve(owner, name);
    if (repo === null) return err(404, NOT_FOUND.message);

    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(repo, req.baseUrl));
      if (method === 'PATCH') return this.patchRepo(req, repo);
      if (method === 'DELETE') {
        this.store.deleteRepo(owner, name);
        return { status: 204, body: null, headers: {} };
      }
      return err(404, NOT_FOUND.message);
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) return this.createRef(req, repo);
      if (method === 'GET' && rest.length >= 4) {
        const kind = rest[2];
        const refName = rest.slice(3).join('/');
        if (kind === 'heads' || kind === 'tags') return this.getRef(repo, `refs/${kind}/${refName}`);
      }
      return err(404, NOT_FOUND.message);
    }

    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) return this.listBranches(repo);
      if (method === 'GET' && rest.length >= 2) {
        const branch = rest.slice(1).join('/');
        return this.getBranch(repo, branch);
      }
      return err(404, NOT_FOUND.message);
    }

    if (rest[0] === 'commits' && rest.length === 1) {
      if (method === 'GET') return this.listCommits(req, repo);
      return err(404, NOT_FOUND.message);
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') return this.getContents(req, repo, path);
      if (method === 'PUT') return this.putContents(req, repo, path);
      if (method === 'DELETE') return this.deleteContents(req, repo, path);
      return err(404, NOT_FOUND.message);
    }

    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) return this.createLabel(req, repo);
      return err(404, NOT_FOUND.message);
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') return this.listIssues(req, repo);
        if (method === 'POST') return this.createIssue(req, repo);
        return err(404, NOT_FOUND.message);
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, NOT_FOUND.message);
      if (rest.length === 2) {
        if (method === 'GET') return this.getIssue(repo, number);
        if (method === 'PATCH') return this.patchIssue(req, repo, number);
        return err(404, NOT_FOUND.message);
      }
      if (rest[2] === 'comments' && rest.length === 3) {
        if (method === 'GET') return this.listComments(repo, number);
        if (method === 'POST') return this.createComment(req, repo, number);
        return err(404, NOT_FOUND.message);
      }
      return err(404, NOT_FOUND.message);
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') return this.listPulls(req, repo);
        if (method === 'POST') return this.createPull(req, repo);
        return err(404, NOT_FOUND.message);
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, NOT_FOUND.message);
      if (rest.length === 2) {
        if (method === 'GET') return this.getPull(repo, number);
        return err(404, NOT_FOUND.message);
      }
      if (rest[2] === 'files' && rest.length === 3) {
        if (method === 'GET') return this.getPullFiles(repo, number);
        return err(404, NOT_FOUND.message);
      }
      if (rest[2] === 'merge' && rest.length === 3) {
        if (method === 'PUT') return this.mergePull(req, repo, number);
        return err(404, NOT_FOUND.message);
      }
      return err(404, NOT_FOUND.message);
    }

    return err(404, NOT_FOUND.message);
  }

  private patchRepo(req: RestRequest, repo: Repo): RestResult {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    if (typeof body.description === 'string') repo.description = body.description;
    repo.updatedAt = this.store.clock.nextIso();
    return json(200, repoJson(repo, req.baseUrl));
  }

  private createRef(req: RestRequest, repo: Repo): RestResult {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/')) return err(422, 'Invalid ref');
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
    repo.refs.set(ref, sha);
    return json(201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice(5)}` });
  }

  private getRef(repo: Repo, ref: string): RestResult {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return err(404, NOT_FOUND.message);
    const obj = repo.objects.get(oid);
    return json(200, { ref, object: { sha: oid, type: obj?.type ?? 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice(5)}` });
  }

  private listBranches(repo: Repo): RestResult {
    const branches: Record<string, unknown>[] = [];
    for (const [ref, oid] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    return json(200, branches);
  }

  private getBranch(repo: Repo, branch: string): RestResult {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return err(404, NOT_FOUND.message);
    return json(200, { name: branch, commit: { sha: oid }, protected: false });
  }

  private listCommits(req: RestRequest, repo: Repo): RestResult {
    const shaParam = req.query.get('sha');
    let tip: string | null = null;
    if (shaParam !== null && shaParam !== '') {
      if (shaParam.startsWith('refs/')) tip = repo.refs.get(shaParam) ?? null;
      else tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : null);
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (tip === null) return json(200, []);
    const commit = this.store.peelToCommit(repo, tip);
    if (commit === null) return json(200, []);
    const walk = this.store.commitWalk(repo, commit);
    const items = walk.map((oid) => {
      const obj = repo.objects.get(oid);
      const message = obj !== undefined && obj.type === 'commit' ? this.storeMessage(repo, oid) : '';
      return {
        sha: oid,
        commit: {
          message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: repo.createdAt },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: repo.createdAt },
        },
      };
    });
    return json(200, items);
  }

  private storeMessage(repo: Repo, oid: string): string {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return '';
    const text = Buffer.from(obj.data).toString('utf8');
    const blank = text.indexOf('\n\n');
    return blank >= 0 ? text.slice(blank + 2) : '';
  }

  private getContents(req: RestRequest, repo: Repo, path: string): RestResult {
    const refParam = req.query.get('ref');
    let treeOid: string | null = null;
    if (refParam !== null && refParam !== '') {
      treeOid = this.store.refTreeOid(repo, refParam.startsWith('refs/') ? refParam : `refs/heads/${refParam}`);
    } else {
      treeOid = this.store.refTreeOid(repo, `refs/heads/${repo.defaultBranch}`);
    }
    if (treeOid === null) return err(404, NOT_FOUND.message);
    if (path === '') return this.directoryListing(repo, treeOid, '');
    const flat = this.store.flattenTree(repo, treeOid);
    const file = flat.get(path);
    if (file !== undefined) {
      const obj = repo.objects.get(file.oid);
      const data = obj !== undefined ? Buffer.from(obj.data) : Buffer.alloc(0);
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: b64encodeBytes(data),
        sha: file.oid,
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
      });
    }
    // A directory: list the entries directly under it.
    const prefix = `${path}/`;
    const entries: Record<string, unknown>[] = [];
    const seenDirs = new Set<string>();
    for (const [entryPath, entry] of flat) {
      if (!entryPath.startsWith(prefix)) continue;
      const rest = entryPath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ type: 'file', name: rest, path: entryPath, sha: entry.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          const dirTree = this.dirTreeOid(repo, treeOid, `${path}/${dir}`);
          entries.push({ type: 'dir', name: dir, path: `${path}/${dir}`, sha: dirTree ?? '' });
        }
      }
    }
    if (entries.length === 0) return err(404, NOT_FOUND.message);
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return json(200, entries);
  }

  private directoryListing(repo: Repo, treeOid: string, prefix: string): RestResult {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return err(404, NOT_FOUND.message);
    const flat = this.store.flattenTree(repo, treeOid);
    const entries: Record<string, unknown>[] = [];
    const seenDirs = new Set<string>();
    for (const [entryPath, entry] of flat) {
      const slash = entryPath.indexOf('/');
      if (slash === -1) {
        entries.push({ type: 'file', name: entryPath, path: entryPath, sha: entry.oid });
      } else {
        const dir = entryPath.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          const dirTree = this.dirTreeOid(repo, treeOid, dir);
          entries.push({ type: 'dir', name: dir, path: dir, sha: dirTree ?? '' });
        }
      }
    }
    entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return json(200, entries);
  }

  /** The tree oid of a directory path inside a root tree, or null. */
  private dirTreeOid(repo: Repo, rootTreeOid: string, path: string): string | null {
    let current = rootTreeOid;
    for (const segment of path.split('/')) {
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (entry === undefined) return null;
      current = entry.oid;
    }
    return current;
  }

  private putContents(req: RestRequest, repo: Repo, path: string): RestResult {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    if (contentB64 === '') return err(422, 'Content is required');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;

    let baseTree: string | null = null;
    let parent: string[] = [];
    let isNewBranch = false;
    const currentTip = repo.refs.get(ref);
    if (currentTip !== undefined) {
      const commit = this.store.peelToCommit(repo, currentTip);
      if (commit !== null) {
        parent = [commit];
        baseTree = this.store.refTreeOid(repo, ref);
      }
    } else {
      // An unborn repository accepts the first commit; a missing branch on a live
      // repository is created from the default branch tip (the MCP fallback needs it).
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) {
        const commit = this.store.peelToCommit(repo, defaultTip);
        if (commit !== null) {
          parent = [commit];
          baseTree = this.store.refTreeOid(repo, `refs/heads/${repo.defaultBranch}`);
        }
      }
      isNewBranch = true;
    }

    const content = b64decode(contentB64);
    const blobOid = this.store.addObject(repo, 'blob', content);
    const existing = baseTree !== null ? this.store.blobAtPath(repo, baseTree, path) : null;
    const isUpdate = existing !== null;
    if (isUpdate) {
      const sentSha = typeof body.sha === 'string' ? body.sha : '';
      if (sentSha !== '' && sentSha.toLowerCase() !== existing.oid.toLowerCase()) {
        return err(409, 'The blob sha does not match the current file');
      }
    }
    const newTree = this.store.setPathInTree(repo, baseTree, path, blobOid, '100644');
    const commitOid = this.store.createCommit(repo, newTree, parent, message);
    repo.refs.set(ref, commitOid);
    repo.updatedAt = this.store.clock.nextIso();
    void isNewBranch;
    return json(isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitOid },
    });
  }

  private deleteContents(req: RestRequest, repo: Repo, path: string): RestResult {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const currentTip = repo.refs.get(ref);
    if (currentTip === undefined) return err(404, NOT_FOUND.message);
    const commit = this.store.peelToCommit(repo, currentTip);
    if (commit === null) return err(404, NOT_FOUND.message);
    const baseTree = this.store.refTreeOid(repo, ref);
    if (baseTree === null) return err(404, NOT_FOUND.message);
    const existing = this.store.blobAtPath(repo, baseTree, path);
    if (existing === null) return err(404, NOT_FOUND.message);
    const sentSha = typeof body.sha === 'string' ? body.sha : '';
    if (sentSha !== '' && sentSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return err(409, 'The blob sha does not match the current file');
    }
    const newTree = this.store.setPathInTree(repo, baseTree, path, null, '100644');
    const commitOid = this.store.createCommit(repo, newTree, [commit], message);
    repo.refs.set(ref, commitOid);
    repo.updatedAt = this.store.clock.nextIso();
    return json(200, { commit: { sha: commitOid } });
  }

  private createLabel(req: RestRequest, repo: Repo): RestResult {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') return err(422, 'Label name is required');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    const existing = repo.labels.get(name);
    if (existing !== undefined) return json(201, { name: existing.name, color: existing.color });
    repo.labels.set(name, { name, color });
    return json(201, { name, color });
  }

  private listIssues(req: RestRequest, repo: Repo): RestResult {
    const state = req.query.get('state') ?? 'open';
    const sort = req.query.get('sort') ?? 'created';
    const direction = req.query.get('direction') ?? 'desc';
    let issues = repo.issueOrder.map((number) => repo.issues.get(number) as Issue);
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    if (sort === 'created') {
      issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    }
    const { page, headers } = paginate(
      issues.map((issue) => issueJson(repo, issue)),
      req.query,
      req.baseUrl,
      `/api/v3/repos/${repo.owner}/${repo.name}/issues`,
    );
    return json(200, page, headers);
  }

  private createIssue(req: RestRequest, repo: Repo): RestResult {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    const title = typeof body.title === 'string' ? body.title : '';
    if (title === '') return err(422, 'Title is required');
    const issueBody = typeof body.body === 'string' ? body.body : '';
    const labelNames = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
    const created = this.store.createIssue(repo, title, issueBody, labelNames);
    if ('error' in created) return err(422, created.error);
    return json(201, issueJson(repo, created));
  }

  private getIssue(repo: Repo, number: number): RestResult {
    const issue = repo.issues.get(number);
    if (issue === undefined) return err(404, NOT_FOUND.message);
    return json(200, issueJson(repo, issue));
  }

  private patchIssue(req: RestRequest, repo: Repo, number: number): RestResult {
    const issue = repo.issues.get(number);
    if (issue === undefined) return err(404, NOT_FOUND.message);
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
    issue.updatedAt = this.store.clock.nextIso();
    return json(200, issueJson(repo, issue));
  }

  private listComments(repo: Repo, number: number): RestResult {
    const issue = repo.issues.get(number);
    if (issue === undefined) return err(404, NOT_FOUND.message);
    const comments = repo.comments.get(number) ?? [];
    return json(200, comments.map((comment) => commentJson(repo, number, comment)));
  }

  private createComment(req: RestRequest, repo: Repo, number: number): RestResult {
    const issue = repo.issues.get(number);
    if (issue === undefined) return err(404, NOT_FOUND.message);
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    const text = typeof body.body === 'string' ? body.body : '';
    if (text === '') return err(422, 'Comment body is required');
    const comment = this.store.addComment(repo, number, text);
    if (comment === null) return err(404, NOT_FOUND.message);
    return json(201, commentJson(repo, number, comment));
  }

  private listPulls(req: RestRequest, repo: Repo): RestResult {
    const state = req.query.get('state') ?? 'open';
    let pulls = repo.pullOrder.map((number) => repo.pulls.get(number) as Pull);
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    const { page, headers } = paginate(
      pulls.map((pull) => pullJson(repo, pull)),
      req.query,
      req.baseUrl,
      `/api/v3/repos/${repo.owner}/${repo.name}/pulls`,
    );
    return json(200, page, headers);
  }

  private createPull(req: RestRequest, repo: Repo): RestResult {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const body = parsed.value;
    const title = typeof body.title === 'string' ? body.title : '';
    if (title === '') return err(422, 'Title is required');
    const pullBody = typeof body.body === 'string' ? body.body : '';
    const head = typeof body.head === 'string' ? body.head : '';
    const base = typeof body.base === 'string' ? body.base : '';
    if (head === '' || base === '') return err(422, 'Head and base branches are required');
    const created = this.store.createPull(repo, title, pullBody, head, base);
    if ('error' in created) return err(422, created.error);
    return json(201, pullJson(repo, created));
  }

  private getPull(repo: Repo, number: number): RestResult {
    const pull = repo.pulls.get(number);
    if (pull === undefined) return err(404, NOT_FOUND.message);
    return json(200, pullJson(repo, pull));
  }

  private getPullFiles(repo: Repo, number: number): RestResult {
    const pull = repo.pulls.get(number);
    if (pull === undefined) return err(404, NOT_FOUND.message);
    return json(200, this.store.pullFiles(repo, pull));
  }

  private mergePull(req: RestRequest, repo: Repo, number: number): RestResult {
    const pull = repo.pulls.get(number);
    if (pull === undefined) return err(404, NOT_FOUND.message);
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    const result = this.store.mergePull(repo, pull);
    if (typeof result === 'object') {
      if (result.conflicted) return err(405, result.error);
      return err(422, result.error);
    }
    return json(200, { sha: result, merged: true, message: `Merge pull request #${number} from ${pull.headRef}` });
  }
}
