/**
 * akron-prune — configuration.
 *
 * Settings live in ~/.pi/agent/akron-prune/settings.json so they survive
 * restarts and apply across projects. All thresholds are expressed in
 * characters (matching the design notes), not tokens.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Mirrors pi's getAgentDir() (PI_CODING_AGENT_DIR override, else ~/.pi/agent)
 * without a runtime import of the package entry, which Bun cannot resolve
 * through the package's .d.ts re-exports.
 */
function resolveAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) {
    return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
  }
  return join(homedir(), ".pi", "agent");
}

export interface AkronConfig {
  /** Master switch. */
  enabled: boolean;
  /** Footer status widget with the pending backlog. */
  showStatus: boolean;
  /** Newest N eligible batches always stay in context, verbatim. */
  newestBatches: number;
  /** Standard trigger: minimum number of pending batches. */
  minPendingBatches: number;
  /** Standard trigger: minimum pending characters. */
  minPendingChars: number;
  /** Standard trigger: pending item count (ORs with triggerChars). */
  triggerItems: number;
  /** Standard trigger: pending characters (ORs with triggerItems). */
  triggerChars: number;
  /** Emergency trigger: pending characters, regardless of item counts. */
  emergencyChars: number;
  /** Even in an emergency, never prune the newest K batches. */
  emergencyKeepBatches: number;
  /** Results below this size are not worth replacing with a reference. */
  minResultChars: number;
  /** Also prune error outputs (they are artifacts too). */
  pruneErrors: boolean;
  /** Tools whose file-mutation arguments get stubbed (the file is the artifact). */
  mutationTools: string[];
  /** read results for these paths stay in context verbatim (working instructions). */
  preserveReadExtensions: string[];
  /** bash commands longer than this get their arguments stubbed + artifacted. */
  stubBashArgsOver: number;
  /** Cancel threshold compaction when pruning can free enough context. */
  cancelCompaction: boolean;
  /** Required freed-token fraction of tokensBefore to justify cancelling compaction. */
  compactionFreeFraction: number;
  /** Artifact retention for /akron gc (days). */
  retentionDays: number;
  /** Maximum number of pruning checkpoints kept in the index. */
  maxCheckpoints: number;
}

export const DEFAULT_CONFIG: AkronConfig = {
  enabled: true,
  showStatus: true,
  newestBatches: 16,
  minPendingBatches: 4,
  minPendingChars: 256_000,
  triggerItems: 64,
  triggerChars: 450_000,
  emergencyChars: 1_400_000,
  emergencyKeepBatches: 2,
  minResultChars: 120,
  pruneErrors: true,
  mutationTools: ["write", "edit"],
  preserveReadExtensions: [".md", ".markdown", ".mdx"],
  stubBashArgsOver: 800,
  cancelCompaction: true,
  compactionFreeFraction: 0.2,
  retentionDays: 30,
  maxCheckpoints: 50,
};

/** Extension version, surfaced in /akron status. */
export const AKRON_VERSION = "0.1.0";

/** The active pi agent dir (honors PI_CODING_AGENT_DIR). */
export function agentDir(): string {
  return resolveAgentDir();
}

export function akronDir(): string {
  return join(agentDir(), "akron-prune");
}

export function artifactsRoot(): string {
  return join(akronDir(), "artifacts");
}

export function profileFile(): string {
  return join(akronDir(), "profile.jsonl");
}

export function cacheProfileFile(): string {
  return join(akronDir(), "cache-profile.jsonl");
}

export function settingsFile(): string {
  return join(akronDir(), "settings.json");
}

export function sessionsDir(): string {
  return join(resolveAgentDir(), "sessions");
}

export function loadConfig(): AkronConfig {
  try {
    if (!existsSync(settingsFile())) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(readFileSync(settingsFile(), "utf8"));
    if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: AkronConfig): void {
  try {
    mkdirSync(akronDir(), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(cfg, null, 2));
  } catch {
    /* best-effort persistence */
  }
}