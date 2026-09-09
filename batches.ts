/**
 * akron-prune — stateless batch computation.
 *
 * Batches are recomputed from the outgoing message array on every LLM call:
 * a batch is the tool activity of one assistant message, or the images of
 * one user message. Because nothing here depends on in-memory state, batch
 * identity is stable across restarts, /resume, and tree navigation. What
 * has *already been pruned* is answered by the durable index, which is
 * also why fully-pruned batches stop occupying slots in the "newest N"
 * window — the window slides forward on its own.
 */

import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { Batch, BatchItem, PendingInfo, PruneIndex } from "./types.js";
import type { AkronConfig } from "./config.js";

/** Small, fast, stable string hash for keys. */
export function djb2(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff;
	}
	return (h >>> 0).toString(16);
}

/**
 * Stable key for a user message carrying images. Derived from timestamp
 * plus a hash of the text content — both are stored in the session, so the
 * key is identical on every rebuild.
 */
export function userKey(msg: { content?: unknown; timestamp?: number }): string {
	let text = "";
	if (typeof msg.content === "string") {
		text = msg.content;
	} else if (Array.isArray(msg.content)) {
		text = (msg.content as Array<{ type?: string; text?: string }>)
			.filter((b) => b?.type === "text")
			.map((b) => b.text ?? "")
			.join(" ");
	}
	return `u:${msg?.timestamp ?? 0}:${djb2(text.slice(0, 300))}`;
}

/** Filesystem-safe, collision-resistant artifact basename. */
export function sanitizeId(id: string): string {
	const clean = String(id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	return `${clean}-${djb2(String(id))}`;
}

/** Character size of a message content array (images approximated from base64). */
export function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const b of content as Array<{ type?: string; text?: string; data?: string }>) {
		if (b?.type === "text" && typeof b.text === "string") n += b.text.length;
		else if (b?.type === "image" && typeof b.data === "string") n += Math.ceil(b.data.length * 0.75);
	}
	return n;
}

/** Character size of image blocks only (for user messages). */
export function imageOnlyChars(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let n = 0;
	for (const b of content as Array<{ type?: string; data?: string }>) {
		if (b?.type === "image" && typeof b.data === "string") n += Math.ceil(b.data.length * 0.75);
	}
	return n;
}

/** Cheap size estimate for tool call arguments without full serialization. */
export function argsChars(input: unknown): number {
	if (input === null || input === undefined) return 0;
	if (typeof input === "string") return input.length;
	if (typeof input !== "object") return 8;
	let n = 16;
	for (const v of Object.values(input as Record<string, unknown>)) {
		if (typeof v === "string") n += v.length;
		else if (v === null || v === undefined) n += 4;
		else if (typeof v === "number" || typeof v === "boolean") n += 8;
		else n += JSON.stringify(v).length;
	}
	return n;
}

/**
 * Working-instruction reads (markdown, skills, AGENTS.md-style files)
 * remain verbatim in context — they stay useful as instructions and are
 * cheap relative to their value.
 */
function readPath(input: unknown): string {
	return String((input as { path?: string } | undefined)?.path ?? "");
}

function pathKey(path: string, cwd: string): string {
	const p = path.trim();
	if (!p) return "";
	return (isAbsolute(p) ? resolve(p) : resolve(cwd, p)).toLowerCase();
}

function isPreservedRead(toolName: string, input: unknown, cfg: AkronConfig, mutatedMarkdownPaths: Set<string>, cwd: string): boolean {
	if (toolName !== "read" || cfg.preserveReadExtensions.length === 0) return false;
	const p = readPath(input).toLowerCase();
	if (mutatedMarkdownPaths.has(pathKey(p, cwd))) return false;
	return cfg.preserveReadExtensions.some((ext) => p.endsWith(ext));
}

/** Loose structural superset of pi's AgentMessage — see types.ts. */
export type AnyMessage = {
	role?: string;
	content?: unknown;
	timestamp?: number;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
};

