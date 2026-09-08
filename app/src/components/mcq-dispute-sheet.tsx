/**
 * "This looks wrong" — the dispute sheet.
 *
 * ## Why this control exists
 *
 * A generated answer key that is wrong does not merely fail to teach. Spaced
 * repetition takes the falsehood and drills it to mastery, and the better the
 * scheduling works the more thoroughly the wrong fact is learned. This is the
 * one tap that stops it — and it has to work on a train with no signal, which
 * it does, because everything behind it is a local SQLite transaction and
 * nothing here touches the network.
 *
 * ## Never before the reveal
 *
 * `revealed` gates both halves of this file, and `DisputeTrigger` renders
 * nothing at all until it is true. Offered before she has committed to an
 * answer, "this looks wrong" becomes a way to dodge committing: a hard
 * question she has not worked out is indistinguishable, from the inside, from
 * a question that is actually broken. After the reveal she has seen the key
 * and the elimination logic, so the judgement is about the question rather
 * than about her confidence. The gate is a prop rather than a convention so a
 * caller cannot forget it.
 *
 * ## Three chips, and a note she never has to write
 *
 * The reason is a closed set of three, because "answer key wrong" and
 * "ambiguous" call for completely different fixes and a free-text box would
 * bury that distinction in prose. The note is optional and stays optional: a
 * dispute must cost one tap plus one chip, or it will not be raised at 07:45
 * on a commute, and an unraised dispute is a falsehood left in the deck.
 *
 * ## No effects
 *
 * `react-hooks/set-state-in-effect` is an error in this repo, and nothing here
 * needs an effect anyway: the sheet's state is reset in the open and close
 * handlers, at the moment the transition actually happens, rather than
 * inferred afterwards from a changed prop.
 *
 * Built from React Native's own `Modal` rather than `@expo/ui`'s `BottomSheet`
 * (SDK 57). The sheet has to host this app's existing primitives — `Card`,
 * `ChipPicker`, `MultilineField`, all plain RN — and a SwiftUI/Compose sheet
 * would need every one of them bridged back through `RNHostView`. `Modal`
 * also gives `onRequestClose`, which is what makes the Android back button
 * dismiss rather than leave a half-filled dispute on screen.
 */

