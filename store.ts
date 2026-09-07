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
	const m = (mimeType ?? "").toLowerCase();
	for (const [ext, mime] of Object.entries(MIME_BY_EXT)) {
		if (mime === m) return ext;
	}
	return "png";
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
		const files: ArtifactFile[] = [];
		const textParts: string[] = [];
		let imgIdx = 0;

		for (const block of blocks ?? []) {
			if (block?.type === "text" && typeof block.text === "string") {
				textParts.push(block.text);
			} else if (block?.type === "image" && typeof block.data === "string") {
				const ext = extForMime(block.mimeType);
				const path = join(this.sessionDir, `${base}-img${++imgIdx}.${ext}`);
				const buf = Buffer.from(block.data, "base64");
				this.writeVerified(path, buf);
				files.push({ path, sha256: sha256(buf), bytes: buf.length });
			}
		}

		if (textParts.length > 0 && textParts.some((t) => t.length > 0)) {
			const path = join(this.sessionDir, `${base}.txt`);
			const text = textParts.length === 1 ? textParts[0] : textParts.join("\n\n--- [akron block boundary] ---\n\n");
			const buf = Buffer.from(text, "utf8");
			this.writeVerified(path, buf);
			files.push({ path, sha256: sha256(buf), bytes: buf.length });
		}

		if (files.length === 0) throw new Error(`no artifact content for ${base}`);
		return files;
	}

	private writeVerified(path: string, buf: Buffer): void {
		writeFileSync(path, buf);
		const back = readFileSync(path);
		if (sha256(back) !== sha256(buf)) {
			throw new Error(`artifact verification failed: ${path}`);
		}
	}

	/**
	 * Drops index entries whose artifacts went missing or no longer match
	 * their recorded size. Because the session file still holds the originals,
	 * dropping an entry simply means the original stays in context — nothing
	 * is lost. Returns how many entries were dropped.
	 */
	validateEntries(index: PruneIndex): { dropped: number } {
		let dropped = 0;
		for (const [key, entry] of Object.entries(index.entries)) {
			for (const f of entry.files ?? []) {
				try {
					const st = statSync(f.path);
					if (st.size !== f.bytes) throw new Error("size mismatch");
				} catch {
					delete index.entries[key];
					dropped++;
					break;
				}
			}
		}
		return { dropped };
	}

	/** Resolves a user-supplied ref to an artifact path inside this session's store. */
	resolveArtifactPath(ref: string): string | null {
		const root = resolve(this.sessionDir);
		const abs = resolve(ref);
		if (abs !== root && !abs.startsWith(root + sep)) return null;
		if (!existsSync(abs)) return null;
		return abs;
	}

	/** Reads an artifact file back as content blocks (text or image). */
	readArtifactBlocks(
		path: string,
	): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
		const ext = extname(path).slice(1).toLowerCase();
		if (MIME_BY_EXT[ext]) {
			const data = readFileSync(path).toString("base64");
			return [{ type: "image", data, mimeType: MIME_BY_EXT[ext] }];
		}
		return [{ type: "text", text: readFileSync(path, "utf8") }];
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