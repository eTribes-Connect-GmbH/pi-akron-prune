# pi-akron-prune coding benchmark

Cheap synthetic benchmark comparing context strategies over an identical long-ish agentic coding session:

| Arm | Context strategy |
| --- | --- |
| `pure` | No third-party pruning; native pi compaction remains enabled |
| `pcp` | [pi-context-prune](https://github.com/championswimmer/pi-context-prune) enabled, pi-akron-prune disabled |
| `akron` | Project-local pi-akron-prune enabled, pcp absent |

Default model: `openai-codex/gpt-5.6-luna` (override with `--model provider/modelId`).

## How it works

Each run happens in a **fresh temp pi agent dir** (`PI_CODING_AGENT_DIR`) seeded with a copy of your real auth/model settings, so provider auth works but real sessions, profiles, artifacts, and settings are not touched. The temp workdir symlinks this checkout as `.pi/extensions/akron-prune` so the `akron` arm loads it; the `pcp` arm loads pi-context-prune from your existing npm install via `-e`.

The workload is deterministic. For each arm/rep, the runner creates a tiny dependency-free JavaScript project under `coding-workload/` plus large per-round plain-text evidence files under `evidence/`.

Workload per run:

1. **Coding rounds** — each round asks the model to read verbose plain-text evidence chunks, inspect source/tests, implement one behavior, and run `BENCH_MAX_ROUND=<n> npm test`.
2. **Final round** — asks the model to run/fix the full generated test suite.
3. **Runner scoring** — after every coding/final turn, the runner independently executes `npm test` in the generated project with the matching `BENCH_MAX_ROUND` and records pass/fail.

The generated behaviors are deliberately mundane but dependent: SKU normalization, catalog indexing, money parsing, discounts, cart totals, and receipt rendering. The point is not benchmark novelty; it is to create a controlled coding workload with executable correctness and enough historical tool output to test what pruning preserves.

## Metrics

Per prompt turn (`results.jsonl` rows): wall time, assistant usage, context tokens/percent, tool-call and `akron_recover` counts, runner test pass/fail, test runtime, test output size, and failure status.

Per run (`summary.json`): pi-akron-prune events/chars, native compaction events, extension errors, session path, and options.

Aggregate report per arm: total cost, total/p50/p90 wall time, task-p50 latency, cache-hit ratio, maximum observed context size, recovery-call totals, prune/compaction event counts, and test pass score.

## Usage

```bash
cd ~/.pi/agent/extensions/pi-akron-prune/benchmark
bun run test.ts                          # deterministic checks, no LLM calls
bun run runner.ts                        # 3 arms x 3 reps x 6 rounds (SPENDS REAL TOKENS)
bun run report.ts results/<ts>           # comparison table
bun run report.ts results/<ts> --json    # machine-readable
```

Runner flags: `--arms pure,pcp,akron`, `--reps 3`, `--rounds 6`, `--fixture-bytes 46080`, `--seed 42`, `--model openai-codex/gpt-5.6-luna`, `--prompt-timeout 600000`, `--out results/<ts>`.

Sizing: default is 6 × 45KB of evidence text plus code/test/tool output. Evidence is split into ~44KB `.txt` chunks so large `--fixture-bytes` values produce prunable completed reads instead of overlarge or markdown-protected outputs. Increase `--fixture-bytes` or repeat reps if you need more context pressure; decrease them for a cheaper smoke test.

## Example pilot result

One local pilot using Luna with enough evidence text to trigger pressure:

```bash
bun run runner.ts --reps 1 --rounds 6 --fixture-bytes 500000 --model openai-codex/gpt-5.6-luna
bun run report.ts /Users/floriankrause/.pi/agent/extensions/pi-akron-prune/benchmark/results/1788878675177
```

```text
arm    prompts  fail  tests   cost$    wall     p50/p90      task-p50   hit     in/rd/wr (tok)        maxctx       recover  prune/comp
akron  7        0     7/7     0.2392   257.9s   43.5s/49.6s  43.8s      75.9%   872k/2.74M/0k         129k/47.3%   0        6/0
pcp    7        0     7/7     0.2753   324.7s   47.8s/66.8s  52.4s      82.3%   805k/3.74M/0k         253k/93.0%   0        0/2
pure   7        0     7/7     0.2414   349.1s   50.7s/69.5s  54.3s      80.1%   824k/3.31M/0k         133k/48.9%   0        0/3
```

All arms passed all generated tests. In this single-rep pilot, pi-akron-prune avoided native compaction, had the lowest wall time, and kept max observed context at 47.3%; pcp and pure both hit native compaction. Treat this as a smoke/pilot datapoint, not a statistically stable result.

## Caveats

- This is a synthetic coding benchmark. It is useful for controlled pruner behavior, cost, latency, and executable task completion, but it is not a substitute for SWE-bench Pro or Terminal-Bench.
- The model is asked to run tests, but the runner independently scores tests after each turn because model-reported status is not trusted.
- pi-context-prune's summarizer cost is a separate provider call; include it in that arm when provider usage exposes it.
- Runs are not free. Start with `--arms akron --reps 1 --rounds 2 --fixture-bytes 8000` or similar before running the full matrix.

## Files

- `workload.ts` — generated coding project + deterministic prompt script
- `runner.ts` — arm isolation, RPC driving, metric/test collection
- `report.ts` — pure aggregation + table/JSON report
- `test.ts` — behavior checks for the above, no LLM needed
- `CODING_BENCHMARKS.md` — notes on real benchmark candidates and pilot protocol
- `coding-candidates.json` — machine-readable candidate/guardrail summary
