/**
 * The answer pad. One hand, on a moving train, at 7:44am.
 *
 * Every decision here follows from that sentence:
 *
 *  - **Everything interactive is in the bottom of the screen.** The stem
 *    scrolls above; this control is pinned above the safe-area inset by the
 *    screen. A pad in the middle of the display is a two-handed pad.
 *  - **Five one-tap commits**: four options plus Skip. No "select then confirm"
 *    — that is two taps for every question, twelve times a commute, to protect
 *    against a mis-tap that the target sizes below already prevent.
 *  - **A persistent "I'm guessing" toggle**, reset per question by the machine
 *    in `lib/mcq-session.ts`. It costs one extra tap exactly when it applies,
 *    and it is what makes the highest-value Prelims skill measurable at all:
 *    under −1/3 marking, guessing pays only above 25% accuracy, so knowing when
 *    NOT to guess is worth marks on its own and cannot be derived from anything
 *    else in the schema.
 *  - **No horizontal swipe to advance.** It fights the router's back gesture on
 *    iOS and is unreliable one-handed with a thumb that is also holding the
 *    phone. Every transition is an explicit tap.
 *  - **Targets are 56pt minimum with `hitSlop` on top.** `review-controls.tsx`
 *    sets 76 and explains why: a mis-tap there writes a wrong grade into a
 *    schedule. The same is true here — a mis-tap commits an answer that cannot
 *    be taken back, moves the mark, and enrols the question in the re-drill
 *    queue.
 *
 * ## The adaptive layout, and why it is one rule
 *
 * UPSC options are bimodal. Statement-combination questions produce "1 and 3
 * only", "2 only", "All of the above" — four short strings. Assertion and
 * single-fact questions produce full sentences.
 *
 * A 2×2 grid of wrapped sentences is unreadable: each cell is half a screen
 * wide, every option wraps to four lines, and the four cells stop being
 * scannable. A four-row list of "2 only" wastes the thumb arc: four 56pt rows
 * of three characters each, where a grid would have put all four inside one
 * thumb sweep.
 *
 * So there is one rule, measured on the content rather than on the question
 * type — which is not stored anyway: if every option is short, grid; otherwise
 * rows. Both cases are handled by the same component, so there is no way for
 * the two layouts to drift apart.
 */

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useTheme } from '@/components/form';
import { OPTION_COUNT, OPTION_LETTERS } from '@/lib/mcq-types';

/** Re-exported so existing importers keep working. Defined in `mcq-types.ts`. */
export { OPTION_LETTERS };

/**
 * The longest an option can be and still read cleanly at half-width.
 *
 * Roughly two lines in a 2×2 cell on the narrowest phone this app targets.
 * "Only one of the statements given above is correct" is 48 characters and is
 * the kind of string that must NOT go in a grid; "1 and 3 only" is 12 and must.
 */
export const SHORT_OPTION_CHARS = 28;

export type PadLayout = 'grid' | 'rows';

/**
 * One rule, both cases. Measured on the actual strings: the question type is
 * not stored, and inferring it from the stem would be a parser that is wrong
 * often enough to matter.
 */
export function padLayout(options: readonly string[]): PadLayout {
  return options.every((option) => option.trim().length <= SHORT_OPTION_CHARS) ? 'grid' : 'rows';
}

