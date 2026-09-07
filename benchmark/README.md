# akron-bench — pruning benchmark

Time/cost benchmark comparing context strategies over an identical scripted,
tool-heavy session:

| Arm | Context strategy |
| --- | --- |
| `pure` | No pruning (akron disabled, pi-context-prune absent) |
| `pcp` | [pi-context-prune](https://github.com/championswimmer/pi-context-prune) enabled, akron disabled |
| `akron` | Project-local `akron-prune` enabled, pcp absent |

Default model: `zai/glm-5.3-flash` (override with `--model provider/modelId`).

## How it works

Each run happens in a **fresh temp pi agent dir** (`PI_CODING_AGENT_DIR`) seeded with a
copy of your real `auth.json`, `models*.json`, and base settings — so provider auth
works, but your real sessions, akron artifacts/profiles, and settings are never touched.
The temp workdir symlinks the real `.pi/extensions/akron-prune` so the `akron` arm loads
it; the `pcp` arm loads pi-context-prune directly from your existing npm install via
`-e`. Fixtures and prompts are seeded-deterministic: every arm sees byte-identical
content.

Workload per run (`rounds` fill rounds, then tail, then retrieval):

1. **Fill** — each round prompts the model to `cat` one ~45KB fixture file (fixed
   pseudo-random text plus a unique `MK<r>-<token>` marker on line 1), then reply `ok <r>`.
2. **Tail** — one trivial exchange.
3. **Retrieve** — "reply with only the exact marker token from chunk 001". Scored by
   exact substring match against the final assistant text; measures what each strategy
   preserves of old context (for `akron`, the model may use `akron_recover`).

## Metrics

Per prompt turn (`results.jsonl` rows): wall time, assistant usage
(input/output/cacheRead/cacheWrite/tokens/cost), context tokens/percent, tool-call and
`akron_recover` counts, retrieval correctness. Per run (`summary.json`): akron prune
events/chars (from the temp agent's own profile), compaction events (session scan),
extension errors.

Aggregate report per arm: total cost, total/p50/p90 wall time, fill-p50 latency,
cache-hit ratio (`cacheRead / (cacheRead + input + cacheWrite)` over all rows — failed
prompts still spend real tokens and are included), prune/compaction event counts, and
retrieval score.

## Usage

```bash
cd .pi/extensions/akron-prune/benchmark
bun run test.ts                          # deterministic checks, no LLM calls
bun run runner.ts                        # 3 arms x 3 reps x 24 rounds (SPENDS REAL TOKENS)
bun run report.ts results/<ts>           # comparison table
bun run report.ts results/<ts> --json    # machine-readable
```

Runner flags: `--arms pure,pcp,akron`, `--reps 3`, `--rounds 24`,
`--fixture-bytes 46080`, `--seed 42`, `--model zai/glm-5.3-flash`,
`--prompt-timeout 600000`, `--out results/<ts>`.

Sizing: default is 24 × 45KB ≈ 1.1MB chars (~270k tokens) of tool output — sized for
large-window models. For 200k-window models, drop `--rounds` so the pure arm does not
auto-compact unless you specifically want to measure that (compaction events are
reported per arm either way).

## Caveats

- The model is instructed to run exactly one command per fill prompt, but compliance is
  probabilistic; use `--reps` and read medians, not single runs.
- pi-context-prune's summarizer cost is a separate provider call; it shows up in its
  arm's cost only if the provider reports it through the main stream, so `pcp` cost can
  be slightly understated.
- Runs are not free: default settings are roughly 3 arms × 3 reps × 26 prompts with
  ~270k tokens of context by the end of each fill phase.

## Files

- `workload.ts` — seeded fixtures + prompt script (pure, unit-tested)
- `runner.ts` — arm isolation, RPC driving, metric collection
- `report.ts` — pure aggregation + table/JSON report (unit-tested)
- `test.ts` — behavior checks for the above, no LLM needed
