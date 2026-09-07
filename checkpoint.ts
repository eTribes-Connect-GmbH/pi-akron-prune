/**
 * akron-prune — pruning-boundary checkpoint.
 *
 * When a batch is pruned, a compact checkpoint is inserted at the pruning
 * boundary describing the current Git changes and pointing out untracked
 * files (changes "outside Git"). This gives the model a durable, cheap
 * awareness of workspace state across the pruned region.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 5000;
const MAX_TRACKED_LINES = 30;
const MAX_UNTRACKED_LINES = 15;

export async function gitSnapshot(cwd: string): Promise<string> {
	try {
		const branch = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		});
		const branchName = branch.stdout.trim() || "(detached)";
		const status = await exec("git", ["status", "--porcelain"], { cwd, timeout: GIT_TIMEOUT_MS });
		const lines = status.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

		if (lines.length === 0) {
			return `git: branch ${branchName}, working tree clean`;
		}

		const tracked = lines.filter((l) => !l.startsWith("??"));
		const untracked = lines.filter((l) => l.startsWith("??")).map((l) => l.slice(3).trim());

		const parts: string[] = [`git: branch ${branchName}`];
		if (tracked.length > 0) {
			const shown = tracked.slice(0, MAX_TRACKED_LINES).join("; ");
			parts.push(`${tracked.length} modified/staged (${shown}${tracked.length > MAX_TRACKED_LINES ? "; …" : ""})`);
		}
		if (untracked.length > 0) {
			const shown = untracked.slice(0, MAX_UNTRACKED_LINES).join(", ");
			parts.push(
				`${untracked.length} outside git/untracked (${shown}${untracked.length > MAX_UNTRACKED_LINES ? ", …" : ""})`,
			);
		}
		return parts.join(" — ");
	} catch {
		return "git: not a repository / git unavailable";
	}
}