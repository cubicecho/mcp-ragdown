# Project Todos

Findings from the refactor workflow. IDs are stable — don't renumber when items are removed.
`(unverified)` marks items inferred from docs or naming rather than confirmed in code.
Nothing here is implemented until approved.

Scope: `src/` only. The web UI (`web/`) is out of scope by decision at Gate 1.

## Conventions

The canonical way this codebase does things. New code and refactors follow these.

- A Markdown file is a **document** in code. "File" is anything on disk, attachments included.
- Missing lookups and failures: throw, with a status the HTTP face answers with; the MCP face
  turns the same throw into an `isError` result (AGENTS.md).
- Events/signals: none; the watcher calls the indexer's sync queue directly.
- Shared helpers live in: `src/shared/`. Tunable numbers live in `src/shared/defaults.ts`.
- Test helpers live in: `src/shared/testing.ts`. Tests use real LanceDB in temp dirs, never mocks.
- Generated files and the command that rebuilds them: `web/dist` → `npm run build`;
  `site/_site` → the site build; `web/src/components/ui` and the cubeui shells → re-add from the
  registry.
- ESM with `.ts` import extensions, no enums, no parameter properties, no namespaces.
- Public surface, never changed by an `R` item: MCP tool names and arguments, `/api` routes and
  their JSON keys, `.ragdown.json` and `.ragdown-server.json` keys, environment variables,
  embedder names, `INDEX_VERSION`, `CHUNKER_VERSION`, the `src/cli.ts` entry path.

## Refactoring

### R11 [sweep] — apply P20 (`=== false` for logic checks) across `src/`

**Hits:** about 125 leading `!` by grep; null guards are not hits and are not yet separated
out, so the real count is lower. Each logic check gets a positively named const.

## Features

None filed.

---

## Tests

### T2 [readability] — `store.test.ts` reaches a private field through `as any`

**File:** `src/indexing/store.test.ts`. `(store as any).table` goes on compiling if the field is
renamed. Ask: assert through `store.search` instead, or keep it with a comment saying why.

---

## Docs

## Bugs

### B1 — A move does not rewrite `supersedes` paths (intended for now, by decision at Gate 2)

**File:** `src/documents/move.ts`. A move rewrites wikilinks and Markdown links, but a
`supersedes:` front-matter path pointing at the moved document, or written in it, is left
as it was, so the document it hid reappears in search. Intended?

## API changes (need a decision)

### A3 — "note" remains where changing it changes an interface or is out of scope

**File:** `src/shared/config.ts`. `RAGDOWN_NOTES_DIR` and its `notes` default are the last of
it: everything else says "document". Renaming the variable or the default directory is breaking
for anyone who set one or has documents in the other. The site's screenshots also still show the
dialog as "New note".

### A4 — `DELETE /api/doc` takes no `base_hash`

**File:** `src/serving/api-documents.ts`. `ragdown_delete` now refuses a document that changed
since it was read (A1); the route the web UI calls still deletes whatever is there. Passing the
hash needs a web change, which was out of scope.

## Low value

### R15 [readability] — Rename `rag` where it holds a `Scope`

**File:** `src/serving/mcp-tools.ts` `(unverified count)`. `rag` names a `Ragdown` in `engine.ts` and a
`Scope` in the tool handlers.

### R16 [simplify] — `applyChanges` repeats one null-or-undefined step three times

**File:** `src/shared/server-settings.ts` (`applyChanges`).

### R17 [sweep] — apply P1 (name conditions) across `src/`

**Hits:** not counted. Many overlap R11's sites, so most value arrives with that item.
