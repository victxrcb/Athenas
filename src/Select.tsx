import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export type SelectOption = { value: string; label: string };

type Props = {
  value: string;
  options: (string | SelectOption)[];
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

const normalize = (option: string | SelectOption): SelectOption =>
  typeof option === 'string' ? { value: option, label: option } : option;

/** Themed replacement for the native <select>, whose popup cannot be styled. */
export function Select({ value, options, onChange, label, placeholder, disabled, className }: Props) {
  const items = options.map(normalize);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [upward, setUpward] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = items.find((item) => item.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const show = () => {
    if (disabled) return;
    const rect = root.current?.getBoundingClientRect();
    setUpward(!!rect && window.innerHeight - rect.bottom < Math.min(items.length, 6) * 34 + 16 && rect.top > window.innerHeight - rect.bottom);
    setActive(Math.max(0, items.findIndex((item) => item.value === value)));
    setOpen(true);
  };
  const pick = (index: number) => {
    const item = items[index];
    if (item) onChange(item.value);
    setOpen(false);
  };

  return <div className={`ui-select ${className ?? ''}`} ref={root}>
    <button type="button" className="ui-select-trigger" role="combobox" aria-label={label} aria-expanded={open} aria-controls={listId} disabled={disabled}
      onClick={() => (open ? setOpen(false) : show())}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { if (open) { event.stopPropagation(); setOpen(false); } return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) { show(); return; }
          setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
        } else if ((event.key === 'Enter' || event.key === ' ') && open) {
          event.preventDefault();
          pick(active);
        }
      }}>
      <span className={current ? undefined : 'ui-select-placeholder'}>{current?.label ?? placeholder ?? 'Selecione'}</span>
      <ChevronDown size={14} />
    </button>
    {open && <ul className={`ui-select-list ${upward ? 'upward' : ''}`} id={listId} role="listbox" aria-label={label}>
      {items.map((item, index) => <li key={item.value} role="option" aria-selected={item.value === value} className={index === active ? 'active' : undefined}
        onMouseEnter={() => setActive(index)} onMouseDown={(event) => { event.preventDefault(); pick(index); }}>
        <span>{item.label}</span>{item.value === value && <Check size={13} />}
      </li>)}
    </ul>}
  </div>;
}

export function UncontrolledSelect({ options, initial, label }: { options: string[]; initial?: string; label: string }) {
  const [value, setValue] = useState(initial ?? options[0]);
  return <Select label={label} value={value} onChange={setValue} options={options} />;
}
