/**
 * One fact card: the cue, then the answer, then the four grading buttons.
 *
 * The same reveal-then-grade shape as the topic half of the Revise screen, for
 * the same reason: seeing the interval or the past grades before the recall
 * attempt anchors the self-assessment, and an item labelled "you found this
 * easy" gets graded easy. The scheduling numbers appear only once the attempt
 * is already over.
 *
 * What is deliberately DIFFERENT from a topic review is the size of the ask.
 * A topic is a ~90-second recall over a whole syllabus leaf; a card is a
 * ~10-second one. So the prompt is one line rather than a paragraph, and the
 * card carries a "Fact card" pill — she needs to know which of the two things
 * she is being asked for before she starts, because grading a 10-second recall
 * against a 90-second standard is how the ease factor gets corrupted.
 *
 * The grading buttons are `ReviewControls`, unchanged. There is exactly one
 * grader in this app and its previews come from `applyReview` itself; a second
 * one would drift into describing a different algorithm from the one running.
 */

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Card, Pill, Row } from '@/components/controls';
import { useTheme } from '@/components/form';
import { ReviewControls } from '@/components/review-controls';
import type { DueCard } from '@/db/flashcards';
import { SM2, type ReviewGrade } from '@/lib/sm2';

export function FlashcardReview({
  card,
  todayIso,
  revealed,
  disabled = false,
  onReveal,
  onGrade,
}: {
  card: DueCard;
  /** Local calendar day, from `localDate(profile.timezone)`. */
  todayIso: string;
  revealed: boolean;
  disabled?: boolean;
  onReveal: () => void;
  onGrade: (grade: ReviewGrade) => void;
}) {
  const theme = useTheme();

  return (
    <Card>
      <View style={styles.pills}>
        <Pill text="Fact card" />
        {card.daysOverdue > 0 ? (
          <Pill
            text={card.daysOverdue === 1 ? '1 day late' : `${card.daysOverdue} days late`}
            tone="warn"
          />
        ) : null}
        {card.isLeech ? <Pill text="Stuck" tone="bad" /> : null}
      </View>

      {/* The cue, never the headline. See the header of `lib/flashcards.ts`. */}
      <Text style={[styles.front, { color: theme.text }]}>{card.front}</Text>

      {revealed ? (
        <View style={styles.panel}>
          <Text style={[styles.back, { color: theme.text }]}>{card.back}</Text>

          <View style={styles.rows}>
            <Row
              label="Last reviewed"
              value={card.lastReviewedAt ? card.lastReviewedAt.slice(0, 10) : 'Never'}
            />
            <Row
              label="Current interval"
              value={
                card.state.repetitions === 0 ? 'First recall' : `${card.state.intervalDays} days`
              }
            />
            <Row
              label="Ease"
              value={
                card.state.easeFactor <= SM2.minEase
                  ? `${card.state.easeFactor.toFixed(2)} — at the floor`
                  : card.state.easeFactor.toFixed(2)
              }
            />
            {card.state.lapses > 0 ? (
              <Row label="Times forgotten" value={String(card.state.lapses)} />
            ) : null}
          </View>

          <Text style={[styles.prompt, { color: theme.text }]}>How did that go?</Text>
          <ReviewControls
            state={card.state}
            todayIso={todayIso}
            disabled={disabled}
            onGrade={onGrade}
          />
        </View>
      ) : (
        <>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>
            Name the example, the finding or the change — then check it.
          </Text>
          <TouchableOpacity
            onPress={onReveal}
            accessibilityRole="button"
            accessibilityLabel="Show the answer to this card and the grading buttons."
            style={[styles.reveal, { backgroundColor: theme.text }]}
          >
            <Text style={[styles.revealText, { color: theme.background }]}>Show the answer</Text>
          </TouchableOpacity>
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  front: { fontSize: 19, fontWeight: '700', lineHeight: 26 },
  hint: { fontSize: 13, lineHeight: 20, marginTop: 10 },

  reveal: {
    borderRadius: 12,
    // 44pt is the iOS HIG floor; this is the only control on the card.
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
  },
  revealText: { fontSize: 15, fontWeight: '700' },

  panel: { marginTop: 14 },
  back: { fontSize: 15, lineHeight: 22 },
  rows: { marginTop: 12, gap: 2 },
  prompt: { fontSize: 15, fontWeight: '600', marginTop: 14 },
});
