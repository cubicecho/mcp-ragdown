# syntax=docker/dockerfile:1

# ── Stage 1: dependencies and model ───────────────────────────────────────────
# Debian slim rather than alpine: LanceDB and ONNX Runtime ship glibc binaries, and
# their musl builds are the less-travelled path.
FROM node:26-slim AS builder

WORKDIR /app

# Manifests first so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Unused weight, about 1.2 GB of a 3 GB image:
# - LanceDB's optional transformers 3 (with its own ONNX Runtime and sharp) backs its
#   embedding registry, which ragdown does not use.
# - ONNX Runtime's CUDA and TensorRT providers; the server runs on the CPU.
# - Prebuilt binaries for other platforms.
RUN rm -rf node_modules/@lancedb/lancedb/node_modules \
  && cd node_modules/onnxruntime-node/bin \
  && find . -name 'libonnxruntime_providers_*' ! -name '*shared*' -delete \
  && find . -mindepth 2 -maxdepth 2 ! -name linux -exec rm -rf {} + \
  && arch="$(node -p process.arch)" \
  && find . -mindepth 3 -maxdepth 3 ! -name "$arch" -exec rm -rf {} +

# The default embedding model (~50 MB) is baked in, so the container starts offline and the
# first start does not stall on a download. The same call the server makes, so the
# cache layout is exactly what it will look for. Setting RAGDOWN_EMBEDDER to any other
# model downloads it on first start instead.
RUN node --input-type=module -e ' \
  const { env, pipeline } = await import("@huggingface/transformers"); \
  env.cacheDir = "/models"; \
  await pipeline("feature-extraction", "onnx-community/granite-embedding-small-english-r2-ONNX", { dtype: "q8" });'

# ── Stage 2: web UI ───────────────────────────────────────────────────────────
# Needs the dev dependencies (Vite, React, Tailwind); only the built files leave this stage.
FROM node:26-slim AS web

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY web ./web
RUN npm run build

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
# No build step: Node 26 runs the TypeScript in src/ directly by type stripping.
FROM node:26-slim

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /models /models
COPY package.json ./
COPY src ./src
COPY --from=web /app/web/dist ./web/dist

ENV NODE_ENV=production
# Mount the Markdown folder here. Read-write if agents should be able to save notes
# with ragdown_remember; add :ro and RAGDOWN_READ_ONLY=true otherwise.
ENV RAGDOWN_DOCS_DIR=/docs
# The LanceDB index. Derived data, but a volume saves re-embedding every file on
# each restart, which for a large folder is minutes.
ENV RAGDOWN_DATA_DIR=/data
ENV RAGDOWN_MODELS=/models
ENV PORT=3000

RUN mkdir -p /docs /data && chown node:node /docs /data

VOLUME /data

# Run unprivileged; /data is the only place written to besides notes in /docs.
USER node

EXPOSE 3000

# /api/status answers as soon as the process listens, reporting `ready: false`
# while the model loads, so a slow start is not a failed one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e 'fetch("http://localhost:" + (process.env.PORT || 3000) + "/api/status").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

CMD ["node", "src/cli.ts", "serve"]
