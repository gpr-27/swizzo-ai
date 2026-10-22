'use client';

// Renders an assistant message's Markdown as cleanly-styled, on-brand prose so
// raw syntax (** , * , -, #) never shows as literal characters. Single newlines
// become line breaks (remark-breaks) to preserve the model's line-per-item lists;
// blank lines start new paragraphs.

import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { stripMarkers } from './markers';

const components: Components = {
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold text-ink">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-coral underline decoration-coral/40 underline-offset-[3px] transition-colors hover:decoration-coral"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1.5 pl-5 marker:text-coral/70">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1.5 pl-5 marker:font-display marker:text-muted">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5 leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 font-display text-xl text-ink first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-4 font-display text-lg text-ink first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-3 text-[15px] font-semibold text-ink first:mt-0">
      {children}
    </h3>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-coral/40 bg-surface-soft/60 py-1.5 pl-3.5 pr-3 text-muted italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-hairline" />,
  // Tables (used by the Compare turn): a crisp editorial card on cream — soft
  // hairline frame, quiet serif-ish header, zebra rows for scannability.
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-hairline bg-canvas shadow-soft">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-hairline bg-surface-card/70 text-ink">
      {children}
    </thead>
  ),
  tbody: ({ children }) => (
    <tbody className="[&>tr:nth-child(even)]:bg-surface-soft/40">{children}</tbody>
  ),
  tr: ({ children }) => (
    <tr className="border-b border-hairline/70 last:border-0">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2.5 align-top leading-snug text-body [&>strong]:text-ink">
      {children}
    </td>
  ),
  code: ({ children }) => (
    <code className="rounded bg-surface-card px-1.5 py-0.5 font-mono text-[13px] text-ink">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-2.5 overflow-x-auto rounded-lg bg-dark p-3 text-[13px] text-on-dark [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-on-dark">
      {children}
    </pre>
  ),
};

// Marker scrubbing lives in ./markers (no react-markdown dependency).
export { stripMarkers };

export function Markdown({ children }: { children: string }) {
  const clean = stripMarkers(children);
  if (!clean) return null;
  return (
    <div className="text-[15px] leading-relaxed text-body [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
      >
        {clean}
      </ReactMarkdown>
    </div>
  );
}

export default Markdown;
