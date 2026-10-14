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
| `fusion.ts` | embedder | How dense and BM25 are combined and how BM25 tokenizes: the shipped RRF against score fusions (min-max RSF, DBSF), routing identifier-looking queries to BM25, and FTS tokenizer variants, over the questions and over identifier probes. Ranks are what `ragdown_recall` returns; a second column runs each fused top 8 through the hook's own gates. |
| `diversity.ts` | embedder | Whether results should spread over more documents: `RAGDOWN_MAX_PER_DOCUMENT` at 1, 2 and 3 against maximal marginal relevance at λ 0.9, 0.7 and 0.5, over the questions with one right section and the count questions that span documents, with the hook's own gates run on each top 8. |
| `fields.ts` | embedder | Whether a document's own names should count for more than its body: each document given a made-up codename as an alias, the questions asked by title and by alias, against aliases on every chunk, a third BM25 list over title, heading and aliases, and the shipped boost for the chunks of a document the query calls by an alias. Misses are split into wrong document and wrong section, and a hook column tries two rules for an aliased document. |

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

`fusion.ts` found one change worth making and closed off two. Pool 32, as the hook asks for; three
corpora (`BENCH_SEED` default, 42, 7); and the bench's own routed fusion reproduces `store.search`'s
top 8 on every query, so the variants are compared against the real thing. Identifier probes are a token that
occurs in exactly one chunk, asked as "where is \`token\` used?":

```
                                  questions first         worst type      identifier probes first
                                  def    42     7         def  42   7     def    42     7
dense only                        73.3  72.6  76.7                         7.6   8.4  13.7
lexical only                      74.4  71.1  73.3                        77.2  82.1  82.1
rrf k60 (before)                  76.7  74.1  78.1                        26.1  35.8  35.8
rsf 0.5                           79.3  77.0  79.3      -10  -10  -3      55.4  69.5  65.3
dbsf                              79.6  77.8  79.3       -7   -3  -3      57.6  67.4  69.5
routed: rrf, or rsf 0.2 (shipped) 82.2  79.6  82.2        0    0   0      77.2  84.2  85.3
```

Routing is the change. A query that looks like it holds an identifier (a backtick span, snake_case,
a dotted, slashed or flag-shaped name, camelCase, a hyphenated name with a digit) is fused by RSF
weighted 0.2 dense / 0.8 lexical; every other query keeps RRF unchanged. It gains 4–6 points on the
questions with no type worse on any corpus — all of it from the questions that quote a command — and
takes the identifier probes from a quarter or a third to 77–85%, level with BM25 alone. The shipped
fusion is worse there than either side alone would suggest: an exact identifier BM25 ranks first
loses to chunks both retrievers half-agree on. The detector fired on every question that quotes a command
and otherwise only on a version number ("after the 4.2 release"), which routing did not hurt. Real
prompts are messier than these, so it needs watching.

Score fusion on its own (Weaviate's relative score fusion, Qdrant's DBSF) is better than RRF by 1–3
points but costs table-cell questions up to 10, so it only earns its place inside the routing.

The tokenizer is already right. `Index.fts()` with no options ranks identically to stemming plus
stop-word removal on every query of every corpus; turning stemming off or keeping stop words is no
better and usually worse.

Fusion alone barely reaches the hook. `hookContext` takes the fused top 8, re-sorts by cosine and
gates on it, so the right section is injected for 88% of questions under every fusion, and an
identifier probe's chunk only 4–10% of the time even when the fusion ranks it first: a chunk can
hold the exact string and still sit below 0.8 cosine, or below 0.95 of the best hit. So the hook has
its own rule (`HOOK=1`): the best-ranked candidate holding a name the prompt quotes, whole, is
injected first whatever its cosine. Gold injected / other chunks per prompt:

```
                                  questions            identifier probes     off-topic chunks
                                  def   42    7        def    42     7       def  42   7
routed, no rule                   88.5  88.5  87.8      6.5   7.4   4.2      0.2  0.1  0.1
routed, best holder (shipped)     88.5  88.5  87.8    100.0 100.0 100.0      0.2  0.1  0.1
routed, every holder              88.5  88.5  87.8    100.0 100.0 100.0      0.2  0.1  0.1
rrf k60 (before), best holder     88.5  88.5  87.8     90.2  83.2  83.2      0.2  0.1  0.0

other chunks per prompt, questions: no rule 2.28–2.40, best holder 2.44–2.53, every holder 2.57–2.66
```

