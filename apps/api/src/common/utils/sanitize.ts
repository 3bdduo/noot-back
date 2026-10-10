/**
 * Minimal server-side clean-up for admin-authored rich text (journal, pages, FAQ).
 * Defence in depth only: the frontend must still render it through a sanitizer or a Markdown renderer.
 */
const BLOCKED_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base', 'svg', 'math'];

export function sanitizeRichText(input: string): string {
  let out = input;
  for (const tag of BLOCKED_TAGS) {
    out = out.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, 'gi'), '');
    out = out.replace(new RegExp(`<\\s*/?\\s*${tag}\\b[^>]*>`, 'gi'), '');
  }
  // inline event handlers (onclick=, onerror= …)
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // javascript: / data: / vbscript: URLs in href/src/xlink:href/srcset
  out = out.replace(/(\b(?:href|src|xlink:href|action|formaction)\s*=\s*)(["']?)\s*(?:javascript|vbscript|data)\s*:[^"'>\s]*\2/gi, '$1"#"');
  return out;
}
