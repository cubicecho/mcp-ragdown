# Benchmarks

The measurements behind the design decisions in the root [`README.md`](../../README.md): the
embedding model, `RAGDOWN_HOOK_MIN_SCORE`, `RAGDOWN_HOOK_MIN_RATIO`, and the things that were tried
and *not* shipped. Nothing here runs in CI — the scripts are slow, some need a local LLM, and their
outputs are gitignored. They exist so a claim can be re-checked rather than taken on trust.

Everything runs against a synthetic corpus, not the real docs folder: 30 generated service runbooks
with gold answers for every question, so grading is exact and no answer can leak in from a model's
training data. That is also the limitation — synthetic prose is easier than real notes, so read the
numbers as comparisons between variants, never as absolute accuracy.

```bash
node scripts/bench/gen.ts          # write scripts/bench/corpus/{md,html,txt} + questions.json
node scripts/bench/retrieval.ts    # needed before llm.ts: writes retrieved.json
```

Embedding models download to `~/.cache/ragdown-bench-models` on first use. The scripts that ask an
LLM take the model name as their first argument and need an OpenAI-compatible endpoint:

```bash
export BENCH_LLM_URL=http://localhost:8000/v1/chat/completions   # default
node scripts/bench/llm.ts <model> closed,oracle,retrieved,haystack,edit 10
```

They append to `results.jsonl` / `nearmiss.jsonl` and skip keys already in it, so an interrupted run
resumes by re-running the same command.

## The scripts

| Script | Needs | Measures |
| --- | --- | --- |
| `gen.ts` | — | The corpus itself: one document model rendered as Markdown, strict semantic HTML and plain text, plus questions, hard questions, unanswerable questions and edit tasks. Everything else imports it. |
| `retrieval.ts` | embedder | Recall\@k of the real `Store` (LanceDB FTS + dense + RRF) per format, with token counts. Writes `retrieval.json` and the `retrieved.json` that `llm.ts` replays. |
| `llm.ts` | LLM | Answer accuracy and edit fidelity per format, per condition. Conditions: `closed` (no documents — the leakage control), `oracle` (the one right document), `retrieved` (what the retriever actually returned), `haystack` (the whole corpus), `edit`. |
| `analyze.ts` | `results.jsonl` | Aggregates `llm.ts`: accuracy per format/condition/type, exact McNemar on the discordant pairs. Writes `summary.json` and `wrong.txt`. |
| `leak.ts` | `results.jsonl` | How much of the score does not need the documents: `closed` against `haystack`, per question type. |
| `nearmiss.ts` | LLM, embedder | A harder unanswerable slice — a field that *is* in the corpus for every service except this one — across `closed`, `oracle`, `retrieved` (real retriever plus the shipped gates) and `haystack`. |
| `embedders.ts` | embedder | The same corpus and questions with only the embedding model changed: recall, index time, query latency. |
| `threshold.ts` | embedder | Where `MIN_SCORE` belongs for a given model: best-hit cosine for answerable questions against the same for off-topic prompts. A model's cosine scale is its own. |
| `gate.ts` | embedder | The relative drop-off gate: recall and chunks injected per prompt as the ratio sweeps 1.00 → 0. |
| `rrf.ts` | embedder | Whether RRF buries an exact lexical hit the dense side missed, over k ∈ {60, 20, 10, 0}. Probes are tokens that occur in exactly one chunk, so they are exact identifiers by construction. |
| `selective.ts` | embedder | Adding context to `embeddingText` only where a chunk cannot say what it is about (repeated leaf heading, breadcrumb sandwich, selective title). |
| `frontmatter.ts` | LLM, embedder | Derived front matter at index time: deterministic headings, an LLM document summary, and a per-chunk context sentence (Anthropic Contextual Retrieval). |
| `scale.ts` | — | Not a benchmark: the shared parts of the two below. The corpus embedded as the server would, its vectors jittered and replicated to any N, exact brute-force ground truth, recall\@k, and `interleaved()`, which times variants round-robin so load drift lands on all of them alike. |
| `qdrant.ts` | embedder, a local Qdrant | Whether a separate vector server beats the embedded table: the real pipeline (embed, dense, FTS) against Qdrant on the same 210 chunks, then jittered to 1k/10k/100k, top-10 unfiltered and with a 10% payload filter, recall against brute force. |
| `lance-tuning.ts` | embedder | The LanceDB knobs, one table per variant: selected columns, distance type, `readConsistencyInterval`, prefilter against postfilter, scalar indexes on the filter column, and the vector index types (IVF-flat, HNSW-SQ, IVF-PQ) across `nprobes`/`ef`. |
| `rerank.ts` | embedder | CPU cross-encoder rerankers over the shipped top 10: rank of the right section, latency, and whether the reranker's score separates on-topic from off-topic prompts better than cosine (gate AUC). `BLEND=1` mixes the reranker into the shipped ranking instead of replacing it, `TIMING=1` times the models interleaved, `BENCH_SEED` (read by `gen.ts`) draws a held-out corpus. |

