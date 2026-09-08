/**
 * Deterministic synthetic coding workload for the pruning comparison.
 *
 * Generates a tiny dependency-free JavaScript project plus large per-round
 * briefings. The agent must edit the project over several dependent coding
 * turns; the runner scores behavior by executing the generated tests.
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
	phase: "task" | "final";
	round: number;
	text: string;
}

export interface Workload {
	projectDir: string;
	evidenceDir: string;
	prompts: WorkloadPrompt[];
	testCommand: string[];
}

interface CodingTask {
	name: string;
	files: string[];
	requirement: string;
}

const TASKS: CodingTask[] = [
	{
		name: "SKU normalization",
		files: ["src/catalog.mjs"],
		requirement:
			"Implement normalizeSku(value). It must trim surrounding whitespace, convert to uppercase, replace every run of non-alphanumeric characters with one dash, and remove leading/trailing dashes.",
	},
	{
		name: "catalog indexing",
		files: ["src/catalog.mjs"],
		requirement:
			"Implement indexCatalog(items). It must return a Map keyed by normalizeSku(item.sku). Duplicate normalized SKUs are invalid and must throw an Error containing 'duplicate sku'.",
	},
	{
		name: "money parsing",
		files: ["src/pricing.mjs"],
		requirement:
			"Implement parseMoney(value). Accept numbers or strings like '$12.34', '12', and ' 7.5 '. Return integer cents rounded to the nearest cent. Reject negative or non-finite values with an Error containing 'invalid money'.",
	},
	{
		name: "discounts",
		files: ["src/pricing.mjs"],
		requirement:
			"Implement applyDiscount(cents, code). Supported codes are SAVE10 for 10% off and SAVE25 for 25% off. Unknown, empty, or missing codes leave the amount unchanged. Always round to the nearest cent.",
	},
	{
		name: "cart totals",
		files: ["src/cart.mjs"],
		requirement:
			"Implement totalCart(lines, catalog, options). Each line has sku and qty. Look up normalized SKUs in the catalog Map, multiply unitPrice by qty, apply an optional discountCode to the subtotal, then add shipping: 0 cents at or above 5000 discounted cents, otherwise 799 cents.",
	},
	{
		name: "receipt rendering",
		files: ["src/cart.mjs"],
		requirement:
			"Implement renderReceipt(lines, catalog, options). Return exactly three newline-separated lines: subtotal, shipping, total. Format cents as dollars with two decimals, e.g. 'subtotal: $12.30'. Use the same normalization, discount, and shipping rules as totalCart.",
	},
];

/** Deterministic 32-bit LCG so every arm and rep sees identical filler text. */
function createRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" ");

