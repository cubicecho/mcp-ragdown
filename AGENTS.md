# AGENTS.md — mcp-ragdown

mcp-ragdown is an MCP server over folders of Markdown files. It chunks the
files by heading, embeds the chunks into a local LanceDB index (granite-small on ONNX Runtime by
default), keeps that index in sync with the files, and serves hybrid search. Under `serve`, each
top-level directory is a folder with its own `/mcp/<folder>` server, human-only until its
`.ragdown.json` says `"mcp": true`; `stdio` serves the docs dir as one folder. The Markdown files
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
- `src/config.ts`: the only reader of `process.env`. `mode` is `folders` (`serve`) or `single` (`stdio`).
- `src/folders.ts`: discovering folders and reading, creating, renaming and deleting them and their
  `.ragdown.json` settings.
- `src/chunk.ts`: Markdown to heading-scoped chunks. Bump `CHUNKER_VERSION` whenever chunk
  boundaries or `embeddingText` change; existing indexes then rebuild themselves.
- `src/embedder.ts`: `granite-small`, `bge-small`, `embeddinggemma`, `openai:<model>` and `hash`. An embedder's `name` is recorded in
  the index, so changing what a name produces means changing the name.
- `src/store.ts`: the LanceDB table, the meta file, and hybrid search (dense + FTS, RRF). Bump
  `INDEX_VERSION` when the columns change. Tags and aliases have their own columns: never add them
  (or titles) to `embeddingText`.
- `src/indexer.ts`: diff sync, the single-flight sync queue, and the watcher.
- `src/primary.ts`: the unix-socket lock and request protocol (newline-delimited JSON).
- `src/engine.ts`: `Ragdown`. Primary/reader roles, the store, syncs, the session memory.
- `src/links.ts`: Obsidian wikilink parsing and resolution within one folder.
- `src/scope.ts`: `Scope`, the notes as one endpoint sees them (a folder, or a subfolder of one):
  recall, hook context, reading and writing notes, stats. Paths in and out are scope-relative.
- `src/server.ts`: MCP tools, including `ragdown_context` for hooks.
- `src/http.ts`: `serve` — `/mcp/<folder>[/<sub...>]`, and `/api/status`, `/api/folders`, `/api/docs`,
  `/api/doc`, `/api/search`, `/api/resolve`, `/api/file` for the UI, with
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
