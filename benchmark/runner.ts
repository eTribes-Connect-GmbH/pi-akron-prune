/**
 * Pruning benchmark runner.
 *
 * Runs the identical scripted workload through pi's RPC mode once per
 * arm/rep, each against an isolated temp agent dir, and writes:
 *   <outDir>/results.jsonl   one row per prompt turn
 *   <outDir>/summary.json    per-run metadata + pointer to rows
 *
 * Arms:
 *   pure   — no pruning (akron disabled, pi-context-prune absent)
 *   pcp    — pi-context-prune enabled via -e, akron disabled
 *   akron  — project-local pi-akron-prune enabled, pcp absent
 *
 * Usage: bun run runner.ts [--arms pure,pcp,akron] [--reps 3] [--rounds 6]
 *                          [--fixture-bytes 46080] [--seed 42] [--model provider/modelId]
 *                          [--out results/<ts>]
 */

import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createWorkload, type WorkloadPrompt } from "./workload.js";

type Arm = "pure" | "pcp" | "akron";
const ARMS: Arm[] = ["pure", "pcp", "akron"];

interface TurnRow {
	arm: Arm;
	rep: number;
	phase: WorkloadPrompt["phase"];
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
	testPassed: boolean | null;
	testMs: number | null;
	testOutputChars: number;
	failed: boolean;
}

interface RunMeta {
	arm: Arm;
	rep: number;
	sessionFile: string | null;
	pruneEvents: number;
	prunedChars: number;
	compactionEvents: number;
	extensionErrors: number;
}

interface UsageShape {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	totalTokens?: unknown;
	cost?: { total?: unknown };
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[i + 1];
		args[key] = next && !next.startsWith("--") ? next : "true";
		if (next && !next.startsWith("--")) i++;
	}
	return args;
}

const realAgentDir = join(homedir(), ".pi", "agent");
const scriptDir = process.argv[1] ? dirname(resolve(process.argv[1])) : process.cwd();
// This file lives in <akron-prune>/benchmark/, so the extension is the parent dir.
const akronExtensionDir = join(scriptDir, "..");
const pcpExtensionPath = join(realAgentDir, "npm", "node_modules", "pi-context-prune", "dist", "index.js");

