/**
 * akron-prune — durable artifact store.
 *
 * Every pruned item is written to disk *before* its reference replaces the
 * original in the outgoing context, and verified by re-read + sha256. If a
 * write or verification fails, the original content is kept — pruning fails
 * rather than silently discarding output. The session file is never touched,
 * so a lost artifact only costs a graceful fallback to the original content.
 *
 * Layout:
 *   ~/.pi/agent/akron-prune/
 *     settings.json
 *     profile.jsonl                      ← one line per prune event
 *     artifacts/<sessionId>/
 *       index.json                        ← pruned-item index + checkpoints
 *       tc-<sanitized-id>.txt             ← text results
 *       tc-<sanitized-id>-img1.png        ← image results
 *       tc-<sanitized-id>-args.txt        ← stubbed bash commands
 *       img-u-<ts>-<hash>-img1.jpg        ← uploaded user images
 */

import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { profileFile } from "./config.js";
import type { ArtifactFile, PruneIndex } from "./types.js";

export function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

function extForMime(mimeType: string | undefined): string {
	const found = Object.entries(MIME_BY_EXT).find(([, mime]) => mime === mimeType?.toLowerCase());
	return found?.[0] ?? "png";
}

/** Appends one profiling record — friend's "Effektivität auswerten" data source. */
export function appendProfile(record: Record<string, unknown>): void {
	try {
		appendFileSync(profileFile(), `${JSON.stringify(record)}\n`);
	} catch {
		/* profiling must never break pruning */
	}
}

export class ArtifactStore {
	readonly sessionDir: string;
	readonly indexFile: string;

	private constructor(sessionDir: string) {
		this.sessionDir = sessionDir;
		this.indexFile = join(sessionDir, "index.json");
	}

	static open(root: string, sessionId: string): ArtifactStore {
		const dir = join(root, sessionId);
		mkdirSync(dir, { recursive: true });
		return new ArtifactStore(dir);
	}

