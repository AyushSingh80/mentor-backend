/**
 * Writing one drill.
 *
 * ## Everything is saved as she types
 *
 * Every part is upserted on blur and on a debounce. The block is 8:00–10:00 and
 * the phone is a phone: a call, a low-battery kill or a rotation must not cost
 * her twenty minutes. `drill_parts` is keyed on `(drill_id, part)` precisely so
 * autosave can be called as often as it likes.
 *
 * ## The dimension counter is local and instant
 *
 * Multi-dimensional coverage is 25% of the essay rubric and the one dimension a
 * machine can check without judgement — a lens is either labelled or it is not.
 * Spending a paid model call to be told "you did not name the environmental
 * angle" would be absurd, and waiting for signal to be told it is worse: the
 * moment that feedback is useful is while she is still looking at the outline.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Card, MultilineField, Pill } from '@/components/controls';
import { useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { readDrill, saveDrillPart, siblingTopicIds, startDrill } from '@/db/drills';
import { readMaterial } from '@/db/material';
import {
  DRILL_RULES,
  PARTS_OF_KIND,
  PART_PROMPTS,
  type DrillFacts,
  type DrillPart,
} from '@/lib/drill-types';
import { submitAndEvaluate } from '@/lib/drill-run';
import { checkSubmittable, namedDimensions, openDimensions, targetMinutes, wordCount } from '@/lib/drills';
import { suggestMaterial, type MaterialSuggestion } from '@/lib/material';

/** Autosave delay. Long enough not to write on every keystroke, short enough
 *  that a kill costs a sentence rather than a paragraph. */
const AUTOSAVE_MS = 1200;

