/**
 * Minimal markdown renderer for evaluation feedback.
 *
 * Hand-rolled rather than pulling in `react-native-markdown-display`: this app
 * renders one narrow, known shape of markdown (the rubric's own output —
 * headings, bold, bullets, paragraphs) and a stale native-adjacent dependency
 * on the daily-use screen is a worse trade than eighty lines here.
 *
 * Parsing is split from rendering so the block parser is unit-testable.
 */

import { StyleSheet, Text, View } from 'react-native';
import { parseMarkdown, parseInline, type MarkdownBlock } from '@/lib/markdown-parse';

interface Theme {
  text: string;
  textSecondary: string;
  backgroundElement: string;
}

export function Markdown({ source, theme }: { source: string; theme: Theme }) {
  const blocks = parseMarkdown(source);

  return (
    <View style={styles.root}>
      {blocks.map((block, i) => (
        <Block key={`${block.kind}-${i}`} block={block} theme={theme} />
      ))}
    </View>
  );
}

function Block({ block, theme }: { block: MarkdownBlock; theme: Theme }) {
  switch (block.kind) {
    case 'heading':
      return (
        <Text
          accessibilityRole="header"
          style={[
            block.level <= 2 ? styles.h2 : styles.h3,
            { color: theme.text },
          ]}
        >
          <Inline text={block.text} theme={theme} />
        </Text>
      );

    case 'bullet':
      return (
        <View style={styles.bulletRow}>
          <Text style={[styles.bulletDot, { color: theme.textSecondary }]}>•</Text>
          <Text style={[styles.paragraph, { color: theme.text, flex: 1 }]}>
            <Inline text={block.text} theme={theme} />
          </Text>
        </View>
      );

    case 'numbered':
      return (
        <View style={styles.bulletRow}>
          <Text style={[styles.bulletDot, { color: theme.textSecondary }]}>{block.marker}</Text>
          <Text style={[styles.paragraph, { color: theme.text, flex: 1 }]}>
            <Inline text={block.text} theme={theme} />
          </Text>
        </View>
      );

    case 'code':
      return (
        <View style={[styles.code, { backgroundColor: theme.backgroundElement }]}>
          <Text style={[styles.codeText, { color: theme.text }]}>{block.text}</Text>
        </View>
      );

    case 'rule':
      return <View style={[styles.rule, { backgroundColor: theme.textSecondary }]} />;

    case 'paragraph':
    default:
      return (
        <Text style={[styles.paragraph, { color: theme.text }]}>
          <Inline text={block.text} theme={theme} />
        </Text>
      );
  }
}

/** Renders **bold**, *italic* and `code` spans within a line. */
function Inline({ text, theme }: { text: string; theme: Theme }) {
  const spans = parseInline(text);
  return (
    <>
      {spans.map((span, i) => (
        <Text
          key={i}
          style={
            span.style === 'bold'
              ? styles.bold
              : span.style === 'italic'
                ? styles.italic
                : span.style === 'code'
                  ? [styles.inlineCode, { backgroundColor: theme.backgroundElement }]
                  : undefined
          }
        >
          {span.text}
        </Text>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  h2: { fontSize: 17, fontWeight: '700', marginTop: 6 },
  h3: { fontSize: 15, fontWeight: '700', marginTop: 4 },
  paragraph: { fontSize: 14, lineHeight: 21 },
  bulletRow: { flexDirection: 'row', gap: 8, paddingRight: 4 },
  bulletDot: { fontSize: 14, lineHeight: 21, minWidth: 18 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  inlineCode: { fontFamily: 'monospace', fontSize: 13, borderRadius: 3 },
  code: { borderRadius: 8, padding: 12 },
  codeText: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
  rule: { height: StyleSheet.hairlineWidth, opacity: 0.3, marginVertical: 6 },
});
