/**
 * Aggregation + report for the pruning benchmark.
 *
 * Runner.ts owns benchmark execution; this file owns pure aggregation plus
 * a tiny CLI: bun run report.ts <resultsDir> [--json]
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TurnRow {
	arm: string;
	rep: number;
	phase: string;
	round: number;
	promptChars: number;
	wallMs: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
	contextTokens: number | null;
	contextPercent: number | null;
	toolCalls: number;
	recoverCalls: number;
	assistantChars: number;
	retrievalCorrect: boolean | null;
	testPassed?: boolean | null;
	testMs?: number | null;
	testOutputChars?: number;
	failed: boolean;
}

export interface RunMeta {
	arm: string;
	rep: number;
	sessionFile: string | null;
	pruneEvents: number;
	prunedChars: number;
	compactionEvents: number;
	extensionErrors: number;
}

export interface ArmSummary {
	arm: string;
	prompts: number;
	failedPrompts: number;
	totalWallMs: number;
	medianWallMs: number;
	p90WallMs: number;
	fillMedianWallMs: number;
	totalCost: number;
	totalInput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalOutput: number;
	cacheHitRatio: number | null;
	maxContextTokens: number | null;
	maxContextPercent: number | null;
	recoverCalls: number;
	pruneEvents: number;
	prunedChars: number;
	compactionEvents: number;
	extensionErrors: number;
	testPassed: number;
	testTotal: number;
	testPassRate: number | null;
	testMedianMs: number;
	testOutputChars: number;
	retrievalCorrect: number;
	retrievalTotal: number;
}

/** Linear-interpolation percentile on an unsorted copy. */
export function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = p * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	const frac = rank - lo;
	return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

function isPromptSide(row: TurnRow): boolean {
	return !row.failed;
}

export function aggregateArm(rows: TurnRow[], metas: RunMeta[]): ArmSummary {
	const scored = rows.filter(isPromptSide);
	const wall = scored.map((row) => row.wallMs);
	const fillWall: number[] = [];
	for (const row of scored) {
		if (row.phase === "task") fillWall.push(row.wallMs);
	}

	let totalInput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalOutput = 0;
	let totalCost = 0;
	for (const row of rows) {
		totalInput += row.usage.input;
		totalCacheRead += row.usage.cacheRead;
		totalCacheWrite += row.usage.cacheWrite;
		totalOutput += row.usage.output;
		totalCost += row.usage.cost;
	}
	const promptSide = totalCacheRead + totalInput + totalCacheWrite;

	return {
		arm: rows[0]?.arm ?? metas[0]?.arm ?? "(none)",
		prompts: rows.length,
		failedPrompts: rows.filter((row) => row.failed).length,
		totalWallMs: rows.reduce((sum, row) => sum + row.wallMs, 0),
		medianWallMs: percentile(wall, 0.5) ?? 0,
		p90WallMs: percentile(wall, 0.9) ?? 0,
		fillMedianWallMs: percentile(fillWall, 0.5) ?? 0,
		totalCost,
		totalInput,
		totalCacheRead,
		totalCacheWrite,
		totalOutput,
		cacheHitRatio: promptSide > 0 ? totalCacheRead / promptSide : null,
		maxContextTokens: maxNullable(rows.map((row) => row.contextTokens)),
		maxContextPercent: maxNullable(rows.map((row) => row.contextPercent)),
		recoverCalls: rows.reduce((sum, row) => sum + row.recoverCalls, 0),
		pruneEvents: metas.reduce((sum, meta) => sum + meta.pruneEvents, 0),
		prunedChars: metas.reduce((sum, meta) => sum + meta.prunedChars, 0),
		compactionEvents: metas.reduce((sum, meta) => sum + meta.compactionEvents, 0),
		extensionErrors: metas.reduce((sum, meta) => sum + meta.extensionErrors, 0),
		testPassed: rows.filter((row) => row.testPassed === true).length,
		testTotal: rows.filter((row) => row.testPassed !== null && row.testPassed !== undefined).length,
		testPassRate: testPassRate(rows),
		testMedianMs: percentile(rows.map((row) => row.testMs).filter((ms): ms is number => typeof ms === "number"), 0.5) ?? 0,
		testOutputChars: rows.reduce((sum, row) => sum + (row.testOutputChars ?? 0), 0),
		retrievalCorrect: rows.filter((row) => row.retrievalCorrect === true).length,
		retrievalTotal: rows.filter((row) => row.retrievalCorrect !== null).length,
	};
}

