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
function isPreservedRead(toolName: string, input: unknown, cfg: AkronConfig): boolean {
	if (toolName !== "read" || cfg.preserveReadExtensions.length === 0) return false;
	const p = String((input as { path?: string } | undefined)?.path ?? "");
	return cfg.preserveReadExtensions.some((ext) => p.toLowerCase().endsWith(ext));
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

/**
 * Computes all batches that still contain prunable content. Each batch:
 *   - anchors at the assistant message that issued the tool calls (its
 *     first toolCall id), or at the user message that uploaded images
 *   - is "complete" only when at least one message follows its last item,
 *     which protects the in-flight tail of the current turn
 */
export function computeBatches(messages: AnyMessage[], index: PruneIndex, cfg: AkronConfig): Batch[] {
	const last = messages.length - 1;

	// toolCallId → { name, input, assistant message index }
	const calls = new Map<string, { name: string; input: unknown; msgIndex: number }>();
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown; input?: unknown }>) {
				if (b?.type === "toolCall" && b.id) {
					calls.set(b.id, {
						name: b.name ?? "",
						input: b.arguments ?? b.input ?? {},
						msgIndex: i,
					});
				}
			}
		}
	}

	const batchMap = new Map<number, Batch>();

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

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];

		if (m?.role === "toolResult" && m.toolCallId) {
			const info = calls.get(m.toolCallId);
			if (!info) continue;
			const batch = getToolBatch(info.msgIndex);
			const input = info.input;

			// 1) the tool result content itself
			const resultKey = `tc:${m.toolCallId}`;
			if (!index.entries[resultKey] && !isPreservedRead(info.name, input, cfg)) {
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
						blocks: Array.isArray(m.content) ? (m.content as unknown[]) : undefined,
					};
					batch.items.push(item);
				}
			}

			// 2) bulk tool-call arguments (file mutations, huge bash commands)
			const argsKey = `tc:${m.toolCallId}:args`;
			if (!index.entries[argsKey]) {
				const aChars = argsChars(input);
				let prunable = false;
				if (cfg.mutationTools.includes(info.name)) {
					prunable = aChars >= cfg.minResultChars;
				} else if (info.name === "bash" && typeof (input as { command?: unknown })?.command === "string") {
					prunable = ((input as { command: string }).command).length > cfg.stubBashArgsOver;
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
		b.complete = b.lastMsgIndex < last;
	}

	return batches;
}

/** Splits eligible batches into the pending set, keeping the newest `window` intact. */
export function pendingFrom(eligible: Batch[], window: number): PendingInfo {
	const keep = Math.max(0, Math.min(window, eligible.length));
	const pending = eligible.slice(0, eligible.length - keep);
	return {
		batches: pending,
		chars: pending.reduce((s, b) => s + b.chars, 0),
		items: pending.reduce((s, b) => s + b.items.length, 0),
	};
}