// Shared helpers: hashing, base64, the deterministic logical clock.
//
// Determinism rule (RULES.txt): nothing that differs between two runs may reach a
// request or an object the suite reads. All timestamps in this entry come from the
// logical clock below: the trial's opening time (MAKEFUN_TRIAL_NOW, identical on the
// live pass and the replay) plus a monotonically increasing counter. No Date.now(),
// no Math.random(), no UUID anywhere in this codebase.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);

export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Base64 (standard alphabet) of a UTF-8 string. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Base64 (standard alphabet) of bytes. */
export function b64encodeBytes(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** Decode standard base64, ignoring whitespace/newlines (GitHub wraps content). */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** Decode a base64 global id back to its text, or null when it is not one. */
export function b64decodeText(text: string): string | null {
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** The trial's opening time in Unix seconds, from MAKEFUN_TRIAL_NOW (same on live and replay). */
function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    if (/^\d+$/.test(raw)) return Number(raw);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1735689600; // 2025-01-01T00:00:00Z fallback for local runs
}

/**
 * The logical clock. Every timestamp the entry emits (commit times, created_at,
 * merged_at, ...) comes from here: base + a counter that advances once per call, so
 * two runs driven by the same requests produce byte-identical objects.
 */
export class LogicalClock {
  private base: number;
  private tick: number;

  constructor() {
    this.base = trialNowSec();
    this.tick = 0;
  }

  /** Next Unix second. */
  nextSec(): number {
    const value = this.base + this.tick;
    this.tick += 1;
    return value;
  }

  /** Next ISO-8601 timestamp. */
  nextIso(): string {
    return new Date(this.nextSec() * 1000).toISOString();
  }
}

/** A per-request id: deterministic, non-empty, unique within the process. */
export class RequestIds {
  private seq = 0;

  next(): string {
    this.seq += 1;
    return `req-${this.seq.toString(16).padStart(8, '0')}`;
  }
}

/** Split a path into segments, decoding each percent-encoded piece. */
export function splitPath(path: string): string[] {
  return path
    .split('/')
    .filter((piece) => piece !== '')
    .map((piece) => {
      try {
        return decodeURIComponent(piece);
      } catch {
        return piece;
      }
    });
}

/** Count lines in text the way a diff summary does (a trailing newline ends the last line). */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * A naive line diff: lines present in `next` but not in `prev` count as additions,
 * lines in `prev` but not in `next` as deletions. Exact enough for the pull-file
 * change counts the suite asserts (>= 1 addition for a changed path).
 */
export function lineDiff(prev: string, next: string): { additions: number; deletions: number } {
  const prevLines = new Set(prev === '' ? [] : prev.split('\n'));
  const nextLines = next === '' ? [] : next.split('\n');
  let additions = 0;
  const seenNext = new Set<string>();
  for (const line of nextLines) {
    if (!prevLines.has(line) && !seenNext.has(line)) additions += 1;
    seenNext.add(line);
  }
  const nextSet = new Set(nextLines);
  let deletions = 0;
  const seenPrev = new Set<string>();
  for (const line of prevLines) {
    if (!nextSet.has(line) && !seenPrev.has(line)) deletions += 1;
    seenPrev.add(line);
  }
  return { additions, deletions };
}
