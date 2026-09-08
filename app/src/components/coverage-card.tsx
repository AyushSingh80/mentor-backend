/**
 * Syllabus coverage card.
 *
 * Rendered on Progress and linked into the per-paper screen.
 *
 * Copy rules:
 * - Label Essay's coverage as thematic clusters, not an official syllabus.
 *   "Essay 40% covered" otherwise asserts something untrue.
 * - The projection against 31 March 2027 is the point of the card. Show
 *   `behindTarget` plainly — this is the number that tells her in month two,
 *   not month ten, that the first-pass date has slipped.
 */

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Card, Pill } from '@/components/controls';
import { useTheme } from '@/components/form';
import type { Coverage, MilestoneProjection } from '@/lib/syllabus-coverage';
import { isPaperValue, type PaperValue } from '@/lib/papers';

/**
 * Essay has no published syllabus. Its entries are clusters drawn from past
 * papers, so its percentage measures progress through a scaffold this app
 * invented — useful, but not the same claim as "40% of GS2". Every surface that
 * shows the number has to carry the qualification with it.
 */
const ESSAY_NOTE =
  'Essay has no official UPSC syllabus. Its percentage is progress through past-paper themes collected here, not through a published list.';

function days(count: number): string {
  return `${count} ${count === 1 ? 'day' : 'days'}`;
}

/** "31 Mar 2027" from "2027-03-31", without pulling in a date library. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const month = MONTHS[Number(match[2]) - 1] ?? match[2];
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/**
 * The projection in one sentence, with its sample attached.
 *
 * "On track for March 2027" measured over four days of data is a promise the
 * sample cannot keep, so the window it was measured over is never dropped.
 */
function projectionSentence(projection: MilestoneProjection): string {
  const target = formatDay(projection.targetIso);

  if (projection.remainingTopics === 0) {
    return `Every live topic has had its first pass, ahead of ${target}.`;
  }
  if (projection.sampleDays === 0) {
    return `Nothing marked yet, so there is no rate to project against ${target}.`;
  }
  if (projection.projectedDateIso === null) {
    return (
      `Nothing reached a first pass in the last ${days(projection.sampleDays)}, ` +
      `so there is no rate to project against ${target}.`
    );
  }

  const rate = projection.topicsPerDay;
  const pace = rate >= 1 ? `${rate.toFixed(1)} topics a day` : `${(rate * 7).toFixed(1)} a week`;

  return (
    `${projection.remainingTopics} topics left. At ${pace} over the last ` +
    `${days(projection.sampleDays)}, that is ${formatDay(projection.projectedDateIso)} — ` +
    `${projection.behindTarget ? 'after' : 'before'} your ${target} target.`
  );
}

export interface CoverageCardProps {
  coverage: Coverage[];
  projection: MilestoneProjection;
  onOpenPaper: (paper: PaperValue) => void;
  compact?: boolean;
}

export function CoverageCard({
  coverage,
  projection,
  onOpenPaper,
  compact = false,
}: CoverageCardProps): React.ReactElement | null {
  const theme = useTheme();

  const total = coverage.reduce((sum, row) => sum + row.total, 0);
  const passed = coverage.reduce((sum, row) => sum + row.firstPass + row.revised, 0);
  const overall = total === 0 ? 0 : (passed / total) * 100;
  const showsEssay = coverage.some((row) => row.key === 'essay');

  if (total === 0) {
    return (
      <Card title="Syllabus coverage">
        <Text style={{ color: theme.textSecondary }}>
          The syllabus has not been seeded yet. It loads on the next launch; nothing is lost.
        </Text>
      </Card>
    );
  }

  return (
    <Card title="Syllabus coverage">
      {/* Figure and caveat in one focusable element: a screen reader announcing
          "18%" and "measured over 6 days" as unrelated fragments drops the
          caveat, which is the honest half. */}
      <View
        accessible
        accessibilityLabel={`${Math.round(overall)} percent of ${total} live topics have had a first pass. ${projectionSentence(projection)}`}
        style={styles.headline}
      >
        <Text style={[styles.value, { color: theme.text }]}>{Math.round(overall)}%</Text>
        <Text style={[styles.valueMeta, { color: theme.textSecondary }]}>
          first pass, {passed} of {total} topics
        </Text>
        {projection.behindTarget ? <Pill text="behind target" tone="bad" /> : null}
      </View>

      <Text style={[styles.line, { color: theme.textSecondary }]}>
        {projectionSentence(projection)}
      </Text>

      {!compact ? (
        <>
          <View style={styles.rows}>
            {coverage.map((row) => (
              <PaperRow key={row.key} row={row} onOpenPaper={onOpenPaper} theme={theme} />
            ))}
          </View>

          {showsEssay ? (
            <Text style={[styles.note, { color: theme.textSecondary }]}>{ESSAY_NOTE}</Text>
          ) : null}

          <Text style={[styles.note, { color: theme.textSecondary }]}>
            Open a paper to see coverage by section. One topic moves a paper by about a fifth of a
            point, which reads as nothing; sections are the unit that actually moves.
          </Text>
        </>
      ) : null}
    </Card>
  );
}

