/**
 * akron-prune — profiling stats helpers.
 *
 * Prune-event stats measure context saved when artifacts are created.
 * Cache-profile records measure observed provider usage on completed
 * assistant responses, so cache hit rates are based on actual usage fields
 * rather than inferred from prune cadence.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { cacheProfileFile } from "./config.js";
import type { PruneIndex } from "./types.js";

export interface UsageCostProfile {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
}

export interface CacheProfileRecord {
	ts: number;
	sessionId: string;
	provider: string;
	model: string;
	api?: string;
	stopReason?: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: UsageCostProfile;
	prunedEntries: number;
	checkpoints: number;
	prunedChars: number;
}

type AssistantLike = {
	role?: string;
	provider?: string;
	model?: string;
	api?: string;
	stopReason?: string;
	timestamp?: number;
	usage?: {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		totalTokens?: unknown;
		cost?: Record<string, unknown>;
	};
};

function readNumber(raw: unknown): number | undefined {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function buildCostProfile(cost: Record<string, unknown> | undefined): UsageCostProfile | undefined {
	if (!cost) return undefined;
	const profile: UsageCostProfile = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
		const amount = readNumber(cost[key]);
		if (amount !== undefined && amount !== 0) profile[key] = amount;
	}
	return Object.keys(profile).length > 0 ? profile : undefined;
}

function sumTokens(...amounts: Array<number | undefined>): number {
	return amounts.reduce<number>((total, amount) => total + (amount ?? 0), 0);
}

export function buildCacheProfileRecord(
	message: AssistantLike,
	index: PruneIndex,
	sessionId: string,
): CacheProfileRecord | null {
	if (message.role !== "assistant" || !message.usage) return null;
	const input = readNumber(message.usage.input);
	const output = readNumber(message.usage.output);
	const cacheRead = readNumber(message.usage.cacheRead);
	const cacheWrite = readNumber(message.usage.cacheWrite);
	const totalTokens = readNumber(message.usage.totalTokens) ?? sumTokens(input, output, cacheRead, cacheWrite);
	if (totalTokens === 0) return null;

	const entries = Object.values(index.entries);
	const record: CacheProfileRecord = {
		ts: readNumber(message.timestamp) ?? Date.now(),
		sessionId,
		provider: message.provider ?? "unknown",
		model: message.model ?? "unknown",
		api: message.api,
		stopReason: message.stopReason,
		totalTokens,
		cost: buildCostProfile(message.usage.cost),
		prunedEntries: entries.length,
		checkpoints: index.checkpoints.length,
		prunedChars: entries.reduce((total, entry) => total + entry.prunedChars, 0),
	};
	if (input !== undefined) record.input = input;
	if (output !== undefined) record.output = output;
	if (cacheRead !== undefined) record.cacheRead = cacheRead;
	if (cacheWrite !== undefined) record.cacheWrite = cacheWrite;
	return record;
}

export function appendCacheProfile(record: CacheProfileRecord): void {
	try {
		const path = cacheProfileFile();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch {
		/* profiling must never break agent execution */
	}
}

function isCacheProfileRecord(candidate: unknown): candidate is CacheProfileRecord {
	const record = candidate as Partial<CacheProfileRecord> | null;
	if (!record) return false;
	return typeof record.ts === "number" && typeof record.sessionId === "string";
}

function addCacheRecordLine(records: CacheProfileRecord[], line: string, sessionId: string, limit: number): void {
	if (records.length >= limit || !line.trim()) return;
	try {
		const parsed = JSON.parse(line) as unknown;
		if (isCacheProfileRecord(parsed) && parsed.sessionId === sessionId) records.push(parsed);
	} catch {
		/* skip malformed lines */
	}
}

export function readCacheProfilesForSession(sessionId: string, limit: number): CacheProfileRecord[] {
	const maxRecords = Math.max(0, limit);
	if (maxRecords === 0) return [];
	try {
		const path = cacheProfileFile();
		if (!existsSync(path)) return [];
		const fd = openSync(path, "r");
		try {
			const records: CacheProfileRecord[] = [];
			const chunkSize = 64 * 1024;
			let position = statSync(path).size;
			let prefix = "";
			while (position > 0 && records.length < maxRecords) {
				const bytesToRead = Math.min(chunkSize, position);
				position -= bytesToRead;
				const buffer = Buffer.allocUnsafe(bytesToRead);
				const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
				const lines = `${buffer.subarray(0, bytesRead).toString("utf8")}${prefix}`.split("\n");
				prefix = lines.shift() ?? "";
				for (let index = lines.length - 1; index >= 0; index--) {
					addCacheRecordLine(records, lines[index], sessionId, maxRecords);
				}
			}
			addCacheRecordLine(records, prefix, sessionId, maxRecords);
			const chronological: CacheProfileRecord[] = [];
			for (let index = records.length - 1; index >= 0; index--) chronological.push(records[index]);
			return chronological;
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
}

export interface CacheTokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	promptTokens: number;
	cacheMeasuredPromptTokens: number;
	totalTokens: number;
	costTotal: number;
}

export interface CacheProfileSummary extends CacheTokenTotals {
	requests: number;
	cacheHitRatio: number;
	cacheWriteRatio: number;
	perModel: Array<CacheTokenTotals & { provider: string; model: string; requests: number; cacheHitRatio: number }>;
}

function newTokenTotals(): CacheTokenTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		promptTokens: 0,
		cacheMeasuredPromptTokens: 0,
		totalTokens: 0,
		costTotal: 0,
	};
}