Every probe's chunk is injected, questions lose nothing for about 0.15 more chunks a prompt, and the
ten off-topic prompts, each quoting a name the corpus lacks, gain none: what they get is the gates'
doing either way. Keeping every holder adds chunks and no recall. Routing and the rule need each
other: without routing the holder is out of the top 8 a tenth to a sixth of the time.

`fields.ts` found that a title needs nothing and an alias needs a lot. Three corpora (default, 42,
7; a fourth, seed 0, agreed), each document given a made-up codename as its frontmatter alias, the
questions asked once by title and once with the title swapped for the alias. The baseline
reproduces `store.search`'s top 8 on every query, now with the alias boost it ships. First / top 8,
with the right section injected by the hook:

```
                                  by title                       by alias
                                  first     hook                 first      top 8      hook
before                            79.6–82.2 87.8–88.5            30.0–32.4  57.6–61.4  32–38
aliases on every chunk            unchanged unchanged            46.2–50.5  83.8–86.2  36–41
field list, RRF ×1                75.2–77.8 +0–1                 74.3–77.1  92.9–93.8  36–41
alias boost ×1 (shipped)          unchanged unchanged            82.9–84.8  98.1–99.0  36–41
  + hook keeps the aliased doc's best (shipped)                  ·          ·          86–89
aliases on every chunk + boost ×1 unchanged unchanged            88.6–90.5  100        36–41
  + hook keeps the aliased doc's best                            ·          ·          90–92
```

A title is already in every chunk's breadcrumb, embedded and indexed, so a query that names its
document by title finds it: of the 18–20% of title questions not ranked first, two fifths land in
the wrong document and three fifths in the wrong section of the right one, which no document-level
boost can fix. The field list (BM25 over title › heading and aliases alone) makes that worse, costing
table-cell questions 27–47 points, since every chunk of the right document matches it equally and
the heading words outvote the cell. An earlier run boosted a document named by title as well as by
alias: it changed nothing by title, and in the hook it found no right answer the gates had not and
added 0.6 chunks a prompt.

An alias is in neither: it reaches lexical search on the document's first chunk only, and the
embedder has never seen it, so the right section came first for under a third of alias questions
and the right document for barely a third. One rank-1 RRF share for each candidate of a document the
query calls by an alias (`callsByAlias`: the whole alias, case-insensitively) takes that to 83–85%
first and 98–99% in the top 8, with no index change, and is what `store.search` ships. Putting the
aliases on every chunk's lexical text as well reaches 89–91% and 100%, but means rebuilding every
index, so it is not shipped; on its own it is worth half as much, and contrary to the comment on
`search_text`, it did not lift whole documents over the section on title questions.

None of it reaches the hook, which re-sorts by cosine: the alias means nothing to the embedder.
Keeping the best-ranked candidate of a document the prompt calls by an alias, whatever its cosine,
as the exact-name rule does, takes the hook from 32–38% to 86–89% on alias questions, with fewer
stray chunks a prompt (2.10–2.18 against 2.14–2.24); that is what `hookContext` ships. Keeping every
candidate of that document instead reached only 53–57%.

`diversity.ts` found that a per-document cap trades a little recall for a cleaner hook, and that
neither it nor MMR finds the other documents a question needs. Three corpora (default, 42, 7);
the fused pool reproduces `store.search`'s top 8 on every query. Ranges are across the corpora:

```
            one right section (270)                        across documents (15–17)
            top 8       hook        off-target/prompt      gold docs in top 8   distinct docs
none        88.9–89.3   87.8–88.5   2.31–2.40              69.6–72.3            4.35–4.42
cap 1       84.4–85.9   84.1–84.8   1.24–1.28              68.8–69.6            8.00
cap 2       86.7        85.6–86.3   1.83–1.89              69.6–70.2            6.29–6.32
cap 3       87.8–89.3   86.7–88.1   2.10–2.14              69.6–72.3            5.41–5.45
mmr 0.9     88.9        87.8–88.5   2.31–2.41              69.6–71.3            4.35–4.42
mmr 0.5     88.5–88.9   87.8–88.5   2.31–2.41              68.5–69.1            4.28–4.37
```

The first hit never changes: a cap only moves a document's later sections. A cap of 2 takes about a
fifth of the hook's off-target sections away at about 2 points of recall; a cap of 1 halves them at
4. The count questions do not gain from either: their missing documents are not in the pool to be
promoted, so spreading the top 8 over twice as many documents brings in other documents, not the
right ones. MMR on the chunk vectors barely moves anything, because sections of one runbook are not
near-duplicates of each other. So the cap ships off by default, for a corpus where one long document
crowds out the rest, and MMR does not ship.
