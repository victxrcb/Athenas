import { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, ListOrdered } from 'lucide-react';
import { copyText } from './actions';
import { highlight, htmlLines, languageName } from './highlight';
import { toggleLineNumbers, useChatPrefs } from './prefs';

const COLLAPSED_LINES = 24;

export const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language: string }) {
  const numbers = useChatPrefs((state) => state.lineNumbers);
  const lineCount = useMemo(() => code.split('\n').length, [code]);
  const long = lineCount > COLLAPSED_LINES;
  const [open, setOpen] = useState(false);
  const shown = long && !open ? code.split('\n').slice(0, COLLAPSED_LINES).join('\n') : code;
  const html = useMemo(() => highlight(shown, language), [shown, language]);
  return <figure className="chat-code">
    <figcaption>
      <span>{languageName(language)}</span>
      <div>
        <button type="button" aria-pressed={numbers} title="Numerar linhas" aria-label="Numerar linhas" onClick={toggleLineNumbers}><ListOrdered size={13} /></button>
        <button type="button" onClick={() => void copyText(code, 'Código copiado.')}><Copy size={13} /> Copiar</button>
        {long && <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />} {open ? 'Recolher' : `Expandir (${lineCount} linhas)`}</button>}
      </div>
    </figcaption>
    {numbers
      ? <pre className="numbered"><code>{(html === null ? shown.split('\n') : htmlLines(html)).map((line, index) => html === null
        ? <span key={index} className="code-line">{line}{'\n'}</span>
        : <span key={index} className="code-line" dangerouslySetInnerHTML={{ __html: `${line}\n` }} />)}</code></pre>
      : <pre>{html === null ? <code>{shown}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}</pre>}
  </figure>;
});
