# mcp-ragdown

**Website:** [cubicecho.github.io/mcp-ragdown](https://cubicecho.github.io/mcp-ragdown/): an
overview, a walkthrough and a condensed reference.

An MCP server over folders of Markdown files. Point it at a directory and it embeds every section
into a local LanceDB index and keeps that index in sync as files change. Each top-level folder is
its own MCP server, off until you turn it on, and each one opens as an Obsidian vault. Agents get
search tools, and a hook that calls `ragdown_context` before each turn adds related notes to the
prompt. The tool layout follows mcp-zeromem, but the memory here is your Markdown files, not
conversation turns.

Everything an agent or a hook does goes through MCP. There is no hook command and no hook HTTP
route; the only other routes feed the web UI.

Everything runs locally: the default embedder is `granite-embedding-small-english-r2` on ONNX
Runtime. The Docker image has the model baked in; outside Docker it is downloaded once (about
50 MB) on first start. Two others are a setting away — see
[Choosing an embedder](#choosing-an-embedder).

## Quick start

`docker-compose.yml`:

```yaml
services:
  ragdown:
    image: vantreeseba/mcp-ragdown:latest
    ports:
      - '3300:3000'
    volumes:
      - ~/notes:/docs          # one folder per directory in here; add :ro and RAGDOWN_READ_ONLY=true to forbid writes
      - ragdown-data:/data     # the index, so restarts only diff
    environment:
      RAGDOWN_TOKEN: ${RAGDOWN_TOKEN}
    restart: unless-stopped

volumes:
  ragdown-data:
```

```bash
export RAGDOWN_TOKEN=$(openssl rand -hex 32)   # keep it; clients need it too
docker compose up -d
curl localhost:3300/api/status                  # "ready": true, and the file and chunk counts
```

`~/notes/work` is now the folder `work`. It starts human-only: open http://localhost:3300, turn
MCP on for it under **Settings → Folders** (or put `{ "mcp": true }` in `~/notes/work/.ragdown.json`),
and **Copy MCP config** there gives you this line:

```bash
claude mcp add --transport http ragdown-work http://localhost:3300/mcp/work \
  --header "Authorization: Bearer $RAGDOWN_TOKEN"
```

The first index of a large folder takes minutes; searches answer from what is indexed so far. The
web UI lists each folder's files, renders them with their wikilinks and images, and searches them.
To add notes to every turn automatically, see [Hooks in min-agent](#hooks-in-min-agent). Images
are published for `linux/amd64` to Docker Hub and `ghcr.io/cubicecho/mcp-ragdown`.

### Without Docker

```bash
npm install
RAGDOWN_DOCS_DIR=~/notes node src/cli.ts stdio                        # what an MCP client launches
RAGDOWN_DOCS_DIR=~/notes SECURE_LOCAL_NET=true node src/cli.ts serve  # HTTP and the web UI on :3000
```

Requires Node 26+, which runs the TypeScript directly.

## Claude Code setup

Against the container, the `claude mcp add --transport http` line above. As a local process:

```bash
claude mcp add ragdown -e RAGDOWN_DOCS_DIR=$HOME/notes/work -- node /path/to/mcp-ragdown/src/cli.ts stdio
```

`stdio` serves one folder: `RAGDOWN_DOCS_DIR` itself, whatever its `.ragdown.json` says (you chose
it by launching it). Point it at an Obsidian vault and the whole vault is the folder.

Claude calls `ragdown_recall` and `ragdown_read_doc` itself when the notes might help; the server's
instructions tell it to. There is no hook command to wire into Claude Code: automatic per-prompt
context needs a client whose hooks call MCP tools, such as min-agent.

## Folders

`serve` treats every top-level directory of `RAGDOWN_DOCS_DIR` as a **folder**, found as it
appears; the directories inside one are **subfolders**. All folders share one index, one model and
one watcher, but each is its own MCP server at `/mcp/<folder>`, named `ragdown-<folder>`, and sees
only its own notes: paths in and out are relative to it (`backups.md`, not `work/backups.md`), and
`ragdown_read_doc` refuses one that leaves it.

A folder's settings live in `.ragdown.json` at its root, and the web UI edits them:

```json
{ "title": "Work notes", "mcp": true }
```

- `title` is shown in the web UI and the server's instructions; it defaults to the directory name.
- `mcp` defaults to **false**. A folder is **human-only** until someone turns it on: indexed and
  searchable in the web UI, but no endpoint, no recall hits and no hook context. `/mcp/<folder>`
  answers a human-only folder with the same 404 as a missing one.

There is no endpoint over every folder: bare `/mcp` is a 404 that says to pick one. Markdown loose
in `RAGDOWN_DOCS_DIR`, outside every folder, is not indexed; the log and the web UI list it.

The web UI creates, renames and deletes folders, and **Copy MCP config** on each one gives the
`claude mcp add` line and the JSON `mcpServers` entry for it. Under `RAGDOWN_READ_ONLY` a folder's
title and MCP switch can still change — they are settings, not notes — but creating, renaming and
deleting cannot.

**New note** (the **+** beside Upload in a folder's list, or the button in an empty folder) asks
for a title and an optional subfolder, created if missing. It starts beside the open note, writes
`# <title>` to `<subfolder>/<title>.md`, and opens it in the editor. A name that is already taken
offers to open that note instead.

**Edit** on an open note swaps the preview for a Markdown source editor (CodeMirror, loaded on
first use), with a Write/Preview switch and Ctrl/Cmd+S to save. It edits the source, not rich
text, so wikilinks, embeds and front matter come back exactly as written. A save is made against
the version that was opened: if the file changed on disk meanwhile — in Obsidian, by an agent, by
`git pull` — the editor says so and asks whether to save over it or discard the edit, rather than
quietly losing either. Leaving with unsaved changes asks first.

A folder keeps an agent focused, not out: one token opens every folder with MCP on.

### Subfolders

`/mcp/<folder>/<subfolder...>` narrows a folder's server to a subfolder, following the folder's MCP
setting:

```bash
claude mcp add --transport http work-alpha http://localhost:3300/mcp/work/projects/alpha \
  --header "Authorization: Bearer $RAGDOWN_TOKEN"
```

- `ragdown_recall` and `ragdown_context` search only files under it, and `path_prefix` narrows
  further inside it. Paths are relative to the subfolder.
- `ragdown_remember` writes into the subfolder itself; on a folder's own endpoint it writes into
  `<folder>/<RAGDOWN_NOTES_DIR>`.
- `ragdown_stats` counts the subfolder's files and chunks, and `ragdown_context`'s per-session
  memory is kept separately for each endpoint.
- `ragdown_reindex` still syncs everything.

A missing subfolder, a file, a symlink or a dot-folder is a 404.

### Obsidian

Open a folder as an Obsidian vault and both see the same notes:

- `.obsidian/`, `.trash/` and every other dot-folder are skipped, as is `.ragdown.json`.
- **Tags** from frontmatter (`tags: [a, b]` or `tags: a, b`) and inline `#tags` in the text (not in
  code) are indexed per note. `ragdown_recall`'s `tag` filter matches a tag and the tags nested
  under it: `project` finds `#project/alpha`. Every hit lists its note's tags.
- **Aliases** from frontmatter are found by keyword search and by wikilinks.
- **Wikilinks.** `ragdown_read_doc` takes a link target as well as a path — `Note`, `Note#Heading`,
  `sub/Note`, an alias — and resolves it the way Obsidian does, within the folder: an exact path,
  then a note whose name matches (the one beside the linking note, then the shortest path), then an
  alias. A heading narrows the text to that section. The web UI follows `[[links]]`, shows
  `![[embeds]]` and images, lists the notes that link to the open one, completes `[[` in the editor
  with the folder's notes, and rewrites the links to a note when it is renamed or moved.

Tags and aliases get their own columns; they are not added to the text that is embedded, which was
measured and made retrieval worse.

## Hooks in min-agent

A min-agent hook calls a tool on a connected MCP server,
so ragdown needs nothing beyond its MCP endpoint. Add a server under **Settings → MCP**:

```jsonc
{
  "id": "ragdown",
  "label": "Notes",
  "transport": "http",
  "url": "http://localhost:3300/mcp/work",   // a folder with MCP on
  // Stored as-is: min-agent does not expand env vars. Leave empty with SECURE_LOCAL_NET=true.
  "headers": { "Authorization": "Bearer <RAGDOWN_TOKEN>" },
  // The model has ragdown_recall; the context tool is for the hook only.
  "hiddenTools": ["ragdown_context"],
  "hooks": [
    { "id": "notes", "on": "beforeTurn", "tool": "ragdown_context", "inject": true, "maxTokens": 800,
      "args": { "prompt": "{{prompt}}", "session_id": "min-agent:{{session.id}}", "max_chars": 3000 } }
  ]
}
```

Before each turn the hook sends the user's message. `ragdown_context` answers with the sections
whose cosine similarity reaches `RAGDOWN_HOOK_MIN_SCORE`, wrapped in `<ragdown-context>`, or with
empty text, which min-agent treats as nothing to add. It skips:

- prompts under 12 characters and slash commands;
- sections it already returned for the same `session_id`, so a long chat pays for each note once.

`max_chars` of 3,000 keeps the block near min-agent's 800-token cap, so a section is not cut in the
middle. A hook that fails or takes longer than min-agent's 3 seconds only loses that turn's notes.

## Tools

| Tool | What it does |
| --- | --- |
| `ragdown_context` | For hooks: the sections related to a `prompt` as a `<ragdown-context>` block, or empty text. Filters by similarity, skips short prompts and slash commands, and never repeats a section for the same `session_id`. Takes `top_k`, `min_score`, `min_ratio` and `max_chars` to override the `RAGDOWN_HOOK_*` defaults. |
| `ragdown_recall` | Hybrid search. Returns path, line range, heading breadcrumb, tags and similarity for each hit. Takes `top_k`, `path_prefix`, `tag`, `format: text\|json` and `max_chars`. |
| `ragdown_read_doc` | Reads a file, or a line range of one, straight from disk. Never clipped. Also takes a wikilink target (`Note#Heading`); see [Obsidian](#obsidian). Returns the whole file's `hash`, for `ragdown_edit`, and `superseded_by` when another note replaces it. |
| `ragdown_backlinks` | The notes that link to a `path` — by wikilink, alias or relative Markdown link — with the lines the links are on. Links in code are not links. |
| `ragdown_list` | Browses rather than searches: each note's path, title, tags, last change, and `superseded_by` if it has been replaced. Takes `path_prefix`, `tag`, `sort: path\|recent` and `limit`. |
| `ragdown_stats` | Folder, index size, embedder, role (primary or reader), whether a sync is running, and the last sync. |
| `ragdown_remember` | Writes a new note (with frontmatter) under `RAGDOWN_NOTES_DIR` and indexes it before returning. Never overwrites a file. `supersedes` lists the notes this one replaces, which search then skips; `session_id` is recorded as provenance. |
| `ragdown_edit` | Changes a note at a `path`, or creates one. `text` replaces the whole file, which for an existing note needs `base_hash` — the `hash` `ragdown_read_doc` gave — so an agent never overwrites a version it has not read. `append: true` adds `text` at the end instead, or with `heading` at the end of that section. A file that changed since `base_hash` is not written. |
| `ragdown_reindex` | Syncs now; `full: true` re-embeds everything. |

The write tools (`ragdown_remember`, `ragdown_edit`, `ragdown_reindex`) are not listed when
`RAGDOWN_READ_ONLY=true`.

## Configuration

Only `RAGDOWN_DOCS_DIR` is required. See [`.env.example`](.env.example).

| Variable | Default | |
| --- | --- | --- |
| `RAGDOWN_DOCS_DIR` | — | For `serve`, the directory holding the folders; for `stdio`, the one folder. Walked recursively. Dot-folders and `node_modules` are skipped, and symlinks are not followed. Indexes `.md`, `.markdown` and `.mdx`. |
| `RAGDOWN_DATA_DIR` | `~/.cache/ragdown/<hash of docs dir>` | The index. Deleting it only costs a rebuild. `serve` and `stdio` on the same directory keep separate ones. |
| `RAGDOWN_MODELS` | `~/.cache/ragdown/models` | Model cache, shared by every folder. |
| `RAGDOWN_EMBEDDER` | `granite-small` | A local model — `granite-small`, `bge-small` or `embeddinggemma` — or `openai:<model>` (any OpenAI-compatible `/embeddings` endpoint, such as Ollama or llama.cpp), or `hash` (tests only). See [Choosing an embedder](#choosing-an-embedder). |
| `RAGDOWN_EMBEDDING_URL` / `_API_KEY` | OpenAI | For `openai:<model>`. |
| `RAGDOWN_THREADS` | half the cores | ONNX Runtime threads for the local model. |
| `RAGDOWN_WATCH` | `true` | Watch the folder; without a watcher, sync on start and on `ragdown_reindex` only. |
| `RAGDOWN_READ_ONLY` | `false` | Hide the write tools, and refuse uploads, deletes and folder changes other than settings. |
| `RAGDOWN_NOTES_DIR` | `notes` | Where `ragdown_remember` writes, relative to each folder (a subfolder endpoint writes into the subfolder). A relative path inside the folder, not a dot-folder. |
| `RAGDOWN_TEXT_LIMIT` | `2000` | Characters per hit in text output. Every cut names the `ragdown_read_doc` call that returns the rest. |
| `RAGDOWN_HOOK_TOP_K` | `4` | `ragdown_context`: most sections per prompt. |
| `RAGDOWN_HOOK_MIN_SCORE` | `0.8` | `ragdown_context`: lowest cosine similarity returned. Calibrated for the default embedder; another one needs another number. |
| `RAGDOWN_HOOK_MIN_RATIO` | `0.95` | `ragdown_context`: lowest share of the best hit's similarity a hit may have and still be injected; `0` disables it. Being a ratio, it carries across embedders as `MIN_SCORE` does not. See [Design](#design). |
| `RAGDOWN_HOOK_MAX_CHARS` | `6000` | `ragdown_context`: most characters per prompt. |
| `PORT` | `3000` | `serve` only. The HTTP port. |
| `RAGDOWN_TOKEN` | — | `serve` only. The bearer token `/mcp/<folder>` and the web UI's `/api` routes require. |
| `SECURE_LOCAL_NET` | `false` | `serve` only. Skip the token on a trusted network. `serve` refuses to start with neither. |

## Commands and HTTP

`node src/cli.ts <command>`: `stdio` (the MCP server a client launches) or `serve` (HTTP, what the
image runs). Searching, indexing and stats are MCP tools, not commands.

`serve` exposes these routes:

| Route | Auth | |
| --- | --- | --- |
| `GET /api/status` | none | Liveness and index stats. `ready: false` while the model loads. `settings` holds the non-secret tuning values (`RAGDOWN_WATCH`, `RAGDOWN_TEXT_LIMIT`, `RAGDOWN_HOOK_*`) for the web UI's Settings page. |
| `/mcp/<folder>[/<subfolder...>]` | bearer | Streamable HTTP MCP, stateless, for a folder with MCP on. 404 otherwise, and for bare `/mcp`. See [Folders](#folders). |
| `GET /api/folders` | bearer | Each folder's `name`, `title`, `mcp`, `mcp_path`, `files` and `chunks`, and `loose_files`: the Markdown outside every folder. |
| `POST /api/folders` | bearer | Create a folder: JSON `{ name, title?, mcp? }`. 201; 409 when it exists, 400 for a bad name. |
| `PATCH /api/folders/<name>` | bearer | JSON `{ title?, mcp?, name? }`: change its settings, or rename it with `name` (which re-indexes it). Unknown keys in `.ragdown.json` are kept. |
| `DELETE /api/folders/<name>?confirm=<name>` | bearer | Delete a folder and everything in it. 400 unless `confirm` repeats the name. |
| `GET /api/docs?folder=` | bearer | The indexed files, of one folder or all: `path`, `folder`, `title`, `tags`, `aliases`, `superseded_by`, `mtime_ms`, `size`, `chunks`. |
| `GET /api/doc?path=` | bearer | One indexed file's text, read from disk, with its tags, aliases and `hash` (SHA-256 of the bytes on disk). 404 for a file the index does not hold. |
| `POST /api/doc` | bearer | Upload a file: JSON `{ path, text, overwrite? }`, body up to 4 MiB. Only `.md`, `.markdown` or `.mdx` inside an existing folder, somewhere the indexer reads (no `..`, dot-folders, `node_modules` or symlinked folders); subfolders are created. 201 when created, 200 when overwritten, 409 for an existing file without `overwrite: true`. An edit sends `base_hash`, the `hash` it was opened at, in place of `overwrite`: 409 with `code: "changed"` if the file has changed or gone since. Saved over a CRLF file, the text keeps CRLF. The answer carries the new `hash`. |
| `DELETE /api/doc?path=` | bearer | Delete a Markdown file. 404 when it is not there. |
| `GET /api/search?folder=&q=&tag=&top_k=` | bearer | Hybrid search in one folder, human-only ones included. `top_k` defaults to 10, at most 50. |
| `GET /api/resolve?from=&link=` | bearer | A wikilink target, resolved from the note `from` within its folder: `{ path, anchor? }` or 404. |
| `POST /api/move` | bearer | `{ from, to }`: rename or move a note within its folder. Every link in the folder that pointed at it — wikilinks and relative Markdown links, its own included — is rewritten to follow it, with the shortest target that still resolves. Answers with the notes it `updated`. |
| `GET /api/backlinks?path=` | bearer | The notes in the same folder that link to `path`, with the linking lines. The UI shows them under the preview. |
| `GET /api/file?path=` | bearer | Any file inside a folder — an image, a PDF — as raw bytes, sandboxed and `nosniff`. Never a dot-path or a symlink out. |
| `GET /*` | none | The web UI from `web/dist`, with `index.html` for any other path. |

Every `path` in `/api` includes the folder: `work/notes/a.md`. Writes answer after the index has
synced, so the next `GET /api/docs` already shows them, and uploads, deletes, and creating,
renaming or deleting a folder are a 403 under `RAGDOWN_READ_ONLY`. They are for the web UI; agents
write with `ragdown_remember` and `ragdown_edit`.

The web UI asks for the token once and keeps it in the browser's local storage. Its static files
hold no notes, so they need none; everything it shows comes from the bearer routes. It is built by
`npm run build` (the image does this) and only `serve` serves it.

## Upgrading from 4.x

5.0 splits the docs directory into folders, and nothing is migrated for you:

1. **Move loose Markdown into a folder.** Files directly in `RAGDOWN_DOCS_DIR` are no longer
   indexed by `serve`; the log and the web UI list them.
2. **Turn MCP on for each folder** agents should reach, under **Settings → Folders** or with
   `"mcp": true` in its `.ragdown.json`. Every folder starts human-only.
3. **Point clients at `/mcp/<folder>`.** `/mcp` no longer serves anything. A 4.x scope URL
   `/mcp/<folder>/<sub>` keeps working once `<folder>` has MCP on.
4. **`RAGDOWN_NOTES_DIR` is relative to each folder**: `notes` now means `<folder>/notes`.

`stdio` is unchanged in use: it serves `RAGDOWN_DOCS_DIR` as one folder. Both modes rebuild their
index once on first start, for the new tag and alias columns.

## Design

**Chunks follow headings.** Every heading starts a section, and the section's breadcrumb
(`Backups › Restore`) is part of what gets embedded. That is how a paragraph that only says "run it
twice" is found by a question about restoring backups. A section longer than 1,500 characters
(about 400 tokens, inside the window of every embedder here) is packed paragraph by paragraph. Fenced code blocks are
never split. Line numbers refer to the original file, so a hit is always one `ragdown_read_doc`
call away from its surroundings.

**Hybrid retrieval.** Dense cosine search finds a paragraph that answers the question in different
words. BM25 full-text search finds an exact error string or flag name that an embedding blurs.
Both read the chunk with its breadcrumb in front, so a table of settings is still findable by the
name of the service its heading names and never repeats. Indexing the body alone cost 22 points of
top-1 recall on a benchmark of 210 questions, and left the fused ranking below dense search on its
own. Both return a pool, and reciprocal rank fusion (k = 60) merges them. Ranking uses the fused score.
Filtering uses cosine similarity, because a fused score is not comparable across queries.

**Choosing an embedder.** `RAGDOWN_EMBEDDER` picks one of three local models. They were measured on
the same benchmark — 30 generated runbooks, 210 questions with a known answering section, identical
chunks throughout — so only the model differs. Top-1 is how often the right section ranked first;
the timings are one 8-thread laptop CPU indexing that corpus and embedding one query.

| `RAGDOWN_EMBEDDER` | Model | Dim | Top-1 | Recall@5 | Index | Per query | `MIN_SCORE` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `granite-small` (default) | granite-embedding-small-english-r2 | 384 | 85.7% | 100% | 3.6 s | 9 ms | `0.8` |
| `bge-small` | bge-small-en-v1.5 | 384 | 82.9% | 100% | 3.5 s | 9 ms | `0.7` |
| `embeddinggemma` | embeddinggemma-300m | 768 | 91.0% | 100% | 33 s | 260 ms | `0.6` |

`granite-small` is the default because it costs what `bge-small` costs — same dimensions, same
index, 9 ms a query — and was ahead of it on every measure here, though on 210 questions that gap
alone is not significant (p = 0.41). `embeddinggemma` is a real jump and a significant one
(p < 0.001), but 260 ms is paid on every search, and a hook searches every turn. Being the default
is also why `granite-small` is the model baked into the Docker image; the other two download on
first start. gte-small, snowflake-arctic-embed-s, mxbai-embed-xsmall, bge-base, granite's 149M
model and arctic-embed-m were measured too and beat the default on nothing — bigger was not better.

**Changing the model rebuilds the index, and `RAGDOWN_HOOK_MIN_SCORE` has to move with it.** Cosine
is on each model's own scale, not a shared one. On the same corpus, the weakest on-topic question
and the strongest unrelated prompt ("weather in Paris", "a recipe for carbonara") scored:

| | on-topic (10th percentile) | unrelated (worst case) |
| --- | --- | --- |
| `granite-small` | 0.86 | 0.75 |
| `bge-small` | 0.70 | 0.60 |
| `embeddinggemma` | 0.68 | 0.53 |

The last column of the table above is the value that separates the two for each model. Borrow
another model's number and the hook either injects a pasta recipe into every prompt or drops the
notes that answer the question.

**A second, relative gate under that one.** `RAGDOWN_HOOK_MIN_RATIO` drops a hit scoring less than
0.95 of the best hit for the same prompt, whatever `MIN_SCORE` let through. An absolute floor
answers "is this on topic at all"; the ratio answers "is this as on topic as the thing I already
found", and a chunk far below the best one is a distractor that costs accuracy, not just tokens.
Being a ratio it also survives a change of embedder, which `MIN_SCORE` does not. On the same
benchmark (`granite-small`, `min_score` 0.8, `top_k` 4, 210 questions plus 10 unrelated prompts):

| ratio | recall | chunks/prompt | off-topic chunks |
| --- | --- | --- | --- |
| `1.00` | 84.3% | 1.00 | 0.16 |
| `0.98` | 94.8% | 1.62 | 0.67 |
| `0.96` | 99.0% | 2.67 | 1.68 |
| `0.95` (default) | 99.0% | 3.17 | 2.18 |
| `0` (off) | 99.0% | 3.99 | 3.00 |

Recall is flat from 0.96 down, so the default sits one step below the knee rather than on it: 0.95
keeps everything an ungated hook found while still cutting a fifth of the injected chunks.

**Superseding a note.** A note whose frontmatter lists `supersedes:` hides the notes it names from
search and from hook context. Nothing is deleted or rewritten — the old file stays on disk and
`ragdown_read_doc` still opens it, saying which note replaced it (`superseded_by`), and the web UI
marks it superseded and links to the replacement. But a fact that changed stops coming back as
confident prose next to its replacement.

```markdown
---
title: "Embedder"
date: 2026-09-15
supersedes: ["2025-04-02-embedder.md"]
created_by: ragdown_remember
---
```

Paths are relative to the note's own folder, the way a Markdown link is, and one that climbs out of
the docs folder is ignored: frontmatter is data from a file, not a path the server should follow.
`ragdown_remember` writes the field for you from its `supersedes` argument and refuses a path that
names no note, so an agent that gets it wrong hears about it instead of believing it replaced
something. It also records `created_by: ragdown_remember` and the `session_id`, so a later reader —
person or model — can tell an agent's note from one the user wrote.

**The index is derived data.** `meta.json` records the embedder and chunker version, and a
mismatch drops and rebuilds the index instead of migrating it. Syncs are diffs:

1. Files whose size and mtime are unchanged are skipped without being read.
2. A content hash decides whether a changed file is re-embedded.
3. Files gone from disk are dropped.

A file's chunks are replaced with one delete and one add. Syncs never overlap: changes that arrive
during a sync share one follow-up. The watcher debounces for 750 ms and falls back to polling
every 60 s where recursive `fs.watch` fails.

**One primary per index.** Several Claude Code windows on the same folder must not all index it.
The process that binds `<data dir>/primary.sock` is the primary: it indexes and watches. The others
are readers. They search the same LanceDB table (which sees the primary's commits) and forward syncs to the primary. Holding the socket *is* the lock. A crashed primary
leaves a socket nobody listens on, and the next process takes it over; readers retry every 30 s.

**Searches never wait for indexing.** The first index of a large folder takes minutes, so until it
finishes, searches answer from whatever is indexed so far. `ragdown_stats` shows `syncing`.

**Why TypeScript, not Rust.** The plan allowed a Rust/napi port if it paid for itself. It does
not. Measured on an i9-13900H:

| | |
| --- | --- |
| Model load (warm cache) | ~300 ms |
| Query embedding | ~23 ms |
| First index, 105 files / 1,919 chunks | 180 s (~11 chunks/s) |
| Re-sync with nothing changed | ~40 ms |

Almost all indexing time is the ONNX Runtime forward pass, which is native C++. Tokenizing takes
about 1 ms a chunk, and raw `onnxruntime-node` without transformers.js measured the same
throughput. A Rust port would call the same kernels. Two changes did help, and neither depends on
the language:

- **Batch chunks by length.** A batch is padded to its longest member.
- **Use half the cores.** Four threads beat eight on this P/E-core CPU.

For faster indexing, switch the embedder to a GPU-backed `openai:<model>` endpoint.

## Development

```bash
npm run typecheck && npm run lint && npm test
npm run build            # the web UI, into web/dist
npm run dev:web          # Vite on :5173, proxying /api to a `serve` on :3000
```

The web UI in `web/` is React, TanStack Query and Router, Tailwind and shadcn components from the
[cubeui](https://cubicecho.github.io/cubeui) registry (`npx shadcn add @cubeui/<name>` from `web/`).

The tests run against real LanceDB, the real socket, and MCP over the SDK's in-memory transport and
real HTTP. They use the `hash` embedder, so they need no model download.

The numbers quoted in [Design](#design) come from [`scripts/bench`](scripts/bench/README.md) — the
embedder comparison, the threshold and drop-off sweeps, the RRF check, and the retrieval and
answer-accuracy runs against a synthetic corpus. They are too slow for CI and some need a local LLM,
so they are run by hand; that README says how, and what each one found.
