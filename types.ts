/**
 * akron-prune — shared data types.
 *
 * Lossless context pruning for pi: completed tool activity and uploaded
 * images are stored as durable artifacts on disk and replaced in the
 * outgoing LLM context with short, deterministic references. The session
 * file is never modified; pruning only affects request building.
 */

export type EntryKind = "result" | "args" | "userImage";

export interface ArtifactFile {
  /** Absolute path of the artifact on disk. */
  path: string;
  /** sha256 of the file content at write time. */
  sha256: string;
  bytes: number;
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
  /** Deterministic replacement text used in the outgoing context. */
  refText: string;
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