import { userKey, type AnyMessage } from "./batches.js";
import type { PruneIndex } from "./types.js";

type AnyBlock = Record<string, unknown>;

function anchorKeyOf(msg: AnyMessage): string {
	if (!msg) return "";
	if (msg.role === "assistant" && Array.isArray(msg.content)) {
		for (const b of msg.content as Array<{ type?: string; id?: string }>) {
			if (b?.type === "toolCall" && b.id) return b.id;
		}
	}
	if (msg.role === "user" && Array.isArray(msg.content) && (msg.content as Array<{ type?: string }>).some((b) => b?.type === "image")) {
		return userKey(msg);
	}
	return "";
}

function removedToolCallIds(index: PruneIndex): Set<string> {
	const ids = new Set<string>();
	for (const entry of Object.values(index.entries)) {
		if (entry.rewrite === "removePair" && entry.toolCallId) ids.add(entry.toolCallId);
	}
	return ids;
}

function rewriteAssistantMessage(
	msg: AnyMessage,
	index: PruneIndex,
	removeIds: Set<string>,
): { message?: AnyMessage; changed: boolean } {
	let changed = false;
	const content: AnyBlock[] = [];

	for (const block of msg.content as AnyBlock[]) {
		const id = block?.type === "toolCall" ? String(block.id ?? "") : "";
		if (id) {
			if (removeIds.has(id)) {
				changed = true;
				continue;
			}
			const entry = index.entries[`tc:${id}:args`];
			if (entry?.stubArgs) {
				changed = true;
				const { thoughtSignature: _thoughtSignature, ...stub } = block;
				content.push({ ...stub, arguments: entry.stubArgs, input: entry.stubArgs });
				continue;
			}
		}
		content.push(block);
	}

	if (!changed) return { message: msg, changed: false };
	return content.length > 0 ? { message: { ...msg, content }, changed: true } : { changed: true };
}

function rewriteToolResultMessage(
	msg: AnyMessage,
	index: PruneIndex,
	removeIds: Set<string>,
): { message?: AnyMessage; changed: boolean } {
	const toolCallId = String((msg as { toolCallId?: unknown }).toolCallId ?? "");
	if (removeIds.has(toolCallId)) return { changed: true };

	const entry = index.entries[`tc:${toolCallId}`];
	if (!entry) return { message: msg, changed: false };
	return { message: { ...msg, content: [{ type: "text", text: entry.refText }] }, changed: true };
}

function rewriteUserImageMessage(msg: AnyMessage, index: PruneIndex): { message?: AnyMessage; changed: boolean } {
	const entry = index.entries[userKey(msg)];
	if (!entry) return { message: msg, changed: false };
	const content = (msg.content as AnyBlock[]).map((block) =>
		block?.type === "image" ? { type: "text", text: entry.refText } : block,
	);
	return { message: { ...msg, content }, changed: true };
}

function rewriteMessage(msg: AnyMessage, index: PruneIndex, removeIds: Set<string>): { message?: AnyMessage; changed: boolean } {
	if (msg.role === "assistant" && Array.isArray(msg.content)) return rewriteAssistantMessage(msg, index, removeIds);
	if (msg.role === "toolResult" && msg.toolCallId) return rewriteToolResultMessage(msg, index, removeIds);
	if (msg.role === "user" && Array.isArray(msg.content)) return rewriteUserImageMessage(msg, index);
	return { message: msg, changed: false };
}

export function applyIndex(
	messages: AnyMessage[],
	index: PruneIndex,
): { messages: AnyMessage[]; changed: boolean } {
	let changed = false;
	const out: AnyMessage[] = [];
	const removeIds = removedToolCallIds(index);

	// anchor key → checkpoint texts to insert before that message
	const insertBefore = new Map<string, string[]>();
	for (const cp of index.checkpoints) {
		const list = insertBefore.get(cp.anchorKey) ?? [];
		list.push(cp.text);
		insertBefore.set(cp.anchorKey, list);
	}

	for (const msg of messages) {
		const anchor = anchorKeyOf(msg);
		if (anchor) {
			for (const text of insertBefore.get(anchor) ?? []) {
				out.push({ role: "user", content: text, timestamp: 0 });
				changed = true;
			}
		}

		if (!msg) {
			out.push(msg);
			continue;
		}

		const rewritten = rewriteMessage(msg, index, removeIds);
		if (rewritten.changed) changed = true;
		if (rewritten.message) out.push(rewritten.message);
	}

	return { messages: out, changed };
}
