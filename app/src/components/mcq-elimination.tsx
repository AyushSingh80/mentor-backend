/**
 * The reveal — why the wrong options are wrong.
 *
 * This is the part of a drill that teaches. Getting a question right tells her
 * she knew it; getting it wrong tells her nothing at all unless she is shown
 * which distractor she fell for and why it was built to catch her. That is why
 * `micro` reveals per question and is only ten questions long: roughly 45 s to
 * answer plus roughly 30 s to actually READ this is the entire budget.
 *
 * Deliberately presentational — there is not a single touchable in this file.
 * Everything interactive on the drill screen lives in the bottom of the
 * display, in the pad's place, so her thumb never moves between answering and
 * continuing. A "Next" button rendered here would sit wherever the elimination
 * text happened to end.
 *
 * ## Order
 *
 * 1. The verdict and the mark it moved, because that is what she is looking
 *    for and burying it makes her scroll past the explanation to find it.
 * 2. The key, then her answer if it differed.
 * 3. The elimination logic.
 * 4. Provenance, and the guess note.
 *
 * ## Provenance belongs on screen
 *
 * A past question's key is UPSC's; a generated key is a model's, and she is
 * entitled to weight them differently. Showing which is which is what makes
 * "this looks wrong" a reasonable thing to think rather than an accusation —
 * and an AI-generated key that is wrong does not merely fail to teach, it gets
 * drilled to mastery by spaced repetition.
 */

import { StyleSheet, Text, View } from 'react-native';

import { Pill, type PillTone } from '@/components/controls';
import { useTheme } from '@/components/form';
import { MARKS, type DrillQuestion } from '@/lib/mcq-types';
import { OPTION_LETTERS } from '@/components/mcq-option-pad';

/**
 * The marks one attempt moved.
 *
 * Reads `MARKS` directly rather than deriving anything: `lib/mcq-score.ts` owns
 * scoring and is the only implementation of it, and a second one here is
 * exactly how the drill and the summary end up disagreeing by a third of a
 * mark. This is a lookup in a frozen constant, not a scoring rule.
 */
function markDelta(chosenIndex: number | null, correct: boolean): number {
  if (chosenIndex === null) return MARKS.perSkip;
  return correct ? MARKS.perCorrect : MARKS.perWrong;
}

/** `-0.67`, `+2`. Two places, signed, because the sign is the whole message. */
function formatDelta(value: number): string {
  if (value === 0) return '0';
  const rounded = Math.round(value * 100) / 100;
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}`;
}

export function McqElimination({
  question,
  chosenIndex,
  correct,
  guessed,
}: {
  question: DrillQuestion;
  /** `null` IS the skip. */
  chosenIndex: number | null;
  correct: boolean;
  guessed: boolean;
}) {
  const theme = useTheme();

  const skipped = chosenIndex === null;
  const tone: PillTone = skipped ? 'neutral' : correct ? 'good' : 'bad';
  const verdict = skipped ? 'Skipped' : correct ? 'Correct' : 'Wrong';
  const delta = markDelta(chosenIndex, correct);

  const key = question.options[question.correctIndex] ?? null;
  const chosen = chosenIndex === null ? null : (question.options[chosenIndex] ?? null);

  return (
    <View style={styles.wrap}>
      <View style={styles.verdictRow}>
        <Pill text={verdict} tone={tone} />
        <Text
          style={[styles.delta, { color: theme.text }]}
          accessibilityLabel={`${verdict}. ${formatDelta(delta)} marks.`}
        >
          {formatDelta(delta)}
        </Text>
      </View>

      {key === null ? (
        // `correctIndex` outside the option array. Possible only on a corrupt
        // row; saying so is better than rendering a blank where the key goes.
        <Text style={[styles.body, { color: theme.textSecondary }]}>
          This question&apos;s answer key is missing or out of range. Nothing here is safe to
          learn from — flag it rather than trusting it.
        </Text>
      ) : (
        <View style={styles.answers}>
          <Text style={[styles.label, { color: theme.textSecondary }]}>Answer</Text>
          <Text style={[styles.answer, { color: theme.text }]}>
            {OPTION_LETTERS[question.correctIndex]}. {key}
          </Text>

          {skipped ? (
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              You skipped this one. Under negative marking that is often the right call — a blind
              four-way guess is exactly break-even, so guessing only pays once you have eliminated
              something.
            </Text>
          ) : correct ? null : (
            <>
              <Text style={[styles.label, { color: theme.textSecondary, marginTop: 10 }]}>
                You chose
              </Text>
              <Text style={[styles.answer, { color: theme.textSecondary }]}>
                {OPTION_LETTERS[chosenIndex]}. {chosen ?? '—'}
              </Text>
            </>
          )}
        </View>
      )}

      {question.eliminationLogic ? (
        <View style={styles.logic}>
          <Text style={[styles.label, { color: theme.textSecondary }]}>Why the others are wrong</Text>
          <Text style={[styles.logicText, { color: theme.text }]}>{question.eliminationLogic}</Text>
        </View>
      ) : (
        <Text style={[styles.body, { color: theme.textSecondary }]}>
          No elimination logic was stored for this question, so there is nothing here to learn from
          beyond the key itself.
        </Text>
      )}

      {guessed ? <GuessNote correct={correct} /> : null}

      <View style={styles.provenance}>
        <Text style={[styles.provenanceText, { color: theme.textSecondary }]}>
          {question.source === 'pyq'
            ? `Past question${question.pyqYear ? `, ${question.pyqYear}` : ''}${
                question.pyqPaper ? ` · ${question.pyqPaper}` : ''
              }. The key is UPSC's.`
            : 'Generated question. The key is a model’s, not UPSC’s — weigh it accordingly.'}
        </Text>
        {question.priorAttempts > 0 ? (
          <Text style={[styles.provenanceText, { color: theme.textSecondary }]}>
            You have seen this {question.priorAttempts === 1 ? 'once' : `${question.priorAttempts} times`}{' '}
            before. A remembered answer is not a known one, and it is scored apart.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The guess note.
 *
 * A guess that came off is the dangerous one: it feels like knowledge and
 * enters the accuracy figure as knowledge. Saying so is the only moment the
 * app can separate the two, and it is exactly why the flag exists.
 */
function GuessNote({ correct }: { correct: boolean }) {
  const theme = useTheme();
  return (
    <View style={[styles.guessNote, { borderColor: theme.backgroundSelected }]}>
      <Text style={[styles.body, { color: theme.textSecondary }]}>
        {correct
          ? 'You flagged this as a guess and it came off. It still counts as a guess: a guess that lands feels exactly like knowing, which is why the flag is worth the tap.'
          : 'You flagged this as a guess. Over a whole paper, guessing pays only above 25% accuracy — the summary prices yours in marks.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  verdictRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  delta: { fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },

  answers: { gap: 2 },
  label: { fontSize: 12, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase' },
  // 16pt minimum with a 1.4 line-height, as everywhere on this screen.
  answer: { fontSize: 16, lineHeight: 23, fontWeight: '600' },

  logic: { gap: 4 },
  logicText: { fontSize: 16, lineHeight: 23 },

  body: { fontSize: 14, lineHeight: 20 },
  guessNote: { borderLeftWidth: 3, paddingLeft: 12 },

  provenance: { gap: 4 },
  provenanceText: { fontSize: 12, lineHeight: 17 },
});
