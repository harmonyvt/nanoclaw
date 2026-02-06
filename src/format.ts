/**
 * Converts standard markdown to Telegram-compatible HTML.
 * Handles code blocks, inline formatting, headings, links, and lists.
 * Gracefully handles malformed markdown by escaping unmatched syntax.
 */

const ASSISTANT_NAME_PATTERN = /^Aluei:\s*/i;

/** Escape HTML entities in text that will be placed inside HTML tags */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface CodeBlock {
  placeholder: string;
  html: string;
}

/**
 * Convert markdown text to Telegram-compatible HTML.
 *
 * Supported conversions:
 * - Fenced code blocks (```lang ... ```) → <pre><code>
 * - Inline code (`text`) → <code>
 * - Bold (**text**) → <b>
 * - Italic (*text*) → <i>
 * - Strikethrough (~~text~~) → <s>
 * - Links [text](url) → <a href="url">
 * - Headings (## text) → <b>text</b>
 * - Blockquotes (> text) → <blockquote>
 * - Bullets (- item / * item) → • item
 */
export function markdownToTelegramHtml(text: string): string {
  // Strip leading assistant name prefix
  let result = text.replace(ASSISTANT_NAME_PATTERN, '');

  // Pass 1: Extract fenced code blocks and protect them
  const codeBlocks: CodeBlock[] = [];
  let blockIndex = 0;

  result = result.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const placeholder = `\x00CODEBLOCK_${blockIndex}\x00`;
      const escapedCode = escapeHtml(code.replace(/\n$/, '')); // trim trailing newline
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      codeBlocks.push({
        placeholder,
        html: `<pre><code${langAttr}>${escapedCode}</code></pre>`,
      });
      blockIndex++;
      return placeholder;
    },
  );

  // Pass 2: Extract inline code and protect it
  const inlineCodes: CodeBlock[] = [];
  let inlineIndex = 0;

  result = result.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const placeholder = `\x00INLINECODE_${inlineIndex}\x00`;
    inlineCodes.push({
      placeholder,
      html: `<code>${escapeHtml(code)}</code>`,
    });
    inlineIndex++;
    return placeholder;
  });

  // Pass 3: Escape HTML in remaining text
  result = escapeHtml(result);

  // Pass 4: Convert block-level elements (process line by line)
  const lines = result.split('\n');
  const processedLines: string[] = [];
  let inBlockquote = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Headings: ## text → <b>text</b>
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      line = `<b>${headingMatch[2]}</b>`;
    }

    // Blockquotes: > text
    const blockquoteMatch = line.match(/^&gt;\s?(.*)$/);
    if (blockquoteMatch) {
      if (!inBlockquote) {
        line = `<blockquote>${blockquoteMatch[1]}`;
        inBlockquote = true;
      } else {
        line = blockquoteMatch[1];
      }
    } else if (inBlockquote) {
      // Close the blockquote
      processedLines[processedLines.length - 1] += '</blockquote>';
      inBlockquote = false;
    }

    // Bullet points: - item or * item (but not ** which is bold)
    // Only match "* " at start of line (not "**")
    line = line.replace(/^[-]\s+/, '\u2022 ');
    line = line.replace(/^\*\s(?!\*)/, '\u2022 ');

    processedLines.push(line);
  }

  // Close any open blockquote
  if (inBlockquote) {
    processedLines[processedLines.length - 1] += '</blockquote>';
  }

  result = processedLines.join('\n');

  // Pass 5: Convert inline formatting
  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words for underscores)
  result = result.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url) - note: < and > are already escaped
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>',
  );

  // Pass 6: Restore code blocks and inline code
  for (const block of codeBlocks) {
    result = result.replace(block.placeholder, block.html);
  }
  for (const code of inlineCodes) {
    result = result.replace(code.placeholder, code.html);
  }

  return result.trim();
}
