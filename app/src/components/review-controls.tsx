/**
 * The four SM-2 grading buttons.
 *
 * Used at 7am, one-handed, before a 2:30pm shift, by someone who has just
 * tried to recall a whole syllabus topic from memory. Every decision here
 * follows from that:
 *
 *  - Four buttons in a 2×2 grid rather than a row of six. SM-2's 0–5 scale has
 *    six grades; `GRADE_BUTTONS` collapses them to the four that are actually
 *    distinguishable in the moment, and a grid gives each of them roughly a
 *    thumb's worth of target instead of a sliver.
 *  - Every target is at least 44×44 — the iOS HIG floor — and in practice much
 *    taller, because a mis-tap here does not just annoy: it writes a wrong
 *    grade into the schedule and the item comes back at the wrong time.
 *  - The consequence of each button is printed on it. She is choosing between
 *    "tomorrow" and "in three weeks", not between four adjectives, and the
 *    numbers come from `applyReview` itself rather than from a second,
 *    drifting description of the algorithm.
 *
 * `syllabusTopics.confidence` is a standing 1–5 self-report and has no place
 * on this control. These buttons grade recall right now; the two scales are
 * never shown together and neither is derived from the other.
 */

import { useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useTheme } from '@/components/form';
import { GRADE_BUTTONS, applyReview, type ReviewGrade, type Sm2State } from '@/lib/sm2';

/**
 * Tints matched to `Pill`'s tone palette in `controls.tsx` — deliberately the
 * same four colours, so a red button and a red pill mean the same thing.
 * Colour is a second channel here, never the only one: each button also says
 * what it means in words.
 */
const GRADE_TINT: Record<ReviewGrade, string> = {
  0: 'rgba(255,69,58,0.20)',
  1: 'rgba(255,69,58,0.20)',
  2: 'rgba(255,69,58,0.20)',
  3: 'rgba(255,169,64,0.22)',
  4: 'rgba(128,128,128,0.18)',
  5: 'rgba(52,199,89,0.20)',
};

function formatInterval(days: number): string {
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `In ${days} days`;
  if (days < 60) return `In ${Math.round(days / 7)} weeks`;
  return `In ${Math.round(days / 30)} months`;
}

export function ReviewControls({
  state,
  todayIso,
  disabled = false,
  onGrade,
}: {
  /** The item's current SM-2 state, used to preview what each grade would do. */
  state: Sm2State;
  /** Local calendar day, from `localDate(profile.timezone)`. */
  todayIso: string;
  disabled?: boolean;
  onGrade: (grade: ReviewGrade) => void;
}) {
  const theme = useTheme();

  // Previewing costs four pure calls. Wrapped because `applyReview` rejects a
  // date it cannot parse, and a throw during render is a red box over the
  // whole screen — the buttons still have to work without their sub-labels.
  const previews = useMemo(() => {
    try {
      return GRADE_BUTTONS.map((button) => applyReview(state, button.grade, todayIso).intervalDays);
    } catch {
      return null;
    }
  }, [state, todayIso]);

  return (
    <View style={styles.grid}>
      {GRADE_BUTTONS.map((button, index) => {
        const days = previews?.[index] ?? null;
        const next = days === null ? null : formatInterval(days);

        return (
          <TouchableOpacity
            key={button.grade}
            onPress={() => onGrade(button.grade)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            // The label carries the hint because "Good" on its own tells a
            // screen-reader user nothing about which of four near-synonyms
            // this is.
            accessibilityLabel={`${button.label}. ${button.hint}.`}
            {...(next ? { accessibilityHint: `Schedules this topic for ${next.toLowerCase()}` } : {})}
            style={[
              styles.button,
              {
                backgroundColor: GRADE_TINT[button.grade],
                borderColor: theme.backgroundSelected,
                opacity: disabled ? 0.4 : 1,
              },
            ]}
          >
            <Text style={[styles.label, { color: theme.text }]}>{button.label}</Text>
            <Text style={[styles.hint, { color: theme.textSecondary }]} numberOfLines={2}>
              {button.hint}
            </Text>
            {next ? (
              <Text style={[styles.next, { color: theme.textSecondary }]}>{next}</Text>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  button: {
    // 2×2. `flexBasis` rather than a fixed width so it survives a narrow phone
    // and a tablet without a second layout.
    flexGrow: 1,
    flexBasis: '45%',
    minWidth: 44,
    minHeight: 76, // Well past the 44pt floor: this is the tap that matters.
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
    justifyContent: 'center',
    gap: 2,
  },
  label: { fontSize: 17, fontWeight: '700' },
  hint: { fontSize: 12, lineHeight: 16 },
  next: { fontSize: 12, fontWeight: '600', marginTop: 2 },
});
