// Agent control-marker scrubbing, kept free of react-markdown so the composer
// (TTS) and copy helpers can use it without pulling the Markdown renderer into
// the initial bundle. Markdown.tsx re-exports stripMarkers for older imports.

// Safety net for agent control markers. The server strips well-formed marker
// lines (agent.ts extractMarkers), but variants slip through — `**BEST:** id`,
// `BEST: id (reason)`, a second SUGGESTIONS line, a `STEPS:` header — and would
// otherwise render as literal machine text. Drop any line that STARTS with a
// marker keyword (optionally behind list/quote/bold syntax). Prose that merely
// mentions a word like "best" mid-sentence is untouched.
const MARKER_LINE =
  /^[ \t>*_\-•]*\**_*(?:SUGGESTIONS|ADD|REMOVE|BEST|HEALTHY|WARN|MACRO|COMPARE|NOTE|STEPS?|DISHES|INGREDIENTS|SHOPPING\s*LIST|CONTROL|PICK|WHY)\**_*\s*:.*$/gm;

/** Remove leaked marker lines from assistant text (also used for copy / TTS). */
export function stripMarkers(text: string): string {
  return text
    .replace(MARKER_LINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