function addCacheRecord(totals: CacheTokenTotals, record: CacheProfileRecord): void {
	const input = record.input ?? 0;
	const cacheRead = record.cacheRead ?? 0;
	const cacheWrite = record.cacheWrite ?? 0;
	const promptTokens = input + cacheRead + cacheWrite;
	totals.input += input;
	totals.output += record.output ?? 0;
	totals.cacheRead += cacheRead;
	totals.cacheWrite += cacheWrite;
	totals.promptTokens += promptTokens;
	if (record.cacheRead !== undefined || record.cacheWrite !== undefined) {
		totals.cacheMeasuredPromptTokens += promptTokens;
	}
	totals.totalTokens += record.totalTokens ?? 0;
	totals.costTotal += record.cost?.total ?? 0;
}

function cacheHitRatio(totals: CacheTokenTotals): number {
	return totals.cacheMeasuredPromptTokens > 0 ? totals.cacheRead / totals.cacheMeasuredPromptTokens : 0;
}

export function summarizeCacheProfiles(records: CacheProfileRecord[]): CacheProfileSummary {
	const totals = newTokenTotals();
	const perModel = new Map<string, CacheProfileSummary["perModel"][number]>();
	for (const record of records) {
		addCacheRecord(totals, record);
		const key = `${record.provider}\0${record.model}`;
		const modelStats = perModel.get(key) ?? {
			...newTokenTotals(),
			provider: record.provider,
			model: record.model,
			requests: 0,
			cacheHitRatio: 0,
		};
		modelStats.requests += 1;
		addCacheRecord(modelStats, record);
		perModel.set(key, modelStats);
	}

	const modelRows = [...perModel.values()].map((modelStats) => ({
		...modelStats,
		cacheHitRatio: cacheHitRatio(modelStats),
	}));
	modelRows.sort((a, b) => b.cacheRead - a.cacheRead || b.requests - a.requests);

	return {
		requests: records.length,
		...totals,
		cacheHitRatio: cacheHitRatio(totals),
		cacheWriteRatio: totals.cacheMeasuredPromptTokens > 0 ? totals.cacheWrite / totals.cacheMeasuredPromptTokens : 0,
		perModel: modelRows,
	};
}

export interface StatusPendingInfo {
	batches: unknown[];
	items: number;
	chars: number;
}

export interface StatusContextUsage {
	tokens: number | null;
	contextWindow: number;
}

function formatCompact(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.max(0, Math.round(n)));
}

function formatPercent(n: number): string {
	return `${(n * 100).toFixed(1)}%`;
}

function formatCompactionHeadroom(contextUsage: StatusContextUsage | undefined, reserveTokens: number): string {
	if (!contextUsage || contextUsage.tokens === null) return "⏳?";
	const threshold = Math.max(0, contextUsage.contextWindow - reserveTokens);
	const remaining = threshold - contextUsage.tokens;
	if (remaining <= 0) return "⏳due";
	return `⏳${formatCompact(remaining)}`;
}

function formatPending(pending: StatusPendingInfo): string {
	if (pending.items === 0) return "✂idle";
	return `✂${pending.items}/${formatCompact(pending.chars)}`;
}

export function formatStatusLine(
	pending: StatusPendingInfo,
	cacheRecords: CacheProfileRecord[],
	contextUsage: StatusContextUsage | undefined,
	reserveTokens = 16_384,
): string {
	const cacheSummary = summarizeCacheProfiles(cacheRecords);
	const hit = cacheSummary.cacheMeasuredPromptTokens > 0 ? formatPercent(cacheSummary.cacheHitRatio) : "n/a";
	return `↻${hit} ⧉${formatCompact(cacheSummary.cacheRead)} ${formatCompactionHeadroom(contextUsage, reserveTokens)} ${formatPending(pending)}`;
}
