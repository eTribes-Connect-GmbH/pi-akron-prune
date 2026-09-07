/**
 * akron-prune — context rewrite.
 *
 * Applies the durable prune index to the outgoing message array. This runs
 * on EVERY LLM call (the `context` event receives a fresh deep copy of the
 * session's messages), so everything it emits must be deterministic:
 * reference texts and checkpoint texts are generated once at prune time,
 * stored in the index, and replayed verbatim. Identical input → identical
 * output on every call is what keeps the rewritten prefix cacheable.
 *
 * The rewrite never deletes messages: tool results keep their toolCallId
 * and are replaced in place, toolCall blocks keep their id and only get
 * stubbed arguments, user images become text references. toolCall↔toolResult
 * pairing and thinking signatures stay valid for every provider.
 */

import { userKey } from "./batches.js";
import type { PruneIndex } from "./types.js";

type AnyBlock = {
	type?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	input?: unknown;
	thoughtSignature?: unknown;
	text?: string;
	data?: string;
	mimeType?: string;
};

type AnyMessage = {
	role?: string;
	content?: unknown;
	timestamp?: number;
	toolCallId?: string;
};

/** Key of the message a checkpoint is anchored to (first toolCall id / user key). */
function anchorKeyOf(msg: AnyMessage): string | null {
	if (msg?.role === "assistant" && Array.isArray(msg.content)) {
		for (const b of msg.content as AnyBlock[]) {
			if (b?.type === "toolCall" && b.id) return b.id;
		}
		return null;
	}
	if (msg?.role === "user" && Array.isArray(msg.content)) {
		if ((msg.content as AnyBlock[]).some((b) => b?.type === "image")) return userKey(msg);
	}
	return null;
}

export function applyIndex(
	messages: AnyMessage[],
	index: PruneIndex,
): { messages: AnyMessage[]; changed: boolean } {
	let changed = false;
	const out: AnyMessage[] = [];

	// anchor key → checkpoint texts to insert before that message
	const insertBefore = new Map<string, string[]>();
	for (const cp of index.checkpoints) {
		const list = insertBefore.get(cp.anchorKey) ?? [];
		list.push(cp.text);
		insertBefore.set(cp.anchorKey, list);
	}

	for (const msg of messages) {
		// checkpoints anchored to this message
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

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			let modified = false;
			const content = (msg.content as AnyBlock[]).map((block) => {
				if (block?.type === "toolCall" && block.id) {
					const entry = index.entries[`tc:${block.id}:args`];
					if (entry?.stubArgs) {
						modified = true;
						const stub: AnyBlock = { ...block };
						// a stubbed argument set no longer matches any thought
						// signature attached to the original call
						delete stub.thoughtSignature;
						stub.arguments = entry.stubArgs;
						stub.input = entry.stubArgs;
						return stub;
					}
				}
				return block;
			});
			if (modified) {
				changed = true;
				out.push({ ...msg, content });
				continue;
			}
			out.push(msg);
			continue;
		}

		if (msg.role === "toolResult" && msg.toolCallId) {
			const entry = index.entries[`tc:${msg.toolCallId}`];
			if (entry) {
				changed = true;
				out.push({ ...msg, content: [{ type: "text", text: entry.refText }] });
				continue;
			}
			out.push(msg);
			continue;
		}

		if (msg.role === "user" && Array.isArray(msg.content)) {
			const entry = index.entries[userKey(msg)];
			if (entry) {
				changed = true;
				const content = (msg.content as AnyBlock[]).map((block) =>
					block?.type === "image" ? { type: "text", text: entry.refText } : block,
				);
				out.push({ ...msg, content });
				continue;
			}
			out.push(msg);
			continue;
		}

		out.push(msg);
	}

	return { messages: out, changed };
}