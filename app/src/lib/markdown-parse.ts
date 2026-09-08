/**
 * Block and inline markdown parsing for evaluation feedback.
 *
 * Pure and dependency-free so it can be unit-tested under Node. Scoped
 * deliberately to what the rubric actually emits — headings, bullets, numbered
 * lists, bold/italic/code spans, fenced code, horizontal rules. It is not a
 * general markdown implementation and does not try to be.
 */

export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'numbered'; marker: string; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  let paragraph: string[] = [];
  let codeLines: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ').trim() });
      paragraph = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Fenced code. Everything inside is passed through verbatim.
    if (/^\s*```/.test(line)) {
      if (codeLines === null) {
        flushParagraph();
        codeLines = [];
      } else {
        blocks.push({ kind: 'code', text: codeLines.join('\n') });
        codeLines = null;
      }
      continue;
    }
    if (codeLines !== null) {
      codeLines.push(raw);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ kind: 'bullet', text: bullet[1]!.trim() });
      continue;
    }

    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      blocks.push({ kind: 'numbered', marker: `${numbered[1]}.`, text: numbered[2]!.trim() });
      continue;
    }

    paragraph.push(line.trim());
  }

  // An unterminated fence still renders rather than swallowing the content.
  if (codeLines !== null && codeLines.length > 0) {
    blocks.push({ kind: 'code', text: codeLines.join('\n') });
  }
  flushParagraph();

  return blocks;
}

export interface InlineSpan {
  text: string;
  style?: 'bold' | 'italic' | 'code';
}

/**
 * Splits a line into styled spans.
 *
 * Order matters: `**bold**` is matched before `*italic*`, and backticks before
 * either, so `**a**` never renders as an italic wrapping a stray asterisk.
 */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/g;

  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index === undefined) continue;

    if (index > lastIndex) {
      spans.push({ text: text.slice(lastIndex, index) });
    }

    const token = match[0];
    if (token.startsWith('`')) {
      spans.push({ text: token.slice(1, -1), style: 'code' });
    } else if (token.startsWith('**') || token.startsWith('__')) {
      spans.push({ text: token.slice(2, -2), style: 'bold' });
    } else {
      spans.push({ text: token.slice(1, -1), style: 'italic' });
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) {
    spans.push({ text: text.slice(lastIndex) });
  }

  return spans.length > 0 ? spans : [{ text }];
}
