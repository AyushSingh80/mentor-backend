/**
 * The interview question bank.
 *
 * ## Flagged questions are at the top, not hidden
 *
 * The question she flinched at is the one to prepare. An app that let her bury
 * it would be helping her avoid the interview rather than prepare for it, which
 * is a comfortable feature and a bad one.
 *
 * ## Three states, and the middle one is the point
 *
 * Notes made is not the same as being able to say it out loud under a board's
 * gaze, and an interview is entirely the second thing. A single "prepared" flag
 * would let her mark the bank done on the strength of having read about it.
 */

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

import { Card, ChipPicker, MultilineField, Pill } from '@/components/controls';
import { useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { readQuestions, saveNotes, setFlagged, setPrep } from '@/db/daf';
import { questionOrder, readinessByArea, readyShare, summariseReadiness } from '@/lib/daf';
import {
  PREP_LABELS,
  PREP_STATES,
  type InterviewQuestion,
  type PrepState,
} from '@/lib/daf-types';

const PREP_OPTIONS = PREP_STATES.map((state) => ({ value: state, label: PREP_LABELS[state] }));

export default function QuestionBank() {
  const theme = useTheme();
  const isMounted = useIsMounted();

  const [questions, setQuestions] = useState<InterviewQuestion[] | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(
    (isActive: () => boolean) =>
      readQuestions()
        .then((rows) => {
          if (!isActive()) return;
          setQuestions(rows);
          setDrafts(Object.fromEntries(rows.map((row) => [row.id, row.notes ?? ''])));
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

  const commitNotes = useCallback(
    (id: number) => {
      void saveNotes(id, drafts[id] ?? '')
        .then(() => load(isMounted))
        .catch(() => undefined);
    },
    [drafts, isMounted, load],
  );

  const changePrep = useCallback(
    (id: number, prep: PrepState) => {
      void setPrep(id, prep)
        .then(() => load(isMounted))
        .catch(() => undefined);
    },
    [isMounted, load],
  );

  const toggleFlag = useCallback(
    (question: InterviewQuestion) => {
      void setFlagged(question.id, !question.flagged)
        .then(() => load(isMounted))
        .catch(() => undefined);
    },
    [isMounted, load],
  );

  if (loadError !== null) {
    return (
      <ScrollView style={{ backgroundColor: theme.background }} contentContainerStyle={styles.container}>
        <Card>
          <Text style={[styles.body, { color: theme.textSecondary }]}>{loadError}</Text>
        </Card>
      </ScrollView>
    );
  }

  if (questions === null) {
    return (
      <View style={[styles.centre, { backgroundColor: theme.background }]}>
        <ActivityIndicator />
      </View>
    );
  }

  const ordered = questionOrder(questions);
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
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          Question bank
        </Text>

        {questions.length === 0 ? (
          <Card>
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              Nothing yet. Fill in a few DAF fields and generate — the questions follow from what
              you have written, and only from what you have written.
            </Text>
          </Card>
        ) : (
          <>
            <Card>
              <Text style={[styles.cardTitle, { color: theme.text }]}>
                {readiness.ready} of {readiness.areas} areas ready
              </Text>
              {areas.slice(0, 5).map((area) => (
                <View key={area.area} style={styles.areaRow}>
                  <Text numberOfLines={1} style={[styles.areaName, { color: theme.text }]}>
                    {area.area}
                  </Text>
                  <Pill
                    text={area.likelihood}
                    tone={area.likelihood === 'certain' ? 'bad' : 'neutral'}
                  />
                  <Text style={[styles.areaScore, { color: theme.textSecondary }]}>
                    {Math.round(readyShare(area) * 100)}%
                  </Text>
                </View>
              ))}
            </Card>

            {ordered.map((question) => {
              const expanded = open === question.id;
              return (
                <Card key={question.id}>
                  <TouchableOpacity
                    onPress={() => setOpen(expanded ? null : question.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`${expanded ? 'Collapse' : 'Open'}: ${question.question}`}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <View style={styles.headRow}>
                      <Pill text={question.area} tone="neutral" />
                      {question.flagged && <Pill text="flagged" tone="bad" />}
                      <Pill
                        text={PREP_LABELS[question.prep]}
                        tone={question.prep === 'rehearsed' ? 'good' : 'neutral'}
                      />
                    </View>
                    <Text style={[styles.question, { color: theme.text }]}>
                      {question.question}
                    </Text>
                  </TouchableOpacity>

                  {expanded && (
                    <>
                      <ChipPicker
                        label="Where you are with it"
                        options={PREP_OPTIONS}
                        selected={question.prep}
                        onSelect={(value) => changePrep(question.id, value as PrepState)}
                      />
                      <MultilineField
                        label="Your answer"
                        hint="Yours alone — nothing generates this. Write the position you would actually take, not a paragraph you would recite."
                        value={drafts[question.id] ?? ''}
                        onChangeText={(value) =>
                          setDrafts((current) => ({ ...current, [question.id]: value }))
                        }
                        minHeight={110}
                      />
                      <View style={styles.actions}>
                        <TouchableOpacity
                          onPress={() => commitNotes(question.id)}
                          accessibilityRole="button"
                          accessibilityLabel="Save your answer"
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={styles.tap}
                        >
                          <Text style={[styles.link, { color: theme.text }]}>Save</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => toggleFlag(question)}
                          accessibilityRole="button"
                          accessibilityLabel={
                            question.flagged
                              ? 'Remove the flag from this question'
                              : 'Flag this as one you do not want to be asked'
                          }
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={styles.tap}
                        >
                          <Text style={[styles.link, { color: theme.textSecondary }]}>
                            {question.flagged ? 'Unflag' : 'I do not want this one'}
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </Card>
              );
            })}
          </>
        )}

        <View style={{ height: 64 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 30, fontWeight: '700', marginBottom: 16 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 13, lineHeight: 19 },
  question: { fontSize: 15, lineHeight: 22, marginTop: 8 },
  headRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  areaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  areaName: { fontSize: 13, flex: 1 },
  areaScore: { fontSize: 13, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 20, alignItems: 'center' },
  tap: { minHeight: 44, justifyContent: 'center' },
  link: { fontSize: 15, fontWeight: '600' },
});
