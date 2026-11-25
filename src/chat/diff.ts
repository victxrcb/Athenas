import type { FileChange, Hunk } from './model';

export function hunkStats(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) for (const line of hunk.lines) {
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

export function parseUnifiedDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
    } else if (current && !line.startsWith('\\')) current.lines.push(line);
  }
  return hunks;
}

export type DiffRow = { kind: 'context' | 'add' | 'remove'; text: string; oldLine?: number; newLine?: number };

export function unifiedRows(hunk: Hunk): DiffRow[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.lines.map((line) => {
    const content = line.slice(1);
    if (line.startsWith('+')) return { kind: 'add', text: content, newLine: newLine++ };
    if (line.startsWith('-')) return { kind: 'remove', text: content, oldLine: oldLine++ };
    return { kind: 'context', text: content, oldLine: oldLine++, newLine: newLine++ };
  });
}

/** Pairs each run of removed lines with the added lines that replaced it. */
export function splitRows(hunk: Hunk): [DiffRow | null, DiffRow | null][] {
  const pairs: [DiffRow | null, DiffRow | null][] = [];
  let removed: DiffRow[] = [];
  let added: DiffRow[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) pairs.push([removed[index] ?? null, added[index] ?? null]);
    removed = [];
    added = [];
  };
  for (const row of unifiedRows(hunk)) {
    if (row.kind === 'remove') removed.push(row);
    else if (row.kind === 'add') added.push(row);
    else { flush(); pairs.push([row, row]); }
  }
  flush();
  return pairs;
}

/** One entry per file, joining the successive edits the agent made to it. */
export function mergeChanges(changes: FileChange[]): FileChange[] {
  const files = new Map<string, FileChange>();
  for (const change of changes) {
    const previous = files.get(change.path);
    files.set(change.path, previous ? {
      ...change,
      type: previous.type === 'add' && change.type !== 'delete' ? 'add' : change.type,
      hunks: [...previous.hunks, ...change.hunks],
      added: previous.added + change.added,
      removed: previous.removed + change.removed,
    } : change);
  }
  return [...files.values()];
}
