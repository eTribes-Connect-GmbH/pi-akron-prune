import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Batch, BatchItem } from "./types.js";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 5000;
const MAX_DIFF_CHARS = 24_000;
const MAX_STATUS_LINES = 60;
const MAX_OUTSIDE_PATHS = 20;
const MAX_MARKDOWN_CHARS = 80_000;

function argPath(input: unknown): string | undefined {
	const p = String((input as { path?: unknown } | undefined)?.path ?? "").trim();
	return p || undefined;
}

function isMutationItem(item: BatchItem): boolean {
	return item.kind === "args" && ["write", "edit"].includes(item.toolName ?? "") && !item.isError;
}

function isMarkdownPath(path: string): boolean {
	return /(?:^|[/\\])AGENTS\.md$/i.test(path) || /\.(?:md|markdown|mdx)$/i.test(path);
}

function workspacePath(cwd: string, path: string): { abs: string; rel: string; inside: boolean } {
	const root = resolve(cwd);
	const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
	const rel = relative(root, abs);
	const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
	return { abs, rel: inside ? rel || "." : abs, inside };
}

function mutatedPaths(cwd: string, batches: Batch[]): { inside: string[]; outside: string[]; markdown: string[] } {
	const inside = new Set<string>();
	const outside = new Set<string>();
	const markdown = new Set<string>();
	for (const item of batches.flatMap(batch => batch.items)) {
		if (!isMutationItem(item)) continue;
		const p = argPath(item.input);
		if (!p) continue;
		const resolved = workspacePath(cwd, p);
		if (resolved.inside) inside.add(resolved.rel);
		else outside.add(resolved.abs);
		if (resolved.inside && isMarkdownPath(resolved.rel)) markdown.add(resolved.rel);
	}
	for (const item of batches.flatMap(batch => batch.items)) {
		if (item.kind !== "result" || item.toolName !== "read") continue;
		const p = argPath(item.input);
		if (!p || !isMarkdownPath(p)) continue;
		const resolved = workspacePath(cwd, p);
		if (resolved.inside) markdown.add(resolved.rel);
	}
	const byName = (a: string, b: string) => a.localeCompare(b);
	return { inside: [...inside].sort(byName), outside: [...outside].sort(byName), markdown: [...markdown].sort(byName) };
}

async function git(cwd: string, args: string[]): Promise<string> {
	const out = await exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 512_000 });
	return out.stdout.trim();
}

function bounded(text: string, max: number, label = "content"): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… ${label} omitted after ${max} chars`;
}

export async function workspaceSnapshot(cwd: string, batches: Batch[]): Promise<string> {
	const paths = mutatedPaths(cwd, batches);
	const parts: string[] = [];
	try {
		const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) || "(detached)";
		const status = await git(cwd, ["status", "--porcelain"]);
		parts.push(`git: branch ${branch}`);
		if (status) parts.push(`status:\n${status.split("\n").slice(0, MAX_STATUS_LINES).join("\n")}`);
		else parts.push("status: clean");
		const diffArgs = paths.inside.length ? ["diff", "--", ...paths.inside] : ["diff", "--stat"];
		const diff = await git(cwd, diffArgs);
		if (diff) parts.push(`diff:\n${bounded(diff, MAX_DIFF_CHARS)}`);
	} catch {
		parts.push("git: not a repository / git unavailable");
	}
	if (paths.outside.length) {
		parts.push(`outside git mutations:\n${paths.outside.slice(0, MAX_OUTSIDE_PATHS).join("\n")}${paths.outside.length > MAX_OUTSIDE_PATHS ? "\n…" : ""}`);
	}
	for (const rel of paths.markdown) {
		if (!/(?:^|[/\\])AGENTS\.md$/i.test(rel)) continue;
		const abs = resolve(cwd, rel);
		if (existsSync(abs)) parts.push(`Latest ${rel} (complete up to ${MAX_MARKDOWN_CHARS} chars):\n\n${bounded(readFileSync(abs, "utf8"), MAX_MARKDOWN_CHARS, "file content")}`);
	}
	return parts.join("\n\n");
}
