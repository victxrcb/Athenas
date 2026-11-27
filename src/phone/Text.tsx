import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const COMPONENTS: Components = {
  // Only web addresses open; a path or another scheme in a message stays text.
  a: ({ href, children }) => (href && /^https?:\/\//i.test(href)
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>),
  // Nothing is fetched from the network because a message mentions it.
  img: ({ alt }) => <span>[imagem{alt ? `: ${alt}` : ''}]</span>,
  table: ({ children }) => <div className="phone-table"><table>{children}</table></div>,
};

/** Message text as Markdown; raw HTML in it is shown as text. */
export const Text = memo(function Text({ text }: { text: string }) {
  return <div className="phone-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{text}</ReactMarkdown></div>;
});
