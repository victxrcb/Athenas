/**
 * Provider-neutral conversation model. Each provider adapter turns the lines of its own conversation file
 * into these items; nothing here is inferred from the terminal screen.
 */
export type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'mcp' | 'question' | 'plan' | 'agent' | 'other';
export type ToolStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'approval';

export type Hunk = { oldStart: number; newStart: number; lines: string[] };
export type FileChange = {
  path: string;
  type: 'add' | 'update' | 'delete';
  hunks: Hunk[];
  added: number;
  removed: number;
  movedTo?: string;
};
export type Question = { question: string; header?: string; multiSelect: boolean; options: { label: string; description?: string }[] };

type Base = {
  id: string;
  /** Milliseconds since the epoch, when the source records it. */
  at: number | null;
  /** Byte offset of the source line, used to show the original record. */
  offset: number | null;
  clipped?: boolean;
};

export type MessageItem = Base & {
  type: 'user' | 'assistant';
  text: string;
  images?: string[];
  /** Text still arriving through the live channel. */
  streaming?: boolean;
  /** Sent from this chat and not yet recorded by the agent. */
  pending?: boolean;
};

export type ToolItem = Base & {
  type: 'tool';
  name: string;
  kind: ToolKind;
  /** The file, pattern, command or subject of the action, exactly as the agent gave it. */
  target: string;
  description?: string;
  status: ToolStatus;
  input?: unknown;
  command?: string;
  cwd?: string;
  output?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  changes?: FileChange[];
  filePath?: string;
  line?: number;
  questions?: Question[];
  answers?: Record<string, string>;
  plan?: string;
  /** Codex call records: once richer items exist, shown only while the call is still running. */
  fallback?: boolean;
};

export type NoticeItem = Base & { type: 'notice'; tone: 'info' | 'warning' | 'error'; text: string; detail?: string };
export type PullRequestItem = Base & { type: 'pr'; number: number; url: string; repository: string };
export type ChatItem = MessageItem | ToolItem | NoticeItem | PullRequestItem;

export type Usage = {
  /** Tokens sent in the latest model request, cached ones included. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  contextWindow?: number;
};

export type TranscriptMeta = {
  model?: string;
  effort?: string;
  permissionMode?: string;
  branch?: string;
  cwd?: string;
  version?: string;
  title?: string;
  usage?: Usage;
  /** A turn has started and not finished according to the file. */
  turnOpen: boolean;
};

/** One line of a conversation file, already filtered by the backend. */
export type Line = { o: number; v: any; clipped?: boolean };

export type Transcript = { items: ChatItem[]; meta: TranscriptMeta };