export function McqOptionPad({
  options,
  guessing,
  disabled = false,
  onToggleGuess,
  onCommit,
}: {
  /** Always `OPTION_COUNT` long — a short array renders a dead button. */
  options: string[];
  /** The per-question flag. Owned by the machine, reset on every advance. */
  guessing: boolean;
  disabled?: boolean;
  onToggleGuess: () => void;
  /** `null` IS the skip. There is no second callback — see the schema comment. */
  onCommit: (chosenIndex: number | null) => void;
}) {
  const theme = useTheme();
  const layout = padLayout(options);

  return (
    <View style={styles.pad}>
      <TouchableOpacity
        onPress={onToggleGuess}
        disabled={disabled}
        accessibilityRole="switch"
        accessibilityState={{ checked: guessing, disabled }}
        accessibilityLabel="I'm guessing"
        accessibilityHint="Marks the next answer as a guess. Reset after every question."
        hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
        style={[
          styles.guess,
          {
            backgroundColor: guessing ? theme.text : theme.backgroundElement,
            borderColor: guessing ? theme.text : theme.backgroundSelected,
            opacity: disabled ? 0.4 : 1,
          },
        ]}
      >
        <Text
          style={[styles.guessText, { color: guessing ? theme.background : theme.textSecondary }]}
        >
          {guessing ? "✓  I'm guessing" : "I'm guessing"}
        </Text>
      </TouchableOpacity>

      <View style={layout === 'grid' ? styles.grid : styles.rows}>
        {options.slice(0, OPTION_COUNT).map((option, index) => (
          <TouchableOpacity
            key={`${index}-${option}`}
            onPress={() => onCommit(index)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            // The letter alone tells a screen-reader user nothing about which
            // of four options this is, so the text is read with it.
            accessibilityLabel={`Option ${OPTION_LETTERS[index]}. ${option}`}
            accessibilityHint={guessing ? 'Commits this answer, flagged as a guess' : undefined}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
            style={[
              layout === 'grid' ? styles.cell : styles.row,
              {
                backgroundColor: theme.backgroundElement,
                borderColor: theme.backgroundSelected,
                opacity: disabled ? 0.4 : 1,
              },
            ]}
          >
            <Text style={[styles.letter, { color: theme.textSecondary }]}>
              {OPTION_LETTERS[index]}
            </Text>
            <Text style={[styles.optionText, { color: theme.text }]}>{option}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity
        onPress={() => onCommit(null)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        accessibilityLabel="Skip this question"
        // The arithmetic, not an exhortation. A skip scores zero; a wrong
        // answer costs two thirds of a mark.
        accessibilityHint="Scores zero. A wrong answer costs two thirds of a mark."
        hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
        style={[
          styles.skip,
          {
            backgroundColor: theme.background,
            borderColor: theme.backgroundSelected,
            opacity: disabled ? 0.4 : 1,
          },
        ]}
      >
        <Text style={[styles.skipText, { color: theme.textSecondary }]}>Skip</Text>
      </TouchableOpacity>
    </View>
  );
}

/**
 * The advance control, in the pad's place.
 *
 * Deliberately the same shape and the same position as the options so her
 * thumb does not move between answering and continuing. Sized like them too:
 * this is the tap she makes most often in a session.
 */
export function McqAdvanceButton({
  label,
  hint,
  onPress,
  disabled = false,
}: {
  label: string;
  hint?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.pad}>
      <TouchableOpacity
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        accessibilityLabel={label}
        {...(hint ? { accessibilityHint: hint } : {})}
        hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
        style={[styles.advance, { backgroundColor: theme.text, opacity: disabled ? 0.4 : 1 }]}
      >
        <Text style={[styles.advanceText, { color: theme.background }]}>{label}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { gap: 10 },

  guess: {
    alignSelf: 'flex-start',
    borderRadius: 20,
    borderWidth: 1.5,
    paddingHorizontal: 16,
    // Smaller than the commits on purpose: it is a modifier, and giving it the
    // same visual weight as an answer invites tapping it BY mistake, which
    // writes a false guess flag into the one figure it exists to measure.
    minHeight: 44,
    justifyContent: 'center',
  },
  guessText: { fontSize: 15, fontWeight: '600' },

  // 2×2 for short options. `flexBasis` rather than a fixed width so it survives
  // a narrow phone and a tablet without a second layout — as `review-controls`
  // does.
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  cell: {
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: 56,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    justifyContent: 'center',
    gap: 2,
  },

  // Full-width rows for sentence options.
  rows: { gap: 10 },
  row: {
    minHeight: 56,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: 'center',
    gap: 2,
  },

  letter: { fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  // 16pt with a 1.4 line-height, matching the stem. Options are read, not
  // glanced at.
  optionText: { fontSize: 16, lineHeight: 22 },

  skip: {
    minHeight: 56,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipText: { fontSize: 16, fontWeight: '600' },

  advance: {
    minHeight: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  advanceText: { fontSize: 17, fontWeight: '700' },
});
