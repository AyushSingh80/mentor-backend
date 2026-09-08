/**
 * One drill, in marks.
 *
 * Copy rules, in priority order:
 *
 * 1. **Net marks lead, not a percentage.** Prelims is scored in marks under
 *    negative marking; a percentage silently discards the penalty and would
 *    tell her a 60%-correct set was a good one when it may have been a losing
 *    one. The comparable figure — marks per 100 questions — sits directly under
 *    it, because that is the only number two differently-sized sets can share.
 *
 * 2. **The counterfactuals ARE the lesson.** "Guess only when you have
 *    eliminated something" is a rule she has already read. What she has not
 *    seen is what her own guesses cost her, in marks, this session. A preached
 *    rule changes nothing; her own arithmetic does. They sit above the
 *    breakdown for that reason.
 *
 * 3. **Attempt rate is shown next to accuracy, always.** Over-correcting into
 *    skipping everything is a real failure mode that an accuracy figure hides
 *    completely: skip nine of ten and answer the tenth correctly and accuracy
 *    reads 100%.
 *
 * 4. **An abandoned session says so.** Its marks are still shown — she really
 *    scored them — but they are labelled as not a score, because a 3-of-12
 *    session is an interrupted commute.
 */

import { StyleSheet, Text, View } from 'react-native';

import { Card, Pill, Row, type PillTone } from '@/components/controls';
import { useTheme } from '@/components/form';
import {
  formatMarks,
  formatPercent,
  formatSignedMarks,
  type AttemptOutcome,
  type SessionScore,
} from '@/lib/mcq-score';

/** Matches the pill tones in `controls.tsx` so one session reads as one palette. */
const OUTCOME_TONE: Record<AttemptOutcome, string> = {
  correct: 'rgba(52,199,89,0.55)',
  wrong: 'rgba(255,69,58,0.55)',
  skipped: 'rgba(128,128,128,0.35)',
};

const OUTCOME_WORD: Record<AttemptOutcome, string> = {
  correct: 'right',
  wrong: 'wrong',
  skipped: 'skipped',
};

function netTone(netPer100: number | null): PillTone {
  if (netPer100 === null) return 'neutral';
  if (netPer100 > 0) return 'good';
  if (netPer100 < 0) return 'bad';
  return 'warn';
}

export interface McqScoreCardProps {
  score: SessionScore;
}

export function McqScoreCard({ score }: McqScoreCardProps): React.ReactElement {
  const theme = useTheme();
  const { guessing, skipping } = score.counterfactuals;

  const headlineLabel =
    `${formatSignedMarks(score.netMarks)} net marks out of ${formatMarks(score.maxMarks)}` +
    (score.netPer100 === null ? '' : `, ${Math.round(score.netPer100)} per hundred questions`) +
    (score.scoreable ? '' : ', not counted as a score');

  return (
    <Card>
      <View style={styles.headlineRow}>
        <View style={styles.headlineText}>
          <Text
            accessibilityRole="header"
            accessibilityLabel={headlineLabel}
            style={[styles.net, { color: theme.text }]}
          >
            {formatSignedMarks(score.netMarks)}
          </Text>
          <Text style={[styles.netUnit, { color: theme.textSecondary }]}>
            net marks of {formatMarks(score.maxMarks)}
          </Text>
        </View>
        <Pill
          text={score.scoreable ? score.mode : 'not scored'}
          tone={score.scoreable ? netTone(score.netPer100) : 'warn'}
        />
      </View>

      {score.netPer100 === null ? null : (
        <Text style={[styles.per100, { color: theme.text }]}>
          {Math.round(score.netPer100)} per 100 questions
        </Text>
      )}
      <Text style={[styles.note, { color: theme.textSecondary }]}>
        Marks per 100 is the only figure two differently-sized sets can share — and it is the
        scale of the real paper, which is 100 questions for 200 marks.
      </Text>

      {score.notScoreableReason ? (
        <Text style={[styles.warning, { color: theme.text }]}>{score.notScoreableReason}</Text>
      ) : null}

      <OutcomeStrip score={score} />

      {guessing.guesses > 0 ? (
        <Lesson
          title="What the guesses cost"
          body={guessing.message}
          delta={guessing.deltaMarks}
          invert
        />
      ) : null}

      {skipping.skips > 0 ? (
        <Lesson
          title="What the skips forwent"
          body={skipping.message}
          delta={skipping.deltaMarks}
        />
      ) : null}

      <View style={[styles.divider, { backgroundColor: theme.textSecondary }]} />

      <Row label="Right" value={`${score.correct} · ${formatMarks(score.correct * score.scheme.perCorrect)} marks`} />
      <Row
        label="Wrong"
        value={`${score.wrong} · ${formatMarks(Math.abs(score.wrong * score.scheme.perWrong))} marks lost`}
      />
      <Row label="Skipped" value={`${score.skipped} · 0 marks`} />
      <Row label="Attempt rate" value={formatPercent(score.attemptRate)} />
      <Row label="Accuracy on attempted" value={formatPercent(score.accuracy)} />
      {score.repeats > 0 ? (
        <Row label="Seen before" value={`${score.repeats} of ${score.seen}`} />
      ) : null}
      {score.excluded > 0 ? (
        <Row label="Disputed, not scored" value={String(score.excluded)} />
      ) : null}

      <Text style={[styles.note, { color: theme.textSecondary }]}>
        A skip is worth exactly zero — it never carries a wrong answer&apos;s penalty. Accuracy
        counts first sightings only
        {score.repeats > 0 ? ', so the repeats above are left out of it' : ''} — a remembered
        answer is not a known one.
      </Text>
    </Card>
  );
}

