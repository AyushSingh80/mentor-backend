/**
 * The DAF and the interview question bank.
 *
 * ## Why this exists in 2026 and not in 2028
 *
 * The form is submitted with the Mains application, around August 2028, and the
 * Personality Test follows in early 2029. A form to fill in 2028 would be
 * useful for four months and dead for two years.
 *
 * What makes it worth opening now is that three of its fields are commitments
 * about things she must ALREADY have done — hobbies, sport, and the job she is
 * doing at this moment. Writing "reading" in July 2028 because there is nothing
 * better is a decision made under deadline about two years already spent. So
 * the screen leads with those, and says so.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Card, MultilineField, Pill } from '@/components/controls';
import { useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { bankedQuestionTexts, bankQuestions, readDaf, readQuestions, saveDafField } from '@/db/daf';
import { getProfile } from '@/db/profile';
import { generateQuestions } from '@/lib/daf-api';
import { buildQuestionsRequest, INTERVIEW_PROMPT_VERSION } from '@/lib/daf-request';
import {
  DAF_RULES,
  FIELD_LABELS,
  FIELD_RATIONALE,
  GROUP_LABELS,
  type DafField,
  type DafGroup,
  type InterviewQuestion,
} from '@/lib/daf-types';
import {
  describeForm,
  formState,
  monthsToDaf,
  readinessByArea,
  readyShare,
  summariseForm,
  summariseReadiness,
  type FieldState,
} from '@/lib/daf';
import { localDate } from '@/lib/time';

const GROUP_ORDER: DafGroup[] = ['interests', 'identity', 'education', 'record', 'service'];

export default function InterviewProfile() {
  const theme = useTheme();
  const router = useRouter();
  const isMounted = useIsMounted();

  const [fields, setFields] = useState<FieldState[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [months, setMonths] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    (isActive: () => boolean) =>
      Promise.all([readDaf(), readQuestions(), getProfile().catch(() => null)])
        .then(([entries, banked, profile]) => {
          if (!isActive()) return;
          const state = formState(entries);
          setFields(state);
          setDrafts(Object.fromEntries(state.map((entry) => [entry.field, entry.value])));
          setQuestions(banked);
          setMonths(
            monthsToDaf(
              localDate(profile?.timezone ?? 'Asia/Kolkata'),
              profile?.examYear ?? 2028,
            ),
          );
          setLoadError(null);
        })
        .catch((err: Error) => {
          if (isActive()) setLoadError(err.message);
        }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const commit = useCallback(
    (field: DafField, value: string) => {
      void saveDafField(field, value)
        .then(() => load(isMounted))
        .catch((err: Error) => {
          if (isMounted()) setNote(err.message);
        });
    },
    [isMounted, load],
  );

  const generate = useCallback(() => {
    setBusy(true);
    setNote(null);

    Promise.all([readDaf(), bankedQuestionTexts()])
      .then(([entries, banked]) =>
        generateQuestions(
          buildQuestionsRequest({
            requestId: `iv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            entries,
            bankedQuestions: banked,
          }),
        ),
      )
      .then(async (response) => {
        const written = await bankQuestions(
          response.questions.map((question) => ({
            field: question.field,
            area: question.area,
            question: question.question,
            likelihood: question.likelihood,
            batchId: response.batchId,
            promptVersion: response.promptVersion ?? INTERVIEW_PROMPT_VERSION,
          })),
        );
        if (!isMounted()) return;
        const dropped = response.summary.dropped;
        setNote(
          written === 0
            ? 'Nothing new — every question that came back was already in your bank.'
            : `${written} new question${written === 1 ? '' : 's'}${
                dropped > 0 ? `, ${dropped} discarded by the server's own checks` : ''
              }.`,
        );
        return load(isMounted);
      })
      .catch((err: Error) => {
        if (isMounted()) {
          setNote(
            (err as { status?: number }).status === 400
              ? 'Fill in at least one field first — there is nothing to generate questions from.'
              : err.message,
          );
        }
      })
      .finally(() => {
        if (isMounted()) setBusy(false);
      });
  }, [isMounted, load]);

  if (loadError !== null) {
    return (
      <ScrollView style={{ backgroundColor: theme.background }} contentContainerStyle={styles.container}>
        <Card>
          <Text style={[styles.cardTitle, { color: theme.text }]}>Could not read your form</Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>{loadError}</Text>
        </Card>
      </ScrollView>
    );
  }

  if (fields === null) {
    return (
      <View style={[styles.centre, { backgroundColor: theme.background }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const summary = summariseForm(fields);
  const advice = describeForm(summary, months);
  const areas = readinessByArea(questions);
  const readiness = summariseReadiness(areas, questions);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.background }}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load(isMounted).finally(() => {
                if (isMounted()) setRefreshing(false);
              });
            }}
          />
        }
      >
        <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>
          {months === null ? 'Personality Test' : `DAF in about ${months} months`}
        </Text>
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          Interview profile
        </Text>
        <Text style={[styles.lede, { color: theme.textSecondary }]}>
          Every line on the DAF is fair game for the board, which means the questions are knowable
          two years early. Fill this in slowly — most of it you will report, but hobbies, sport and
          the job you are doing right now are things you are deciding now whether you notice or not.
        </Text>

        {advice !== null && (
          <Card>
            <Text style={[styles.body, { color: theme.text }]}>{advice}</Text>
          </Card>
        )}

        <View style={styles.pillRow}>
          <Pill text={`${summary.filled}/${summary.total} filled`} tone="neutral" />
          {questions.length > 0 && (
            <Pill
              text={`${readiness.rehearsed}/${questions.length} said out loud`}
              tone={readiness.rehearsed > 0 ? 'good' : 'neutral'}
            />
          )}
          {readiness.flagged > 0 && <Pill text={`${readiness.flagged} flagged`} tone="bad" />}
        </View>

        {questions.length > 0 && (
          <Card>
            <Text style={[styles.cardTitle, { color: theme.text }]}>
              {readiness.areas} area{readiness.areas === 1 ? '' : 's'}, {readiness.ready} ready
            </Text>
            {readiness.weakest !== null && (
              <Text style={[styles.body, { color: theme.textSecondary }]}>
                Least ready of the likely ones: {readiness.weakest.area} —{' '}
                {Math.round(readyShare(readiness.weakest) * 100)}%.
              </Text>
            )}
            <TouchableOpacity
              onPress={() => router.push('/interview/questions')}
              accessibilityRole="button"
              accessibilityLabel="Open the interview question bank"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={styles.tap}
            >
              <Text style={[styles.link, { color: theme.text }]}>
                {questions.length} question{questions.length === 1 ? '' : 's'} →
              </Text>
            </TouchableOpacity>
          </Card>
        )}

        <TouchableOpacity
          onPress={generate}
          disabled={busy || summary.filled === 0}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || summary.filled === 0 }}
          accessibilityLabel={
            summary.filled === 0
              ? 'Fill in at least one field before generating questions'
              : 'Generate interview questions from your form'
          }
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={styles.tap}
        >
          {busy ? (
            <View style={styles.row}>
              <ActivityIndicator size="small" color={theme.textSecondary} />
              <Text style={[styles.link, { color: theme.textSecondary }]}> Generating…</Text>
            </View>
          ) : (
            <Text
              style={[styles.link, { color: summary.filled === 0 ? theme.textSecondary : theme.text }]}
            >
              Generate {DAF_RULES.batchSize} more questions
            </Text>
          )}
        </TouchableOpacity>

        {note !== null && (
          <Card>
            <Text style={[styles.body, { color: theme.textSecondary }]}>{note}</Text>
          </Card>
        )}

        {GROUP_ORDER.map((group) => {
          const inGroup = fields.filter((entry) => entry.group === group);
          if (inGroup.length === 0) return null;
          return (
            <View key={group}>
              <Text style={[styles.section, { color: theme.text }]}>{GROUP_LABELS[group]}</Text>
              {inGroup.map((entry) => (
                <View key={entry.field}>
                  <MultilineField
                    label={FIELD_LABELS[entry.field]}
                    hint={FIELD_RATIONALE[entry.field]}
                    value={drafts[entry.field] ?? ''}
                    onChangeText={(value) =>
                      setDrafts((current) => ({ ...current, [entry.field]: value }))
                    }
                    minHeight={72}
                    maxLength={DAF_RULES.maxValueChars}
                  />
                  <View style={styles.metaRow}>
                    {entry.decideEarly && (
                      <Pill text="decide early" tone={entry.empty || entry.thin ? 'bad' : 'good'} />
                    )}
                    {entry.thin && (
                      <Text style={[styles.hint, { color: theme.textSecondary }]}>
                        A board takes a one-word answer to its floor in about ninety seconds.
                      </Text>
                    )}
                    <TouchableOpacity
                      onPress={() => commit(entry.field, drafts[entry.field] ?? '')}
                      accessibilityRole="button"
                      accessibilityLabel={`Save ${FIELD_LABELS[entry.field]}`}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={styles.saveTap}
                    >
                      <Text style={[styles.hint, { color: theme.text }]}>Save</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          );
        })}

        <View style={{ height: 64 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { fontSize: 13, marginBottom: 2 },
  h1: { fontSize: 30, fontWeight: '700', marginBottom: 8 },
  lede: { fontSize: 14, lineHeight: 21, marginBottom: 16 },
  section: { fontSize: 13, fontWeight: '700', marginTop: 20, marginBottom: 8, opacity: 0.7 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 13, lineHeight: 19 },
  hint: { fontSize: 12, lineHeight: 17 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
  row: { flexDirection: 'row', alignItems: 'center' },
  tap: { minHeight: 44, justifyContent: 'center' },
  // `flexShrink: 0` so the control is never squeezed by the pill and the hint
  // beside it. Without it "Save" rendered as "Sav" on device — a shrunk `Text`
  // clips with no ellipsis, the same defect found on the Today screen's rows.
  saveTap: { minHeight: 44, justifyContent: 'center', marginLeft: 'auto', flexShrink: 0 },
  link: { fontSize: 15, fontWeight: '600' },
});
