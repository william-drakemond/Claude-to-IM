/**
 * Slack mrkdwn chunking — splits long markdown text into Slack-safe
 * chunks (≤40000 chars) with code fence balancing.
 *
 * Slack uses its own "mrkdwn" format which is close to standard markdown
 * but with some differences:
 * - Bold: *text* (not **text**)
 * - Italic: _text_ (same)
 * - Code: `code` and ```code blocks``` (same)
 * - Strikethrough: ~text~ (not ~~text~~)
 * - Blockquote: > text (same)
 * - Links: <url|text> (not [text](url))
 *
 * This module converts standard markdown to Slack mrkdwn and handles
 * chunking at the 40000 character limit.
 */

export interface SlackChunk {
  text: string;
}

/** Soft limit — leave room for fence repair overhead. */
const SOFT_LIMIT = 39000;

/**
 * Convert standard markdown to Slack mrkdwn format.
 * Handles the most common markdown constructs.
 */
export function markdownToSlackMrkdwn(markdown: string): string {
  if (!markdown) return '';

  let text = markdown;

  // Convert bold: **text** → *text*
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Convert strikethrough: ~~text~~ → ~text~
  text = text.replace(/~~(.+?)~~/g, '~$1~');

  // Convert links: [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Code blocks and inline code pass through unchanged (```)
  // Blockquotes pass through unchanged (>)
  // Italic with _ passes through unchanged
  // Lists pass through unchanged (- and *)

  return text;
}

/**
 * Split markdown into Slack-safe chunks after converting to mrkdwn.
 * Splits at line boundaries and rebalances open code fences at split points.
 */
export function markdownToSlackChunks(
  markdown: string,
  limit = 40000,
): SlackChunk[] {
  if (!markdown) return [];

  const converted = markdownToSlackMrkdwn(markdown);

  const softLimit = Math.min(limit - 1000, SOFT_LIMIT);

  // Fast path: fits in one message
  if (converted.length <= limit) {
    return [{ text: converted }];
  }

  const lines = converted.split('\n');
  const chunks: SlackChunk[] = [];
  let currentLines: string[] = [];
  let currentLen = 0;
  let openFence: string | null = null;

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for newline

    // Check if this line toggles a fence
    const fenceMatch = line.match(/^(`{3,})([\w]*)/);

    if (currentLen + lineLen > softLimit && currentLines.length > 0) {
      // Need to split here
      let chunkText = currentLines.join('\n');

      // If we're inside a fence, close it at the end of this chunk
      if (openFence) {
        chunkText += '\n```';
      }

      chunks.push({ text: chunkText });

      // Start new chunk — if we were inside a fence, reopen it
      currentLines = [];
      currentLen = 0;

      if (openFence) {
        currentLines.push(openFence);
        currentLen = openFence.length + 1;
      }
    }

    currentLines.push(line);
    currentLen += lineLen;

    // Track fence state
    if (fenceMatch) {
      if (openFence) {
        openFence = null;
      } else {
        openFence = fenceMatch[0];
      }
    }
  }

  // Flush remaining
  if (currentLines.length > 0) {
    let chunkText = currentLines.join('\n');
    if (openFence) {
      chunkText += '\n```';
    }
    chunks.push({ text: chunkText });
  }

  // Hard split: if any chunk still exceeds limit, force-split by chars
  const result: SlackChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.text.length <= limit) {
      result.push(chunk);
    } else {
      let remaining = chunk.text;
      while (remaining.length > limit) {
        result.push({ text: remaining.slice(0, limit) });
        remaining = remaining.slice(limit);
      }
      if (remaining) {
        result.push({ text: remaining });
      }
    }
  }

  return result;
}
