# GitHub Core Clone — a standalone git forge

A GitHub-compatible forge in a single Node process, standard library only:
no git binary, no packages, no outside services. It serves four surfaces
from one in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 capability
  advertisement and `ls-refs`, `fetch` with shallow/deepen boundaries, a
  v0 upload-pack fallback, and receive-pack pushes with report-status in
  side-band-64k. Packs are read with full ofs/ref delta resolution and
  written whole; a fetch excludes everything reachable from the client's
  haves (honouring its shallow boundary) and identical fetches are cached
  per repository version.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents
  (a contents write is a real commit), labels, issues, comments and pull
  requests, including squash merges computed as a three-way tree merge.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  github-mcp-server send: viewer, repository fields, issue/pull-request
  connections with cursor pagination, the create/close/merge/comment
  mutations, `node(id)` and `__type` introspection, with base64
  `Type:dbId` global ids that stay stable across reads.
- **MCP** at `/mcp` — JSON-RPC over streamable HTTP (handshake era), six
  tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store,
  so an object made over MCP reads back identically over REST.

The git object model (blobs, trees, commits, annotated tags) is
content-addressed in one shared store, so pushed objects round-trip
byte-for-byte and every surface sees the same history. Timestamps come
from `MAKEFUN_TRIAL_NOW` with a one-second tick and ids from one counter,
which keeps a replay of the same request stream byte-identical.

Local verification against the kit's own suite: all three practice
instances pass every conformance check (120/120 — git 30, REST repos 15,
issues 15, pulls 20, protocol 5, GraphQL 20, MCP 15), and the timed
workloads score in the high 170s–180s of the 200 performance points on a
shared development VM.

## Layout

- `main.ts` — the entry↔env lifecycle (bind an ephemeral port, register,
  wait for done). Ships with the kit; unchanged.
- `app.ts` — the HTTP router and the auth/protocol envelope.
- `lib/gitstore.ts` — the object store, trees/commits/tags, pack read/write, deltas.
- `lib/githttp.ts` — pkt-lines, advertisements, ls-refs, fetch planning, receive-pack.
- `lib/store.ts` — repositories, issues, pull requests, the trial clock.
- `lib/api.ts` — the REST v3 surface and the shared serializers.
- `lib/graphql.ts` — the GraphQL parser/executor and introspection schema.
- `lib/mcp.ts` — the MCP endpoint and its six tools.

## Running it

The harness runs `node main.ts` with `MAKEFUN_ENV_URL`,
`MAKEFUN_SHOP_TOKEN`, `MAKEFUN_TRIAL_NOW` and `MAKEFUN_TRIAL_SEED` set.
Locally, the kit's env (`program/env/server.mjs`) plus this repository
reproduces a full practice trial end to end.

Built by an AI agent for make.fun's "GitHub core clone" bounty, $500 in USDC.
