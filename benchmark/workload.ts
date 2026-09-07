/**
 * Deterministic benchmark workload for the pruning comparison.
 *
 * Generates fixture files with seeded pseudo-random text plus a unique
 * marker token at the top of each file, and produces the exact prompt
 * script (fill → tail → retrieve) every benchmark arm executes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkloadOptions {
	rounds: number;
	fixtureBytes: number;
	seed: number;
	workdir: string;
}

export interface WorkloadPrompt {
	phase: "fill" | "tail" | "retrieve";
	round: number;
	text: string;
	/** Expected marker token for retrieval scoring (retrieve phase only). */
	expectMarker?: string;
}

export interface Workload {
	fixturesDir: string;
	prompts: WorkloadPrompt[];
	markers: string[];
}

/** Deterministic 32-bit LCG so every arm and rep sees identical content. */
function createRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" ");

function markerFor(rng: () => number, round: number): string {
	const hex = Math.floor(rng() * 0xffff_ffff)
		.toString(16)
		.padStart(8, "0");
	return `MK${round}-${hex}`;
}

function fixtureText(rng: () => number, bytes: number, marker: string): string {
	const lines: string[] = [`marker ${marker}`];
	let size = lines[0].length + 1;
	while (size < bytes) {
		const words: string[] = [];
		let lineSize = 0;
		while (lineSize < 72) {
			const word = WORDS[Math.floor(rng() * WORDS.length)];
			words.push(word);
			lineSize += word.length + 1;
		}
		const line = words.join(" ");
		lines.push(line);
		size += line.length + 1;
	}
	return `${lines.join("\n")}\n`;
}

export function createWorkload(options: WorkloadOptions): Workload {
	const rng = createRng(options.seed);
	const fixturesDir = join(options.workdir, "fixtures");
	mkdirSync(fixturesDir, { recursive: true });

	const markers: string[] = [];
	const prompts: WorkloadPrompt[] = [];

	for (let round = 1; round <= options.rounds; round++) {
		const marker = markerFor(rng, round);
		markers.push(marker);
		const path = join(fixturesDir, `chunk-${String(round).padStart(3, "0")}.txt`);
		writeFileSync(path, fixtureText(rng, options.fixtureBytes, marker));
		prompts.push({
			phase: "fill",
			round,
			text:
				`Use the bash tool to run exactly this one command and nothing else:\n` +
				`cat ${path}\n` +
				`After the command finishes, reply with exactly: ok ${round}`,
		});
	}

	prompts.push({ phase: "tail", round: 0, text: "Reply with only the word: ready" });

	// Retrieval targets the OLDEST fill round to maximize context distance.
	const retrieveRound = 1;
	prompts.push({
		phase: "retrieve",
		round: retrieveRound,
		text:
			`Earlier in this session, the output of the cat command for chunk 001 contained a marker token ` +
			`on its first line, formatted like MK1-XXXXXXXX. Reply with only that exact marker token.`,
		expectMarker: markers[retrieveRound - 1],
	});

	return { fixturesDir, prompts, markers };
}
