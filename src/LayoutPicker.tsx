import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, PanelLeft } from 'lucide-react';
import { useAppStore, type ProjectInfo, type WorkspaceSnapshot } from './store';

type Layout = ProjectInfo['layout'];

const OPTIONS: { id: Layout; name: string; hint: string; cells: string[]; template: string }[] = [
  { id: 'auto', name: 'Auto', hint: 'Divide a tela sozinho conforme os agentes', cells: ['a', 'b', 'c', 'd'], template: 'repeat(2,1fr) / repeat(2,1fr)' },
  { id: 'spotlight', name: 'Foco', hint: 'Um terminal grande por vez', cells: ['a'], template: '1fr / 1fr' },
  { id: 'sidebar', name: 'Lateral', hint: 'Um terminal principal e a lista ao lado', cells: ['nav', 'main'], template: '1fr / 26% 1fr' },
  { id: 'grid', name: 'Grade', hint: 'Dois painéis com divisória ajustável', cells: ['a', 'b'], template: '1fr / 1fr 1fr' },
];

function Preview({ option }: { option: (typeof OPTIONS)[number] }) {
  return <div className="layout-preview" style={{ gridTemplate: option.template }} aria-hidden="true">
    {option.cells.map((cell) => <i key={cell} className={cell === 'nav' ? 'nav' : undefined} />)}
  </div>;
}

export function LayoutPicker() {
  const { workspace, activeProjectId, setWorkspace, setNotice } = useAppStore();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const project = workspace.projects.find((item) => item.id === activeProjectId);
  const current = OPTIONS.find((option) => option.id === (project?.layout ?? 'auto')) ?? OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
  }, [open]);

  const choose = async (layout: Layout) => {
    if (!project) return;
    try {
      setWorkspace(await invoke<WorkspaceSnapshot>('project_set_layout', { id: project.id, layout }));
      setOpen(false);
    } catch (error) { setNotice(String(error)); }
  };

  return <div className="layout-picker" ref={root}>
    <button className="layout-select" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      <PanelLeft size={15} /><span>Organização</span><b>{current.name}</b><ChevronDown size={14} />
    </button>
    {open && <div className="layout-popover" role="dialog" aria-label="Organização dos terminais">
      <div className="layout-popover-head">Formato das telas{!project && <small>Abra um projeto para escolher.</small>}</div>
      <div className="layout-options">
        {OPTIONS.map((option) => <button key={option.id} disabled={!project} aria-pressed={current.id === option.id} onClick={() => void choose(option.id)}>
          <Preview option={option} /><strong>{option.name}</strong><small>{option.hint}</small>
        </button>)}
      </div>
    </div>}
  </div>;
}
