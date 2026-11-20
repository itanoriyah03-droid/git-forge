// The HTTP server: one process, the standard library only. It routes by path:
//   GET  /healthz                  the env's boot probe
//   /api/v3/*                      REST v3
//   POST /api/graphql              GraphQL v4
//   /mcp                           MCP (JSON-RPC 2.0)
//   /{owner}/{repo}.git/*          git smart HTTP (upload-pack v2/v0, receive-pack v0)
// Anything else is a JSON 404, never HTML. A request that throws is answered 500
// and never takes the process down: a crash scores 0, so the handler is the last
// line of defence.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './lib/store.ts';
import { RestHandler, type RestRequest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { McpHandler } from './lib/mcp.ts';
import {
  uploadPackAdvertisementV2,
  uploadPackAdvertisementV0,
  receivePackAdvertisement,
  handleLsRefs,
  handleV2Fetch,
  handleV0Fetch,
  handleReceivePack,
} from './lib/git-http.ts';
import { parsePktLines } from './lib/git.ts';
import { RequestIds, splitPath } from './lib/util.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function lowerHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Read the request body, up to MAX_BODY_BYTES, with a 30 s cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (body: Buffer): void => {
      if (done) return;
      done = true;
      resolve(body);
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks)), 30_000);
    timer.unref?.();
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        finish(Buffer.concat(chunks));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks));
    });
    req.on('error', () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks));
    });
  });
}

export function createApp(): Server {
  const store = new Store();
  const requestIds = new RequestIds();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const rest = new RestHandler(store, { token, requestIds });
  const mcp = new McpHandler(store, token);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handle(req, res, store, rest, mcp, token, requestIds);
      } catch (err) {
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, { 'x-github-request-id': requestIds.next() });
        else res.destroy();
      }
    })();
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  rest: RestHandler,
  mcp: McpHandler,
  token: string,
  requestIds: RequestIds,
): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const query = queryOf(req);
  const headers = lowerHeaders(req);
  const host = headers.host ?? '127.0.0.1';
  const baseUrl = `http://${host}`;

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const segments = splitPath(path);

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    const body = await readBody(req);
    const request: RestRequest = { method, segments: segments.slice(2), query, body, headers, baseUrl };
    const result = rest.handle(request);
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { errors: [{ message: 'Method not allowed' }] }, { 'x-github-request-id': requestIds.next() });
      return;
    }
    const authorization = headers.authorization ?? '';
    if (token !== '' && authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { errors: [{ message: 'Requires authentication' }] }, { 'x-github-request-id': requestIds.next() });
      return;
    }
    const body = await readBody(req);
    const result = handleGraphQL(store, body);
    sendJson(res, result.status, result.body, { 'x-github-request-id': requestIds.next() });
    return;
  }

  // MCP.
  if (path === '/mcp') {
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const result = mcp.handle(method, body, headers);
    if (result.status === 204 || result.body === null) {
      res.writeHead(result.status, result.headers);
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, { ...result.headers, 'x-github-request-id': requestIds.next() });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    const restPath = segments.slice(2);
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const gitProtocol = (headers['git-protocol'] ?? '').toLowerCase();

    if (method === 'GET' && restPath.length === 2 && restPath[0] === 'info' && restPath[1] === 'refs') {
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        if (gitProtocol === 'version=2') {
          sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', uploadPackAdvertisementV2());
        } else {
          sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', uploadPackAdvertisementV0(repo));
        }
        return;
      }
      if (service === 'git-receive-pack') {
        sendBytes(res, 200, 'application/x-git-receive-pack-advertisement', receivePackAdvertisement(repo));
        return;
      }
      sendJson(res, 400, { message: 'Missing service parameter' });
      return;
    }

    if (method === 'POST' && restPath.length === 1 && restPath[0] === 'git-upload-pack') {
      const body = await readBody(req);
      if (gitProtocol === 'version=2') {
        const { lines } = parsePktLines(body);
        const first = lines[0]?.toString('utf8') ?? '';
        if (first.includes('command=ls-refs')) {
          sendBytes(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, body));
        } else if (first.includes('command=fetch')) {
          sendBytes(res, 200, 'application/x-git-upload-pack-result', handleV2Fetch(store, repo, body));
        } else {
          sendJson(res, 400, { message: 'Unknown upload-pack command' });
        }
        return;
      }
      sendBytes(res, 200, 'application/x-git-upload-pack-result', handleV0Fetch(store, repo, body));
      return;
    }

    if (method === 'POST' && restPath.length === 1 && restPath[0] === 'git-receive-pack') {
      const body = await readBody(req);
      sendBytes(res, 200, 'application/x-git-receive-pack-result', handleReceivePack(store, repo, body));
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': requestIds.next() });
}