/* ---------------------------------------------------------------- parts */

/**
 * One counterfactual.
 *
 * `invert` flips which sign is good: for the guessing block a POSITIVE delta
 * means skipping would have scored more, which is bad news about the guesses.
 * For the skipping block a positive delta means guessing would have paid.
 */
function Lesson({
  title,
  body,
  delta,
  invert = false,
}: {
  title: string;
  body: string;
  delta: number | null;
  invert?: boolean;
}) {
  const theme = useTheme();

  const tone: PillTone =
    delta === null || Math.abs(delta) < 0.05 ? 'neutral' : (delta > 0) === invert ? 'bad' : 'good';

  return (
    <View style={styles.lesson}>
      <View style={styles.lessonHeader}>
        <Text style={[styles.lessonTitle, { color: theme.text }]}>{title}</Text>
        {delta === null ? null : <Pill text={`${formatSignedMarks(delta)} marks`} tone={tone} />}
      </View>
      <Text style={[styles.lessonBody, { color: theme.text }]}>{body}</Text>
    </View>
  );
}

/**
 * The shape of the session, one block per question in the order she saw them.
 *
 * Silent to a screen reader as bare `View`s, so the whole strip is one
 * focusable element with a sentence for a label — the same treatment the trend
 * chart gets in `score-trend.tsx`.
 */
function OutcomeStrip({ score }: { score: SessionScore }) {
  const theme = useTheme();
  if (score.perAttempt.length === 0) return null;

  const label =
    `${score.perAttempt.length} questions in order: ` +
    score.perAttempt.map((a, i) => `${i + 1} ${OUTCOME_WORD[a.outcome]}`).join(', ') +
    '.';

  return (
    <View style={styles.strip} accessible accessibilityLabel={label}>
      {score.perAttempt.map((attempt, index) => (
        <View
          key={`${attempt.questionId}-${index}`}
          style={[
            styles.tick,
            {
              backgroundColor: OUTCOME_TONE[attempt.outcome],
              // A disputed row is drawn hollow: the outcome happened, but it is
              // not part of the score and must not read as part of it.
              opacity: attempt.excluded ? 0.3 : 1,
              borderColor: theme.background,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  headlineRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  headlineText: { flexShrink: 1 },
  net: { fontSize: 44, fontWeight: '700', fontVariant: ['tabular-nums'], lineHeight: 50 },
  netUnit: { fontSize: 13, marginTop: -2 },
  per100: { fontSize: 17, fontWeight: '600', marginTop: 10, fontVariant: ['tabular-nums'] },
  note: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  warning: { fontSize: 13, lineHeight: 19, fontWeight: '600', marginTop: 12 },

  strip: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, marginTop: 16 },
  tick: { width: 14, height: 14, borderRadius: 3, borderWidth: 1 },

  lesson: { marginTop: 18, gap: 6 },
  lessonHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  lessonTitle: { fontSize: 13, fontWeight: '700', letterSpacing: 0.3, textTransform: 'uppercase', flexShrink: 1 },
  lessonBody: { fontSize: 15, lineHeight: 22 },

  divider: { height: StyleSheet.hairlineWidth, opacity: 0.3, marginVertical: 16 },
});
