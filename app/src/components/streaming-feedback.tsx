/**
 * Live evaluation feedback, rendered as it is written.
 *
 * THROTTLING is the whole point of this component, and it is why the API is
 * imperative rather than a `text` prop.
 *
 * The model emits tokens faster than the UI thread can lay out markdown — often
 * several per frame. Calling `setState` once per token does two bad things at
 * once: it schedules a render per token, and if the token handler lived in the
 * parent it would re-render the entire New Answer screen (every chip, every
 * field, the whole page strip) each time. The result is a visibly stuttering
 * screen for the duration of a minutes-long evaluation.
 *
 * So tokens land in a ref-held buffer and are flushed to state on a ~100ms
 * timer: at most ten renders a second, each one appending a whole run of text,
 * and the parent renders zero times because it only ever touches `ref.current`.
 * The timer is scheduled lazily on the first buffered token and cleared after
 * each flush, so an idle component costs nothing, and it is cleared on unmount
 * so a late flush cannot fire against a gone component.
 *
 * Partial markdown is safe to render. `parseMarkdown` closes an unterminated
 * fence at end of input rather than swallowing everything after it (verified
 * against `markdown-parse.ts`: the trailing `codeLines !== null` branch emits
 * the block), and an incomplete `**bold` span falls through `parseInline` as
 * plain text. So every intermediate state of the stream renders as something
 * reasonable, not as a blank panel that only fills in at the end.
 */

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Markdown } from '@/components/markdown';

/** One state update per tick, ten ticks a second. */
const FLUSH_MS = 100;

export interface StreamingFeedbackHandle {
  /** Buffer a token. Cheap — no render happens until the next flush. */
  append: (chunk: string) => void;
  /** Drop everything, including anything still buffered. */
  reset: () => void;
}

interface Theme {
  text: string;
  textSecondary: string;
  backgroundElement: string;
}

export function StreamingFeedback({
  ref,
  theme,
  title = 'Feedback',
  maxHeight = 320,
}: {
  ref?: Ref<StreamingFeedbackHandle>;
  theme: Theme;
  title?: string;
  maxHeight?: number;
}) {
  const [text, setText] = useState('');
  const buffer = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scroll = useRef<ScrollView>(null);

  // A pending flush after unmount would fire setState against a dead component
  // and keep the closure alive for another 100ms of an already-failed screen.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      append(chunk: string) {
        if (chunk === '') return;
        buffer.current += chunk;

        // A flush is already scheduled — this token joins that one. This is
        // what collapses a burst of tokens into a single render.
        if (timer.current !== null) return;

        timer.current = setTimeout(() => {
          timer.current = null;
          const pending = buffer.current;
          if (pending === '') return;
          buffer.current = '';
          setText((previous) => previous + pending);
        }, FLUSH_MS);
      },

      reset() {
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = null;
        buffer.current = '';
        setText('');
      },
    }),
    [],
  );

  // Nothing has streamed yet: render nothing rather than an empty panel. The
  // component stays mounted so the handle is live and text survives a failure.
  if (text === '') return null;

  return (
    <View style={[styles.root, { backgroundColor: theme.backgroundElement }]}>
      <Text accessibilityRole="header" style={[styles.title, { color: theme.textSecondary }]}>
        {title}
      </Text>
      <ScrollView
        ref={scroll}
        style={{ maxHeight }}
        // The parent screen is itself a vertical ScrollView; without this
        // Android hands every drag to the parent and this panel never scrolls.
        nestedScrollEnabled
        // Fires after layout, which is the only point at which the new content
        // height is known — scrolling from an effect races the layout pass.
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        <Markdown source={text} theme={theme} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { borderRadius: 12, padding: 14, marginBottom: 18, gap: 8 },
  title: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
});
