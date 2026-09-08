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
		testPassed: null,
		testMs: null,
		testOutputChars: 0,
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

// aggregation: sums, cache-hit ratio, test results, prune/compaction events
const rows: TurnRow[] = [
	row({ phase: "task", wallMs: 1000, contextTokens: 10_000, contextPercent: 10, recoverCalls: 1, testPassed: true, testMs: 90, testOutputChars: 1000 }),
	row({ phase: "task", wallMs: 2000, contextTokens: 30_000, contextPercent: 30, recoverCalls: 2, testPassed: false, testMs: 110, testOutputChars: 2000, usage: { input: 2000, output: 20, cacheRead: 18_000, cacheWrite: 0, totalTokens: 20_020, cost: 0.02 } }),
	row({ phase: "final", wallMs: 500, contextTokens: 20_000, contextPercent: 20, testPassed: true, testMs: 100, testOutputChars: 3000 }),
	row({ phase: "task", wallMs: 400, retrievalCorrect: true, testPassed: true, testMs: 120 }),
	row({ phase: "task", wallMs: 300, retrievalCorrect: null, testPassed: null, failed: true }),
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
check("aggregate task median wall", summary.fillMedianWallMs === 1000);
check("aggregate prune events", summary.pruneEvents === 3);
check("aggregate pruned chars", summary.prunedChars === 60_000);
check("aggregate compaction events", summary.compactionEvents === 0);
check("aggregate tests scored", summary.testTotal === 4 && summary.testPassed === 3);
check("aggregate test pass rate", summary.testPassRate === 0.75);
check("aggregate test median ms", summary.testMedianMs === 105);
check("aggregate test output chars", summary.testOutputChars === 6000);
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
check("report includes test score", formatted.includes("3/4"));

// workload determinism: same seed → identical prompt script
const dirA = mkdtempSync(join(tmpdir(), "akron-bench-a-"));
const dirB = mkdtempSync(join(tmpdir(), "akron-bench-b-"));
try {
	const a = createWorkload({ rounds: 3, fixtureBytes: 512, seed: 7, workdir: dirA });
	const b = createWorkload({ rounds: 3, fixtureBytes: 512, seed: 7, workdir: dirB });
	const c = createWorkload({ rounds: 3, fixtureBytes: 512, seed: 8, workdir: dirB });
	// Prompt texts embed absolute project/briefing paths, so compare with the workdir stripped.
	const promptShape = (w: Workload) =>
		JSON.stringify(
			w.prompts.map((p) => ({
				...p,
				text: p.text.replaceAll(w.projectDir, "<project>").replaceAll(w.evidenceDir, "<evidence>"),
			})),
		);
	check("same seed same prompts", promptShape(a) === promptShape(b));
	check("different seed same prompt script", promptShape(a) === promptShape(c));
	check("prompt script shape", a.prompts.length === 4 && a.prompts[0].phase === "task" && a.prompts[3].phase === "final");
	check("test command shape", JSON.stringify(a.testCommand) === JSON.stringify(["npm", "test"]));
} finally {
	rmSync(dirA, { recursive: true, force: true });
	rmSync(dirB, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
