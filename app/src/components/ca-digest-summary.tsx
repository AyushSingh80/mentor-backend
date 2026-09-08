/**
 * What today's digest threw away, and why — rendered, not logged.
 *
 * ## This is a feature, not debug output
 *
 * The selection rule is the product. Six items out of thirty-one is only
 * trustworthy if the twenty-five rejections are legible; otherwise the number
 * is an assertion she has to take on faith, and the first time it feels wrong
 * she stops opening the digest. Naming the filter does something better than
 * build trust, though: it is teachable. "Twelve dropped as event-only" is the
 * same test she should be applying to the front page herself, stated in the
 * vocabulary she will use in an answer. A filter she cannot see teaches
 * nothing. A filter she can see transfers.
 *
 * ## Source failures are never folded into the counts
 *
 * A feed that 404s produces zero candidates, which is arithmetically identical
 * to a genuinely quiet news day and completely different in what it means. One
 * is a fact about the world; the other is a bug in the allowlist. They get
 * separate, louder treatment for that reason.
 */

import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/components/form';
import type { DigestSummaryFacts } from '@/lib/ca-types';

type Theme = ReturnType<typeof useTheme>;

/**
 * Server-side drop reasons, in her vocabulary rather than the pipeline's.
 *
 * Unknown keys fall through to a de-slugged form instead of being hidden: a
 * reason this build has not learned about is still a reason, and dropping it
 * would silently unbalance the histogram against `dropped`.
 */
const REASON_PHRASE: Record<string, { one: string; many: string }> = {
  event_only: { one: 'event-only', many: 'event-only' },
  no_syllabus_hook: { one: 'no syllabus hook', many: 'no syllabus hook' },
  duplicate: { one: 'duplicate', many: 'duplicates' },
  ungrounded: { one: 'ungrounded', many: 'ungrounded' },
  over_daily_cap: { one: 'over the daily cap', many: 'over the daily cap' },
  section_cap: { one: 'section already full', many: 'section already full' },
  stale: { one: 'stale', many: 'stale' },
  low_confidence: { one: 'low confidence', many: 'low confidence' },
};

function phraseFor(reason: string, count: number): string {
  const known = REASON_PHRASE[reason];
  if (known) return count === 1 ? known.one : known.many;
  return reason.replace(/[-_]+/g, ' ').trim() || 'unspecified';
}

/**
 * The histogram in words.
 *
 * `"31 considered, 6 kept. Dropped: 12 event-only, 8 no syllabus hook, 3
 * duplicates, 2 ungrounded."`
 *
 * Sorted by count descending so the dominant reason leads, with the reason key
 * as a stable tiebreak — two reasons on four each must not swap places between
 * renders.
 */
export function describeDigestFilter(summary: DigestSummaryFacts): string {
  const head = `${summary.considered} considered, ${summary.kept} kept.`;

  const entries = Object.entries(summary.dropReasons)
    .filter(([, count]) => count > 0)
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]));

  if (entries.length === 0) {
    return summary.dropped > 0
      ? `${head} Dropped: ${summary.dropped} with no reason recorded.`
      : head;
  }

  const parts = entries.map(([reason, count]) => `${count} ${phraseFor(reason, count)}`);

  // If the reasons do not add up to `dropped`, say so rather than presenting a
  // short histogram as a complete one.
  const accounted = entries.reduce((sum, [, count]) => sum + count, 0);
  const missing = summary.dropped - accounted;
  if (missing > 0) parts.push(`${missing} not categorised`);

  return `${head} Dropped: ${parts.join(', ')}.`;
}

