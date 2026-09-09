/**
 * akron-prune — functional test for the core pruning pipeline.
 *
 * Runs a synthetic conversation through the real modules:
 * batch computation → prune execution (artifacts + index) → context
 * rewrite → recovery → integrity validation. Executed with `bun run
 * test.ts` from the extension directory (bun resolves the .js→.ts
 * import specifiers; the modules under test only use node builtins).
 *
 * This file is NOT loaded by pi — extension auto-discovery only loads
 * index.ts. It exists so the deterministic core can be tested without
 * an LLM in the loop.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheProfileFile, DEFAULT_CONFIG, profileFile, type AkronConfig } from "./config.js";
import { computeBatches, pendingFrom } from "./batches.js";
import { applyIndex } from "./rewrite.js";
import { runPrune } from "./prune.js";
import { hasUnmeasuredPrune, recoveryFiles } from "./index.js";
import { ArtifactStore } from "./store.js";
import { buildCacheProfileRecord, formatStatusLine, readCacheProfilesForSession, summarizeCacheProfiles } from "./stats.js";
import type { AnyMessage } from "./batches.js";

const originalProfile = existsSync(profileFile()) ? readFileSync(profileFile(), "utf8") : undefined;
const originalCacheProfile = existsSync(cacheProfileFile()) ? readFileSync(cacheProfileFile(), "utf8") : undefined;
process.on("exit", () => {
	if (originalProfile === undefined) rmSync(profileFile(), { force: true });
	else writeFileSync(profileFile(), originalProfile);
	if (originalCacheProfile === undefined) rmSync(cacheProfileFile(), { force: true });
	else writeFileSync(cacheProfileFile(), originalCacheProfile);
});

const BIG = "x".repeat(5000);
const LONG_CMD = `cat ${"f".repeat(900)}.txt`;

const messages: AnyMessage[] = [
	{ role: "user", content: "please do things", timestamp: 1 },
	{
		role: "assistant",
		content: [
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
		],
		timestamp: 2,
	},
	{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "a.txt b.txt" }], isError: false, timestamp: 3 },
	{
		role: "assistant",
		content: [
			{ type: "toolCall", id: "t2", name: "write", arguments: { path: "/tmp/out.txt", content: BIG } },
		],
		timestamp: 4,
	},
	{ role: "toolResult", toolCallId: "t2", toolName: "write", content: [{ type: "text", text: "updated" }], isError: false, timestamp: 5 },
	{
		role: "assistant",
		content: [
			{ type: "toolCall", id: "t3", name: "bash", arguments: { command: LONG_CMD } },
		],
		timestamp: 6,
	},
	{ role: "toolResult", toolCallId: "t3", toolName: "bash", content: [{ type: "text", text: BIG }], isError: false, timestamp: 7 },
	{
		role: "user",
		content: [
			{ type: "text", text: "look at this screenshot:" },
			{ type: "image", data: Buffer.from("fake-png-bytes").toString("base64"), mimeType: "image/png" },
		],
		timestamp: 8,
	},
	{
		role: "assistant",
		content: [
			{ type: "toolCall", id: "t4", name: "read", arguments: { path: "README.md" } },
		],
		timestamp: 9,
	},
	{ role: "toolResult", toolCallId: "t4", toolName: "read", content: [{ type: "text", text: BIG }], isError: false, timestamp: 10 },
	{ role: "assistant", content: [{ type: "text", text: "all done" }], timestamp: 11 },
];

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const cfg: AkronConfig = { ...DEFAULT_CONFIG };
const root = mkdtempSync(join(tmpdir(), "akron-test-"));
const store = ArtifactStore.open(root, "test-session");
const index = store.loadIndex("test-session");

console.log("1. batch computation");
const batches = computeBatches(messages, index, cfg);
check("3 eligible batches (t2, t3, user image)", batches.length === 3, `got ${batches.length}`);
check("all batches complete", batches.every((b) => b.complete));
const t2Batch = batches.find((b) => b.anchorKey === "t2");
const t3Batch = batches.find((b) => b.anchorKey === "t3");
const imgBatch = batches.find((b) => b.anchorIsUser);
check("t2 batch: write args item only", !!t2Batch && t2Batch.items.length === 1 && t2Batch.items[0].kind === "args");
check(
	"t3 batch: result + args items",
	!!t3Batch && t3Batch.items.length === 2 && t3Batch.items.some((i) => i.kind === "result") && t3Batch.items.some((i) => i.kind === "args"),
);
check("image batch present", !!imgBatch && imgBatch.items.length === 1 && imgBatch.items[0].kind === "userImage");
check("read of .md is preserved", !batches.some((b) => b.anchorKey === "t4"));
check("small bash result not prunable", !batches.some((b) => b.anchorKey === "t1"));

console.log("2. prune execution");
const pending = pendingFrom(batches, 0);
const stats = await runPrune({ store, index, cfg, batches: pending.batches, cwd: process.cwd(), sessionId: "test-session", trigger: "manual" });
check("4 items pruned", stats.items === 4, `got ${stats.items}`);
check("no failures", stats.failures === 0);
check("3 batches counted", stats.batches === 3, `got ${stats.batches}`);
check("charsPruned > 0", stats.charsPruned > 10_000);
check("index has 4 entries", Object.keys(index.entries).length === 4);
check("checkpoint recorded", index.checkpoints.length === 1);
check("checkpoint anchored at t2", index.checkpoints[0].anchorKey === "t2");
check("git snapshot in checkpoint", index.checkpoints[0].text.includes("git:"));

console.log("3. artifacts on disk");
const t3Entry = index.entries["tc:t3"];
check("t3 artifact exists", !!t3Entry && existsSync(t3Entry.files[0].path));
const t3ArtifactBlocks = store.readArtifactBlocks(t3Entry.files[0]);
check("artifact content matches original", t3ArtifactBlocks.length === 1 && t3ArtifactBlocks[0].type === "text" && t3ArtifactBlocks[0].text === BIG);
check("single text artifact stays directly readable", t3Entry.files[0].path.endsWith(".txt") && readFileSync(t3Entry.files[0].path, "utf8") === BIG);
const imgEntry = index.entries[imgBatch!.anchorKey];
check("image artifact written", !!imgEntry && existsSync(imgEntry.files[0].path));
const imageArtifactBlocks = store.readArtifactBlocks(imgEntry.files[0]);
check(
	"image artifact content round-trips",
	imageArtifactBlocks.length === 1 && imageArtifactBlocks[0].type === "image" && imageArtifactBlocks[0].data === Buffer.from("fake-png-bytes").toString("base64"),
);

console.log("4. context rewrite");
const { messages: rewritten, changed } = applyIndex(messages, index);
check("rewrite reports change", changed);
const t3Result = rewritten.find((m) => m.role === "toolResult" && m.toolCallId === "t3");
check(
	"t3 result replaced with reference",
	!!t3Result &&
		(t3Result.content as Array<{ type: string; text?: string }>)[0].type === "text" &&
		(t3Result.content as Array<{ type: string; text?: string }>)[0].text!.includes("akron-pruned") &&
		(t3Result.content as Array<{ type: string; text?: string }>)[0].text!.includes("akron_recover"),
);
const t2Assistant = rewritten.find((m) => m.role === "assistant" && (m.content as Array<{ id?: string }>).some((b) => b.id === "t2"));
const t2Call = (t2Assistant!.content as Array<{ type: string; id?: string; arguments?: Record<string, unknown> }>).find((b) => b.id === "t2")!;
check("write args stubbed", typeof t2Call.arguments === "object" && "_akron_pruned" in t2Call.arguments && t2Call.arguments.path === "/tmp/out.txt");
const t2ArgsEntry = index.entries["tc:t2:args"];
check("write args artifacted", !!t2ArgsEntry?.files[0] && readFileSync(t2ArgsEntry.files[0].path, "utf8").includes(BIG));
check("write result untouched (short)", rewritten.find((m) => m.role === "toolResult" && m.toolCallId === "t2")!.content === messages[4].content);
const t1Result = rewritten.find((m) => m.role === "toolResult" && m.toolCallId === "t1");
check("small result untouched", t1Result === messages[2]);
const t4Result = rewritten.find((m) => m.role === "toolResult" && m.toolCallId === "t4");
check("preserved .md read untouched", t4Result === messages[9]);
const imgMsg = rewritten.find((m) => m.timestamp === 8);
check(
	"user image replaced with text ref",
	!!imgMsg && (imgMsg.content as Array<{ type: string; text?: string }>).every((b) => b.type === "text"),
);
const cpIdx = rewritten.findIndex((m) => m.role === "user" && typeof m.content === "string" && (m.content as string).startsWith("[akron checkpoint"));
const t2AssistantIdx = rewritten.indexOf(t2Assistant!);
check("checkpoint inserted before first pruned batch", cpIdx !== -1 && cpIdx < t2AssistantIdx, `cp at ${cpIdx}, t2 at ${t2AssistantIdx}`);

console.log("5. determinism");
const second = applyIndex(messages, index);
check("rewrite is deterministic", JSON.stringify(second.messages) === JSON.stringify(rewritten));
check("re-compute finds no new pending", computeBatches(messages, index, cfg).length === 0);
check("fresh prune generation defers threshold compaction", hasUnmeasuredPrune(index));
index.measuredPruneTs = Math.max(...Object.values(index.entries).map((entry) => entry.ts));
check("measured prune generation permits threshold compaction", !hasUnmeasuredPrune(index));

console.log("6. pressure/budget selection");
const fakeBatches = Array.from({ length: 5 }, (_, i) => ({
	anchorMsgIndex: i,
	anchorKey: `b${i + 1}`,
	anchorIsUser: false,
	items: [{ kind: "result" as const, key: `k${i + 1}`, msgIndex: i, chars: 100 }],
	chars: 100,
	lastMsgIndex: i,
	complete: true,
}));
const budgetPending = pendingFrom(fakeBatches, 4, { keepChars: 250, minKeepBatches: 1 });
check("working-set budget prunes within recent window", budgetPending.batches.map((b) => b.anchorKey).join(",") === "b1,b2,b3");
const targetPending = pendingFrom(fakeBatches, 4, { keepChars: 250, minKeepBatches: 1, targetChars: 150 });
check("pressure target selects enough eligible content", targetPending.batches.map((b) => b.anchorKey).join(",") === "b1,b2");

console.log("7. mutated Markdown workspace snapshot");
const mdRoot = mkdtempSync(join(tmpdir(), "akron-md-"));
execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: mdRoot });
execFileSync("git", ["config", "user.email", "akron@example.test"], { cwd: mdRoot });
execFileSync("git", ["config", "user.name", "Akron Test"], { cwd: mdRoot });
writeFileSync(join(mdRoot, "AGENTS.md"), "old instructions\n");
execFileSync("git", ["add", "AGENTS.md"], { cwd: mdRoot });
execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: mdRoot });
const latestAgents = `latest complete instructions\n${"do not lose this\n".repeat(20)}`;
writeFileSync(join(mdRoot, "AGENTS.md"), latestAgents);
const mdMessages: AnyMessage[] = [
	{ role: "user", content: "update instructions", timestamp: 40 },
	{ role: "assistant", content: [{ type: "toolCall", id: "md-edit", name: "edit", arguments: { path: "./AGENTS.md", edits: [{ oldText: "old", newText: "new".repeat(200) }] } }], timestamp: 41 },
	{ role: "toolResult", toolCallId: "md-edit", toolName: "edit", content: [{ type: "text", text: "updated" }], isError: false, timestamp: 42 },
	{ role: "assistant", content: [{ type: "text", text: "mutation consumed" }], timestamp: 43 },
	{ role: "assistant", content: [{ type: "toolCall", id: "md-read", name: "read", arguments: { path: "AGENTS.md" } }], timestamp: 44 },
	{ role: "toolResult", toolCallId: "md-read", toolName: "read", content: [{ type: "text", text: latestAgents }], isError: false, timestamp: 45 },
	{ role: "assistant", content: [{ type: "text", text: "read consumed" }], timestamp: 46 },
];
const mdStore = ArtifactStore.open(mdRoot, "md-session");
const mdIndex = mdStore.loadIndex("md-session");
const mdBatches = computeBatches(mdMessages, mdIndex, cfg, mdRoot);
check("mutated AGENTS.md read becomes prunable", mdBatches.some((b) => b.anchorKey === "md-read"));
await runPrune({ store: mdStore, index: mdIndex, cfg, batches: pendingFrom(mdBatches, 0).batches, cwd: mdRoot, sessionId: "md-session", trigger: "markdown-test" });
const mdRewrite = applyIndex(mdMessages, mdIndex).messages;
check("mutated AGENTS.md read was replaced", ((mdRewrite.find((m) => m.toolCallId === "md-read")?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "").includes("akron-pruned"));
check("checkpoint includes complete latest AGENTS.md", mdIndex.checkpoints[0]?.text.includes("Latest AGENTS.md (complete") && mdIndex.checkpoints[0]?.text.includes(latestAgents));
rmSync(mdRoot, { recursive: true, force: true });

const outsideRoot = mkdtempSync(join(tmpdir(), "akron-outside-"));
const outsidePath = join(tmpdir(), `akron-outside-${process.pid}.txt`);
const outsideMessages: AnyMessage[] = [
	{ role: "user", content: "outside mutation", timestamp: 50 },
	{ role: "assistant", content: [{ type: "toolCall", id: "outside-write", name: "write", arguments: { path: outsidePath, content: BIG } }], timestamp: 51 },
	{ role: "toolResult", toolCallId: "outside-write", toolName: "write", content: [{ type: "text", text: "updated" }], isError: false, timestamp: 52 },
	{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 53 },
];
const outsideStore = ArtifactStore.open(outsideRoot, "outside-session");
const outsideIndex = outsideStore.loadIndex("outside-session");
const outsideBatches = computeBatches(outsideMessages, outsideIndex, cfg);
await runPrune({ store: outsideStore, index: outsideIndex, cfg, batches: pendingFrom(outsideBatches, 0).batches, cwd: outsideRoot, sessionId: "outside-session", trigger: "outside-test" });
check("checkpoint reports outside-git mutation", outsideIndex.checkpoints[0]?.text.includes("outside git mutations") && outsideIndex.checkpoints[0]?.text.includes(outsidePath));
rmSync(outsideRoot, { recursive: true, force: true });

console.log("8. redundant recent removal");
const SCREENSHOT = Buffer.alloc(5000, 7).toString("base64");
const redundantMessages: AnyMessage[] = [
	{ role: "user", content: "repeat and mutate", timestamp: 20 },
	{ role: "assistant", content: [
		{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/a.ts" } },
		{ type: "toolCall", id: "sibling", name: "bash", arguments: { command: "pwd" } },
	], timestamp: 21 },
	{ role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: BIG }], timestamp: 22 },
	{ role: "toolResult", toolCallId: "sibling", toolName: "bash", content: [{ type: "text", text: "cwd" }], timestamp: 22 },
	{ role: "assistant", content: [{ type: "text", text: "processed first read" }], timestamp: 23 },
	{ role: "assistant", content: [{ type: "toolCall", id: "r2", name: "read", arguments: { path: "src/a.ts" } }], timestamp: 24 },
	{ role: "toolResult", toolCallId: "r2", toolName: "read", content: [{ type: "text", text: BIG }], timestamp: 25 },
	{ role: "assistant", content: [{ type: "text", text: "processed repeated read" }], timestamp: 26 },
	{ role: "assistant", content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "src/a.ts", content: BIG } }], timestamp: 27 },
	{ role: "toolResult", toolCallId: "w1", toolName: "write", content: [{ type: "text", text: BIG }], timestamp: 28 },
	{ role: "assistant", content: [{ type: "text", text: "processed first mutation" }], timestamp: 29 },
	{ role: "assistant", content: [{ type: "toolCall", id: "w2", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "x", newText: BIG }] } }], timestamp: 30 },
	{ role: "toolResult", toolCallId: "w2", toolName: "edit", content: [{ type: "text", text: "edited" }], timestamp: 31 },
	{ role: "assistant", content: [{ type: "text", text: "processed second mutation" }], timestamp: 32 },
	{ role: "assistant", content: [{ type: "toolCall", id: "br1", name: "agent_browser", arguments: { args: ["screenshot"] } }], timestamp: 33 },
	{ role: "toolResult", toolCallId: "br1", toolName: "agent_browser", content: [{ type: "image", data: SCREENSHOT, mimeType: "image/png" }], timestamp: 34 },
	{ role: "assistant", content: [{ type: "text", text: "processed screenshot" }], timestamp: 35 },
];
const redundantRoot = mkdtempSync(join(tmpdir(), "akron-redundant-"));
const redundantStore = ArtifactStore.open(redundantRoot, "redundant-session");
const redundantIndex = redundantStore.loadIndex("redundant-session");
const redundantBatches = computeBatches(redundantMessages, redundantIndex, cfg);
const redundantPending = pendingFrom(redundantBatches, 99, { includeRedundant: true });
check("redundant recent items selected", redundantPending.items === 4, `got ${redundantPending.items}`);
await runPrune({ store: redundantStore, index: redundantIndex, cfg, batches: redundantPending.batches, cwd: process.cwd(), sessionId: "redundant-session", trigger: "redundant-test" });
const w1ArgsEntry = redundantIndex.entries["tc:w1:args"];
const r1Entry = redundantIndex.entries["tc:r1"];
const br1Entry = redundantIndex.entries["tc:br1"];
check("removed repeated read call args are artifacted", !!r1Entry?.hiddenFiles?.[0] && readFileSync(r1Entry.hiddenFiles[0].path, "utf8").includes("src/a.ts"));
const r1EnvelopeBlock = r1Entry?.hiddenFiles?.[0] ? redundantStore.readArtifactBlocks(r1Entry.hiddenFiles[0])[0] : undefined;
let r1Envelope: unknown;
try {
	r1Envelope = r1EnvelopeBlock?.type === "text" ? JSON.parse(r1EnvelopeBlock.text) : undefined;
} catch {
	r1Envelope = undefined;
}
check("pair envelope excludes sibling calls", !!r1Envelope && JSON.stringify(r1Envelope).includes('"id":"r1"') && !JSON.stringify(r1Envelope).includes('"id":"sibling"'));
check("removed browser call args are artifacted", !!br1Entry?.hiddenFiles?.[0] && readFileSync(br1Entry.hiddenFiles[0].path, "utf8").includes("screenshot"));
check("normal recovery excludes pair metadata", recoveryFiles(redundantIndex, redundantStore, "r1").length === r1Entry?.files.length);
const recoveredPair = recoveryFiles(redundantIndex, redundantStore, "r1:pair");
check("explicit pair recovery returns call then result", recoveredPair.length === 2 && readFileSync(recoveredPair[0].path, "utf8").includes('"id": "r1"') && readFileSync(recoveredPair[1].path, "utf8").includes(BIG));
check("removed mutation args are artifacted", !!w1ArgsEntry?.files[0] && readFileSync(w1ArgsEntry.files[0].path, "utf8").includes(BIG));
check("removed mutation result is artifacted through args entry", !!w1ArgsEntry?.hiddenFiles?.[0] && readFileSync(w1ArgsEntry.hiddenFiles[0].path, "utf8").includes(BIG));
check("all selected w1 items remove the pair", redundantIndex.entries["tc:w1"]?.rewrite === "removePair" && w1ArgsEntry?.rewrite === "removePair");
const w1ResultEntry = redundantIndex.entries["tc:w1"];
if (w1ResultEntry) w1ResultEntry.rewrite = "replace";
check("pair recovery selects removePair entry", recoveryFiles(redundantIndex, redundantStore, "w1:pair").length === 2);
if (w1ResultEntry) w1ResultEntry.rewrite = "removePair";
const redundantRewrite = applyIndex(redundantMessages, redundantIndex).messages;
check("earlier repeated read pair removed", !redundantRewrite.some((m) => m.toolCallId === "r1") && !JSON.stringify(redundantRewrite).includes('"id":"r1"'));
check("latest repeated read remains", redundantRewrite.some((m) => m.toolCallId === "r2") && JSON.stringify(redundantRewrite).includes('"id":"r2"'));
check("sibling call remains", redundantRewrite.some((m) => m.toolCallId === "sibling") && JSON.stringify(redundantRewrite).includes('"id":"sibling"'));
check("superseded mutation pair removed", !redundantRewrite.some((m) => m.toolCallId === "w1") && !JSON.stringify(redundantRewrite).includes('"id":"w1"'));
check("latest mutation remains", redundantRewrite.some((m) => m.toolCallId === "w2") && JSON.stringify(redundantRewrite).includes('"id":"w2"'));
check("consumed browser screenshot pair removed", !redundantRewrite.some((m) => m.toolCallId === "br1") && !JSON.stringify(redundantRewrite).includes('"id":"br1"'));
check("assistant reasoning remains", redundantRewrite.some((m) => JSON.stringify(m.content).includes("processed first read")));
rmSync(redundantRoot, { recursive: true, force: true });

console.log("9. removed mutation pair with short result remains recoverable");
const smallRoot = mkdtempSync(join(tmpdir(), "akron-small-mutation-"));
const smallStore = ArtifactStore.open(smallRoot, "small-mutation-session");
const smallIndex = smallStore.loadIndex("small-mutation-session");
const smallMutationMessages: AnyMessage[] = [
	{ role: "user", content: "small mutation results", timestamp: 36 },
	{ role: "assistant", content: [{ type: "toolCall", id: "sw1", name: "write", arguments: { path: "src/small.ts", content: BIG } }], timestamp: 37 },
	{ role: "toolResult", toolCallId: "sw1", toolName: "write", content: [{ type: "text", text: "ok" }], timestamp: 38 },
	{ role: "assistant", content: [{ type: "text", text: "processed first small mutation" }], timestamp: 39 },
	{ role: "assistant", content: [{ type: "toolCall", id: "sw2", name: "edit", arguments: { path: "src/small.ts", edits: [{ oldText: "x", newText: BIG }] } }], timestamp: 40 },
	{ role: "toolResult", toolCallId: "sw2", toolName: "edit", content: [{ type: "text", text: "edited" }], timestamp: 41 },
	{ role: "assistant", content: [{ type: "text", text: "processed second small mutation" }], timestamp: 42 },
];
const smallPending = pendingFrom(computeBatches(smallMutationMessages, smallIndex, cfg), 99, { includeRedundant: true });
check("args-only redundant mutation selected", smallPending.items === 1, `got ${smallPending.items}`);
await runPrune({ store: smallStore, index: smallIndex, cfg, batches: smallPending.batches, cwd: process.cwd(), sessionId: "small-mutation-session", trigger: "small-mutation-test" });
const sw1ArgsEntry = smallIndex.entries["tc:sw1:args"];
check("short removed mutation result is artifacted", !!sw1ArgsEntry?.hiddenFiles?.[0] && readFileSync(sw1ArgsEntry.hiddenFiles[0].path, "utf8").includes("ok"));
const smallRewrite = applyIndex(smallMutationMessages, smallIndex).messages;
check("short-result mutation pair removed", !smallRewrite.some((m) => m.toolCallId === "sw1") && !JSON.stringify(smallRewrite).includes('"id":"sw1"'));
rmSync(smallRoot, { recursive: true, force: true });

console.log("10. failed mutations are not supersession evidence");
const failedRoot = mkdtempSync(join(tmpdir(), "akron-failed-mutation-"));
const failedStore = ArtifactStore.open(failedRoot, "failed-mutation-session");
const failedIndex = failedStore.loadIndex("failed-mutation-session");
const failedMutationMessages: AnyMessage[] = [
	{ role: "user", content: "mutate with a failed retry", timestamp: 40 },
	{ role: "assistant", content: [{ type: "toolCall", id: "fw1", name: "write", arguments: { path: "src/b.ts", content: BIG } }], timestamp: 41 },
	{ role: "toolResult", toolCallId: "fw1", toolName: "write", content: [{ type: "text", text: "updated" }], timestamp: 42 },
	{ role: "assistant", content: [{ type: "text", text: "processed successful write" }], timestamp: 43 },
	{ role: "assistant", content: [{ type: "toolCall", id: "fw2", name: "edit", arguments: { path: "src/b.ts", edits: [{ oldText: "missing", newText: BIG }] } }], timestamp: 44 },
	{ role: "toolResult", toolCallId: "fw2", toolName: "edit", content: [{ type: "text", text: "oldText not found" }], isError: true, timestamp: 45 },
	{ role: "assistant", content: [{ type: "text", text: "processed failed edit" }], timestamp: 46 },
];
const failedPending = pendingFrom(computeBatches(failedMutationMessages, failedIndex, cfg), 99, { includeRedundant: true });
check("failed later mutation does not supersede earlier mutation", failedPending.items === 0, `got ${failedPending.items}`);
rmSync(failedRoot, { recursive: true, force: true });

console.log("11. signed tool turns remain provider-valid");
const signedRoot = mkdtempSync(join(tmpdir(), "akron-signed-turn-"));
const signedStore = ArtifactStore.open(signedRoot, "signed-turn-session");
const signedIndex = signedStore.loadIndex("signed-turn-session");
const signedMessages: AnyMessage[] = [
	{ role: "assistant", content: [
		{ type: "text", text: "signed reasoning", textSignature: "opaque" },
		{ type: "toolCall", id: "sg1", name: "read", arguments: { path: "src/signed.ts" } },
		{ type: "toolCall", id: "sg2", name: "read", arguments: { path: "src/signed.ts" } },
	], timestamp: 47 },
	{ role: "toolResult", toolCallId: "sg1", toolName: "read", content: [{ type: "text", text: BIG }], timestamp: 48 },
	{ role: "toolResult", toolCallId: "sg2", toolName: "read", content: [{ type: "text", text: BIG }], timestamp: 49 },
	{ role: "assistant", content: [{ type: "text", text: "processed signed calls" }], timestamp: 50 },
];
const signedBatches = computeBatches(signedMessages, signedIndex, cfg);
check("signed parallel calls are not pair-removal candidates", signedBatches.flatMap((batch) => batch.items).every((item) => item.rewrite !== "removePair"));
signedIndex.entries["tc:sg1"] = { kind: "result", toolCallId: "sg1", toolName: "read", ts: 51, files: [], refText: "signed result ref", rewrite: "removePair", prunedChars: BIG.length };
signedIndex.entries["tc:sg1:args"] = { kind: "args", toolCallId: "sg1", toolName: "read", ts: 51, files: [], refText: "signed args ref", rewrite: "removePair", stubArgs: { path: "stubbed" }, prunedChars: 10 };
const signedRewrite = applyIndex(signedMessages, signedIndex).messages;
const signedCall = (signedRewrite[0].content as Array<{ id?: string; arguments?: { path?: string } }>).find((block) => block.id === "sg1");
check("legacy signed call rewrite remains verbatim", signedCall?.arguments?.path === "src/signed.ts");
check("legacy signed tool result remains paired", signedRewrite.some((message) => message.toolCallId === "sg1"));
rmSync(signedRoot, { recursive: true, force: true });

console.log("12. recovery");
const blocks = store.readArtifactBlocks(t3Entry.files[0].path);
check("text artifact recovers as text block", blocks.length === 1 && blocks[0].type === "text" && blocks[0].text === BIG);
const imgBlocks = store.readArtifactBlocks(imgEntry.files[0].path);
check("image artifact recovers as image block", imgBlocks.length === 1 && imgBlocks[0].type === "image" && imgBlocks[0].mimeType === "image/png");
check("resolveArtifactPath rejects outside paths", store.resolveArtifactPath("/etc/passwd") === null);
check("indexed artifact path resolves for recovery", recoveryFiles(index, store, t3Entry.files[0].path)[0]?.path === t3Entry.files[0].path);
const orderedBlocks = [
	{ type: "text", text: "before" },
	{ type: "image", data: Buffer.from("ordered-image").toString("base64"), mimeType: "image/png" },
	{ type: "text", text: "after" },
];
const orderedFiles = store.writeArtifact("ordered-blocks", orderedBlocks);
check("unindexed artifact path is rejected", recoveryFiles(index, store, orderedFiles[0].path).length === 0);
check("mixed artifact block order round-trips", JSON.stringify(orderedFiles.flatMap((file) => store.readArtifactBlocks(file))) === JSON.stringify(orderedBlocks));
const legacyPath = join(root, "legacy.akron.json");
const legacyData = Buffer.from(JSON.stringify({ version: 1, blocks: orderedBlocks }));
writeFileSync(legacyPath, legacyData);
const legacyFile = { path: legacyPath, bytes: legacyData.length, sha256: createHash("sha256").update(legacyData).digest("hex") };
check("legacy artifact bundles remain readable", JSON.stringify(store.readArtifactBlocks(legacyFile)) === JSON.stringify(orderedBlocks));

console.log("13. integrity validation");
const sharedIndex = store.loadIndex("shared-validation");
const sharedArtifact = { ...t3Entry.files[0] };
sharedIndex.entries.bad = { kind: "result", toolCallId: "bad", ts: 1, files: [{ ...sharedArtifact, sha256: "0".repeat(64) }], refText: "bad", prunedChars: 1 };
sharedIndex.entries.good = { kind: "result", toolCallId: "good", ts: 1, files: [sharedArtifact], refText: "good", prunedChars: 1 };
const sharedValidation = store.validateEntries(sharedIndex);
check("shared artifact descriptors validate independently", sharedValidation.dropped === 1 && !sharedIndex.entries.bad && !!sharedIndex.entries.good);
const corrupted = t3Entry.files[0].path;
writeFileSync(corrupted, Buffer.alloc(t3Entry.files[0].bytes, 121));
const { dropped } = store.validateEntries(index);
check("same-size tampered artifact drops its entry", dropped === 1 && index.entries["tc:t3"] === undefined);
const afterDrop = applyIndex(messages, index);
const t3ResultRestored = afterDrop.messages.find((m) => m.role === "toolResult" && m.toolCallId === "t3");
check("dropped entry falls back to original in context", t3ResultRestored === messages[6]);

console.log("14. cache profiling stats");
const cacheRecord = buildCacheProfileRecord(
	{
		role: "assistant",
		provider: "anthropic",
		model: "claude-opus-5",
		api: "anthropic-messages",
		stopReason: "toolUse",
		timestamp: 12,
		usage: {
			input: 100,
			output: 25,
			cacheRead: 900,
			cacheWrite: 50,
			totalTokens: 1075,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
		},
	},
	index,
	"test-session",
);
check("assistant usage creates cache profile record", !!cacheRecord);
check("cache profile preserves observed token counts", cacheRecord?.cacheRead === 900 && cacheRecord.cacheWrite === 50);
check("cache profile snapshots prune state", cacheRecord?.prunedEntries === Object.keys(index.entries).length && cacheRecord.prunedChars > 0);
check("messages without usage are skipped", buildCacheProfileRecord({ role: "assistant", timestamp: 13 }, index, "test-session") === null);
const firstCacheRecord = cacheRecord ?? {
	ts: 12,
	sessionId: "test-session",
	provider: "anthropic",
	model: "claude-opus-5",
	input: 100,
	output: 25,
	cacheRead: 900,
	cacheWrite: 50,
	totalTokens: 1075,
	prunedEntries: Object.keys(index.entries).length,
	checkpoints: index.checkpoints.length,
	prunedChars: 1,
};
const secondCacheRecord = {
	ts: 13,
	sessionId: "test-session",
	provider: "anthropic",
	model: "claude-opus-5",
	input: 200,
	output: 30,
	cacheRead: 800,
	cacheWrite: 0,
	totalTokens: 1030,
	cost: { total: 0.04 },
	prunedEntries: 3,
	checkpoints: 1,
	prunedChars: 123,
};
const cacheSummary = summarizeCacheProfiles([firstCacheRecord, secondCacheRecord]);
check("cache summary counts requests", cacheSummary.requests === 2);
check("cache summary computes hit ratio", cacheSummary.cacheHitRatio === 1700 / 2050, `got ${cacheSummary.cacheHitRatio}`);
check("cache summary groups by model", cacheSummary.perModel.length === 1 && cacheSummary.perModel[0].requests === 2);
const status = formatStatusLine(
	{ batches: [{}], items: 3, chars: 12_000 },
	[firstCacheRecord, secondCacheRecord],
	{ tokens: 1_000, contextWindow: 20_000 },
	5_000,
);
check("status line shows cache hit rate", status.includes("↻82.9%"), status);
check("status line shows cache-read tokens", status.includes("⧉1.7k"), status);
check("status line shows compaction headroom", status.includes("⏳14k"), status);
check("status line shows pending backlog", status.includes("✂3/12k"), status);
writeFileSync(
	cacheProfileFile(),
	[
		JSON.stringify({ ...firstCacheRecord, sessionId: "other-session", ts: 1 }),
		JSON.stringify({ ...firstCacheRecord, ts: 2 }),
		"not json",
		JSON.stringify({ ...firstCacheRecord, ts: 3 }),
		JSON.stringify({ ...secondCacheRecord, ts: 4 }),
	].join("\n") + "\n",
);
const latestCacheRecords = readCacheProfilesForSession("test-session", 2);
check("cache profile tail reader returns only requested session", latestCacheRecords.every((record) => record.sessionId === "test-session"));
check("cache profile tail reader returns latest matching records", latestCacheRecords.map((record) => record.ts).join(",") === "3,4");
check("cache profile tail reader honors zero limit", readCacheProfilesForSession("test-session", 0).length === 0);

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);