function stableString(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

function hasLaterAssistant(messages: AnyMessage[], msgIndex: number): boolean {
	for (let i = msgIndex + 1; i < messages.length; i++) {
		if (messages[i]?.role === "assistant") return true;
	}
	return false;
}

function hasImageBlock(blocks: unknown[] | undefined): boolean {
	return !!blocks?.some((b) => (b as { type?: string } | undefined)?.type === "image");
}

function mutationPath(item: BatchItem, cfg: AkronConfig): string | null {
	if (item.kind !== "args" || item.isError || !cfg.mutationTools.includes(item.toolName ?? "")) return null;
	const path = String((item.input as { path?: unknown } | undefined)?.path ?? "").trim();
	return path || null;
}

function readCandidateKey(item: BatchItem): string | null {
	if (item.kind !== "result" || item.toolName !== "read") return null;
	return `${stableString(item.input)}:${item.chars}`;
}

function markConsumedEvidence(messages: AnyMessage[], batches: Batch[], cfg: AkronConfig): void {
	const readGroups = new Map<string, BatchItem[]>();
	const mutationItems: Array<{ path: string; item: BatchItem }> = [];

	for (const batch of batches) {
		for (const item of batch.items) {
			const readKey = readCandidateKey(item);
			if (readKey) {
				const group = readGroups.get(readKey) ?? [];
				group.push(item);
				readGroups.set(readKey, group);
			}

			const path = mutationPath(item, cfg);
			if (path && hasLaterAssistant(messages, item.msgIndex)) mutationItems.push({ path, item });

			if (
				item.kind === "result" &&
				item.pairRemovalSafe !== false &&
				item.toolName === "agent_browser" &&
				hasImageBlock(item.blocks) &&
				hasLaterAssistant(messages, item.msgIndex)
			) {
				item.rewrite = "removePair";
				item.pruneReason = "consumed-browser-screenshot";
			}
		}
	}

	for (const group of readGroups.values()) {
		if (group.length < 2) continue;
		const candidates = group.map((item) => ({
			item,
			output: createHash("sha256").update(stableString(item.blocks ?? [])).digest("hex"),
		}));
		const latestByOutput = new Map<string, BatchItem>();
		for (const { item, output } of candidates) {
			const latest = latestByOutput.get(output);
			if (!latest || item.msgIndex > latest.msgIndex) latestByOutput.set(output, item);
		}
		for (const { item, output } of candidates) {
			if (item.pairRemovalSafe !== false && latestByOutput.get(output) !== item && hasLaterAssistant(messages, item.msgIndex)) {
				item.rewrite = "removePair";
				item.pruneReason = "repeated-read";
			}
		}
	}

	const seenPaths = new Set<string>();
	mutationItems.sort((a, b) => b.item.msgIndex - a.item.msgIndex);
	for (const { path, item } of mutationItems) {
		if (seenPaths.has(path)) {
			item.rewrite = "removePair";
			item.pruneReason = "superseded-mutation";
		} else {
			seenPaths.add(path);
		}
	}

	const removePairs = new Map<string, string>();
	for (const batch of batches) {
		for (const item of batch.items) {
			if (item.rewrite === "removePair" && item.toolCallId) removePairs.set(item.toolCallId, item.pruneReason ?? "remove-pair");
		}
	}
	for (const batch of batches) {
		for (const item of batch.items) {
			const reason = item.toolCallId ? removePairs.get(item.toolCallId) : undefined;
			if (reason) {
				item.rewrite = "removePair";
				item.pruneReason = item.pruneReason ?? reason;
			}
		}
	}
}

/**
 * Computes all batches that still contain prunable content. Each batch:
 *   - anchors at the assistant message that issued the tool calls (its
 *     first toolCall id), or at the user message that uploaded images
 *   - is "complete" only once a later assistant message has consumed it,
 *     which protects unprocessed tool output and user images
 */
export function computeBatches(messages: AnyMessage[], index: PruneIndex, cfg: AkronConfig, cwd = process.cwd()): Batch[] {
	const last = messages.length - 1;

	// toolCallId → matching call block metadata for lossless pair removal
	const calls = new Map<string, { name: string; input: unknown; msgIndex: number; block: unknown; signedTurn: boolean }>();
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			const blocks = m.content as Array<{
				type?: string;
				id?: string;
				name?: string;
				arguments?: unknown;
				input?: unknown;
				thoughtSignature?: unknown;
				textSignature?: unknown;
				thinkingSignature?: unknown;
			}>;
			const signedTurn = blocks.some((block) =>
				[block.thoughtSignature, block.textSignature, block.thinkingSignature].some(
					(signature) => typeof signature === "string" && signature.length > 0,
				),
			);
			for (const block of blocks) {
				if (block?.type === "toolCall" && block.id) {
					calls.set(block.id, {
						name: block.name ?? "",
						input: block.arguments ?? block.input ?? {},
						msgIndex: i,
						block,
						signedTurn,
					});
				}
			}
		}
	}

	const batchMap = new Map<number, Batch>();
	const successfulMutations = new Set<string>();

	const getToolBatch = (assistantIdx: number): Batch => {
		let batch = batchMap.get(assistantIdx);
		if (!batch) {
			let anchor = "";
			const m = messages[assistantIdx];
			for (const c of (m.content as Array<{ type?: string; id?: string }>) ?? []) {
				if (c?.type === "toolCall" && c.id) {
					anchor = c.id;
					break;
				}
			}
			batch = {
				anchorMsgIndex: assistantIdx,
				anchorKey: anchor,
				anchorIsUser: false,
				items: [],
				chars: 0,
				lastMsgIndex: assistantIdx,
				complete: false,
			};
			batchMap.set(assistantIdx, batch);
		}
		return batch;
	};

	for (const m of messages) {
		if (m?.role !== "toolResult" || !m.toolCallId || m.isError) continue;
		const info = calls.get(m.toolCallId);
		if (!info || !cfg.mutationTools.includes(info.name)) continue;
		const p = readPath(info.input).toLowerCase();
		if (p && cfg.preserveReadExtensions.some((ext) => p.endsWith(ext))) successfulMutations.add(pathKey(p, cwd));
	}

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];

		if (m?.role === "toolResult" && m.toolCallId) {
			const info = calls.get(m.toolCallId);
			if (!info) continue;
			const batch = getToolBatch(info.msgIndex);
			const input = info.input;
			const pairResultBlocks = Array.isArray(m.content) ? (m.content as unknown[]) : undefined;

			// 1) the tool result content itself
			const resultKey = `tc:${m.toolCallId}`;
			if (!index.entries[resultKey] && !isPreservedRead(info.name, input, cfg, successfulMutations, cwd)) {
				const chars = contentChars(m.content);
				if (chars >= cfg.minResultChars && (cfg.pruneErrors || !m.isError)) {
					const item: BatchItem = {
						kind: "result",
						key: resultKey,
						toolName: m.toolName ?? info.name,
						toolCallId: m.toolCallId,
						input,
						msgIndex: i,
						chars,
						isError: !!m.isError,
						blocks: pairResultBlocks,
						pairCall: info.block,
						pairRemovalSafe: !info.signedTurn,
						pairResultBlocks,
					};
					batch.items.push(item);
				}
			}

			// 2) bulk tool-call arguments (file mutations, huge bash commands)
			const argsKey = `tc:${m.toolCallId}:args`;
			if (!index.entries[argsKey] && !info.signedTurn) {
				const aChars = argsChars(input);
				let prunable = false;
				if (cfg.mutationTools.includes(info.name)) {
					prunable = aChars >= cfg.minResultChars;
				} else if (info.name === "bash" && typeof (input as { command?: unknown })?.command === "string") {
					prunable = (input as { command: string }).command.length > cfg.stubBashArgsOver;
				}
				if (prunable) {
					batch.items.push({
						kind: "args",
						key: argsKey,
						toolName: info.name,
						toolCallId: m.toolCallId,
						input,
						msgIndex: info.msgIndex,
						argsMsgIndex: info.msgIndex,
						chars: aChars,
						isError: !!m.isError,
						pairCall: info.block,
						pairResultBlocks,
					});
				}
			}

			if (i > batch.lastMsgIndex) batch.lastMsgIndex = i;
		}

		if (m?.role === "user" && Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((b) => b?.type === "image")) {
			const key = userKey(m);
			if (!index.entries[key]) {
				const chars = imageOnlyChars(m.content);
				if (chars > 0) {
					batchMap.set(i, {
						anchorMsgIndex: i,
						anchorKey: key,
						anchorIsUser: true,
						items: [{ kind: "userImage", key, msgIndex: i, chars, blocks: m.content }],
						chars,
						lastMsgIndex: i,
						complete: false,
					});
				}
			}
		}
	}

	const batches = [...batchMap.values()]
		.filter((b) => b.items.length > 0)
		.sort((a, b) => a.anchorMsgIndex - b.anchorMsgIndex);

	for (const b of batches) {
		b.chars = b.items.reduce((s, item) => s + item.chars, 0);
		b.complete = b.lastMsgIndex < last && hasLaterAssistant(messages, b.lastMsgIndex);
	}
	markConsumedEvidence(messages, batches, cfg);

	return batches;
}

