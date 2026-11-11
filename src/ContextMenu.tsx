import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type MenuItem =
  | { type: 'separator' }
  | { type?: 'item'; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onSelect: () => void };

/** Right-click menu rendered at the pointer, kept inside the window and closed on outside click, Esc or scroll. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({ left: Math.max(6, Math.min(x, window.innerWidth - box.width - 6)), top: Math.max(6, Math.min(y, window.innerHeight - box.height - 6)) });
  }, [x, y]);

  useEffect(() => {
    const close = (event: Event) => { if (!(event.target instanceof Node) || !root.current?.contains(event.target)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('contextmenu', close);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('contextmenu', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return <div className="context-menu" role="menu" ref={root} style={position} onContextMenu={(event) => event.preventDefault()}>
    {items.map((item, index) => item.type === 'separator'
      ? <hr key={index} />
      : <button key={index} role="menuitem" className={item.danger ? 'danger' : undefined} disabled={item.disabled}
          onClick={() => { onClose(); item.onSelect(); }}>{item.icon}<span>{item.label}</span></button>)}
  </div>;
}
