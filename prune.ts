/**
 * akron-prune — prune execution.
 *
 * Executes one prune event over a list of pending batches (oldest first):
 *
 *   1. write each item to a durable, hash-verified artifact
 *      (file mutations are the exception — the file on disk IS the artifact)
 *   2. record a deterministic reference/stub in the session's prune index
 *   3. capture a git checkpoint at the pruning boundary
 *   4. persist the index, then append a profiling record
 *
 * Failure handling: any item whose artifact cannot be written and verified
 * is skipped and stays in context verbatim. Pruning fails loudly for that
 * item instead of silently discarding the original.
 */

import { gitSnapshot } from "./checkpoint.js";
import { argsChars, sanitizeId } from "./batches.js";
import { appendProfile, type ArtifactStore } from "./store.js";
import type { AkronConfig } from "./config.js";
import type { Batch, BatchItem, PruneEntry, PruneIndex, PruneStats } from "./types.js";

function fmtK(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

/**
 * Stubs file-mutation arguments: keeps small, useful scalars (path, flags)
 * and drops bulk content, pointing at the file on disk instead.
 */
function stubMutationArgs(toolName: string, input: unknown): { stub: Record<string, unknown>; note: string } {
	const stub: Record<string, unknown> = {};
	for (const [k, v] of Object.entries((input as Record<string, unknown>) ?? {})) {
		if (typeof v === "string" && v.length > 200) continue; // bulk content — dropped
		if (v !== null && typeof v === "object") continue; // edits array etc. — dropped
		stub[k] = v; // path, line hints, small options
	}
	const path = String((input as { path?: string } | undefined)?.path ?? "file");
	const note = `[akron-pruned: ${toolName} arguments omitted — change applied to ${path}; the file on disk is the source of truth]`;
	stub._akron_pruned = note;
	return { stub, note };
}

interface PruneItemOutcome {
	entry: PruneEntry;
}

async function pruneItem(
	item: BatchItem,
	store: ArtifactStore,
	cfg: AkronConfig,
	now: number,
): Promise<PruneItemOutcome> {
	if (item.kind === "result") {
		const files = store.writeArtifact(`tc-${sanitizeId(item.toolCallId ?? item.key)}`, (item.blocks ?? []) as never);
		const main = files[0]?.path ?? "";
		const errNote = item.isError ? ", error output" : "";
		const refText =
			`[akron-pruned: ${item.toolName} result (~${fmtK(item.chars)} chars${errNote}) — ` +
			`original saved to ${main}. Recover with the akron_recover tool (ref=${item.toolCallId}) or read the file.]`;
		return {
			entry: {
				kind: "result",
				toolName: item.toolName,
				toolCallId: item.toolCallId,
				ts: now,
				files,
				refText,
				rewrite: item.rewrite,
				pruneReason: item.pruneReason,
				isError: item.isError,
				prunedChars: item.chars,
			},
		};
	}

	if (item.kind === "args") {
		const input = (item.input ?? {}) as Record<string, unknown>;

		// file mutations: ordinary pruning keeps a stub; removed pairs still persist exact args as a hidden artifact
		if (cfg.mutationTools.includes(item.toolName ?? "")) {
			const { stub, note } = stubMutationArgs(item.toolName ?? "write", input);
			const files = item.rewrite === "removePair"
				? store.writeArtifact(`tc-${sanitizeId(item.toolCallId ?? item.key)}-args`, [
					{ type: "text", text: JSON.stringify({ tool: item.toolName, arguments: input }, null, 2) },
				])
				: [];
			return {
				entry: {
					kind: "args",
					toolName: item.toolName,
					toolCallId: item.toolCallId,
					ts: now,
					files,
					refText: files[0] ? `[akron-pruned: ${item.toolName} pair removed — arguments saved to ${files[0].path}]` : note,
					rewrite: item.rewrite,
					pruneReason: item.pruneReason,
					stubArgs: item.rewrite === "removePair" ? undefined : stub,
					prunedChars: item.chars,
				},
			};
		}

		// huge bash commands: artifact the full command, keep a prefix stub
		const files = store.writeArtifact(`tc-${sanitizeId(item.toolCallId ?? item.key)}-args`, [
			{ type: "text", text: JSON.stringify({ tool: item.toolName, arguments: input }, null, 2) },
		]);
		const command = String(input.command ?? "");
		const stub: Record<string, unknown> = { ...input };
		stub.command = `${command.slice(0, 160)}\n… [akron-pruned: full command saved to ${files[0].path}]`;
		return {
			entry: {
				kind: "args",
				toolName: item.toolName,
				toolCallId: item.toolCallId,
				ts: now,
				files,
				refText: `[akron-pruned: bash command arguments stubbed — full command in ${files[0].path}]`,
				rewrite: item.rewrite,
				pruneReason: item.pruneReason,
				stubArgs: stub,
				prunedChars: item.chars,
			},
		};
	}

	// uploaded user images
	const imageBlocks = ((item.blocks ?? []) as Array<{ type?: string }>).filter((b) => b?.type === "image");
	const files = store.writeArtifact(`img-${sanitizeId(item.key)}`, imageBlocks as never);
	const paths = files.map((f) => f.path).join(", ");
	const refText =
		`[akron-pruned: uploaded image (~${fmtK(files.reduce((s, f) => s + f.bytes, 0))} bytes) — ` +
		`saved to ${paths}. Recover with the akron_recover tool (ref=${item.key}).]`;
	return {
		entry: {
			kind: "userImage",
			ts: now,
			files,
			refText,
			prunedChars: item.chars,
		},
	};
}

export async function runPrune(opts: {
	store: ArtifactStore;
	index: PruneIndex;
	cfg: AkronConfig;
	batches: Batch[];
	cwd: string;
	sessionId: string;
	trigger: string;
}): Promise<PruneStats> {
	const t0 = Date.now();
	const { store, index, cfg, batches, cwd, sessionId, trigger } = opts;
	const stats: PruneStats = {
		trigger,
		batches: 0,
		items: 0,
		charsPruned: 0,
		charsAdded: 0,
		failures: 0,
		durationMs: 0,
	};

	let firstAnchor: string | null = null;

	for (const batch of batches) {
		let batchPruned = 0;
		for (const item of batch.items) {
			try {
				const { entry } = await pruneItem(item, store, cfg, t0);
				index.entries[item.key] = entry;
				stats.items++;
				stats.charsPruned += item.chars;
				stats.charsAdded += entry.rewrite === "removePair" ? 0 : entry.refText.length + (entry.stubArgs ? argsChars(entry.stubArgs) : 0);
				batchPruned++;
			} catch {
				// verification failed or write error: keep the original in context
				stats.failures++;
			}
		}
		if (batchPruned > 0) {
			stats.batches++;
			if (!firstAnchor) firstAnchor = batch.anchorKey;
		}
	}

	if (stats.items > 0 && firstAnchor) {
		const gitText = await gitSnapshot(cwd);
		const text =
			`[akron checkpoint — ${stats.items} tool outputs (~${fmtK(stats.charsPruned)} chars) pruned from ` +
			`${stats.batches} batches; originals are durable artifacts, recoverable via the akron_recover tool. ` +
			`Workspace state at prune time — ${gitText}]`;
		index.checkpoints.push({ anchorKey: firstAnchor, ts: t0, text });
		if (index.checkpoints.length > cfg.maxCheckpoints) {
			index.checkpoints.splice(0, index.checkpoints.length - cfg.maxCheckpoints);
		}

		store.saveIndex(index);

		stats.durationMs = Date.now() - t0;
		appendProfile({
			ts: t0,
			sessionId,
			trigger: stats.trigger,
			batches: stats.batches,
			items: stats.items,
			charsPruned: stats.charsPruned,
			charsAdded: stats.charsAdded,
			failures: stats.failures,
			durationMs: stats.durationMs,
			git: gitText.slice(0, 200),
		});
	}

	stats.durationMs = Date.now() - t0;
	return stats;
}