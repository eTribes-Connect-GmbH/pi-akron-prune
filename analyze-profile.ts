#!/usr/bin/env bun
/**
 * akron-prune effectiveness report over prune and cache profile JSONL.
 *
 * Usage: bun run analyze-profile.ts [profile.jsonl] [cache-profile.jsonl] [--json]
 * Default paths: ~/.pi/agent/akron-prune/profile.jsonl and cache-profile.jsonl
 */

import { existsSync, readFileSync } from "node:fs";
import { cacheProfileFile, profileFile } from "./config.js";
import { summarizeCacheProfiles, type CacheProfileRecord } from "./stats.js";

interface ProfileRecord {
	ts: number;
	sessionId: string;
	trigger: string;
	batches: number;
	items: number;
	charsPruned: number;
	charsAdded: number;
	failures: number;
	durationMs: number;
	git?: string;
}

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const positional = args.filter((arg) => !arg.startsWith("--"));
const prunePath = positional[0] ?? profileFile();
const cachePath = positional[1] ?? cacheProfileFile();

function readJsonl<T>(path: string, keep: (candidate: unknown) => candidate is T): T[] {
	if (!existsSync(path)) return [];
	const records: T[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (keep(parsed)) records.push(parsed);
		} catch {
			/* skip malformed lines */
		}
	}
	records.sort((a, b) => ((a as { ts: number }).ts < (b as { ts: number }).ts ? -1 : 1));
	return records;
}

function isPruneRecord(candidate: unknown): candidate is ProfileRecord {
	const record = candidate as Partial<ProfileRecord> | null;
	return !!record && typeof record.ts === "number" && typeof record.charsPruned === "number";
}

function isCacheRecord(candidate: unknown): candidate is CacheProfileRecord {
	const record = candidate as Partial<CacheProfileRecord> | null;
	return !!record && typeof record.ts === "number" && typeof record.totalTokens === "number";
}

const records = readJsonl(prunePath, isPruneRecord);
const cacheRecords = readJsonl(cachePath, isCacheRecord);
const firstRecord = records[0];

const fmt = (n: number) =>
	n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const fmtMoney = (n: number) => `$${n.toFixed(4)}`;
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtDur = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const shortId = (sessionId: string) => sessionId.slice(0, 8);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
const tokens = (chars: number) => Math.round(chars / 3.5); // rough estimate for tool-output text

let overall: Record<string, unknown> | null = null;
let triggers: Record<string, number> = {};
let perDay: Record<string, { events: number; netChars: number }> = {};
let perSession: Array<{ sessionId: string; events: number; netChars: number; medianGapMs: number | null; spanMs: number }> = [];

if (firstRecord) {
	const totalCharsPruned = sum(records.map((record) => record.charsPruned));
	const totalCharsAdded = sum(records.map((record) => record.charsAdded));
	overall = {
		window: { from: dayOf(firstRecord.ts), to: dayOf(records.reduce((latest, record) => Math.max(latest, record.ts), 0)) },
		events: records.length,
		batches: sum(records.map((record) => record.batches)),
		items: sum(records.map((record) => record.items)),
		charsPruned: totalCharsPruned,
		charsAdded: totalCharsAdded,
		netChars: totalCharsPruned - totalCharsAdded,
		overheadRatio: totalCharsPruned > 0 ? totalCharsAdded / totalCharsPruned : 0,
		estimatedTokensSaved: tokens(totalCharsPruned - totalCharsAdded),
		failures: sum(records.map((record) => record.failures)),
		medianPruneDurationMs: median(records.map((record) => record.durationMs)),
	};

	const triggerCounts = new Map<string, number>();
	for (const record of records) triggerCounts.set(record.trigger, (triggerCounts.get(record.trigger) ?? 0) + 1);
	triggers = Object.fromEntries(triggerCounts);

	const days = new Map<string, { events: number; netChars: number }>();
	for (const record of records) {
		const day = days.get(dayOf(record.ts)) ?? { events: 0, netChars: 0 };
		day.events += 1;
		day.netChars += record.charsPruned - record.charsAdded;
		days.set(dayOf(record.ts), day);
	}
	perDay = Object.fromEntries(days);

	const sessions = new Map<string, ProfileRecord[]>();
	for (const record of records) {
		const list = sessions.get(record.sessionId) ?? [];
		list.push(record);
		sessions.set(record.sessionId, list);
	}
	perSession = [...sessions.entries()].map(([sessionId, list]) => {
		const first = list[0]!;
		const last = list[list.length - 1]!;
		const gaps: number[] = [];
		for (let index = 1; index < list.length; index++) gaps.push(list[index].ts - list[index - 1].ts);
		return {
			sessionId: shortId(sessionId),
			events: list.length,
			netChars: sum(list.map((record) => record.charsPruned - record.charsAdded)),
			medianGapMs: gaps.length > 0 ? median(gaps) : null,
			spanMs: last.ts - first.ts,
		};
	});
	perSession.sort((a, b) => b.netChars - a.netChars);
}

