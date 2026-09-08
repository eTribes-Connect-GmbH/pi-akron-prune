/**
 * Behavior checks for the benchmark harness: percentile math, arm
 * aggregation, report formatting, and workload determinism.
 * Run: bun run test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateArm, formatReport, percentile, type RunMeta, type TurnRow } from "./report.js";
import { createWorkload, type Workload } from "./workload.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
	if (condition) {
		console.log(`ok - ${name}`);
	} else {
		failures += 1;
		console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
	}
}

function row(overrides: Partial<TurnRow>): TurnRow {
	return {
		arm: "akron",
		rep: 1,
		phase: "fill",
		round: 1,
		promptChars: 100,
		wallMs: 100,
		usage: { input: 1000, output: 10, cacheRead: 9000, cacheWrite: 0, totalTokens: 10010, cost: 0.01 },
		contextTokens: null,
		contextPercent: null,
		toolCalls: 1,
		recoverCalls: 0,
		assistantChars: 8,
		retrievalCorrect: null,
		failed: false,
		...overrides,
	};
}

function meta(overrides: Partial<RunMeta> = {}): RunMeta {
	return {
		arm: "akron",
		rep: 1,
		sessionFile: null,
		pruneEvents: 2,
		prunedChars: 50_000,
		compactionEvents: 0,
		extensionErrors: 0,
		...overrides,
	};
}

// percentile: linear interpolation
check("percentile empty is null", percentile([], 0.5) === null);
check("percentile single", percentile([5], 0.9) === 5);
check("percentile median even count", percentile([100, 200, 300, 400], 0.5) === 250);
check("percentile p90 interpolates", percentile([100, 200, 300, 400], 0.9) === 370);
check("percentile unsorted input", percentile([400, 100, 300, 200], 0.5) === 250);

// aggregation: sums, cache-hit ratio, retrieval, prune/compaction events
const rows: TurnRow[] = [
	row({ phase: "fill", wallMs: 1000, contextTokens: 10_000, contextPercent: 10, recoverCalls: 1 }),
	row({ phase: "fill", wallMs: 2000, contextTokens: 30_000, contextPercent: 30, recoverCalls: 2, usage: { input: 2000, output: 20, cacheRead: 18_000, cacheWrite: 0, totalTokens: 20_020, cost: 0.02 } }),
	row({ phase: "tail", wallMs: 500, contextTokens: 20_000, contextPercent: 20 }),
	row({ phase: "retrieve", wallMs: 400, retrievalCorrect: true }),
	row({ phase: "retrieve", wallMs: 300, retrievalCorrect: null, failed: true }),
];
const summary = aggregateArm(rows, [meta(), meta({ rep: 2, pruneEvents: 1, prunedChars: 10_000 })]);

check("aggregate prompt count", summary.prompts === 5);
check("aggregate failed count", summary.failedPrompts === 1);
// Failed prompts still spend real tokens/cost, so sums include them.
check("aggregate cost sums", Math.abs(summary.totalCost - 0.06) < 1e-9, String(summary.totalCost));
check("aggregate input sums", summary.totalInput === 6000);
check("aggregate cacheRead sums", summary.totalCacheRead === 54_000);
check(
	"aggregate cache-hit ratio includes all rows",
	Math.abs((summary.cacheHitRatio ?? 0) - 54_000 / 60_000) < 1e-9,
	String(summary.cacheHitRatio),
);
check("aggregate max context tokens", summary.maxContextTokens === 30_000);
check("aggregate max context percent", summary.maxContextPercent === 30);
check("aggregate recovery calls", summary.recoverCalls === 3);
check("aggregate median wall excludes failed", summary.medianWallMs === 750);
check("aggregate fill median wall", summary.fillMedianWallMs === 1500);
check("aggregate prune events", summary.pruneEvents === 3);
check("aggregate pruned chars", summary.prunedChars === 60_000);
check("aggregate compaction events", summary.compactionEvents === 0);
check("aggregate retrieval scored", summary.retrievalTotal === 1 && summary.retrievalCorrect === 1);

// empty aggregation is safe
const empty = aggregateArm([], []);
check("empty aggregate arm name", empty.arm === "(none)");
check("empty aggregate ratio null", empty.cacheHitRatio === null);

// report formatting
const formatted = formatReport([summary]);
check("report includes arm", formatted.includes("akron"));
check("report includes hit percent", formatted.includes("90.0%"));
check("report includes max context", formatted.includes("30k/30.0%"));
check("report includes recovery count", formatted.includes(" 3 "));
check("report includes retrieval score", formatted.includes("1/1"));

// workload determinism: same seed → identical markers and prompt script
const dirA = mkdtempSync(join(tmpdir(), "akron-bench-a-"));
const dirB = mkdtempSync(join(tmpdir(), "akron-bench-b-"));
try {
	const a = createWorkload({ rounds: 3, fixtureBytes: 512, seed: 7, workdir: dirA });
	const b = createWorkload({ rounds: 3, fixtureBytes: 512, seed: 7, workdir: dirB });
	const c = createWorkload({ rounds: 3, fixtureBytes: 512, seed: 8, workdir: dirB });
	check("same seed same markers", JSON.stringify(a.markers) === JSON.stringify(b.markers));
	// Prompt texts embed absolute fixture paths, so compare with the workdir stripped.
	const promptShape = (w: Workload) =>
		JSON.stringify(w.prompts.map((p) => ({ ...p, text: p.text.replace(w.fixturesDir, "") })));
	check("same seed same prompts", promptShape(a) === promptShape(b));
	check("different seed differs", JSON.stringify(a.markers) !== JSON.stringify(c.markers));
	check("prompt script shape", a.prompts.length === 5 && a.prompts[3].phase === "tail" && a.prompts[4].phase === "retrieve");
	check("retrieval targets oldest round", a.prompts[4].expectMarker === a.markers[0]);
} finally {
	rmSync(dirA, { recursive: true, force: true });
	rmSync(dirB, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
