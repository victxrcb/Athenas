import { invoke, isTauri } from '@tauri-apps/api/core';
import { nodeDisplaySize, type MappingMode, type MappingNode } from './mapping';

/** Directed link drawn on the mapping canvas: `fromId` commands `toId`. */
export type AgentLink = { fromId: string; toId: string; createdAt: number };

const STORAGE_KEY = 'athenas-agent-links';

function readLocal(): AgentLink[] {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value ? JSON.parse(value) as AgentLink[] : [];
  } catch { return []; }
}

function writeLocal(links: AgentLink[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(links)); } catch { /* preview still works */ }
  return links;
}

export async function listLinks(): Promise<AgentLink[]> {
  if (isTauri()) return invoke<AgentLink[]>('agent_links_list');
  return readLocal();
}

export async function createLink(fromId: string, toId: string): Promise<AgentLink[]> {
  if (fromId === toId) throw new Error('Um agente não pode comandar a si mesmo.');
  if (isTauri()) return invoke<AgentLink[]>('agent_link_create', { fromId, toId });
  const current = readLocal();
  if (current.some((link) => link.fromId === fromId && link.toId === toId)) return current;
  return writeLocal([...current, { fromId, toId, createdAt: Math.floor(Date.now() / 1000) }]);
}

export async function deleteLink(fromId: string, toId: string): Promise<AgentLink[]> {
  if (isTauri()) return invoke<AgentLink[]>('agent_link_delete', { fromId, toId });
  return writeLocal(readLocal().filter((link) => !(link.fromId === fromId && link.toId === toId)));
}

/** Types a briefing into the commanding agent's terminal listing the agents it controls. */
export async function introduceLeader(fromId: string): Promise<void> {
  if (!isTauri()) throw new Error('Disponível apenas no aplicativo desktop.');
  await invoke('agent_link_introduce', { fromId });
}

export type Point = { x: number; y: number };

/** Anchor points on the facing sides of two nodes, so the curve never crosses its own windows. */
export function linkAnchors(from: MappingNode, to: MappingNode, mode: MappingMode): { start: Point; end: Point } {
  const a = nodeDisplaySize(from, mode);
  const b = nodeDisplaySize(to, mode);
  const ac = { x: from.x + a.width / 2, y: from.y + a.height / 2 };
  const bc = { x: to.x + b.width / 2, y: to.y + b.height / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sign = dx >= 0 ? 1 : -1;
    return {
      start: { x: ac.x + sign * a.width / 2, y: ac.y },
      end: { x: bc.x - sign * b.width / 2, y: bc.y },
    };
  }
  const sign = dy >= 0 ? 1 : -1;
  return {
    start: { x: ac.x, y: ac.y + sign * a.height / 2 },
    end: { x: bc.x, y: bc.y - sign * b.height / 2 },
  };
}

/** Cubic curve between two anchors; horizontal or vertical tangents follow the dominant axis. */
export function linkPath(start: Point, end: Point): string {
  const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
  const bend = Math.max(40, (horizontal ? Math.abs(end.x - start.x) : Math.abs(end.y - start.y)) / 2);
  const c1 = horizontal ? { x: start.x + Math.sign(end.x - start.x || 1) * bend, y: start.y } : { x: start.x, y: start.y + Math.sign(end.y - start.y || 1) * bend };
  const c2 = horizontal ? { x: end.x - Math.sign(end.x - start.x || 1) * bend, y: end.y } : { x: end.x, y: end.y - Math.sign(end.y - start.y || 1) * bend };
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
}

export function linkMidpoint(start: Point, end: Point): Point {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}