import { useCallback, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { ChipPicker, Pill, type ChipOption } from '@/components/controls';
import { Button, useTheme } from '@/components/form';
import type { DisputeReason, QuestionSource } from '@/lib/mcq-types';

/**
 * The three reasons, in the order she is most likely to need them.
 *
 * Labels are what she would say, not what the column stores: nobody thinks
 * "outdated", they think "this changed". The hints matter more than usual
 * because choosing wrongly sends the question for the wrong kind of review.
 */
const REASONS: readonly ChipOption<DisputeReason>[] = [
  { value: 'wrong_key', label: 'Answer key is wrong' },
  { value: 'ambiguous', label: 'More than one answer fits' },
  { value: 'outdated', label: 'Out of date' },
];

const REASON_HINT: Record<DisputeReason, string> = {
  wrong_key: 'The option marked correct is not the right one.',
  ambiguous: 'Two options are defensible, or none of them is clearly right.',
  outdated: 'It was right once — a scheme, a figure or a law has changed since.',
};

/** Free text is optional and stays short; this is a flag, not a bug report. */
const NOTE_LIMIT = 280;

/**
 * The tap target on the reveal. Renders nothing before it.
 *
 * Deliberately quiet — a bordered text button rather than anything alarming.
 * Disputing should feel like a normal thing to do, since the alternative is
 * that she doubts a key, says nothing, and quietly stops trusting the bank.
 */
export function DisputeTrigger({
  revealed,
  disputed = false,
  onPress,
}: {
  revealed: boolean;
  /** Already disputed — the sheet has done its job and must not reopen. */
  disputed?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  if (!revealed) return null;

  if (disputed) {
    return (
      <View style={styles.triggerRow}>
        <Pill text="Reported — withdrawn from your score" tone="warn" />
      </View>
    );
  }

  return (
    <View style={styles.triggerRow}>
      <TouchableOpacity
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="This looks wrong. Report a problem with this question."
        accessibilityHint="Stops this question being asked again and removes it from this set's score."
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={[styles.trigger, { borderColor: theme.backgroundSelected }]}
      >
        <Text style={[styles.triggerText, { color: theme.textSecondary }]}>This looks wrong</Text>
      </TouchableOpacity>
    </View>
  );
}

export function McqDisputeSheet({
  visible,
  revealed,
  source,
  pyqYear = null,
  submitting = false,
  error = null,
  onDismiss,
  onSubmit,
}: {
  visible: boolean;
  /** The reveal gate, again. A sheet that opened early would defeat the trigger. */
  revealed: boolean;
  /** Provenance, and it belongs on screen — see below. */
  source: QuestionSource;
  pyqYear?: number | null;
  submitting?: boolean;
  error?: string | null;
  onDismiss: () => void;
  onSubmit: (reason: DisputeReason, note: string | null) => void;
}) {
  const theme = useTheme();
  const [reason, setReason] = useState<DisputeReason | null>(null);
  const [note, setNote] = useState('');

  // Reset where the transition happens, not in an effect watching for it.
  const dismiss = useCallback(() => {
    setReason(null);
    setNote('');
    onDismiss();
  }, [onDismiss]);

  const submit = useCallback(() => {
    if (!reason || submitting) return;
    const trimmed = note.trim();
    onSubmit(reason, trimmed === '' ? null : trimmed);
    setReason(null);
    setNote('');
  }, [reason, note, submitting, onSubmit]);

  return (
    <Modal
      visible={visible && revealed}
      transparent
      animationType="slide"
      // The Android back button. Without this it dismisses the whole screen
      // and leaves a half-filled dispute behind.
      onRequestClose={dismiss}
      accessibilityViewIsModal
    >
      <View style={styles.backdropWrap}>
        <Pressable
          style={styles.backdrop}
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel="Close without reporting"
        />
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <View style={[styles.grabber, { backgroundColor: theme.backgroundSelected }]} />

          <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
            <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
              What looks wrong?
            </Text>

            {/*
              Provenance, stated before she chooses. A past paper's key is
              UPSC's and a generated key is a model's; she is entitled to
              weight them differently, and saying which is which is what makes
              this a reasonable thing to tap rather than an accusation.
            */}
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              {source === 'pyq'
                ? `This is a past paper question${pyqYear ? ` from ${pyqYear}` : ''}, so the key is UPSC's own. Worth a second look before you report it — but report it if it still looks wrong.`
                : 'This question was generated, so its key has not been checked by anyone. If it looks wrong it probably is.'}
            </Text>

            <ChipPicker
              label="Reason"
              options={REASONS}
              selected={reason}
              onSelect={setReason}
            />

            {reason ? (
              <Text style={[styles.body, { color: theme.textSecondary }]}>
                {REASON_HINT[reason]}
              </Text>
            ) : null}

            <NoteField value={note} onChangeText={setNote} />

            <Text style={[styles.body, { color: theme.textSecondary }]}>
              Reporting it takes it out of your deck straight away, removes it from this set&apos;s
              score, and cancels the re-drill. Nothing is sent anywhere — this works offline.
            </Text>

            {error ? (
              <Text style={[styles.body, { color: theme.text }]}>Could not report it: {error}</Text>
            ) : null}

            <Button
              title={submitting ? 'Reporting…' : 'Report this question'}
              onPress={submit}
              disabled={!reason || submitting}
            />

            <TouchableOpacity
              onPress={dismiss}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              style={styles.cancel}
            >
              <Text style={[styles.cancelText, { color: theme.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The optional note.
 *
 * Its own component only because `MultilineField` lives in `controls.tsx`,
 * another agent's file, and this one wants a shorter box and a different
 * placeholder. Not worth widening a shared control for.
 */
function NoteField({
  value,
  onChangeText,
}: {
  value: string;
  onChangeText: (next: string) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.noteWrap}>
      <Text style={[styles.label, { color: theme.text }]}>Anything to add? (optional)</Text>
      <Text style={[styles.hint, { color: theme.textSecondary }]}>
        Only if it is quick. The reason above is enough on its own.
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="e.g. option B is also correct after the 2023 amendment"
        placeholderTextColor={theme.textSecondary}
        multiline
        textAlignVertical="top"
        maxLength={NOTE_LIMIT}
        accessibilityLabel="Anything to add"
        style={[styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  triggerRow: { flexDirection: 'row', marginTop: 14 },
  trigger: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    // 44pt is the iOS HIG floor, and this is tapped one-handed on a train.
    minHeight: 44,
    justifyContent: 'center',
  },
  triggerText: { fontSize: 14, fontWeight: '600' },

  backdropWrap: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '88%',
    paddingTop: 10,
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 8,
  },
  sheetBody: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 36 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 10 },
  body: { fontSize: 13, lineHeight: 20, marginBottom: 14 },

  noteWrap: { gap: 6, marginBottom: 18 },
  label: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 17 },
  input: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 88,
  },

  cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  cancelText: { fontSize: 15, fontWeight: '600' },
});