export default function DrillWriter() {
  const theme = useTheme();
  const router = useRouter();
  const isMounted = useIsMounted();
  const { id } = useLocalSearchParams<{ id: string }>();
  const drillId = Number(id);

  const [drill, setDrill] = useState<DrillFacts | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState<MaterialSuggestion[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitNote, setSubmitNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A ref, not state: the timer must survive a re-render without restarting,
  // and writing it to state would re-render on every keystroke.
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    let cancelled = false;
    // Derived below rather than set here: `react-hooks/set-state-in-effect` is
    // an ERROR in this repo, and a bad route param is a fact about the props
    // rather than an event worth storing.
    if (!Number.isInteger(drillId)) return;

    readDrill(drillId)
      .then(async (row) => {
        if (cancelled || row === null) {
          if (!cancelled) setLoadError('That drill is not on this device.');
          return;
        }
        // Idempotent: resuming must not reset the clock.
        await startDrill(row.id);

        // RE-READ, and it is not redundant. `startDrill` writes `startedAt` to
        // the database, but `row` was read before that and still carries the
        // `null` it had while banked. Holding the stale copy made
        // `elapsedMinutes(kind, null, now)` return null at submit — so
        // `minutesSpent` was never recorded on any drill, and the one number
        // that says whether she is getting faster silently stayed empty. Found
        // by reading the row back off a device after a 17-minute attempt.
        //
        // A resume reads the ORIGINAL instant here, which is what keeps the
        // clock from restarting when she reopens a half-written outline.
        const started = await readDrill(row.id);
        const [material, siblings] = await Promise.all([
          readMaterial(),
          siblingTopicIds(row.syllabusTopicId),
        ]);
        if (cancelled) return;

        setDrill(started ?? row);
        setDrafts(Object.fromEntries(row.parts.map((part) => [part.part, part.content])));
        setSuggestions(
          suggestMaterial(material, {
            syllabusTopicId: row.syllabusTopicId,
            siblingTopicIds: siblings,
          }),
        );
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [drillId]);

  // Flush any pending autosave on unmount, so leaving the screen mid-sentence
  // does not lose the sentence.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of Object.values(pending)) clearTimeout(timer);
    };
  }, []);

  const onChange = useCallback(
    (part: DrillPart, value: string) => {
      setDrafts((current) => ({ ...current, [part]: value }));
      if (drill === null) return;

      clearTimeout(timers.current[part]);
      timers.current[part] = setTimeout(() => {
        void saveDrillPart(drill.id, part, value, drill.kind).catch(() => undefined);
      }, AUTOSAVE_MS);
    },
    [drill],
  );

  const parts = useMemo(
    () =>
      drill === null
        ? []
        : PARTS_OF_KIND[drill.kind].map((part) => ({
            part,
            content: drafts[part] ?? '',
            words: wordCount(drafts[part] ?? ''),
          })),
    [drill, drafts],
  );

  const check = useMemo(
    () => (drill === null ? null : checkSubmittable(drill.kind, parts)),
    [drill, parts],
  );

  const submit = useCallback(() => {
    if (drill === null || check === null || !check.ready) return;
    setBusy(true);
    setSubmitNote(null);

    // Flush every pending autosave before the network call, or the last
    // sentence she typed would not be in the payload.
    Promise.all(
      parts.map((part) => saveDrillPart(drill.id, part.part, part.content, drill.kind)),
    )
      .then(() =>
        submitAndEvaluate({
          drill: { ...drill, parts },
          suggestedMaterialIds: suggestions.map((entry) => entry.material.id),
        }),
      )
      .then((outcome) => {
        if (!isMounted()) return;
        if (outcome.status === 'blocked') {
          setSubmitNote(outcome.reason);
          return;
        }
        router.replace(`/practice/sheet/${drill.id}`);
      })
      .catch((err: Error) => {
        if (isMounted()) setSubmitNote(err.message);
      })
      .finally(() => {
        if (isMounted()) setBusy(false);
      });
  }, [check, drill, isMounted, parts, router, suggestions]);

  const problem = Number.isInteger(drillId) ? loadError : 'That drill id is not a number.';

  if (problem !== null) {
    return (
      <ScrollView style={{ backgroundColor: theme.background }} contentContainerStyle={styles.container}>
        <Card>
          <Text style={[styles.cardTitle, { color: theme.text }]}>Could not open this drill</Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>{problem}</Text>
        </Card>
      </ScrollView>
    );
  }

  if (drill === null) {
    return (
      <View style={[styles.centre, { backgroundColor: theme.background }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const dimensionsDraft = drafts.dimensions ?? '';
  const named = drill.kind === 'essay_outline' ? namedDimensions(dimensionsDraft) : [];
  const open = drill.kind === 'essay_outline' ? openDimensions(dimensionsDraft) : [];

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.background }}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>
          {drill.kind === 'essay_outline' ? 'Essay outline' : 'Ethics case'} ·{' '}
          {targetMinutes(drill.kind)} min
        </Text>
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          {drill.promptText}
        </Text>

        {drill.caseDetail !== null && (
          <Card>
            <Text style={[styles.caseDetail, { color: theme.text }]}>{drill.caseDetail}</Text>
          </Card>
        )}

        {suggestions.length > 0 && (
          <Card>
            <Text style={[styles.cardTitle, { color: theme.text }]}>From your bank</Text>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>
              Offered, not required. A quote that does not do work in the argument costs more than
              it gains.
            </Text>
            {suggestions.map((entry) => (
              <View key={entry.material.id} style={styles.suggestion}>
                <Text style={[styles.body, { color: theme.text }]}>{entry.material.content}</Text>
                <Text style={[styles.hint, { color: theme.textSecondary }]}>
                  {entry.material.attribution ?? 'unattributed'} · {entry.reason}
                </Text>
              </View>
            ))}
          </Card>
        )}

        {parts.map((part) => {
          const problem = check?.parts.find((entry) => entry.part === part.part) ?? null;
          return (
            <View key={part.part}>
              <MultilineField
                label={part.part[0]!.toUpperCase() + part.part.slice(1)}
                hint={PART_PROMPTS[part.part]}
                value={part.content}
                onChangeText={(value) => onChange(part.part, value)}
                minHeight={part.part === 'dimensions' || part.part === 'options' ? 150 : 110}
              />
              <View style={styles.metaRow}>
                <Text style={[styles.hint, { color: theme.textSecondary }]}>
                  {part.words} / {DRILL_RULES.maxPartWords} words
                </Text>
                {problem?.problem !== null && problem !== null && (
                  <Text style={[styles.hint, { color: theme.textSecondary }]}>
                    {problem.detail}
                  </Text>
                )}
              </View>

              {part.part === 'dimensions' && (
                <View style={styles.lensRow}>
                  <Pill
                    text={`${named.length} of 7 lenses`}
                    tone={named.length >= DRILL_RULES.minDimensions ? 'good' : 'neutral'}
                  />
                  {open.length > 0 && (
                    <Text style={[styles.hint, { color: theme.textSecondary }]}>
                      Open: {open.join(', ')}
                    </Text>
                  )}
                </View>
              )}
            </View>
          );
        })}

        {submitNote !== null && (
          <Card>
            <Text style={[styles.body, { color: theme.textSecondary }]}>{submitNote}</Text>
          </Card>
        )}

        <TouchableOpacity
          onPress={submit}
          disabled={busy || check?.ready !== true}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || check?.ready !== true }}
          accessibilityLabel={
            check?.ready === true ? 'Submit for marking' : `Not ready: ${check?.blocker ?? ''}`
          }
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={[
            styles.submit,
            {
              backgroundColor: check?.ready === true ? theme.text : theme.backgroundElement,
            },
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={theme.background} />
          ) : (
            <Text
              style={[
                styles.submitText,
                { color: check?.ready === true ? theme.background : theme.textSecondary },
              ]}
            >
              {check?.ready === true ? 'Submit for marking' : 'Not ready yet'}
            </Text>
          )}
        </TouchableOpacity>

        {check?.ready !== true && check?.blocker !== null && (
          <Text style={[styles.hint, { color: theme.textSecondary, textAlign: 'center' }]}>
            {check?.blocker}
          </Text>
        )}

        <View style={{ height: 64 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { fontSize: 13, marginBottom: 2 },
  h1: { fontSize: 24, fontWeight: '700', lineHeight: 32, marginBottom: 16 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 13, lineHeight: 19 },
  hint: { fontSize: 12, lineHeight: 17 },
  caseDetail: { fontSize: 14, lineHeight: 21 },
  suggestion: { gap: 2, marginTop: 8 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginBottom: 4 },
  lensRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  submit: { minHeight: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  submitText: { fontSize: 16, fontWeight: '700' },
});