function testPassRate(rows: TurnRow[]): number | null {
	const total = rows.filter((row) => row.testPassed !== null && row.testPassed !== undefined).length;
	if (total === 0) return null;
	return rows.filter((row) => row.testPassed === true).length / total;
}

function maxNullable(values: Array<number | null>): number | null {
	let max: number | null = null;
	for (const value of values) {
		if (value === null) continue;
		max = max === null ? value : Math.max(max, value);
	}
	return max;
}

function fmtMs(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtTokens(tokens: number): string {
	return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2)}M` : `${Math.round(tokens / 1000)}k`;
}

function fmtMaxContext(summary: ArmSummary): string {
	if (summary.maxContextTokens === null) return "n/a";
	const percent = summary.maxContextPercent === null ? "?" : `${summary.maxContextPercent.toFixed(1)}%`;
	return `${fmtTokens(summary.maxContextTokens)}/${percent}`;
}

export function formatReport(summaries: ArmSummary[]): string {
	const header =
		"arm    prompts  fail  tests   cost$    wall     p50/p90      task-p50   hit     in/rd/wr (tok)        maxctx       recover  prune/comp";
	const lines = summaries.map((summary) => {
		const hit = summary.cacheHitRatio === null ? "n/a" : `${(summary.cacheHitRatio * 100).toFixed(1)}%`;
		const tests = summary.testTotal === 0 ? "n/a" : `${summary.testPassed}/${summary.testTotal}`;
		return [
			summary.arm.padEnd(6),
			String(summary.prompts).padEnd(8),
			String(summary.failedPrompts).padEnd(5),
			tests.padEnd(7),
			summary.totalCost.toFixed(4).padEnd(8),
			fmtMs(summary.totalWallMs).padEnd(8),
			`${fmtMs(summary.medianWallMs)}/${fmtMs(summary.p90WallMs)}`.padEnd(12),
			fmtMs(summary.fillMedianWallMs).padEnd(10),
			hit.padEnd(7),
			`${fmtTokens(summary.totalInput)}/${fmtTokens(summary.totalCacheRead)}/${fmtTokens(summary.totalCacheWrite)}`.padEnd(21),
			fmtMaxContext(summary).padEnd(12),
			String(summary.recoverCalls).padEnd(8),
			`${summary.pruneEvents}/${summary.compactionEvents}`.padEnd(11),
		].join(" ");
	});
	return [header, ...lines].join("\n");
}

export function loadReport(resultsDir: string): ArmSummary[] {
	const rows = readJsonl<TurnRow>(join(resultsDir, "results.jsonl"));
	const summary = readJson<{ runs?: RunMeta[] }>(join(resultsDir, "summary.json"));
	const metas = summary.runs ?? [];
	const arms = [...new Set([...rows.map((row) => row.arm), ...metas.map((meta) => meta.arm)])].sort();
	return arms.map((arm) => aggregateArm(rows.filter((row) => row.arm === arm), metas.filter((meta) => meta.arm === arm)));
}

function readJson<T>(path: string): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		throw new Error(`failed to parse ${path}: ${(error as Error).message}`);
	}
}

function readJsonl<T>(path: string): T[] {
	const rows: T[] = [];
	let lineNumber = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		lineNumber += 1;
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as T);
		} catch (error) {
			throw new Error(`failed to parse ${path}:${lineNumber}: ${(error as Error).message}`);
		}
	}
	return rows;
}

function main(argv: string[]): void {
	const dir = argv.find((arg) => !arg.startsWith("--"));
	if (!dir) {
		console.error("usage: bun run report.ts <resultsDir> [--json]");
		process.exit(1);
	}
	const summaries = loadReport(dir);
	console.log(argv.includes("--json") ? JSON.stringify(summaries, null, 2) : formatReport(summaries));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
