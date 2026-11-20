// Git smart HTTP: info/refs advertisements, upload-pack (v2 with a v0 fallback)
// and receive-pack v0. These handlers speak the pkt-line protocol exactly as
// the conformance suite's GitClient expects it.

import type { Store, Repo } from './store.ts';
import { DEFAULT_BRANCH } from './store.ts';
import {
  pktLine,
  FLUSH,
  parsePktLines,
  parseAllPktLines,
  parsePack,
  writePack,
  emptyPack,
  parseCommit,
  parseTag,
  ZERO_OID,
} from './git.ts';

export const AGENT = 'forge/1.0';

const V2_CAPS = ['ls-refs=unborn', 'fetch=shallow', 'object-format=sha1', `agent=${AGENT}`];

export interface GitContext {
  store: Store;
  /** The parsed request body (for POSTs). */
  body: Buffer;
  /** Request headers, lower-cased keys. */
  headers: Record<string, string | undefined>;
  /** The raw query string (without '?'). */
  query: string;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

/** Sorted ref names, HEAD first when it exists. */
function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The oid a ref resolves to for advertisement purposes (tags stay as tag objects). */
function refOid(repo: Repo, ref: string): string {
  return repo.refs.get(ref) ?? ZERO_OID;
}

/* ---------------------------------------------------------- advertisements */

/** info/refs?service=git-upload-pack, protocol v2 (Git-Protocol: version=2). */
export function uploadPackAdvertisementV2(): Buffer {
  const lines: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktLine('version 2\n')];
  for (const cap of V2_CAPS) lines.push(pktLine(`${cap}\n`));
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

/** info/refs?service=git-upload-pack, protocol v0. */
export function uploadPackAdvertisementV0(repo: Repo): Buffer {
  const caps = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k thin-pack ofs-delta multi_ack shallow agent=${AGENT}`;
  const lines: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    if (headOid !== undefined) lines.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const name of names) {
      const oid = refOid(repo, name);
      lines.push(pktLine(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        lines.push(pktLine(`${target} ${name}^{}\n`));
      }
    }
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

/** info/refs?service=git-receive-pack. */
export function receivePackAdvertisement(repo: Repo): Buffer {
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    if (headOid !== undefined) lines.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const name of names) lines.push(pktLine(`${refOid(repo, name)} ${name}\n`));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

/* ---------------------------------------------------------- v2 ls-refs */

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Handle a v2 ls-refs request body. */
export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const packet of parseAllPktLines(body)) {
    const line = packet.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }

  const out: Buffer[] = [];
  const matchesPrefix = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);

  if (args.symrefs && args.prefixes.length === 0) {
    if (headOid !== undefined) {
      out.push(pktLine(`${headOid} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
    } else if (args.unborn) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
    }
  }

  for (const name of sortedRefNames(repo)) {
    if (!matchesPrefix(name)) continue;
    const oid = refOid(repo, name);
    let line = `${oid} ${name}`;
    const obj = repo.objects.get(oid);
    if (args.peel && obj !== undefined && obj.type === 'tag') {
      line += ` peeled:${parseTag(obj.data).object}`;
    }
    if (args.symrefs && name === `refs/heads/${DEFAULT_BRANCH}`) {
      line += ` symref-target:refs/heads/${DEFAULT_BRANCH}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

/* ---------------------------------------------------------- v2 fetch */

/** The first have that is an ancestor of (or equal to) any want, else null. */
function findAck(store: Store, repo: Repo, wants: string[], haves: string[]): string | null {
  for (const have of haves) {
    for (const want of wants) {
      if (have === want || store.isAncestor(repo, have, want)) return have;
    }
  }
  return null;
}

/** Split a sideband payload into band-1 packets of at most 60,000 data bytes. */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunk = 60_000;
  for (let offset = 0; offset < data.length; offset += chunk) {
    const piece = data.subarray(offset, Math.min(offset + chunk, data.length));
    const frame = Buffer.alloc(piece.length + 1);
    frame[0] = 1;
    piece.copy(frame, 1);
    out.push(pktLine(frame));
  }
  return out;
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  depth: number | null;
}

/** The first token of a pkt-line payload: the oid of a `want <oid> [caps]` line. */
function firstToken(line: string): string {
  const beforeNul = line.split('\0')[0];
  return beforeNul.trim().split(/\s+/)[0] ?? '';
}

/** Parse a v2 fetch request body into its wants, haves and depth. */
export function parseV2Fetch(body: Buffer): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  for (const packet of parseAllPktLines(body)) {
    const line = packet.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(firstToken(line.slice(5)));
    else if (line.startsWith('have ')) haves.push(firstToken(line.slice(5)));
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = Math.floor(n);
    }
  }
  return { wants, haves, depth };
}

/** Handle a v2 fetch request: acknowledgments, shallow-info, packfile sections. */
export function handleV2Fetch(store: Store, repo: Repo, body: Buffer): Buffer {
  const { wants, haves, depth } = parseV2Fetch(body);
  const sections: Buffer[] = [];

  if (haves.length > 0) {
    const ack = findAck(store, repo, wants, haves);
    const lines: Buffer[] = [pktLine('acknowledgments\n')];
    if (ack !== null) {
      lines.push(pktLine(`ACK ${ack}\n`));
      lines.push(pktLine('ready\n'));
    } else {
      lines.push(pktLine('NAK\n'));
    }
    lines.push(FLUSH);
    sections.push(Buffer.concat(lines));
  }

  const { objects, shallow, unshallow } = store.fetchObjects(repo, wants, haves, depth);
  if (shallow.length > 0 || unshallow.length > 0) {
    const lines: Buffer[] = [pktLine('shallow-info\n')];
    for (const oid of shallow) lines.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) lines.push(pktLine(`unshallow ${oid}\n`));
    lines.push(FLUSH);
    sections.push(Buffer.concat(lines));
  }

  const pack = objects.size === 0 ? emptyPack() : writePack(objects);
  const packLines: Buffer[] = [pktLine('packfile\n'), ...sidebandPackets(pack), FLUSH];
  sections.push(Buffer.concat(packLines));
  return Buffer.concat(sections);
}

/* ---------------------------------------------------------- v0 fetch */

/** Parse a v0 fetch request body: want/have lines, an optional deepen, then done.
 *  The first want line carries capabilities after a space (`want <oid> side-band-64k ...`). */
export function parseV0Fetch(body: Buffer): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  for (const packet of parseAllPktLines(body)) {
    const line = packet.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(firstToken(line.slice(5)));
    else if (line.startsWith('have ')) haves.push(firstToken(line.slice(5)));
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = Math.floor(n);
    }
  }
  return { wants, haves, depth };
}

/** Handle a v0 fetch request: NAK/ACK lines, shallow lines, then the sideband pack. */
export function handleV0Fetch(store: Store, repo: Repo, body: Buffer): Buffer {
  const { wants, haves, depth } = parseV0Fetch(body);
  const out: Buffer[] = [];
  const ack = haves.length > 0 ? findAck(store, repo, wants, haves) : null;
  if (haves.length > 0) {
    out.push(pktLine(ack !== null ? `ACK ${ack}\n` : 'NAK\n'));
  }
  const { objects, shallow, unshallow } = store.fetchObjects(repo, wants, haves, depth);
  for (const oid of shallow) out.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
  const pack = objects.size === 0 ? emptyPack() : writePack(objects);
  out.push(...sidebandPackets(pack));
  out.push(FLUSH);
  return Buffer.concat(out);
}

/* ---------------------------------------------------------- receive-pack */

/** Parse a receive-pack request: command lines until the flush, then the raw pack. */
export function parseReceivePack(body: Buffer): { commands: { oldOid: string; newOid: string; ref: string }[]; pack: Buffer } {
  const { lines, rest } = parsePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const line of lines) {
    if (line === null) break;
    const text = line.toString('utf8');
    const nul = text.indexOf('\0');
    const command = nul >= 0 ? text.slice(0, nul) : text;
    const parts = command.trim().split(/\s+/);
    if (parts.length === 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  return { commands, pack: rest };
}

/**
 * Handle a receive-pack push. Returns the report-status reply inside sideband
 * band 1. Refused refs still report `unpack ok`; a mixed push applies only the
 * refs that pass.
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { commands, pack } = parseReceivePack(body);
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let unpackError: string | null = null;

  // A delete-only command list carries no pack at all (real git sends none);
  // that is a successful unpack with no objects, not an error.
  let incoming: Map<string, import('./git.ts').GitObject> | null = new Map();
  if (pack.length > 0) {
    try {
      incoming = parsePack(pack, repo.objects).objects;
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
      incoming = null;
    }
  }

  if (unpackError === null && incoming !== null) {
    store.addObjects(repo, incoming);
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'old ref value does not match' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Create or update: the new tip must exist (in the pack or already stored).
      if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing objects' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'ref already exists' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        continue;
      }
      if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old ref value does not match' });
        continue;
      }
      if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  } else {
    for (const command of commands) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack error' });
    }
  }

  const lines: Buffer[] = [];
  lines.push(pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`));
  for (const result of results) {
    lines.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  lines.push(FLUSH);
  const payload = Buffer.concat(lines);
  const frame = Buffer.alloc(payload.length + 1);
  frame[0] = 1;
  payload.copy(frame, 1);
  return Buffer.concat([pktLine(frame), FLUSH]);
}

/** Parse a commit's message (first line) for the commits list. */
export function commitMessage(store: Store, repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return '';
  return parseCommit(obj.data).message;
}