## What they found

`gate.ts`, granite-embedding-small-english-r2, `MIN_SCORE` 0.8, top 4. Recall is flat from 0.96 down
to ungated while the injected chunks nearly halve, so 0.95 sits one step below the knee:

```
ratio   recall  chunks/q  noise/q  off-topic injections
 1.00    84.3%     1.00     0.16                    0
 0.98    94.8%     1.62     0.67                    0
 0.96    99.0%     2.67     1.68                    0
 0.95    99.0%     3.17     2.18                    0
 0.00    99.0%     3.99     3.00                    0
```

`rrf.ts` refuted the burial hypothesis, which is why fusion was left alone: 0/47 cases at every k.
Fusion does cost top-1 on exact-identifier queries, but it ties by top-8, and the hook reads top-8.

```
retriever         top1    top4    top8   missed
dense only        64.7%  78.4%  86.3%    3.9%
lexical only      92.2% 100.0% 100.0%    0.0%
fused k=60        74.5%  98.0% 100.0%    0.0%
```

`leak.ts` validated the benchmark and found a defect in it. The answerable questions have a leakage
floor of 0/210 — the corpus really is closed — but the shipped `unanswerable` slice scores 100%
closed *and* 100% with the whole corpus in the prompt, so it separates nothing.

`nearmiss.ts` is the replacement, and it does separate. Abstention, 90 probes:

```
                       closed retrieved  oracle haystack
absent-dep             100.0%   100.0%  100.0%    63.3%
absent-setting         100.0%   100.0%  100.0%   100.0%
absent-step            100.0%   100.0%  100.0%    90.0%
ALL (n=90)             100.0%   100.0%  100.0%    84.4%
prompt tokens              82       441     716   19,269
```

Of the 14 haystack failures, 10 answered with an adjacent row in the correct section of the correct
document and 1 from another document; none was invented outright. It is near-neighbour substitution
under context pressure. The `retrieved` column is the gates doing their job — the hook behaves like
`oracle`, at less than a tenth of `haystack`'s tokens.

`selective.ts` and `frontmatter.ts` both came back flat, so neither shipped; the breadcrumb prefix
in `embeddingText` is all the context a chunk gets.

`qdrant.ts` says a vector server is not worth the process. Qdrant is genuinely faster, and at 100k
it is not close — but at the size a notes folder actually is, the win is about a millisecond next to
the ~6 ms the query embedding costs, and it is paid for with a second process, a lost BM25 side
(fusion would have to be rebuilt by hand) and a compression workaround. Top-10, p50 ms / recall:

```
N        lance flat      lance hnsw-sq    qdrant default    qdrant exact
1000     2.58 / 1.000     —                1.17 / 1.000      1.20 / 1.000
10000    9.89 / 1.000     2.07 / 0.911     1.28 / 1.000      1.34 / 1.000
100000  72.59 / 1.000    19.29 / 0.719     1.33 / 0.989      4.54 / 1.000
```

The workaround is in the script: `fetch` asks for gzip/br, Qdrant compresses any response over a few
KB, and the write pattern that produces waits out a 40 ms delayed ACK. `accept-encoding: identity`
takes a 44 ms p50 back to 1.5 ms. Anything talking to Qdrant from Node has to know that.

`lance-tuning.ts` is where the two changes in `store.ts` came from, and it also closed off three
knobs that looked promising. Only compare within a group: variants are interleaved, so drift moves a
whole group together.

Selecting without the vector column is free and costs nothing to recall — at corpus size it is most
of the dense search, because 210 vectors get copied out of Arrow only to recompute a number
`_distance` already holds (dense 5.89 → 4.62 ms p50, FTS 5.61 → 3.67). `distanceType("dot")` and
`readConsistencyInterval` unset are both inside the noise, so neither changed.

IVF-flat is exact and twice as fast at 10k, for a one-second build — that is the whole case for
building it there and not before. HNSW-SQ and IVF-PQ are faster still at 100k but pay recall the
hook cannot afford, and IVF-PQ's build is 95 s:

