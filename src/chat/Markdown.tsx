import { memo, useMemo, useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Image as ImageIcon } from 'lucide-react';
import { copyText, openLink } from './actions';
import { CodeBlock } from './CodeBlock';

function textOf(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  return Array.isArray(node.children) ? node.children.map(textOf).join('') : '';
}

function MarkdownTable({ children }: { children: React.ReactNode }) {
  const table = useRef<HTMLTableElement>(null);
  const copy = () => {
    const rows = [...(table.current?.rows ?? [])].map((row) => [...row.cells].map((cell) => cell.textContent?.trim() ?? '').join('\t'));
    void copyText(rows.join('\n'), 'Tabela copiada.');
  };
  return <div className="chat-table">
    <button type="button" className="chat-table-copy" onClick={copy} title="Copiar tabela" aria-label="Copiar tabela"><Copy size={13} /></button>
    <div><table ref={table}>{children}</table></div>
  </div>;
}

/**
 * Raw HTML in a message is shown as text (react-markdown never injects it), images are not fetched from
 * the network, and links go through the app's validated openers.
 */
export const Markdown = memo(function Markdown({ text, sessionId }: { text: string; sessionId: string }) {
  const components = useMemo<Components>(() => ({
    pre: ({ node }) => {
      const code = node?.children[0] as any;
      const language = /language-([\w+#-]+)/.exec(String(code?.properties?.className ?? ''))?.[1] ?? '';
      return <CodeBlock code={textOf(code).replace(/\n$/, '')} language={language} />;
    },
    table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
    a: ({ href, children }) => href
      ? <a href={href} title={href} onClick={(event) => { event.preventDefault(); void openLink(sessionId, href); }} onAuxClick={(event) => event.preventDefault()}>{children}</a>
      : <span>{children}</span>,
    img: ({ src, alt }) => <button type="button" className="chat-image-link" title={typeof src === 'string' ? src : undefined}
      onClick={() => { if (typeof src === 'string') void openLink(sessionId, src); }}><ImageIcon size={13} /> {alt || 'Imagem'}</button>,
  }), [sessionId]);
  return <div className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown></div>;
});