/* ---------------------------------------------------------------- fragments */

type Theme = ReturnType<typeof useTheme>;

/**
 * One paper, with a two-part bar: first pass filled solid, revised marked
 * inside it. Revision is the half of the work that is invisible in a single
 * percentage, and it is what the SM-2 queue is grinding away at.
 */
function PaperRow({
  row,
  onOpenPaper,
  theme,
}: {
  row: Coverage;
  onOpenPaper: (paper: PaperValue) => void;
  theme: Theme;
}) {
  // `coverageByPaper` keys rows by `PaperValue`, but the prop is a plain
  // `Coverage[]` and a caller could pass section rows by mistake. A row that
  // cannot be navigated from is rendered flat rather than made falsely tappable.
  const paper = isPaperValue(row.key) ? row.key : null;
  const isEssay = row.key === 'essay';
  const first = Math.max(0, Math.min(100, row.percentFirstPass));
  const revised = Math.max(0, Math.min(100, row.percentRevised));

  const label =
    `${row.label}: ${Math.round(first)} percent first pass, ` +
    `${Math.round(revised)} percent revised, of ${row.total} topics` +
    (isEssay ? '. Past-paper themes, not an official syllabus' : '');

  const body = (
    <>
      <View style={styles.rowHeader}>
        <Text style={[styles.rowLabel, { color: theme.text }]} numberOfLines={1}>
          {row.label}
          {isEssay ? <Text style={{ color: theme.textSecondary }}> · themes</Text> : null}
        </Text>
        <Text style={[styles.rowValue, { color: theme.text }]}>
          {Math.round(first)}%
          <Text style={[styles.rowCount, { color: theme.textSecondary }]}> of {row.total}</Text>
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: theme.backgroundSelected }]}>
        <View style={[styles.fill, { width: `${first}%`, backgroundColor: theme.text }]}>
          {/* Revised sits inside the filled portion, at reduced opacity, so the
              two numbers can never be read as adding up to more than 100. */}
          <View
            style={[
              styles.revisedFill,
              { width: first === 0 ? '0%' : `${(revised / first) * 100}%` },
            ]}
          />
        </View>
      </View>
    </>
  );

  if (paper === null) {
    return (
      <View accessible accessibilityLabel={label} style={styles.row}>
        {body}
      </View>
    );
  }

  return (
    <TouchableOpacity
      onPress={() => onOpenPaper(paper)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens this paper’s sections"
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      style={styles.row}
    >
      {body}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  headline: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 },
  value: { fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  valueMeta: { fontSize: 13, flexShrink: 1 },
  line: { fontSize: 13, lineHeight: 19, marginTop: 8 },

  rows: { marginTop: 14, gap: 12 },
  row: { gap: 5 },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 },
  rowLabel: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  rowValue: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  rowCount: { fontSize: 12, fontWeight: '400' },
  track: { height: 7, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 7, borderRadius: 4 },
  revisedFill: { height: 7, borderRadius: 4, backgroundColor: 'rgba(52,199,89,0.85)' },

  note: { fontSize: 12, lineHeight: 18, marginTop: 10 },
});