```
N=10000 unfiltered      p50   recall   build      N=100000            p50   recall    build
flat (shipped)        10.18    1.000       —      flat              54.03    1.000        —
ivf-flat nprobes 20    5.90    1.000    156ms     ivf-flat          24.28    1.000    1.0 s
hnsw-sq ef 60          4.84    0.966    989ms     hnsw-sq ef 60      9.24    0.891   62.8 s
ivf-pq refine 10      19.81    0.982    2414ms    ivf-pq refine 10  40.15    0.801   95.5 s
```

The filter findings were the surprise, and all three say leave the scoped search alone. A scalar
index on the filter column makes a *filtered flat* search 4.5–8× slower (13.1 → 58.9 ms at 10k,
73.7 → 613 ms at 100k, btree and bitmap alike), because the flat path is already one scan and the
index only adds work; `folder = 'f3'` is no faster than the shipped `starts_with(path, ...)`; and
`postfilter()` is slightly faster only because it is wrong — it filters the top-k it already picked,
so recall falls to 0.10. Hence: no index on `path`, prefilter, and the vector index built lazily.

`rerank.ts` says a CPU reranker is worth offering, but not as a replacement for the shipped
ranking. Nine candidates were researched (ms-marco TinyBERT-L2 and MiniLM-L6, jina-reranker-v1-tiny,
the Ettin rerankers at 17m/32m/68m/150m, gte-reranker-modernbert-base, granite reranker r2); LLM
rerankers such as Qwen3-Reranker-0.6B were left out as too slow on CPU. Six were run, int8 ONNX,
reranking the shipped top 10, over the 270 answerable questions. `first` is the right section ranked
first; the shipped fusion's own ceiling at 10 is 89.3:

```
                 first   top4    mrr   gate AUC    p50 ms (10 pairs)
fused (shipped)   76.7   88.5      —      0.971    —
ettin-17m         77.8   88.9  0.833      0.935    50–130
ettin-32m         75.6   88.9  0.820      0.936    140–240
minilm-l6         81.1   88.9  0.849      0.989    100–210
ettin-68m         81.9   88.9  0.853      0.934    420–620
ettin-150m        83.3   88.9  0.860      0.989    1300–2800
gte-modernbert    85.6   89.3  0.873      0.943    690–1350
```

Latencies are 4 threads on an i9-13900H that was never idle (load 1–8 across runs), so read the
order, not the numbers: interleaved timing kept the order identical across every run. ModernBERT is
slow on CPU by architecture, not by quantisation; fp32 Ettin is only 5–20% slower than int8. A
pool of 20 doubled the time for under a point.

Replacing the ranking hides regressions behind the averages. ettin-17m drops code-block questions
from 100 to 37 and MiniLM drops scoped-section questions from 97 to 53, because a cross-encoder
reads the chunk without the heading context the fused ranking already used. Only gte-modernbert had
no type that got worse. So `BLEND=1` mixes the two, and the blend that works is linear: min-max
both scores over the pool and weight them, against cosine similarity rather than the fused score.
Equal-weight RRF of the two ranks barely moves anything (about 78 for every model), and
reranker-weighted RRF brings the regressions back. `worst` is the largest drop on any question type:

```
                              default seed       seed 42 (held out)   seed 7 (held out)
                              first   worst      first   worst        first   worst
fused (shipped)               75.9      —        73.7      —          77.8      —
ettin-17m replace             77.0   -63.3       76.7   -56.7         80.0   -46.7
ettin-17m linear-cos 0.5      82.6     0.0       80.0    -6.7         83.7    -3.3
ettin-17m linear-cos 0.7      82.6    -3.3       83.0    -6.7         85.2   -10.0
minilm-l6 linear-cos 0.5      81.5    -3.3       77.8   -10.0         81.1   -10.0
gte-modernbert replace        85.9     0.0         —        —           —       —
```

The blend was chosen on the default corpus, so `BENCH_SEED` draws two more with the same shape and
different services, values and wording. ettin-17m at 0.5 kept +6 points on both and its worst type
stayed within two questions of the shipped ranking; 0.7 scores higher but gives up code blocks.
That makes two useful settings: ettin-17m blended 50/50 with cosine at about the cost of the query
embedding, and gte-modernbert replacing the ranking at about a second.

The gate should stay on cosine. MiniLM and ettin-150m separate on-topic from off-topic better
(AUC 0.989 against 0.971), but the two worth shipping, ettin-17m and gte-modernbert, do worse (0.935, 0.943), and a second threshold per reranker is
not worth it.

One trap: the Ettin ONNX exports are encoder-only. The sentence-transformers head (CLS pooling,
Dense 256→256 with exact GELU, LayerNorm, Dense 256→1) lives in safetensors beside the model, and
`rerank.ts` applies it in JS. Against sentence-transformers it matches exactly in fp32 and keeps the
order in int8. Any shipped version has to do the same.
