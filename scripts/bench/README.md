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