/** Read a JSON object file; missing or malformed files yield an empty record. */
function readJsonRecord(path: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function setupAgentDir(arm: Arm, workdir: string): string {
	const dir = join(tmpdir(), `akron-bench-agent-${arm}-${process.pid}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });

	for (const name of ["auth.json", "models.json", "models-store.json", "APPEND_SYSTEM.md"]) {
		const src = join(realAgentDir, name);
		if (existsSync(src)) copyFileSync(src, join(dir, name));
	}

	const baseSettings = readJsonRecord(join(realAgentDir, "settings.json"));
	baseSettings.packages = [];
	const settings: Record<string, unknown> = {
		lastChangelogVersion: baseSettings.lastChangelogVersion ?? "0.0.0",
		enableInstallTelemetry: false,
		hideThinkingBlock: true,
		defaultThinkingLevel: baseSettings.defaultThinkingLevel ?? "high",
		httpIdleTimeoutMs: 0,
	};
	if (typeof baseSettings.defaultProvider === "string") settings.defaultProvider = baseSettings.defaultProvider;
	if (typeof baseSettings.defaultModel === "string") settings.defaultModel = baseSettings.defaultModel;
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));

	writeFileSync(join(dir, "trust.json"), JSON.stringify({ [workdir]: true }));

	mkdirSync(join(dir, "extensions"), { recursive: true });

	mkdirSync(join(dir, "akron-prune"), { recursive: true });
	writeFileSync(
		join(dir, "akron-prune", "settings.json"),
		JSON.stringify(arm === "akron" ? { enabled: true, showStatus: false } : { enabled: false }, null, 2),
	);

	if (arm === "pcp") {
		mkdirSync(join(dir, "context-prune"), { recursive: true });
		const realPcp = join(realAgentDir, "context-prune", "settings.json");
		const pcpSettings = readJsonRecord(realPcp);
		if (!existsSync(realPcp)) pcpSettings.batchingMode = "agent-message";
		pcpSettings.enabled = true;
		pcpSettings.showPruneStatusLine = false;
		writeFileSync(join(dir, "context-prune", "settings.json"), JSON.stringify(pcpSettings, null, 2));
	}

	return dir;
}

function setupWorkdir(arm: Arm, rep: number, outDir: string): string {
	const workdir = join(outDir, "work", `${arm}-${rep}`);
	mkdirSync(workdir, { recursive: true });
	mkdirSync(join(workdir, ".pi", "extensions"), { recursive: true });
	symlinkSync(akronExtensionDir, join(workdir, ".pi", "extensions", "akron-prune"), "dir");
	return workdir;
}

interface RpcClient {
	send(message: Record<string, unknown>): void;
	waitResponse(id: string, timeoutMs: number): Promise<Record<string, unknown>>;
	waitSettled(timeoutMs: number): Promise<void>;
	events: Array<Record<string, unknown>>;
	extensionErrors: number;
	close(): Promise<void>;
}

function startRpc(workdir: string, agentDir: string, arm: Arm): Promise<RpcClient> {
	const child = spawn(
		"pi",
		["--mode", "rpc", ...(arm === "pcp" ? ["-e", pcpExtensionPath] : [])],
		{ cwd: workdir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["pipe", "pipe", "pipe"] },
	);

	const client: RpcClient = {
		events: [],
		extensionErrors: 0,
		send(message) {
			child.stdin.write(`${JSON.stringify(message)}\n`);
		},
		waitResponse(id, timeoutMs) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const index = pendingResponses.indexOf(entry);
					if (index >= 0) pendingResponses.splice(index, 1);
					reject(new Error(`timeout waiting for response ${id}`));
				}, timeoutMs);
				const entry = { id, resolve, timer };
				pendingResponses.push(entry);
			});
		},
		waitSettled(timeoutMs) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					const index = pendingSettled.indexOf(entry);
					if (index >= 0) pendingSettled.splice(index, 1);
					reject(new Error("timeout waiting for agent_settled"));
				}, timeoutMs);
				const entry = { resolve, timer };
				pendingSettled.push(entry);
			});
		},
		close() {
			return new Promise((resolve) => {
				child.on("exit", () => resolve());
				child.kill();
			});
		},
	};

	const pendingResponses: Array<{ id: string; resolve: (v: Record<string, unknown>) => void; timer: NodeJS.Timeout }> = [];
	const pendingSettled: Array<{ resolve: () => void; timer: NodeJS.Timeout }> = [];

	let buffered = "";
	child.stdout.on("data", (chunk: Buffer) => {
		buffered += chunk.toString("utf8");
		let newlineIndex = buffered.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = buffered.slice(0, newlineIndex).trim();
			buffered = buffered.slice(newlineIndex + 1);
			if (line) handleLine(line);
			newlineIndex = buffered.indexOf("\n");
		}
	});

	function handleLine(line: string): void {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		client.events.push(event);
		if (event.type === "extension_error") client.extensionErrors += 1;

		if (event.type === "response" && typeof event.id === "string") {
			const index = pendingResponses.findIndex((entry) => entry.id === event.id);
			if (index >= 0) {
				const entry = pendingResponses[index];
				pendingResponses.splice(index, 1);
				clearTimeout(entry.timer);
				entry.resolve(event);
			}
		}
		if (event.type === "agent_settled") {
			while (pendingSettled.length > 0) {
				const entry = pendingSettled.shift();
				if (entry) {
					clearTimeout(entry.timer);
					entry.resolve();
				}
			}
		}
	}

	child.stderr.on("data", () => {});

	return new Promise((resolve, reject) => {
		child.once("error", reject);
		// Give the runtime a moment to boot; first send resolves readiness lazily.
		setTimeout(() => resolve(client), 250);
	});
}

function assistantText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const typed = block as { type?: string; text?: unknown };
			return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
		})
		.join("");
}

function runTaskTests(projectDir: string, round: number): { passed: boolean; ms: number; outputChars: number } {
	const startedAt = Date.now();
	const result = spawnSync("npm", ["test"], {
		cwd: projectDir,
		env: { ...process.env, BENCH_MAX_ROUND: String(round) },
		encoding: "utf8",
		timeout: 120_000,
	});
	return {
		passed: result.status === 0,
		ms: Date.now() - startedAt,
		outputChars: (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0),
	};
}

async function runPrompt(
	client: RpcClient,
	prompt: WorkloadPrompt,
	arm: Arm,
	rep: number,
	promptTimeoutMs: number,
	projectDir: string,
): Promise<TurnRow> {
	const row: TurnRow = {
		arm,
		rep,
		phase: prompt.phase,
		round: prompt.round,
		promptChars: prompt.text.length,
		wallMs: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		contextTokens: null,
		contextPercent: null,
		toolCalls: 0,
		recoverCalls: 0,
		assistantChars: 0,
		retrievalCorrect: null,
		testPassed: null,
		testMs: null,
		testOutputChars: 0,
		failed: false,
	};

	const turnEventsStart = client.events.length;
	const startedAt = Date.now();
	try {
		client.send({ id: `p${rep}-${prompt.phase}-${prompt.round}`, type: "prompt", message: prompt.text });
		await client.waitSettled(promptTimeoutMs);
	} catch (error) {
		row.failed = true;
		row.wallMs = Date.now() - startedAt;
		return row;
	}
	row.wallMs = Date.now() - startedAt;

	let lastAssistant: Record<string, unknown> | null = null;
	for (const event of client.events.slice(turnEventsStart)) {
		if (event.type !== "message_end") continue;
		const message = event.message as Record<string, unknown> | undefined;
		if (!message || message.role !== "assistant") continue;
		lastAssistant = message;
		const usage = (message.usage ?? {}) as UsageShape;
		row.usage.input += num(usage.input);
		row.usage.output += num(usage.output);
		row.usage.cacheRead += num(usage.cacheRead);
		row.usage.cacheWrite += num(usage.cacheWrite);
		row.usage.totalTokens += num(usage.totalTokens);
		row.usage.cost += num(usage.cost?.total);
		if (Array.isArray(message.content)) {
			for (const block of message.content as Array<Record<string, unknown>>) {
				if (block.type === "toolCall") {
					row.toolCalls += 1;
					if (block.name === "akron_recover") row.recoverCalls += 1;
				}
			}
		}
	}
	row.assistantChars = lastAssistant ? assistantText(lastAssistant).length : 0;

	// A settled turn with zero provider usage means no real response came back
	// (e.g. request rejected after an aggressive context rewrite) — count it failed.
	if (row.usage.totalTokens === 0) row.failed = true;

	if (prompt.phase === "task" || prompt.phase === "final") {
		const tests = runTaskTests(projectDir, prompt.round);
		row.testPassed = tests.passed;
		row.testMs = tests.ms;
		row.testOutputChars = tests.outputChars;
	}

	try {
		client.send({ id: `s${rep}-${prompt.phase}-${prompt.round}`, type: "get_session_stats" });
		const stats = await client.waitResponse(`s${rep}-${prompt.phase}-${prompt.round}`, 15_000);
		const data = (stats.data ?? {}) as { contextUsage?: { tokens?: unknown; percent?: unknown; contextWindow?: unknown } };
		row.contextTokens = typeof data.contextUsage?.tokens === "number" ? data.contextUsage.tokens : null;
		row.contextPercent = typeof data.contextUsage?.percent === "number" ? data.contextUsage.percent : null;
	} catch {
		/* stats unavailable for this turn */
	}

	return row;
}

function countCompactions(sessionFile: string | null): number {
	if (!sessionFile || !existsSync(sessionFile)) return 0;
	try {
		return readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter((line) => line.includes('"type":"compaction"')).length;
	} catch {
		return 0;
	}
}

function readAkronProfile(agentDir: string): { events: number; chars: number } {
	const path = join(agentDir, "akron-prune", "profile.jsonl");
	if (!existsSync(path)) return { events: 0, chars: 0 };
	try {
		let events = 0;
		let chars = 0;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line) as { charsPruned?: unknown };
				events += 1;
				chars += num(record.charsPruned);
			} catch {
				/* skip */
			}
		}
		return { events, chars };
	} catch {
		return { events: 0, chars: 0 };
	}
}

async function runOne(arm: Arm, rep: number, options: BenchOptions, outDir: string): Promise<{ rows: TurnRow[]; meta: RunMeta }> {
	const workloadOptions = {
		rounds: options.rounds,
		fixtureBytes: options.fixtureBytes,
		seed: options.seed,
		workdir: "",
	};
	const workdir = setupWorkdir(arm, rep, outDir);
	const workload = createWorkload({ ...workloadOptions, workdir });
	const agentDir = setupAgentDir(arm, workdir);

	const client = await startRpc(workdir, agentDir, arm);

	if (options.model) {
		const [provider, modelId] = options.model.split("/", 2);
		if (provider && modelId) {
			client.send({ id: "set-model", type: "set_model", provider, modelId });
			await client.waitResponse("set-model", 15_000).catch(() => {});
		}
	}

	const rows: TurnRow[] = [];
	let sessionFile: string | null = null;
	for (const prompt of workload.prompts) {
		const row = await runPrompt(client, prompt, arm, rep, options.promptTimeoutMs, workload.projectDir);
		rows.push(row);
		if (row.failed) {
			console.error(`[${arm}#${rep}] prompt ${prompt.phase}/${prompt.round} failed/timed out — stopping run`);
			break;
		}
	}

	try {
		client.send({ id: "final-stats", type: "get_session_stats" });
		const stats = await client.waitResponse("final-stats", 15_000);
		const data = (stats.data ?? {}) as { sessionFile?: unknown };
		if (typeof data.sessionFile === "string") sessionFile = data.sessionFile;
	} catch {
		/* keep null */
	}

	await client.close();

	const profile = readAkronProfile(agentDir);
	const meta: RunMeta = {
		arm,
		rep,
		sessionFile,
		pruneEvents: profile.events,
		prunedChars: profile.chars,
		compactionEvents: countCompactions(sessionFile),
		extensionErrors: client.extensionErrors,
	};

	const failedTurns = rows.filter((row) => row.failed).length;
	if (failedTurns > 0) {
		console.error(`[${arm}#${rep}] ${failedTurns} failed turn(s) — keeping temp dirs for debugging:`);
		console.error(`  agent: ${agentDir}\n  work:  ${workdir}`);
	} else {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(workdir, { recursive: true, force: true });
	}

	return { rows, meta };
}

interface BenchOptions {
	arms: Arm[];
	reps: number;
	rounds: number;
	fixtureBytes: number;
	seed: number;
	model?: string;
	outDir: string;
	promptTimeoutMs: number;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const options: BenchOptions = {
		arms: (args.arms ?? ARMS.join(","))
			.split(",")
			.map((arm) => arm.trim() as Arm)
			.filter((arm) => ARMS.includes(arm)),
		reps: Number(args.reps ?? 3),
		rounds: Number(args.rounds ?? 6),
		fixtureBytes: Number(args["fixture-bytes"] ?? 46_080),
		seed: Number(args.seed ?? 42),
		model: args.model && args.model !== "true" ? args.model : "openai-codex/gpt-5.6-luna",
		outDir: args.out && args.out !== "true" ? args.out : join(scriptDir, "results", String(Date.now())),
		promptTimeoutMs: Number(args["prompt-timeout"] ?? 600_000) || 600_000,
	};

	if (options.arms.includes("pcp") && !existsSync(pcpExtensionPath)) {
		console.error(`pi-context-prune not installed at ${pcpExtensionPath} — dropping pcp arm`);
		options.arms = options.arms.filter((arm) => arm !== "pcp");
	}
	if (options.arms.length === 0) {
		console.error("no arms to run");
		process.exit(1);
	}

	mkdirSync(options.outDir, { recursive: true });
	console.error(`benchmark out: ${options.outDir} (arms=${options.arms.join(",")} reps=${options.reps} rounds=${options.rounds})`);

	const resultsPath = join(options.outDir, "results.jsonl");
	const metas: RunMeta[] = [];

	for (const arm of options.arms) {
		for (let rep = 1; rep <= options.reps; rep++) {
			console.error(`[${arm}#${rep}] running…`);
			const { rows, meta } = await runOne(arm, rep, options, options.outDir);
			metas.push(meta);
			appendFileSync(resultsPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
			console.error(
				`[${arm}#${rep}] done: ${rows.length} turns, cost $${rows.reduce((sum, row) => sum + row.usage.cost, 0).toFixed(4)}, ` +
					`prunes=${meta.pruneEvents}, compactions=${meta.compactionEvents}`,
			);
		}
	}

	writeFileSync(join(options.outDir, "summary.json"), JSON.stringify({ options: { ...options, outDir: undefined }, runs: metas }, null, 2));
	console.error(`wrote ${resultsPath} and summary.json — analyze with: bun run report.ts ${options.outDir}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
