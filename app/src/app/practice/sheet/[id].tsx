/**
 * The mark sheet.
 *
 * ## Per part, not one number
 *
 * The whole reason Phase 5 exists. "16 out of 20" on an ethics case says
 * something went wrong; "options 2/5, decision 4/4" says the alternatives were
 * straw men and the decision was fine, which is a thing she can act on
 * tomorrow. The header total is there because the paper has one, but the rows
 * are the feature.
 *
 * ## An unmarked attempt is a first-class state
 *
 * `saved_unmarked` means her writing is on disk and the network was not. It is
 * shown as what it is — finished work awaiting a mark — with a retry, rather
 * than as an error over the top of twenty minutes of writing.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Card, Pill } from '@/components/controls';
import { useTheme } from '@/components/form';
import { Markdown } from '@/components/markdown';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { readDrill } from '@/db/drills';
import { PART_PROMPTS, type DrillFacts } from '@/lib/drill-types';
import { retryEvaluation } from '@/lib/drill-run';
import { targetMinutes } from '@/lib/drills';

export default function MarkSheet() {
  const theme = useTheme();
  const router = useRouter();
  const isMounted = useIsMounted();
  const { id } = useLocalSearchParams<{ id: string }>();
  const drillId = Number(id);

  const [drill, setDrill] = useState<DrillFacts | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (isActive: () => boolean) =>
      readDrill(drillId)
        .then((row) => {
          if (!isActive()) return;
          if (row === null) setLoadError('That drill is not on this device.');
          else setDrill(row);
        })
        .catch((err: Error) => {
          if (isActive()) setLoadError(err.message);
        }),
    [drillId],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const retry = useCallback(() => {
    if (drill === null) return;
    setBusy(true);
    setNote(null);
    retryEvaluation(drill)
      .then((outcome) => {
        if (!isMounted()) return;
        setNote(outcome.reason);
        return load(isMounted);
      })
      .catch((err: Error) => {
        if (isMounted()) setNote(err.message);
      })
      .finally(() => {
        if (isMounted()) setBusy(false);
      });
  }, [drill, isMounted, load]);

  if (loadError !== null) {
    return (
      <ScrollView style={{ backgroundColor: theme.background }} contentContainerStyle={styles.container}>
        <Card>
          <Text style={[styles.cardTitle, { color: theme.text }]}>Could not open this sheet</Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>{loadError}</Text>
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

  const marked = drill.status === 'evaluated' && drill.total !== null && drill.max !== null;
  const overTime =
    drill.minutesSpent !== null && drill.minutesSpent > targetMinutes(drill.kind) * 1.5;

  return (
    <ScrollView style={{ backgroundColor: theme.background }} contentContainerStyle={styles.container}>
      <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>
        {drill.kind === 'essay_outline' ? 'Essay outline' : 'Ethics case'}
        {drill.minutesSpent !== null ? ` · ${drill.minutesSpent} min` : ''}
      </Text>
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        {drill.promptText}
      </Text>

      {marked ? (
        <Card>
          <View style={styles.headRow}>
            <Text style={[styles.total, { color: theme.text }]}>
              {drill.total} <Text style={styles.outOf}>/ {drill.max}</Text>
            </Text>
            {overTime && (
              <Pill text={`over ${targetMinutes(drill.kind)} min`} tone="neutral" />
            )}
          </View>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>
            An outline is not an essay and this is not an essay mark. It scores the parts you can
            decide in {targetMinutes(drill.kind)} minutes.
          </Text>
        </Card>
      ) : (
        <Card>
          <Text style={[styles.cardTitle, { color: theme.text }]}>Saved, not yet marked</Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            Your writing is on this device and nothing is lost. The marking needs a connection.
          </Text>
          <TouchableOpacity
            onPress={retry}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            accessibilityLabel="Mark this attempt now"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.tap}
          >
            {busy ? (
              <ActivityIndicator size="small" color={theme.textSecondary} />
            ) : (
              <Text style={[styles.link, { color: theme.text }]}>Mark it now →</Text>
            )}
          </TouchableOpacity>
        </Card>
      )}

      {note !== null && (
        <Card>
          <Text style={[styles.body, { color: theme.textSecondary }]}>{note}</Text>
        </Card>
      )}

      {drill.parts.map((part) => {
        const score = drill.scores.find((entry) => entry.part === part.part) ?? null;
        return (
          <Card key={part.part}>
            <View style={styles.headRow}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>
                {part.part[0]!.toUpperCase() + part.part.slice(1)}
              </Text>
              {score !== null && (
                <Text style={[styles.partScore, { color: theme.text }]}>
                  {score.score}/{score.max}
                </Text>
              )}
            </View>

            <Text style={[styles.written, { color: theme.text }]}>{part.content}</Text>

            {score?.comment ? (
              <View style={[styles.comment, { borderLeftColor: theme.textSecondary }]}>
                <Text style={[styles.body, { color: theme.textSecondary }]}>{score.comment}</Text>
              </View>
            ) : (
              <Text style={[styles.hint, { color: theme.textSecondary }]}>
                {PART_PROMPTS[part.part]}
              </Text>
            )}
          </Card>
        );
      })}

      {drill.feedbackMd !== null && drill.feedbackMd.trim() !== '' && (
        <Card>
          <Text style={[styles.cardTitle, { color: theme.text }]}>Feedback</Text>
          <Markdown source={drill.feedbackMd} theme={theme} />
        </Card>
      )}

      <TouchableOpacity
        onPress={() => router.replace('/practice')}
        accessibilityRole="button"
        accessibilityLabel="Back to practice"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={styles.tap}
      >
        <Text style={[styles.link, { color: theme.text }]}>← Practice</Text>
      </TouchableOpacity>
      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { fontSize: 13, marginBottom: 2 },
  h1: { fontSize: 22, fontWeight: '700', lineHeight: 30, marginBottom: 16 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 13, lineHeight: 19 },
  hint: { fontSize: 12, lineHeight: 17 },
  written: { fontSize: 14, lineHeight: 21, marginTop: 4 },
  total: { fontSize: 34, fontWeight: '700', fontVariant: ['tabular-nums'] },
  outOf: { fontSize: 18, fontWeight: '600' },
  partScore: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  comment: { borderLeftWidth: 2, paddingLeft: 10, marginTop: 8 },
  tap: { minHeight: 44, justifyContent: 'center' },
  link: { fontSize: 15, fontWeight: '600' },
});