	loadIndex(sessionId: string): PruneIndex {
		try {
			if (existsSync(this.indexFile)) {
				const raw = JSON.parse(readFileSync(this.indexFile, "utf8"));
				if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object") {
					return {
						version: 1,
						sessionId,
						createdTs: typeof raw.createdTs === "number" ? raw.createdTs : Date.now(),
						entries: raw.entries,
						checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints : [],
						measuredPruneTs: typeof raw.measuredPruneTs === "number" ? raw.measuredPruneTs : undefined,
					};
				}
			}
		} catch {
			/* fall through to a fresh index */
		}
		return { version: 1, sessionId, createdTs: Date.now(), entries: {}, checkpoints: [] };
	}

	saveIndex(index: PruneIndex): void {
		const tmp = `${this.indexFile}.tmp`;
		writeFileSync(tmp, JSON.stringify(index));
		renameSync(tmp, this.indexFile);
	}

	/**
	 * Writes an artifact for the given content blocks and verifies it by
	 * re-reading the file and comparing hashes. Throws on any mismatch —
	 * callers must treat a throw as "do not prune this item".
	 */
	writeArtifact(base: string, blocks: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>): ArtifactFile[] {
		if (!blocks?.length) throw new Error(`no artifact content for ${base}`);
		const files: ArtifactFile[] = [];
		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
			const suffix = blocks.length === 1 ? "" : `-block${i + 1}`;
			let path: string;
			let buf: Buffer;
			if (block.type === "text" && typeof block.text === "string") {
				path = join(this.sessionDir, `${base}${suffix}.txt`);
				buf = Buffer.from(block.text, "utf8");
			} else if (block.type === "image" && typeof block.data === "string") {
				path = join(this.sessionDir, `${base}${suffix}.${extForMime(block.mimeType)}`);
				buf = Buffer.from(block.data, "base64");
			} else {
				throw new Error(`unsupported artifact block ${i + 1} for ${base}`);
			}
			this.writeVerified(path, buf);
			const { mtimeMs, ctimeMs } = statSync(path);
			files.push({ path, sha256: sha256(buf), bytes: buf.length, mtimeMs, ctimeMs });
		}
		return files;
	}

	private writeVerified(path: string, buf: Buffer): void {
		const tmp = `${path}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, buf);
			const back = readFileSync(tmp);
			if (sha256(back) !== sha256(buf)) throw new Error(`artifact verification failed: ${path}`);
			renameSync(tmp, path);
		} catch (err) {
			rmSync(tmp, { force: true });
			throw err;
		}
	}

	/**
	 * Drops index entries whose artifacts went missing or no longer match
	 * their recorded size/hash. Because the session file still holds the originals,
	 * dropping an entry simply means the original stays in context — nothing
	 * is lost. Returns how many entries were dropped.
	 */
	validateEntries(index: PruneIndex): { dropped: number; updated: number } {
		let dropped = 0;
		let updated = 0;
		type ObservedArtifact = { exists: boolean; bytes?: number; sha256?: string; mtimeMs?: number; ctimeMs?: number };
		const refsByPath = new Map<string, ArtifactFile[]>();
		for (const entry of Object.values(index.entries)) {
			for (const file of [...(entry.files ?? []), ...(entry.hiddenFiles ?? [])]) {
				const refs = refsByPath.get(file.path) ?? [];
				refs.push(file);
				refsByPath.set(file.path, refs);
			}
		}

		const checked = new Map<string, ObservedArtifact>();
		for (const [path, refs] of refsByPath) {
			try {
				const stat = statSync(path);
				const commonHash = refs.every((file) => file.sha256 === refs[0].sha256);
				const unchanged = commonHash && refs.every(
					(file) => file.bytes === stat.size && file.mtimeMs === stat.mtimeMs && file.ctimeMs === stat.ctimeMs,
				);
				checked.set(path, {
					exists: true,
					bytes: stat.size,
					sha256: unchanged ? refs[0].sha256 : sha256(readFileSync(path)),
					mtimeMs: stat.mtimeMs,
					ctimeMs: stat.ctimeMs,
				});
			} catch {
				checked.set(path, { exists: false });
			}
		}

		for (const [key, entry] of Object.entries(index.entries)) {
			for (const file of [...(entry.files ?? []), ...(entry.hiddenFiles ?? [])]) {
				const observed = checked.get(file.path);
				const valid = observed?.exists && file.bytes === observed.bytes && file.sha256 === observed.sha256;
				if (!valid) {
					delete index.entries[key];
					dropped++;
					break;
				}
				if (file.mtimeMs !== observed.mtimeMs || file.ctimeMs !== observed.ctimeMs) {
					file.mtimeMs = observed.mtimeMs;
					file.ctimeMs = observed.ctimeMs;
					updated++;
				}
			}
		}
		return { dropped, updated };
	}

	/** Resolves a user-supplied ref to an artifact path inside this session's store. */
	resolveArtifactPath(ref: string): string | null {
		const root = resolve(this.sessionDir);
		const abs = resolve(ref);
		if (abs !== root && !abs.startsWith(root + sep)) return null;
		if (!existsSync(abs)) return null;
		return abs;
	}

	private readVerifiedArtifact(file: { path: string; sha256: string; bytes: number }): Buffer {
		const buf = readFileSync(file.path);
		if (buf.length !== file.bytes) throw new Error(`artifact size mismatch: ${file.path}`);
		if (sha256(buf) !== file.sha256) throw new Error(`artifact hash mismatch: ${file.path}`);
		return buf;
	}

	/** Reads an artifact file back as content blocks (text or image), verifying hash when metadata is supplied. */
	readArtifactBlocks(
		file: string | { path: string; sha256: string; bytes: number },
	): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
		const path = typeof file === "string" ? file : file.path;
		const buf = typeof file === "string" ? readFileSync(path) : this.readVerifiedArtifact(file);
		if (path.endsWith(".akron.json")) {
			let parsed: { version?: number; blocks?: unknown };
			try {
				parsed = JSON.parse(buf.toString("utf8")) as { version?: number; blocks?: unknown };
			} catch {
				throw new Error(`invalid artifact bundle: ${path}`);
			}
			if (parsed.version !== 1 || !Array.isArray(parsed.blocks)) throw new Error(`invalid artifact bundle: ${path}`);
			return parsed.blocks as Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
		}
		const ext = extname(path).slice(1).toLowerCase();
		if (MIME_BY_EXT[ext]) {
			return [{ type: "image", data: buf.toString("base64"), mimeType: MIME_BY_EXT[ext] }];
		}
		return [{ type: "text", text: buf.toString("utf8") }];
	}

	static sessionSizeBytes(sessionDir: string): number {
		let total = 0;
		const walk = (dir: string): void => {
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				return;
			}
			for (const n of names) {
				const p = join(dir, n);
				let st;
				try {
					st = statSync(p);
				} catch {
					continue;
				}
				if (st.isDirectory()) walk(p);
				else total += st.size;
			}
		};
		walk(sessionDir);
		return total;
	}

	/**
	 * Removes artifact directories for sessions that no longer exist and
	 * whose index is older than the retention window.
	 */
	static gc(root: string, sessionsDirPath: string, retentionDays: number): { removed: number; freedBytes: number } {
		let removed = 0;
		let freedBytes = 0;
		let entries: string[] = [];
		try {
			entries = readdirSync(root);
		} catch {
			return { removed, freedBytes };
		}
		const cutoff = Date.now() - retentionDays * 86_400_000;
		for (const sessionId of entries) {
			const dir = join(root, sessionId);
			let st;
			try {
				st = statSync(dir);
			} catch {
				continue;
			}
			if (!st.isDirectory()) continue;
			const indexFile = join(dir, "index.json");
			let indexTs = st.mtimeMs;
			try {
				indexTs = statSync(indexFile).mtimeMs;
			} catch {
				/* keep dir mtime */
			}
			if (indexTs > cutoff) continue;
			if (sessionFileExists(sessionsDirPath, sessionId)) continue;
			const bytes = ArtifactStore.sessionSizeBytes(dir);
			try {
				rmSync(dir, { recursive: true, force: true });
				removed++;
				freedBytes += bytes;
			} catch {
				/* skip */
			}
		}
		return { removed, freedBytes };
	}
}

function sessionFileExists(sessionsDirPath: string, sessionId: string): boolean {
	try {
		const level1 = readdirSync(sessionsDirPath, { withFileTypes: true });
		for (const d of level1) {
			if (!d.isDirectory()) continue;
			const dir = join(sessionsDirPath, d.name);
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				continue;
			}
			for (const n of names) {
				if (n === `${sessionId}.jsonl` || n.endsWith(`_${sessionId}.jsonl`)) return true;
			}
		}
	} catch {
		/* sessions dir unavailable — keep artifacts */
	}
	return false;
}