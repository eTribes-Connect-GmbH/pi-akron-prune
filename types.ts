/**
 * akron-prune — shared data types.
 *
 * Lossless context pruning for pi: completed tool activity and uploaded
 * images are stored as durable artifacts on disk and replaced in the
 * outgoing LLM context with short, deterministic references. The session
 * file is never modified; pruning only affects request building.
 */

export type EntryKind = "result" | "args" | "userImage";
export type RewriteMode = "replace" | "removePair";

export interface ArtifactFile {
  /** Absolute path of the artifact on disk. */
  path: string;
  /** sha256 of the file content at write time. */
  sha256: string;
  bytes: number;
  /** Filesystem timestamps used to skip re-hashing unchanged artifacts at startup. */
  mtimeMs?: number;
  ctimeMs?: number;
}

/**
 * One pruned item, durable across restarts. The index is keyed by:
 *   - `tc:<toolCallId>`        → the toolResult content was replaced
 *   - `tc:<toolCallId>:args`   → the toolCall arguments were stubbed
 *   - `u:<ts>:<hash>`          → images in a user message were replaced
 */
export interface PruneEntry {
  kind: EntryKind;
  toolName?: string;
  toolCallId?: string;
  ts: number;
  files: ArtifactFile[];
  /** Files persisted for hidden pair removal; recoverable but not visible in context. */
  hiddenFiles?: ArtifactFile[];
  /** Deterministic replacement text used when the entry remains visible in context. */
  refText: string;
  /** Whether rewrite should replace in place or remove the consumed call/result pair. */
  rewrite?: RewriteMode;
  /** Why this entry was selected for pruning; useful in profile/debug output. */
  pruneReason?: string;
  /** Replacement arguments for stubbed tool calls (args entries only). */
  stubArgs?: Record<string, unknown>;
  isError?: boolean;
  prunedChars: number;
}

export interface Checkpoint {
  /** Key of the message this checkpoint is inserted before (first
   *  toolCall id of the first pruned batch, or a user-image key). */
  anchorKey: string;
  ts: number;
  text: string;
}

export interface PruneIndex {
  version: 1;
  sessionId: string;
  createdTs: number;
  entries: Record<string, PruneEntry>;
  checkpoints: Checkpoint[];
  /** Latest prune generation observed in a completed provider response. */
  measuredPruneTs?: number;
}

export type ItemKind = "result" | "args" | "userImage";

export interface BatchItem {
  kind: ItemKind;
  /** Key used in PruneIndex.entries. */
  key: string;
  toolName?: string;
  toolCallId?: string;
  /** Original tool input (used for stub construction and preserve rules). */
  input?: unknown;
  /** Index of the message that carries this item's content. */
  msgIndex: number;
  /** Index of the assistant message carrying the toolCall (args items). */
  argsMsgIndex?: number;
  chars: number;
  isError?: boolean;
  blocks?: unknown[];
  /** Exact matching tool-call block, archived before removing a pair. */
  pairCall?: unknown;
  /** False when rewriting/removing calls from the source assistant message would invalidate provider signatures. */
  pairRemovalSafe?: boolean;
  /** Exact matching tool-result blocks, archived when only the call arguments were otherwise eligible. */
  pairResultBlocks?: unknown[];
  /** Removal is only used for consumed redundant evidence; assistant reasoning is kept. */
  rewrite?: RewriteMode;
  pruneReason?: string;
}

export interface Batch {
  /** Message index that anchors this batch (assistant or user message). */
  anchorMsgIndex: number;
  /** First toolCall id of the assistant message, or the user-image key. */
  anchorKey: string;
  anchorIsUser: boolean;
  items: BatchItem[];
  chars: number;
  /** Highest message index belonging to this batch. */
  lastMsgIndex: number;
  /** A batch is complete when at least one message follows its last item. */
  complete: boolean;
}

export interface PendingInfo {
  batches: Batch[];
  chars: number;
  items: number;
}

export interface PruneStats {
  trigger: string;
  batches: number;
  items: number;
  charsPruned: number;
  charsAdded: number;
  failures: number;
  durationMs: number;
}