export function CaDigestSummaryCard({
  summary,
  /** Items actually on screen, when it can disagree with `summary.kept`. */
  itemsShown,
}: {
  summary: DigestSummaryFacts | null;
  itemsShown?: number;
}) {
  const theme = useTheme();

  if (summary === null) {
    return (
      <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
        <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
          How today was filtered
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          No selection record was stored for this digest, so there is no way to say what was
          considered or why anything was dropped. The items themselves are unaffected.
        </Text>
      </View>
    );
  }

  const sentence = describeDigestFilter(summary);
  const keepRate =
    summary.considered > 0 ? Math.round((summary.kept / summary.considered) * 100) : null;

  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
        How today was filtered
      </Text>

      {/* The figure and the sentence that qualifies it are ONE node. Split,
          VoiceOver reads "6", "31", then an unattached sentence — three
          fragments that do not compose into the claim being made. */}
      <View
        accessible
        accessibilityRole="summary"
        accessibilityLabel={`${summary.kept} kept of ${summary.considered} considered${
          keepRate === null ? '' : `, ${keepRate} percent`
        }. ${sentence}`}
        style={styles.figureBlock}
      >
        <View style={styles.figureRow}>
          <Text style={[styles.figure, { color: theme.text }]}>{summary.kept}</Text>
          <Text style={[styles.figureOf, { color: theme.textSecondary }]}>
            kept of {summary.considered} considered
            {keepRate === null ? '' : ` · ${keepRate}%`}
          </Text>
        </View>
        <Text style={[styles.sentence, { color: theme.text }]}>{sentence}</Text>
      </View>

      {itemsShown !== undefined && itemsShown !== summary.kept ? (
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          {itemsShown} {itemsShown === 1 ? 'item is' : 'items are'} on this screen but the digest
          recorded {summary.kept} kept. The difference is worth a look before you trust either
          number.
        </Text>
      ) : null}

      {/* Louder than the histogram, deliberately. A broken feed and a quiet
          week produce the same small number and mean opposite things. */}
      {summary.sourceFailures > 0 ? (
        <View
          accessible
          accessibilityLabel={`Warning. ${summary.sourceFailures} ${
            summary.sourceFailures === 1 ? 'source' : 'sources'
          } failed to fetch. A short digest today may be a broken feed rather than a quiet news day.`}
          style={[styles.warning, { borderLeftColor: theme.text }]}
        >
          <Text style={[styles.warningText, { color: theme.text }]}>
            {summary.sourceFailures} {summary.sourceFailures === 1 ? 'source' : 'sources'} failed
            to fetch.
          </Text>
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            A feed that 404s produces nothing, which looks exactly like a quiet news day. Treat a
            short digest today as unexplained rather than as a light week.
          </Text>
        </View>
      ) : null}

      {summary.unknownTags.length > 0 ? (
        <View
          accessible
          accessibilityLabel={`${summary.unknownTags.length} syllabus ${
            summary.unknownTags.length === 1 ? 'tag' : 'tags'
          } this build does not recognise: ${summary.unknownTags.join(', ')}. Items were kept anyway.`}
        >
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            Unrecognised syllabus {summary.unknownTags.length === 1 ? 'tag' : 'tags'}:{' '}
            {summary.unknownTags.join(', ')}. Nothing was rejected for it — the items are readable
            either way — but they will not file themselves into a section of the monthly
            compilation until the syllabus is re-seeded.
          </Text>
        </View>
      ) : null}

      <Text style={[styles.note, { color: theme.textSecondary }]}>
        This list is here to be argued with. It is the same test worth applying to the front page:
        did a rule change, or did something merely happen?
      </Text>
    </View>
  );
}

/**
 * The one-line version, for the Today screen where the full card is too much.
 *
 * Same sentence, same source of truth — deliberately not a second, drifting
 * summary of the same facts.
 */
export function CaDigestSummaryLine({
  summary,
  theme,
}: {
  summary: DigestSummaryFacts;
  theme: Theme;
}) {
  return (
    <Text
      accessible
      accessibilityLabel={describeDigestFilter(summary)}
      style={[styles.note, { color: theme.textSecondary }]}
    >
      {describeDigestFilter(summary)}
    </Text>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 18, marginBottom: 16, gap: 10 },
  title: { fontSize: 16, fontWeight: '700' },
  figureBlock: { gap: 6 },
  figureRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  figure: { fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  figureOf: { fontSize: 13, flexShrink: 1 },
  sentence: { fontSize: 14, lineHeight: 21 },
  warning: { borderLeftWidth: 3, paddingLeft: 12, gap: 4 },
  warningText: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
  note: { fontSize: 12, lineHeight: 18 },
});
