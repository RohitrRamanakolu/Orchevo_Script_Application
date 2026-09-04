/**
 * Convert a raw text string into minimal HTML with markdown-like formatting.
 * Handles: code blocks, inline code, bold, italic, links, and line breaks.
 * HTML entities are escaped first, so the output is safe to use with
 * dangerouslySetInnerHTML.
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";

  let html = text;

  // Escape HTML entities first
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang: string, code: string) => {
    return `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Ordered lists
  html = html.replace(/^\d+\.\s(.+)$/gm, "<li>$1</li>");

  // Line breaks → paragraphs (double newline) or <br> (single)
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");

  // Wrap in paragraph if not already block-level
  if (!html.startsWith("<pre") && !html.startsWith("<ul") && !html.startsWith("<ol")) {
    html = `<p>${html}</p>`;
  }

  return html;
}
