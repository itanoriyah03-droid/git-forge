# Git Forge — a standalone GitHub-compatible forge

One Node 22 process, standard library only (no installs, no git binary, no network
at runtime). It speaks the four surfaces the bounty grades:

- **Git smart HTTP** at `/{owner}/{repo}.git` — `info/refs` advertisements
  (upload-pack v2 with a v0 fallback, receive-pack v0), upload-pack v2 `ls-refs`
  and `fetch` (shallow/deepen, thin packs), receive-pack v0 with per-ref
  report-status and fast-forward enforcement. Pack reading resolves OFS/REF
  deltas; pack writing emits plain objects, version 2, SHA-1 trailer.
- **REST v3** at `/api/v3` — repositories, branches, commits, contents (create /
  update / delete with blob-sha guards), labels, issues, comments, pull requests
  with squash merge and three-way conflict detection. Every reply is JSON with a
  non-empty `X-GitHub-Request-Id`; unknown routes are JSON 404s, malformed JSON
  bodies are 400s, missing tokens are 401s, a foreign owner is 404.
- **GraphQL v4** at `/api/graphql` — `viewer`, `repository`, `node(id:)`,
  `__type` introspection, issue/pull-request connections with cursor pagination,
  and the `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations. Batched arrays answer in order; an unknown field is a
  200 with an `errors` array.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP, modern era `2026-07-28`
  (`server/discover`) with the legacy `initialize` path kept. Seven tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, `close_issue` — all acting on the
  same store as REST and GraphQL.

## Determinism

The trial is replayed and both runs must leave a byte-identical state export.
Nothing in this entry reads the wall clock or any randomness: every timestamp
comes from a logical clock (`MAKEFUN_TRIAL_NOW` plus a monotonic counter), all
ordering is explicit (insertion order of Maps and arrays), and pack bytes are
written in oid order.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind port 0, register, poll `/done`,
  exit 0); without `MAKEFUN_ENV_URL` it serves locally on `PORT` (default 18080).
- `app.ts` — the HTTP server and router.
- `lib/util.ts` — hashing, base64, the logical clock, request ids.
- `lib/git.ts` — loose objects, pkt-line framing, pack reading/writing, deltas.
- `lib/git-http.ts` — the smart-HTTP handlers (advertisements, ls-refs, fetch,
  receive-pack).
- `lib/store.ts` — the in-memory store: repos, objects, refs, issues, pulls,
  merges, reachability, shallow/deepen fetch planning.
- `lib/rest.ts` — REST v3.
- `lib/graphql.ts` — the GraphQL parser and executor.
- `lib/mcp.ts` — the MCP endpoint and tools.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

Local conformance (the kit's own suite, pointed at the local server):

```sh
node --experimental-strip-types ~/workspace/makefun/git-forge-kit/github-core-clone-01-kit/sdk/run.ts \
  --url http://127.0.0.1:18080 --token <token> --perf
```

## make.fun

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/itanoriyah03-droid/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/itanoriyah03-droid/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)
