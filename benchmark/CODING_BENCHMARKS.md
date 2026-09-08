# Coding benchmark candidates for pruner evaluation

This document records the current, evidence-checked shortlist for comparing long-session pruning strategies in pi:

1. `pure` — pi with no third-party pruner; native compaction remains enabled as the baseline escape hatch.
2. `pcp` — pi-context-prune.
3. `akron` — pi-akron-prune.

All arms must use the same model, reasoning level, tools, prompts, native compaction settings, task environments, and execution budgets. Count native compaction events separately. Include summarizer-model latency/cost in the arm that triggers it.

## Recommendation

Use **SWE-bench Pro public** as the primary coding benchmark pilot, **SWE-bench Verified** as a calibration/control set, and a **curated Terminal-Bench software-engineering subset** as a secondary tool-heavy stress track.

The synthetic benchmark in this directory is useful for measuring controlled long-session coding behavior, cost, latency, and pruning mechanics, but it does not establish public-benchmark generalization.

## Candidate matrix

| Candidate | Source | Evidence checked | Fit for pruning comparison | Main caveat |
| --- | --- | --- | --- | --- |
| SWE-bench Pro public | <https://github.com/scaleapi/SWE-bench_Pro-os> and <https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro> | 731 public test rows; 11 public repo classes; Docker/Modal/local-Docker eval; problem statements 419-8.04k chars; patches 1.44k-180k chars; test patches 325-322k chars. Scale's writeup says tasks average 107.4 LOC across 4.1 files and top frontier scores drop from >70% on Verified to about 23% on Pro. | Best primary candidate: repository-level code changes, executable scoring, higher difficulty, enough public tasks to select context-pressure pilots without cherry-picking a final suite. | Need a pi adapter that generates patch predictions inside the provided repo/image setup. Public Pro tasks may still vary widely in duration; select via a baseline pilot and analyze prune-occurring runs separately. |
| SWE-bench Verified | <https://www.swebench.com/>, <https://github.com/SWE-bench/SWE-bench>, <https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified> | 500 human-validated Python issue/PR tasks; Docker-backed `swebench eval verified`; unit-test verification; standard leaderboard/harness. | Good calibration/control and sanity check for patch-generation integration. | Many tasks may finish before pruning matters; do not average them into the primary treatment effect unless pruning actually occurs or the trace crosses the context-pressure threshold. |
| Terminal-Bench | <https://www.tbench.ai/> and <https://github.com/harbor-framework/terminal-bench-1> | Public CLI/harness via `tb run`; Docker/uv dependency; core 0.1.1 registry lists 80 tasks; current original task tree has 241 tasks. Sampling task metadata found 47 `software-engineering` tasks, many with long timeouts or high expert/junior estimates. | Useful secondary stress track for long, tool-heavy, terminal-centric agent behavior after pruning. | It is not purely coding: many tasks are sysadmin, security, data, puzzle, or ML operations. Use a curated software-engineering subset and report it separately from repository issue-resolution benchmarks. |

## Task selection criteria

A task is suitable for a pruner comparison only if it creates context pressure and leaves meaningful work after pruning. High difficulty alone is not enough.

For a pilot, prefer tasks that satisfy most of these:

- Baseline pi run reaches at least one prune/compaction threshold or high context percent before final implementation.
- The task requires later use of evidence gathered before pruning: earlier file reads, test failures, repo exploration, logs, or design constraints.
- The correctness signal is executable: official unit tests, benchmark grader, or task-provided tests.
- The environment can be reset identically per arm/rep.
- The task can run within an explicit wall-time and token/cost budget.
- The task is not selected because one pruner happens to look good on it; selection should come from a preliminary baseline screen.

Exclude or separate:

- Runs where no pruning/compaction occurred.
- Tasks dominated by downloads/build waits rather than agent memory or coding.
- Tasks whose success requires external credentials, live services, or non-reproducible state.
- Non-coding Terminal-Bench tasks from the primary coding score.

## Pilot protocol

1. **Synthetic smoke**: run the local coding benchmark with `openai-codex/gpt-5.6-luna`, small reps, and small briefing size to verify `pure`, `pcp`, and `akron` load correctly after the package rename. This spends tokens, so run only with explicit approval.
2. **Baseline screen**: run a small unpruned baseline sample on SWE-bench Pro public, recording turns, cost, wall time, max context tokens/percent, compactions, and whether the final phase still required old evidence.
3. **Select pilot tasks**: choose a small fixed set from the baseline screen before comparing pruners. Keep tasks where pruning never occurs in a separate bucket.
4. **Three-arm repeated pilot**: run the same selected tasks across `pure`, `pcp`, and `akron` with identical model/settings/budgets. Randomize arm order if provider/cache effects are suspected.
5. **Report**: primary metric is task correctness/resolution. Secondary metrics: total cost, wall time, turns, input/output/cache read/cache write, max context, prune events, compaction events, recovery calls, repeated reads/searches, failed edits, and post-prune latency.

## Instrumentation requirements

For every turn, capture:

- Prompt/assistant wall time and provider usage.
- Context tokens/percent immediately before and after pruning and on later turns.
- Tool calls, especially repeated reads/searches, failed edits, test runs, and recovery calls.
- Native compaction event count and timing.
- Pruner-specific events, bytes/chars removed, summarizer calls, and summarizer usage/cost.
- Final patch and official grader result.

Recovery-call count is not enough by itself: manually inspect sampled traces to distinguish useful recovery from avoidable information loss.

## Guardrails

Do not run paid model/API benchmark prompts from this plan without explicit approval of model, reps, task list, and budget. Keep synthetic benchmark results, SWE-bench-family results, and Terminal-Bench results in separate report sections; they measure different failure modes.
