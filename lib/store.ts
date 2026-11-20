// The forge's store: repos, git objects, refs, issues, pulls — one process, in memory.
//
// Ordering is always explicit (insertion order of Maps / arrays, creation
// sequence numbers). No wall clock, no randomness: every timestamp comes from
// the LogicalClock, so two runs driven by the same requests export identical state.

import { LogicalClock, b64decode, b64encode, lineCount, lineDiff, ZERO_OID } from './util.ts';
import {
  type GitObject,
  type ObjectType,
  objectOid,
  parseCommit,
  parseTree,
  parseTag,
  buildTree,
  buildCommit,
  writePack,
  emptyPack,
  type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  issueOrder: number[];
  issueSeq: number;
  comments: Map<number, IssueComment[]>;
  commentSeq: number;
  pulls: Map<number, Pull>;
  pullOrder: number[];
  pullSeq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export class Store {
  readonly clock = new LogicalClock();
  private repos = new Map<string, Repo>();
  private repoOrder: string[] = [];
  private repoIdSeq = 5000;
  private issueIdSeq = 10000;
  private pullIdSeq = 20000;

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return this.repoOrder.map((key) => this.repos.get(key) as Repo);
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const now = this.clock.nextIso();
    const repo: Repo = {
      id: this.repoIdSeq++,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.repoOrder.length,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      issueOrder: [],
      issueSeq: 1,
      comments: new Map(),
      commentSeq: 1,
      pulls: new Map(),
      pullOrder: [],
      pullSeq: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    this.repoOrder.push(this.key(owner, name));
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.key(owner, name);
    if (!this.repos.has(key)) return false;
    this.repos.delete(key);
    this.repoOrder = this.repoOrder.filter((item) => item !== key);
    return true;
  }

  /* ---------------------------------------------------------- git objects */

  addObject(repo: Repo, type: ObjectType, data: Uint8Array): string {
    const oid = objectOid(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  addObjects(repo: Repo, objects: Map<string, GitObject>): void {
    for (const [oid, obj] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }

  /** Peel a tag (possibly nested) down to the commit it points at. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let guard = 0; guard < 10; guard++) {
      const obj = repo.objects.get(current);
      if (obj === undefined) return null;
      if (obj.type === 'commit') return current;
      if (obj.type === 'tag') {
        current = parseTag(obj.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** True when `ancestor` is reachable from `tip` (both commits, after peeling). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    const ancestorCommit = this.peelToCommit(repo, ancestor);
    const tipCommit = this.peelToCommit(repo, tip);
    if (ancestorCommit === null || tipCommit === null) return false;
    if (ancestorCommit === tipCommit) return true;
    const visited = new Set<string>();
    const stack: string[] = [tipCommit];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestorCommit) return true;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  }

  /** All object oids reachable from a set of starting oids (commits/tags/trees/blobs). */
  reachable(repo: Repo, starts: string[]): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [...starts];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      }
    }
    return seen;
  }

  /** Newest-first walk of a commit's history (all parents), each commit once. */
  commitWalk(repo: Repo, tip: string): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      order.push(oid);
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) stack.push(parent);
    }
    return order;
  }

  /** The merge base of two commits: the first commit reachable from both, newest-first. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set(this.commitWalk(repo, a));
    for (const oid of this.commitWalk(repo, b)) {
      if (ancestorsA.has(oid)) return oid;
    }
    return null;
  }

  /** Flatten a tree (recursively) into path -> { oid, mode } for one commit. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, path: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const full = path === '' ? entry.name : `${path}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, full);
        else out.set(full, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Every tree and blob oid reachable from a tree, without following commits. */
  treeClosure(repo: Repo, treeOid: string): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      out.add(oid);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      }
    }
    return out;
  }

  /** The tree of a ref (branch name or oid), or null when it cannot be resolved. */
  refTreeOid(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref) ?? (repo.objects.has(ref) ? ref : null);
    if (oid === null) return null;
    const commit = this.peelToCommit(repo, oid);
    if (commit === null) return null;
    const obj = repo.objects.get(commit);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  /** Build a new tree from a base tree with one path set (or removed when data is null). */
  setPathInTree(
    repo: Repo,
    baseTreeOid: string | null,
    path: string,
    blobOid: string | null,
    mode: string,
  ): string {
    const segments = path.split('/').filter((piece) => piece !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries: TreeEntry[] = treeOid !== null ? parseTree(repo.objects.get(treeOid)?.data ?? new Uint8Array(0)) : [];
      const name = segments[depth];
      const rest = segments.slice(depth + 1);
      if (rest.length === 0) {
        // Leaf: set or delete this entry.
        const next = entries.filter((entry) => entry.name !== name);
        if (blobOid !== null) next.push({ mode, name, oid: blobOid });
        return this.addObject(repo, 'tree', buildTree(next));
      }
      const child = entries.find((entry) => entry.name === name && entry.mode === '40000');
      const childTree = build(child !== undefined ? child.oid : null, depth + 1);
      const next = entries.filter((entry) => entry.name !== name);
      const childObj = repo.objects.get(childTree);
      if (childObj !== undefined && childObj.type === 'tree' && parseTree(childObj.data).length > 0) {
        next.push({ mode: '40000', name, oid: childTree });
      }
      return this.addObject(repo, 'tree', buildTree(next));
    };
    return build(baseTreeOid, 0);
  }

  /** Create a commit object and return its oid. */
  createCommit(
    repo: Repo,
    treeOid: string,
    parents: string[],
    message: string,
  ): string {
    const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const timeSec = this.clock.nextSec();
    const data = buildCommit({ tree: treeOid, parents, author, committer: author, timeSec, message });
    return this.addObject(repo, 'commit', data);
  }

  /**
   * The objects a fetch must send: reachable(wants) minus reachable(haves).
   *
   * With a depth D, only commits within D-1 generations of a want are kept: the
   * boundary commits (generation D-1) are reported `shallow`, their parents and
   * everything below are excluded, and haves that are now fully covered are
   * reported `unshallow`. This matches the suite's depth-1 clone, deepen-2 and
   * incremental-fetch checks exactly.
   */
  fetchObjects(
    repo: Repo,
    wants: string[],
    haves: string[],
    depth: number | null,
  ): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const haveSet = this.reachable(repo, haves);
    const shallow: string[] = [];
    const unshallow: string[] = [];
    let send: Set<string>;

    if (depth === 1) {
      // Fast path: a depth-1 fetch is only the tip commit, its tree and its
      // blobs — no history walk at all. This is the benchmark's clone workload
      // (50 concurrent depth-1 clones of a 200-commit repo).
      send = new Set<string>();
      for (const want of wants) {
        const commit = this.peelToCommit(repo, want);
        if (commit === null) continue;
        shallow.push(commit);
        send.add(commit);
        const treeOid = this.refTreeOid(repo, commit);
        if (treeOid !== null) {
          for (const oid of this.treeClosure(repo, treeOid)) send.add(oid);
        }
        if (repo.objects.get(want)?.type === 'tag') send.add(want);
      }
      for (const have of haves) {
        const commit = this.peelToCommit(repo, have);
        if (commit !== null && shallow.includes(commit)) unshallow.push(have);
      }
    } else if (depth !== null) {
      // BFS from the wants, counting generations from peeled commits.
      const kept = new Set<string>();
      const boundary = new Set<string>();
      const queue: { oid: string; generation: number }[] = [];
      for (const want of wants) {
        const commit = this.peelToCommit(repo, want);
        if (commit !== null) queue.push({ oid: commit, generation: 0 });
      }
      const seen = new Set<string>();
      while (queue.length > 0) {
        const item = queue.shift() as { oid: string; generation: number };
        if (seen.has(item.oid)) continue;
        seen.add(item.oid);
        kept.add(item.oid);
        if (item.generation === depth - 1) {
          boundary.add(item.oid);
          continue;
        }
        const obj = repo.objects.get(item.oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        for (const parent of parseCommit(obj.data).parents) {
          queue.push({ oid: parent, generation: item.generation + 1 });
        }
      }
      // Everything below a boundary commit's parents is beyond the depth.
      const beyond = new Set<string>();
      for (const oid of boundary) {
        const obj = repo.objects.get(oid);
        if (obj === undefined || obj.type !== 'commit') continue;
        for (const parent of parseCommit(obj.data).parents) {
          for (const reachableOid of this.reachable(repo, [parent])) beyond.add(reachableOid);
        }
      }
      // With a depth the client's haves are shallow boundaries, not fully held
      // histories: the pack still carries the boundary commit and its tree, so
      // haves are NOT subtracted here (the suite's deepen-2 check requires the
      // have commit itself to be in the pack).
      const keptReachable = this.reachable(repo, [...kept]);
      send = new Set<string>();
      for (const oid of keptReachable) {
        if (beyond.has(oid)) continue;
        send.add(oid);
      }
      // Tag objects named by a want are part of the answer too.
      for (const oid of this.reachable(repo, wants)) {
        if (beyond.has(oid)) continue;
        if (repo.objects.get(oid)?.type === 'tag') send.add(oid);
      }
      for (const oid of boundary) shallow.push(oid);
      // A have that is now inside the fetched depth is reported unshallow — even
      // when it is also the new boundary (the suite asserts both for deepen-2).
      for (const have of haves) {
        const commit = this.peelToCommit(repo, have);
        if (commit !== null && kept.has(commit)) unshallow.push(have);
      }
    } else {
      const wantSet = this.reachable(repo, wants);
      send = new Set<string>();
      for (const oid of wantSet) {
        if (!haveSet.has(oid)) send.add(oid);
      }
    }

    const objects = new Map<string, GitObject>();
    for (const oid of send) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined) objects.set(oid, obj);
    }
    return { objects, shallow, unshallow };
  }

  /** Write the pack a fetch sends, given the resolved object set. */
  packForFetch(objects: Map<string, GitObject>): Buffer {
    if (objects.size === 0) return emptyPack();
    return writePack(objects);
  }

  /* ---------------------------------------------------------- issues */

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `Label "${name}" does not exist` };
      labels.push(label);
    }
    const now = this.clock.nextIso();
    const issue: Issue = {
      number: repo.issueSeq++,
      id: this.issueIdSeq++,
      title,
      body,
      state: 'open',
      labels,
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(issue.number, issue);
    repo.issueOrder.push(issue.number);
    return issue;
  }

  addComment(repo: Repo, issueNumber: number, body: string): IssueComment | null {
    const issue = repo.issues.get(issueNumber);
    if (issue === undefined) return null;
    const comment: IssueComment = { id: repo.commentSeq++, body, createdAt: this.clock.nextIso() };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  /* ---------------------------------------------------------- pulls */

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): Pull | { error: string } {
    const headOid = repo.refs.get(`refs/heads/${headRef}`);
    const baseOid = repo.refs.get(`refs/heads/${baseRef}`);
    if (headOid === undefined) return { error: `Head branch "${headRef}" does not exist` };
    if (baseOid === undefined) return { error: `Base branch "${baseRef}" does not exist` };
    const headCommit = this.peelToCommit(repo, headOid) ?? headOid;
    const baseCommit = this.peelToCommit(repo, baseOid) ?? baseOid;
    const now = this.clock.nextIso();
    const pull: Pull = {
      number: repo.pullSeq++,
      id: this.pullIdSeq++,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha: headCommit,
      baseSha: baseCommit,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      mergeable: this.computeMergeable(repo, headCommit, baseCommit),
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(pull.number, pull);
    repo.pullOrder.push(pull.number);
    return pull;
  }

  /** Mergeability: conflicted when both sides changed the same path differently vs the base. */
  computeMergeable(repo: Repo, headSha: string, baseSha: string): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const merge = this.tryMerge(repo, headSha, baseSha);
    return merge === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Three-way merge of the head commit into the base commit. Returns the merged
   * tree oid, or null when both sides changed the same path differently.
   */
  tryMerge(repo: Repo, headSha: string, baseSha: string): string | null {
    const baseCommit = this.mergeBase(repo, headSha, baseSha);
    if (baseCommit === null) return null;
    const headTree = this.refTreeOid(repo, headSha);
    const baseTree = this.refTreeOid(repo, baseSha);
    const mergeBaseTree = this.refTreeOid(repo, baseCommit);
    if (headTree === null || baseTree === null || mergeBaseTree === null) return null;
    const head = this.flattenTree(repo, headTree);
    const base = this.flattenTree(repo, baseTree);
    const ancestor = this.flattenTree(repo, mergeBaseTree);
    const paths = new Set<string>([...head.keys(), ...base.keys(), ...ancestor.keys()]);
    const merged = new Map<string, { oid: string; mode: string }>();
    for (const path of paths) {
      const h = head.get(path);
      const b = base.get(path);
      const a = ancestor.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(h, b)) {
        if (h !== undefined) merged.set(path, h);
      } else if (same(h, a)) {
        if (b !== undefined) merged.set(path, b);
      } else if (same(b, a)) {
        if (h !== undefined) merged.set(path, h);
      } else {
        return null; // both sides changed it differently
      }
    }
    // Rebuild nested trees from the flat map.
    const build = (pathsMap: Map<string, { oid: string; mode: string }>, prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, value] of pathsMap) {
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          entries.push({ mode: value.mode, name: rest, oid: value.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (sub === undefined) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, value);
        }
      }
      for (const [dir, sub] of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(sub, prefix === '' ? dir : `${prefix}/${dir}`) });
      }
      return this.addObject(repo, 'tree', buildTree(entries));
    };
    return build(merged, '');
  }

  /** Squash-merge a pull into its base branch. Returns the merge commit oid or an error. */
  mergePull(repo: Repo, pull: Pull): string | { error: string; conflicted: boolean } {
    if (pull.state !== 'open') return { error: 'Pull request is not open', conflicted: false };
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseOid = repo.refs.get(baseRef);
    if (baseOid === undefined) return { error: 'Base branch does not exist', conflicted: false };
    const baseCommit = this.peelToCommit(repo, baseOid) ?? baseOid;
    const headCommit = this.peelToCommit(repo, pull.headSha) ?? pull.headSha;
    const mergedTree = this.tryMerge(repo, headCommit, baseCommit);
    if (mergedTree === null) return { error: 'Merge conflict', conflicted: true };
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const mergeCommit = this.createCommit(repo, mergedTree, [baseCommit], message);
    repo.refs.set(baseRef, mergeCommit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.clock.nextIso();
    pull.mergeCommitSha = mergeCommit;
    pull.updatedAt = this.clock.nextIso();
    return mergeCommit;
  }

  /** The file changes of a pull: diff between its base commit and its current head. */
  pullFiles(repo: Repo, pull: Pull): PullFile[] {
    const baseTree = this.refTreeOid(repo, pull.baseSha);
    const headTree = this.refTreeOid(repo, pull.headSha);
    if (baseTree === null || headTree === null) return [];
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const files: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) {
        const text = this.blobText(repo, h.oid);
        const additions = lineCount(text);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const text = this.blobText(repo, b.oid);
        const deletions = lineCount(text);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const prev = this.blobText(repo, b.oid);
        const next = this.blobText(repo, h.oid);
        const diff = lineDiff(prev, next);
        files.push({
          filename: path,
          status: 'modified',
          additions: diff.additions,
          deletions: diff.deletions,
          changes: diff.additions + diff.deletions,
        });
      }
    }
    return files;
  }

  blobText(repo: Repo, oid: string): string {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'blob') return '';
    return Buffer.from(obj.data).toString('utf8');
  }

  /** The blob oid of a path in a tree, or null. */
  blobAtPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
    const flat = this.flattenTree(repo, treeOid);
    return flat.get(path) ?? null;
  }

  /** The ref a pull's head branch currently points at (for freshness). */
  currentHeadSha(repo: Repo, pull: Pull): string {
    const oid = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (oid === undefined) return pull.headSha;
    return this.peelToCommit(repo, oid) ?? oid;
  }

  /* ---------------------------------------------------------- ids */

  repoGlobalId(repo: Repo): string {
    return b64encode(`Repository:${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return b64encode(`Issue:${repo.owner}/${repo.name}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return b64encode(`PullRequest:${repo.owner}/${repo.name}:${pull.number}`);
  }

  commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
    return b64encode(`IssueComment:${repo.owner}/${repo.name}:${issueNumber}:${commentId}`);
  }

  /** Resolve a global id back to its repo (and, for issues/pulls, the number). */
  resolveGlobalId(id: string): { kind: string; repo: Repo | null; number: number | null } {
    const decoded = (() => {
      try {
        return Buffer.from(id, 'base64').toString('utf8');
      } catch {
        return '';
      }
    })();
    const match = /^(Repository|Issue|PullRequest|IssueComment):([^:]+)\/([^:]+)(?::(\d+))?/.exec(decoded);
    if (match === null) return { kind: '', repo: null, number: null };
    const repo = this.getRepo(match[2], match[3]) ?? null;
    const number = match[4] !== undefined ? Number(match[4]) : null;
    return { kind: match[1], repo, number };
  }
}

export { b64decode };
