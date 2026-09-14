# AGENTS.md — mcp-ragdown

mcp-ragdown is an MCP server over a folder of Markdown files. It chunks the
files by heading, embeds the chunks into a local LanceDB index (bge-small on ONNX Runtime by
default), keeps that index in sync with the folder, and serves hybrid search. The Markdown files
are the source of truth; the index is derived and disposable. Agents and hooks reach it only through
MCP tools (`ragdown_context` is the one a hook calls); the `/api` routes serve the web UI alone.

Read [`README.md`](README.md) first — it holds the design decisions this file only summarises.

## Commands

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # biome check .
npm run format           # biome check --write .
npm test                 # vitest run — real LanceDB, hash embedder, no model download
npm run build            # web UI into web/dist; npm run dev:web for Vite with an /api proxy
npm start                # stdio MCP server (needs RAGDOWN_DOCS_DIR)
node src/cli.ts serve    # HTTP (needs RAGDOWN_TOKEN or SECURE_LOCAL_NET=true)
docker build -t mcp-ragdown .
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck and tests, and boots the image. Release
(`release.yml`) runs semantic-release on main and pushes an amd64 image to GHCR and Docker Hub;
the Docker Hub credentials are organisation secrets, never files in this repo.

Run typecheck (server and web), lint and test before every commit.

## Layout

- `src/cli.ts`: `stdio` and `serve`.
- `src/config.ts`: the only reader of `process.env`.
- `src/chunk.ts`: Markdown to heading-scoped chunks. Bump `CHUNKER_VERSION` whenever chunk
  boundaries or `embeddingText` change; existing indexes then rebuild themselves.
- `src/embedder.ts`: `bge-small`, `openai:<model>` and `hash`. An embedder's `name` is recorded in
  the index, so changing what a name produces means changing the name.
- `src/store.ts`: the LanceDB table, the meta file, and hybrid search (dense + FTS, RRF).
- `src/indexer.ts`: diff sync, the single-flight sync queue, and the watcher.
- `src/primary.ts`: the unix-socket lock and request protocol (newline-delimited JSON).
- `src/engine.ts`: `Ragdown`. Primary/reader roles, recall, per-session hook context, notes.
- `src/server.ts`: MCP tools, including `ragdown_context` for hooks.
- `src/http.ts`: `serve` — `/mcp`, and `/api/status`, `/api/docs`, `/api/doc` for the UI, with
  bearer auth, and the built web UI for every other `GET`.
- `web/`: the web UI (React, TanStack Query/Router, Tailwind, cubeui/shadcn). Its own tsconfig;
  `components/ui` and the cubeui shells are registry-generated, so prefer re-adding to hand edits.
- `Dockerfile`: model baked in, unused native binaries pruned. `serve` is the entrypoint.

## Conventions

- ESM with `.ts` import extensions, run by Node's type stripping: no enums, no parameter
  properties, no namespaces (`erasableSyntaxOnly`).
- A tool failure is an `isError` result, never a thrown transport error.
- Log to stderr only, prefixed `[ragdown]`, `[indexer]` or `[store]`. On `stdio`, stdout is the
  protocol.
- No hook commands or hook-only HTTP routes: anything a hook needs is an MCP tool.
- `ragdown_context` returns empty text, never an error, when there is nothing to add.
- Tests use real implementations in temp dirs (`src/testing.ts`), not mocks.
- Conventional Commits. Never rebase.