export interface PendingOptions {
	/** Maximum protected working-set chars in the newest batch suffix. */
	keepChars?: number;
	/** Always keep at least this many newest batches, even if keepChars is exceeded. */
	minKeepBatches?: number;
	/** Select only enough oldest non-protected batches to reach this many chars. */
	targetChars?: number;
	/** Also select consumed redundant pair-removal items inside the protected suffix. */
	includeRedundant?: boolean;
}

function recalc(batch: Batch): void {
	batch.chars = batch.items.reduce((total, item) => total + item.chars, 0);
	batch.lastMsgIndex = batch.items.reduce((last, item) => Math.max(last, item.msgIndex), batch.anchorMsgIndex);
}

function addBatch(target: Batch[], batch: Batch, items: BatchItem[]): void {
	const selected = items.filter((item) => !target.some((b) => b.items.some((existing) => existing.key === item.key)));
	if (selected.length === 0) return;
	const copy: Batch = { ...batch, items: selected.slice() };
	recalc(copy);
	target.push(copy);
}

function protectedStartOf(eligible: Batch[], window: number, opts: PendingOptions): number {
	const maxKeep = Math.max(0, Math.min(window, eligible.length));
	const minKeep = Math.max(0, Math.min(opts.minKeepBatches ?? 0, eligible.length));
	let kept = 0;
	let keptChars = 0;
	let start = eligible.length;

	for (let i = eligible.length - 1; i >= 0; i--) {
		const batch = eligible[i];
		const mustKeep = kept < minKeep;
		const underCount = kept < maxKeep;
		const underBudget = opts.keepChars === undefined || keptChars + batch.chars <= opts.keepChars;
		if (!mustKeep && (!underCount || !underBudget)) break;
		kept++;
		keptChars += batch.chars;
		start = i;
	}
	return start;
}

/**
 * Splits eligible batches into pending work. The newest suffix is protected
 * by both count and optional size budget; redundant consumed evidence can be
 * selected from that suffix when a prune event is already happening.
 */
export function pendingFrom(eligible: Batch[], window: number, opts: PendingOptions = {}): PendingInfo {
	const protectedStart = protectedStartOf(eligible, window, opts);
	const selected: Batch[] = [];
	let selectedChars = 0;

	for (let i = 0; i < protectedStart; i++) {
		if (opts.targetChars !== undefined && selectedChars >= opts.targetChars) break;
		addBatch(selected, eligible[i], eligible[i].items);
		selectedChars += eligible[i].chars;
	}

	if (opts.includeRedundant) {
		for (const batch of eligible) {
			const redundant = batch.items.filter((item) => item.rewrite === "removePair");
			addBatch(selected, batch, redundant);
		}
	}

	selected.sort((a, b) => a.anchorMsgIndex - b.anchorMsgIndex);
	return {
		batches: selected,
		chars: selected.reduce((s, b) => s + b.chars, 0),
		items: selected.reduce((s, b) => s + b.items.length, 0),
	};
}
