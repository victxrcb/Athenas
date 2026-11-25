import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Copy, ExternalLink, FileDiff, X } from 'lucide-react';
import { copyText, openFile } from './actions';
import { splitRows, unifiedRows, type DiffRow } from './diff';
import { highlight, languageForPath } from './highlight';
import type { FileChange, Hunk } from './model';

const CHANGE = { add: 'Criado', update: 'Alterado', delete: 'Excluído' } as const;
const MAX_ROWS = 600;

export const shortPath = (path: string, cwd?: string) => {
  const normal = path.replace(/\\/g, '/');
  const base = cwd?.replace(/\\/g, '/').replace(/\/$/, '');
  return base && normal.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? normal.slice(base.length + 1) : normal;
};

export const ChangeStats = ({ added, removed }: { added: number; removed: number }) =>
  <span className="chat-stats"><b className="add">+{added}</b> <b className="remove">−{removed}</b></span>;

function Code({ row, language }: { row: DiffRow; language: string }) {
  const html = highlight(row.text, language);
  return html === null ? <code>{row.text}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />;
}

function HunkView({ hunk, language, split }: { hunk: Hunk; language: string; split: boolean }) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const unified = useMemo(() => unifiedRows(hunk), [hunk]);
  const pairs = useMemo(() => (split ? splitRows(hunk) : []), [hunk, split]);
  const total = split ? pairs.length : unified.length;
  const limit = all ? total : MAX_ROWS;
  const half = (row: DiffRow | null, side: 'old' | 'new') => <>
    <span className={`cdiff-number ${row?.kind ?? 'empty'}`}>{(side === 'old' ? row?.oldLine : row?.newLine) ?? ''}</span>
    <span className={`cdiff-text ${row?.kind ?? 'empty'}`}>{row && <Code row={row} language={language} />}</span>
  </>;
  return <div className="cdiff-hunk">
    <button type="button" className="cdiff-hunk-head" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Linhas {hunk.newStart || hunk.oldStart} em diante</button>
    {open && <div className={`cdiff-rows ${split ? 'split' : 'unified'}`}>
      {split
        ? pairs.slice(0, limit).map(([left, right], index) => <div key={index} className="cdiff-row">{half(left, 'old')}{half(right, 'new')}</div>)
        : unified.slice(0, limit).map((row, index) => <div key={index} className={`cdiff-row ${row.kind}`}>
          <span className="cdiff-number">{row.oldLine ?? ''}</span><span className="cdiff-number">{row.newLine ?? ''}</span>
          <span className="cdiff-sign" aria-label={row.kind === 'add' ? 'adicionada' : row.kind === 'remove' ? 'removida' : undefined}>{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}</span>
          <span className="cdiff-text"><Code row={row} language={language} /></span>
        </div>)}
      {total > limit && <button type="button" className="chat-link-button" onClick={() => setAll(true)}>Mostrar mais {total - limit} linhas</button>}
    </div>}
  </div>;
}

/** Changes the agent itself reported through its editing tools. */
export function DiffViewer({ changes, initial, cwd, sessionId, onClose }: { changes: FileChange[]; initial?: string; cwd?: string; sessionId: string; onClose: () => void }) {
  const [selected, setSelected] = useState(initial ?? changes[0]?.path);
  const [wide, setWide] = useState(false);
  const [split, setSplit] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const change = changes.find((item) => item.path === selected) ?? changes[0];
  useEffect(() => {
    if (!body.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 760));
    observer.observe(body.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  if (!change) return null;
  const language = languageForPath(change.path);
  const patch = change.hunks.map((hunk) => [`@@ -${hunk.oldStart} +${hunk.newStart} @@`, ...hunk.lines].join('\n')).join('\n');
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="chat chat-diff" role="dialog" aria-modal="true" aria-label="Alterações do agente">
      <header><FileDiff size={15} /><strong>Alterações feitas pelo agente</strong>
        <div className="chat-segments" role="group" aria-label="Modo do diff">
          <button type="button" aria-pressed={!split || !wide} onClick={() => setSplit(false)}>Unificado</button>
          <button type="button" aria-pressed={split && wide} disabled={!wide} title={wide ? undefined : 'Amplie a janela para comparar lado a lado'} onClick={() => setSplit(true)}>Lado a lado</button>
        </div>
        <button type="button" className="icon-button" aria-label="Fechar" autoFocus onClick={onClose}><X size={16} /></button>
      </header>
      <div className="chat-diff-main">
        <nav aria-label="Arquivos">{changes.map((item) => <button type="button" key={item.path} aria-current={item.path === change.path ? 'true' : undefined} title={item.path} onClick={() => setSelected(item.path)}>
          <span>{shortPath(item.path, cwd)}</span><ChangeStats added={item.added} removed={item.removed} />
        </button>)}</nav>
        <section ref={body}>
          <div className="chat-diff-file">
            <span title={change.path}>{CHANGE[change.type]} · {shortPath(change.path, cwd)}{change.movedTo ? ` → ${shortPath(change.movedTo, cwd)}` : ''}</span>
            <button type="button" onClick={() => void copyText(patch, 'Diff copiado.')}><Copy size={13} /> Copiar diff</button>
            {change.type !== 'delete' && <button type="button" onClick={() => void openFile(sessionId, change.movedTo ?? change.path, change.hunks[0]?.newStart)}><ExternalLink size={13} /> Abrir no VS Code</button>}
          </div>
          {change.hunks.length
            ? change.hunks.map((hunk, index) => <HunkView key={`${change.path}:${index}`} hunk={hunk} language={language} split={split && wide} />)
            : <p className="chat-muted">O agente não registrou as linhas desta alteração.</p>}
        </section>
      </div>
      <footer>Mostra somente o que as ferramentas de edição do agente registraram, na ordem em que aconteceu. Mudanças feitas por comandos ou já existentes na pasta aparecem na aba Git.</footer>
    </div>
  </div>, document.body);
}