const cacheSummary = summarizeCacheProfiles(cacheRecords);
const cachePerDay = new Map<string, { requests: number; promptTokens: number; cacheMeasuredPromptTokens: number; cacheRead: number }>();
for (const record of cacheRecords) {
	const day = cachePerDay.get(dayOf(record.ts)) ?? { requests: 0, promptTokens: 0, cacheMeasuredPromptTokens: 0, cacheRead: 0 };
	const promptTokens = (record.input ?? 0) + (record.cacheRead ?? 0) + (record.cacheWrite ?? 0);
	day.requests += 1;
	day.promptTokens += promptTokens;
	if (record.cacheRead !== undefined || record.cacheWrite !== undefined) day.cacheMeasuredPromptTokens += promptTokens;
	day.cacheRead += record.cacheRead ?? 0;
	cachePerDay.set(dayOf(record.ts), day);
}

if (jsonOut) {
	console.log(JSON.stringify({ overall, triggers, perDay, perSession, cache: cacheSummary, cachePerDay: Object.fromEntries(cachePerDay) }, null, 2));
	process.exit(0);
}

const pad = (label: string, width = 22) => `  ${label.padEnd(width)}`;

console.log(`akron-prune effectiveness — ${prunePath}`);
if (overall) {
	const stats = overall as {
		window: { from: string; to: string };
		events: number;
		batches: number;
		items: number;
		charsPruned: number;
		charsAdded: number;
		netChars: number;
		overheadRatio: number;
		estimatedTokensSaved: number;
		failures: number;
		medianPruneDurationMs: number;
	};
	console.log(`window ${stats.window.from} .. ${stats.window.to}\n`);
	console.log("overall");
	console.log(`${pad("events")}${stats.events} (batches ${stats.batches}, items ${stats.items})`);
	console.log(`${pad("chars pruned")}${fmt(stats.charsPruned)}  (~${fmt(stats.estimatedTokensSaved)} net tokens @3.5 chars/token)`);
	console.log(`${pad("added back")}${fmt(stats.charsAdded)}  (overhead ${fmtPct(stats.overheadRatio)} — refs, stubs, checkpoints)`);
	console.log(`${pad("net savings")}${fmt(stats.netChars)}`);
	console.log(`${pad("failures")}${stats.failures}`);
	console.log(`${pad("median prune time")}${fmtDur(stats.medianPruneDurationMs)}`);

	console.log("\ntriggers");
	console.log(`  ${Object.entries(triggers).map(([trigger, count]) => `${trigger} ${count}`).join("  |  ")}`);

	console.log("\nper day");
	for (const [day, stats] of Object.entries(perDay).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		console.log(`  ${day}  events ${String(stats.events).padStart(3)}  net ${fmt(stats.netChars).padStart(8)}`);
	}

	console.log("\nper session (top 8 by net savings, gap = median time between prunes)");
	for (const session of perSession.slice(0, 8)) {
		const gap = session.medianGapMs === null ? "single" : `every ${fmtDur(session.medianGapMs).padStart(6)}`;
		console.log(`  ${session.sessionId}  events ${String(session.events).padStart(3)}  net ${fmt(session.netChars).padStart(8)}  cadence ${gap}  span ${fmtDur(session.spanMs)}`);
	}
} else {
	console.log(`no prune records in ${prunePath}`);
}

console.log(`\ncache usage — ${cachePath}`);
if (cacheRecords.length === 0) {
	console.log("  no cache usage records yet");
} else {
	console.log(`${pad("requests")}${cacheSummary.requests}`);
	console.log(`${pad("prompt tokens")}${fmt(cacheSummary.promptTokens)}  (input ${fmt(cacheSummary.input)}, read ${fmt(cacheSummary.cacheRead)}, write ${fmt(cacheSummary.cacheWrite)})`);
	console.log(`${pad("output tokens")}${fmt(cacheSummary.output)}`);
	console.log(`${pad("cache hit ratio")}${fmtPct(cacheSummary.cacheHitRatio)}`);
	console.log(`${pad("cache write ratio")}${fmtPct(cacheSummary.cacheWriteRatio)}`);
	if (cacheSummary.costTotal > 0) console.log(`${pad("observed cost")}${fmtMoney(cacheSummary.costTotal)}`);

	console.log("\ncache by model (top 8 by cache-read tokens)");
	for (const row of cacheSummary.perModel.slice(0, 8)) {
		console.log(
			`  ${row.provider}/${row.model}  requests ${String(row.requests).padStart(3)}  hit ${fmtPct(row.cacheHitRatio).padStart(6)}  read ${fmt(row.cacheRead).padStart(8)}  prompt ${fmt(row.promptTokens).padStart(8)}`,
		);
	}

	console.log("\ncache by day");
	for (const [day, stats] of [...cachePerDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		const hitRatio = stats.cacheMeasuredPromptTokens > 0 ? stats.cacheRead / stats.cacheMeasuredPromptTokens : 0;
		console.log(`  ${day}  requests ${String(stats.requests).padStart(3)}  hit ${fmtPct(hitRatio).padStart(6)}  prompt ${fmt(stats.promptTokens).padStart(8)}`);
	}
}
