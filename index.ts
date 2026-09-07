/**
 * akron-prune — lossless context pruning for pi.
 *
 * A pi extension implementing the "Akron" pruning design:
 *
 *   - Completed tool activity and uploaded images form batches. The newest
 *     N eligible batches stay in context verbatim and cacheable; older
 *     batches become pruning candidates.
 *   - Standard trigger: ≥ minPendingBatches batches AND ≥ minPendingChars
 *     characters pending, followed by ≥ triggerItems items OR
 *     ≥ triggerChars characters.
 *   - Emergency trigger: pending content ≥ emergencyChars.
 *   - Pruned output is written to durable, hash-verified artifacts; the
 *     outgoing context keeps only a short deterministic reference. No
 *     summarizer model, no lossy compaction — the session file is never
 *     modified.
 *   - File mutations (write/edit) have their arguments stubbed — the file
 *     on disk is the artifact. Huge bash commands are artifacted too.
 *   - A compact git checkpoint is inserted at each pruning boundary.
 *   - When pruning can free enough context, threshold compaction is
 *     cancelled (pruning instead of lossy compaction).
 *   - `akron_recover` restores any pruned output (text or images) on
 *     demand; every placeholder carries the recovery ref.
 *
 * Concurrency note: subagent runs and the main loop can trigger context
 * events concurrently, so prune execution is serialized through a lock.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	AKRON_VERSION,
	agentDir,
	artifactsRoot,
	loadConfig,
	sessionsDir,
	saveConfig,
	type AkronConfig,
} from "./config.js";
import { computeBatches, pendingFrom, type AnyMessage } from "./batches.js";
import { applyIndex } from "./rewrite.js";
import { runPrune } from "./prune.js";
import { ArtifactStore } from "./store.js";
import { appendCacheProfile, buildCacheProfileRecord, formatStatusLine, readCacheProfilesForSession, type CacheProfileRecord } from "./stats.js";
import type { Batch, PruneIndex, PruneStats } from "./types.js";

interface SessionState {
	sessionId: string;
	store: ArtifactStore;
	index: PruneIndex;
	cacheRecords: CacheProfileRecord[];
}

export default function (pi: ExtensionAPI) {
	const cfg: AkronConfig = loadConfig();
	let state: SessionState | null = null;

	// ── session state ─────────────────────────────────────────────────────

	function ensureState(ctx: ExtensionContext): SessionState | null {
		try {
			const sid = ctx.sessionManager.getSessionId();
			if (!sid) return null;
			if (state && state.sessionId === sid) return state;
			const store = ArtifactStore.open(artifactsRoot(), sid);
			const index = store.loadIndex(sid);
			const { dropped } = store.validateEntries(index);
			if (dropped > 0) store.saveIndex(index);
			state = { sessionId: sid, store, index, cacheRecords: readCacheProfilesForSession(sid, 80) };
			return state;
		} catch {
			state = null;
			return null;
		}
	}

	/**
	 * Refuses to prune while another context pruner is active — two
	 * extensions rewriting the same context would corrupt each other.
	 */
	function otherPrunerActive(): boolean {
		try {
			const p = join(agentDir(), "context-prune", "settings.json");
			if (!existsSync(p)) return false;
			const raw = JSON.parse(readFileSync(p, "utf8"));
			return raw?.enabled === true;
		} catch {
			return false;
		}
	}

	let conflictNotified = false;

	// ── helpers ──────────────────────────────────────────────────────────

	function eligibleBatches(messages: AnyMessage[]): Batch[] {
		const st = state;
		if (!st) return [];
		return computeBatches(messages, st.index, cfg).filter((b) => b.complete);
	}

	/** Standard + emergency trigger evaluation. */
	function choosePrune(messages: AnyMessage[]): { batches: Batch[]; trigger: string } | null {
		const eligible = eligibleBatches(messages);

		const emergency = pendingFrom(eligible, cfg.emergencyKeepBatches);
		if (emergency.batches.length > 0 && emergency.chars >= cfg.emergencyChars) {
			return { batches: emergency.batches, trigger: "emergency" };
		}

		const std = pendingFrom(eligible, cfg.newestBatches);
		if (
			std.batches.length >= cfg.minPendingBatches &&
			std.chars >= cfg.minPendingChars &&
			(std.items >= cfg.triggerItems || std.chars >= cfg.triggerChars)
		) {
			return { batches: std.batches, trigger: "standard" };
		}
		return null;
	}

	// serialize prune execution across concurrent context events
	let pruneLock: Promise<unknown> = Promise.resolve();
	function withLock<T>(fn: () => Promise<T>): Promise<T> {
		const next = pruneLock.then(fn, fn);
		pruneLock = next.catch(() => {});
		return next;
	}

	async function maybePrune(
		ctx: ExtensionContext,
		messages: AnyMessage[],
		force: boolean,
	): Promise<PruneStats | null> {
		const st = state;
		if (!st) return null;

		const choice = force
			? { batches: pendingFrom(eligibleBatches(messages), cfg.newestBatches).batches, trigger: "manual" }
			: choosePrune(messages);
		if (!choice || choice.batches.length === 0) return null;

		return withLock(async () => {
			// re-check inside the lock: another event may have pruned already
			const stillPending = choice.batches.filter((b) => b.items.some((item) => !st.index.entries[item.key]));
			if (stillPending.length === 0) return null;
			return runPrune({
				store: st.store,
				index: st.index,
				cfg,
				batches: stillPending,
				cwd: ctx.cwd,
				sessionId: st.sessionId,
				trigger: choice.trigger,
			});
		});
	}

	function messagesFromSession(ctx: ExtensionContext): AnyMessage[] {
		const msgs: AnyMessage[] = [];
		try {
			const entries = ctx.sessionManager.buildContextEntries();
			for (const e of entries ?? []) {
				const entry = e as { type?: string; message?: AnyMessage };
				if (entry?.type === "message" && entry.message) msgs.push(entry.message);
			}
		} catch {
			/* no session available */
		}
		return msgs;
	}

	function fmtK(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
		return String(n);
	}

	function currentStatusLine(ctx: ExtensionContext, messages?: AnyMessage[]): string | null {
		const st = ensureState(ctx);
		if (!st) return null;
		const contextMessages = messages ?? messagesFromSession(ctx);
		const pending = pendingFrom(eligibleBatches(contextMessages), cfg.newestBatches);
		return formatStatusLine(pending, st.cacheRecords, ctx.getContextUsage());
	}

	function updateStatus(ctx: ExtensionContext, messages?: AnyMessage[]): void {
		if (!ctx.hasUI) return;
		try {
			if (!cfg.showStatus) {
				ctx.ui.setStatus("akron", undefined);
				return;
			}
			const line = currentStatusLine(ctx, messages);
			if (line) ctx.ui.setStatus("akron", line);
		} catch {
			/* status line unavailable */
		}
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.notify(message, level);
		} catch {
			/* UI unavailable */
		}
	}

	// ── events ───────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		ensureState(ctx);
		if (!cfg.enabled) return;
		if (otherPrunerActive()) {
			notify(
				ctx,
				"akron-prune: disabled — pi-context-prune is also active. Disable it first " +
					"(pi remove npm:pi-context-prune, or set enabled:false in ~/.pi/agent/context-prune/settings.json).",
				"error",
			);
		}
		updateStatus(ctx);
	});

	pi.on("resources_discover", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		state = null;
	});

	pi.on("context", async (event, ctx) => {
		if (!cfg.enabled) return;
		if (otherPrunerActive()) {
			if (!conflictNotified) {
				conflictNotified = true;
				notify(ctx, "akron-prune: inactive because pi-context-prune is enabled.", "error");
			}
			return;
		}
		const st = ensureState(ctx);
		if (!st) return;

		// AgentMessage[] is directly assignable to the helpers' loose AnyMessage[]
		const messages = event.messages;
		if (messages.length === 0) return;

		try {
			await maybePrune(ctx, messages, false);

			const applied = applyIndex(messages, st.index);

			updateStatus(ctx, messages);

			if (applied.changed) {
				// SAFETY: applyIndex only replaces content in place on original
				// messages or inserts structurally valid user messages; every
				// element in applied.messages is a valid AgentMessage, but the
				// loose internal typing cannot prove it to TypeScript.
				return { messages: applied.messages as unknown as AgentMessage[] };
			}
		} catch (err) {
			notify(ctx, `akron-prune: context pass failed — ${(err as Error).message}`, "error");
		}
	});

	// prune instead of compacting, when pruning frees enough context
	pi.on("message_end", async (event, ctx) => {
		if (!cfg.enabled) return;
		const st = ensureState(ctx);
		if (!st) return;
		const record = buildCacheProfileRecord(event.message, st.index, st.sessionId);
		if (!record) return;
		appendCacheProfile(record);
		st.cacheRecords.push(record);
		if (st.cacheRecords.length > 80) st.cacheRecords.splice(0, st.cacheRecords.length - 80);
		updateStatus(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!cfg.enabled || !cfg.cancelCompaction) return;
		if (otherPrunerActive()) return;
		const st = ensureState(ctx);
		if (!st) return;
		if (event.reason !== "threshold") return; // never interfere with overflow recovery

		try {
			const messages = messagesFromSession(ctx);
			const choice = choosePrune(messages);
			if (!choice) return;

			const tokensBefore = event.preparation.tokensBefore;

			const stats = await maybePrune(ctx, messages, true);
			if (!stats || stats.items === 0) return;

			const freedTokens = Math.ceil((stats.charsPruned - stats.charsAdded) / 3.5);
			if (tokensBefore > 0 && freedTokens >= Math.ceil(tokensBefore * cfg.compactionFreeFraction)) {
				notify(
					ctx,
					`akron-prune: pruned ${stats.items} items (~${fmtK(stats.charsPruned)} chars) — cancelling compaction`,
				);
				return { cancel: true };
			}
		} catch (err) {
			notify(ctx, `akron-prune: compaction preemption failed — ${(err as Error).message}`, "error");
		}
	});

	// ── recovery tool ────────────────────────────────────────────────────

	pi.registerTool({
		name: "akron_recover",
		label: "Recover pruned output",
		description:
			"Recover the original content of a pruned tool result, command, or uploaded image. " +
			"Pass the ref from a pruned placeholder (toolCallId or user key), or the artifact file path. " +
			"Returns the original text and/or image content.",
		promptSnippet: "Recover pruned tool output or images by ref or artifact path.",
		parameters: Type.Object({
			ref: Type.String({ description: "Ref or artifact path shown in the pruned placeholder" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const st = state ?? ensureState(ctx);
			if (!st) {
				return { content: [{ type: "text" as const, text: "akron_recover: no active session." }], details: {} };
			}
			const ref = String(params?.ref ?? "").trim();

			let files: string[] = [];
			const entry = st.index.entries[`tc:${ref}`] ?? st.index.entries[ref];
			if (entry) {
				files = entry.files.map((f) => f.path);
			} else {
				const resolved = st.store.resolveArtifactPath(ref);
				if (resolved) files = [resolved];
			}

			if (files.length === 0) {
				return {
					content: [{ type: "text" as const, text: `akron_recover: no artifact found for ref '${ref}'.` }],
					details: {},
					isError: true,
				};
			}

			try {
				const content = files.flatMap((f) => st.store.readArtifactBlocks(f));
				if (content.length === 0) {
					return {
						content: [{ type: "text" as const, text: `akron_recover: artifact '${ref}' is empty.` }],
						details: {},
						isError: true,
					};
				}
				return { content, details: { files } };
			} catch (err) {
				return {
					content: [
						{ type: "text" as const, text: `akron_recover: failed to read artifact — ${(err as Error).message}` },
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// ── commands ─────────────────────────────────────────────────────────

	pi.registerCommand("akron", {
		description: "akron-prune: lossless context pruning (status | on | off | now | gc | help)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const sub = (args ?? "").trim().split(/\s+/)[0] || "status";

			if (sub === "on" || sub === "off") {
				cfg.enabled = sub === "on";
				saveConfig(cfg);
				conflictNotified = false;
				notify(ctx, `akron-prune ${sub === "on" ? "enabled" : "disabled"}.`);
				return;
			}

			if (sub === "now") {
				if (otherPrunerActive()) {
					notify(ctx, "akron-prune: pi-context-prune is active — disable it first.", "error");
					return;
				}
				const st = ensureState(ctx);
				if (!st) {
					notify(ctx, "akron-prune: no persistent session — nothing to prune.", "error");
					return;
				}
				const messages = messagesFromSession(ctx);
				const stats = await maybePrune(ctx, messages, true);
				if (!stats || stats.items === 0) {
					notify(ctx, "akron-prune: nothing pending to prune.");
				} else {
					notify(
						ctx,
						`akron-prune: pruned ${stats.items} items (~${fmtK(stats.charsPruned)} chars) ` +
							`from ${stats.batches} batches in ${stats.durationMs}ms` +
							(stats.failures ? ` — ${stats.failures} failures kept in context` : ""),
					);
				}
				return;
			}

			if (sub === "gc") {
				const res = ArtifactStore.gc(artifactsRoot(), sessionsDir(), cfg.retentionDays);
				notify(
					ctx,
					`akron-prune gc: removed ${res.removed} artifact dirs (${fmtK(res.freedBytes)} bytes freed).`,
				);
				return;
			}

			if (sub === "status") {
				const st = ensureState(ctx);
				const lines: string[] = [`akron-prune v${AKRON_VERSION} — lossless context pruning`];
				lines.push(
					`enabled: ${cfg.enabled}${otherPrunerActive() ? " (CONFLICT: pi-context-prune also active!)" : ""}`,
					`showStatus: ${cfg.showStatus}`,
				);
				if (st) {
					const messages = messagesFromSession(ctx);
					const pending = pendingFrom(eligibleBatches(messages), cfg.newestBatches);
					const footer = currentStatusLine(ctx, messages) ?? "unavailable";
					updateStatus(ctx, messages);
					lines.push(
						`session: ${st.sessionId}`,
						`footer: ${footer}`,
						`cache records: ${st.cacheRecords.length} recent for this session`,
						`pending: ${pending.batches.length} batches · ${pending.items} items · ${fmtK(pending.chars)} chars (window ${cfg.newestBatches})`,
						`pruned: ${Object.keys(st.index.entries).length} entries · ${st.index.checkpoints.length} checkpoints · ${fmtK(ArtifactStore.sessionSizeBytes(st.store.sessionDir))}B artifacts`,
					);
				} else {
					lines.push("session: ephemeral (no persistent session — pruning inactive)");
				}
				lines.push(
					`triggers: ≥${cfg.minPendingBatches} batches & ${fmtK(cfg.minPendingChars)} chars → ${cfg.triggerItems} items | ${fmtK(cfg.triggerChars)} chars; emergency ${fmtK(cfg.emergencyChars)}`,
				);
				notify(ctx, lines.join("\n"));
				return;
			}

			notify(
				ctx,
				[
					"akron-prune commands:",
					"  /akron status — pruning state and pending backlog",
					"  /akron on|off — enable/disable pruning",
					"  /akron now — prune pending batches immediately",
					"  /akron gc — remove artifacts of expired sessions",
				].join("\n"),
			);
		},
	});
}