# mcp-ragdown

An MCP server over a folder of Markdown files. Point it at the folder and it embeds every section
into a local LanceDB index and keeps that index in sync as files change. Agents get search tools,
and a hook that calls `ragdown_context` before each turn adds related notes to the prompt. The tool
layout follows mcp-zeromem, but the memory here is your Markdown files, not conversation turns.

Everything an agent or a hook does goes through MCP. There is no hook command and no hook HTTP
route; the only other routes feed the web UI.

Everything runs locally: the default embedder is `bge-small-en-v1.5` on ONNX Runtime. The Docker
image has the model baked in; outside Docker it is downloaded once (about 35 MB) on first start.

## Quick start

`docker-compose.yml`:

```yaml
services:
  ragdown:
    image: vantreeseba/mcp-ragdown:latest
    ports:
      - '3300:3000'
    volumes:
      - ~/notes:/docs          # your Markdown folder; add :ro and RAGDOWN_READ_ONLY=true to forbid writes
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

claude mcp add --transport http ragdown http://localhost:3300/mcp \
  --header "Authorization: Bearer $RAGDOWN_TOKEN"
```

The first index of a large folder takes minutes; searches answer from what is indexed so far. Open
http://localhost:3300 for the web UI: the indexed files, each rendered beside the list. To add
notes to every turn automatically, see [Hooks in min-agent](#hooks-in-min-agent). Images are
published for `linux/amd64` to Docker Hub and `ghcr.io/cubicecho/mcp-ragdown`.

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
claude mcp add ragdown -e RAGDOWN_DOCS_DIR=$HOME/notes -- node /path/to/mcp-ragdown/src/cli.ts stdio
```

Claude calls `ragdown_recall` and `ragdown_read_doc` itself when the notes might help; the server's
instructions tell it to. There is no hook command to wire into Claude Code: automatic per-prompt
context needs a client whose hooks call MCP tools, such as min-agent.

## Hooks in min-agent

A min-agent hook calls a tool on a connected MCP server,
so ragdown needs nothing beyond its MCP endpoint. Add a server under **Settings → MCP**:

```jsonc
{
  "id": "ragdown",
  "label": "Notes",
  "transport": "http",
  "url": "http://localhost:3300/mcp",
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
| `ragdown_context` | For hooks: the sections related to a `prompt` as a `<ragdown-context>` block, or empty text. Filters by similarity, skips short prompts and slash commands, and never repeats a section for the same `session_id`. Takes `top_k`, `min_score` and `max_chars` to override the `RAGDOWN_HOOK_*` defaults. |
| `ragdown_recall` | Hybrid search. Returns path, line range, heading breadcrumb and similarity for each hit. Takes `top_k`, `path_prefix`, `format: text\|json` and `max_chars`. |
| `ragdown_read_doc` | Reads a file, or a line range of one, straight from disk. Never clipped. |
| `ragdown_stats` | Folder, index size, embedder, role (primary or reader), whether a sync is running, and the last sync. |
| `ragdown_remember` | Writes a new note (with frontmatter) under `RAGDOWN_NOTES_DIR` and indexes it before returning. Never overwrites a file. |
| `ragdown_reindex` | Syncs now; `full: true` re-embeds everything. |

The two write tools are not listed when `RAGDOWN_READ_ONLY=true`.

## Configuration

Only `RAGDOWN_DOCS_DIR` is required. See [`.env.example`](.env.example).

| Variable | Default | |
| --- | --- | --- |
| `RAGDOWN_DOCS_DIR` | — | The Markdown folder, walked recursively. Dot-folders and `node_modules` are skipped, and symlinks are not followed. Indexes `.md`, `.markdown` and `.mdx`. |
| `RAGDOWN_DATA_DIR` | `~/.cache/ragdown/<hash of docs dir>` | The index. Deleting it only costs a rebuild. |
| `RAGDOWN_MODELS` | `~/.cache/ragdown/models` | Model cache, shared by every folder. |
| `RAGDOWN_EMBEDDER` | `bge-small` | `bge-small`, `openai:<model>` (any OpenAI-compatible `/embeddings` endpoint, such as Ollama or llama.cpp), or `hash` (tests only). |
| `RAGDOWN_EMBEDDING_URL` / `_API_KEY` | OpenAI | For `openai:<model>`. |
| `RAGDOWN_THREADS` | half the cores | ONNX Runtime threads for `bge-small`. |
| `RAGDOWN_WATCH` | `true` | Watch the folder; without a watcher, sync on start and on `ragdown_reindex` only. |
| `RAGDOWN_READ_ONLY` | `false` | Hide the write tools. |
| `RAGDOWN_NOTES_DIR` | `notes` | Where `ragdown_remember` writes. Must be inside the docs folder. |
| `RAGDOWN_TEXT_LIMIT` | `2000` | Characters per hit in text output. Every cut names the `ragdown_read_doc` call that returns the rest. |
| `RAGDOWN_HOOK_TOP_K` | `4` | `ragdown_context`: most sections per prompt. |
| `RAGDOWN_HOOK_MIN_SCORE` | `0.7` | `ragdown_context`: lowest cosine similarity returned. |
| `RAGDOWN_HOOK_MAX_CHARS` | `6000` | `ragdown_context`: most characters per prompt. |
| `PORT` | `3000` | `serve` only. The HTTP port. |
| `RAGDOWN_TOKEN` | — | `serve` only. The bearer token `/mcp` and the web UI's `/api` routes require. |
| `SECURE_LOCAL_NET` | `false` | `serve` only. Skip the token on a trusted network. `serve` refuses to start with neither. |

## Commands and HTTP

`node src/cli.ts <command>`: `stdio` (the MCP server a client launches) or `serve` (HTTP, what the
image runs). Searching, indexing and stats are MCP tools, not commands.

`serve` exposes these routes:

| Route | Auth | |
| --- | --- | --- |
| `GET /api/status` | none | Liveness and index stats. `ready: false` while the model loads. |
| `/mcp` | bearer | Streamable HTTP MCP, stateless. |
| `GET /api/docs` | bearer | The indexed files: `path`, `title`, `mtime_ms`, `size`, `chunks`. |
| `GET /api/doc?path=` | bearer | One indexed file's text, read from disk. 404 for a file the index does not hold. |
| `GET /*` | none | The web UI from `web/dist`, with `index.html` for any other path. |

The web UI asks for the token once and keeps it in the browser's local storage. Its static files
hold no notes, so they need none; everything it shows comes from the bearer routes. It is built by
`npm run build` (the image does this) and only `serve` serves it.

## Design

**Chunks follow headings.** Every heading starts a section, and the section's breadcrumb
(`Backups › Restore`) is part of what gets embedded. That is how a paragraph that only says "run it
twice" is found by a question about restoring backups. A section longer than 1,500 characters
(about 400 tokens, well inside bge's 512) is packed paragraph by paragraph. Fenced code blocks are
never split. Line numbers refer to the original file, so a hit is always one `ragdown_read_doc`
call away from its surroundings.

**Hybrid retrieval.** Dense cosine search finds a paragraph that answers the question in different
words. BM25 full-text search finds an exact error string or flag name that an embedding blurs.
Both return a pool, and reciprocal rank fusion (k = 60) merges them. Ranking uses the fused score.
Filtering uses cosine similarity, because a fused score is not comparable across queries.

**Calibrating `MIN_SCORE`.** On a 1,900-chunk corpus of engineering notes with bge-small:

- On-topic questions scored their best hits at 0.73–0.79.
- Unrelated prompts ("weather in Paris", "pasta recipe") peaked at 0.53–0.57.
- Generic coding requests ("refactor this to async/await") reached 0.62–0.68.

0.7 injects on-topic notes and skips the rest. Other embedders need their own threshold.

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