function fillerText(rng: () => number, bytes: number): string {
	const lines: string[] = [];
	let size = 0;
	while (size < bytes) {
		const words: string[] = [];
		let lineSize = 0;
		while (lineSize < 88) {
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

function writeEvidenceFiles(dir: string, rng: () => number, round: number, task: CodingTask, totalBytes: number): string[] {
	const chunkBytes = 44_000;
	const chunks = Math.max(1, Math.ceil(totalBytes / chunkBytes));
	const paths: string[] = [];
	for (let index = 0; index < chunks; index++) {
		const path = join(dir, `round-${String(round).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}.txt`);
		const header =
			`Round ${round}: ${task.name}\n` +
			`Requirement: ${task.requirement}\n` +
			`Relevant files: ${task.files.join(", ")}\n` +
			`Evidence chunk ${index + 1} of ${chunks}. This is plain text so completed reads are eligible for pruning.\n\n`;
		writeFileSync(path, header + fillerText(rng, Math.min(chunkBytes, Math.max(0, totalBytes - index * chunkBytes))));
		paths.push(path);
	}
	return paths;
}

function selectedTasks(rounds: number): CodingTask[] {
	const count = Math.max(1, Math.min(rounds, TASKS.length));
	return TASKS.slice(0, count);
}

function writeProject(projectDir: string, taskCount: number): void {
	mkdirSync(join(projectDir, "src"), { recursive: true });
	mkdirSync(join(projectDir, "tests"), { recursive: true });
	writeFileSync(
		join(projectDir, "package.json"),
		JSON.stringify({ type: "module", scripts: { test: "node --test tests/workload.test.mjs" } }, null, 2),
	);
	writeFileSync(
		join(projectDir, "src", "catalog.mjs"),
		`export function normalizeSku(value) {\n  throw new Error('TODO normalizeSku');\n}\n\nexport function indexCatalog(items) {\n  throw new Error('TODO indexCatalog');\n}\n`,
	);
	writeFileSync(
		join(projectDir, "src", "pricing.mjs"),
		`export function parseMoney(value) {\n  throw new Error('TODO parseMoney');\n}\n\nexport function applyDiscount(cents, code) {\n  throw new Error('TODO applyDiscount');\n}\n`,
	);
	writeFileSync(
		join(projectDir, "src", "cart.mjs"),
		`import { normalizeSku } from './catalog.mjs';\nimport { applyDiscount } from './pricing.mjs';\n\nexport function totalCart(lines, catalog, options = {}) {\n  throw new Error('TODO totalCart');\n}\n\nexport function renderReceipt(lines, catalog, options = {}) {\n  throw new Error('TODO renderReceipt');\n}\n`,
	);
	writeFileSync(join(projectDir, "tests", "workload.test.mjs"), testFile(taskCount));
}

function testFile(taskCount: number): string {
	return `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { normalizeSku, indexCatalog } from '../src/catalog.mjs';\nimport { parseMoney, applyDiscount } from '../src/pricing.mjs';\nimport { totalCart, renderReceipt } from '../src/cart.mjs';\n\nconst maxRound = Number(process.env.BENCH_MAX_ROUND || ${taskCount});\nfunction round(n, name, fn) {\n  if (maxRound >= n) test(\`round ${"${n}"}: ${"${name}"}\`, fn);\n}\n\nround(1, 'normalizes sku text', () => {\n  assert.equal(normalizeSku('  abc 123  '), 'ABC-123');\n  assert.equal(normalizeSku('summer__sale//blue'), 'SUMMER-SALE-BLUE');\n  assert.equal(normalizeSku('---already-OK---'), 'ALREADY-OK');\n});\n\nround(2, 'indexes catalog by normalized sku and rejects duplicates', () => {\n  const map = indexCatalog([{ sku: 'abc 123', unitPrice: 1200 }, { sku: 'blue-widget', unitPrice: 3499 }]);\n  assert.equal(map.get('ABC-123').unitPrice, 1200);\n  assert.throws(() => indexCatalog([{ sku: 'a b' }, { sku: 'A-B' }]), /duplicate sku/i);\n});\n\nround(3, 'parses money as cents', () => {\n  assert.equal(parseMoney('$12.34'), 1234);\n  assert.equal(parseMoney('7.5'), 750);\n  assert.equal(parseMoney(1.235), 124);\n  assert.throws(() => parseMoney('-1'), /invalid money/i);\n  assert.throws(() => parseMoney('wat'), /invalid money/i);\n});\n\nround(4, 'applies supported discounts', () => {\n  assert.equal(applyDiscount(999, 'SAVE10'), 899);\n  assert.equal(applyDiscount(999, 'SAVE25'), 749);\n  assert.equal(applyDiscount(999, 'NOPE'), 999);\n  assert.equal(applyDiscount(999), 999);\n});\n\nround(5, 'computes cart totals with normalized sku lookup and shipping', () => {\n  const catalog = indexCatalog([{ sku: 'abc 123', unitPrice: 1200 }, { sku: 'big', unitPrice: 5000 }]);\n  assert.deepEqual(totalCart([{ sku: 'ABC-123', qty: 2 }], catalog), { subtotal: 2400, shipping: 799, total: 3199 });\n  assert.deepEqual(totalCart([{ sku: 'abc 123', qty: 5 }], catalog, { discountCode: 'SAVE10' }), { subtotal: 6000, shipping: 0, total: 5400 });\n  assert.throws(() => totalCart([{ sku: 'missing', qty: 1 }], catalog), /unknown sku/i);\n});\n\nround(6, 'renders a stable receipt', () => {\n  const catalog = indexCatalog([{ sku: 'abc 123', unitPrice: 1200 }, { sku: 'big', unitPrice: 5000 }]);\n  assert.equal(renderReceipt([{ sku: 'abc 123', qty: 2 }], catalog, { discountCode: 'SAVE25' }), 'subtotal: $18.00\\nshipping: $7.99\\ntotal: $25.99');\n});\n`;
}

export function createWorkload(options: WorkloadOptions): Workload {
	const rng = createRng(options.seed);
	const projectDir = join(options.workdir, "coding-workload");
	const evidenceDir = join(options.workdir, "evidence");
	const tasks = selectedTasks(options.rounds);
	mkdirSync(evidenceDir, { recursive: true });
	writeProject(projectDir, tasks.length);

	const prompts: WorkloadPrompt[] = [];
	for (let index = 0; index < tasks.length; index++) {
		const round = index + 1;
		const task = tasks[index];
		const evidencePaths = writeEvidenceFiles(evidenceDir, rng, round, task, options.fixtureBytes);
		prompts.push({
			phase: "task",
			round,
			text:
				`You are working in ${projectDir}.\n` +
				`First read every evidence file for this round:\n${evidencePaths.map((path) => `- ${path}`).join("\n")}\n` +
				`Then inspect the relevant source/tests and implement only round ${round}: ${task.name}.\n` +
				`${task.requirement}\n` +
				`Run the narrow test command: BENCH_MAX_ROUND=${round} npm test.\n` +
				`When done, reply with a concise summary and whether the tests pass.`,
		});
	}

	prompts.push({
		phase: "final",
		round: tasks.length,
		text:
			`In ${projectDir}, run the full benchmark test suite with BENCH_MAX_ROUND=${tasks.length} npm test. ` +
			`If anything fails, fix the implementation. Reply with the final test status only.`,
	});

	return { projectDir, evidenceDir, prompts, testCommand: ["npm", "test"] };
}
