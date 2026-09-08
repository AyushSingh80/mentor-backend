/**
 * History — the score trend, the answer log, and the offline queue.
 *
 * Everything here is a view over local SQLite, so it renders in full with no
 * network. The only thing that needs a server is the retry button.
 *
 * Reactivity: `enableChangeListener` is on, so drizzle's `useLiveQuery` gives
 * a change signal for free. It cannot wrap `listAnswers()` / `scoreTrend()` /
 * `listPending()` directly — it takes a drizzle query builder, and those are
 * repository functions issuing several queries each and doing work in JS. So
 * it is used for exactly what it can do: a cheap live select over the two
 * tables an evaluation writes, whose `updatedAt` then drives a reload of the
 * repository functions. The effect uses promise chains and a `cancelled` flag
 * (as `(tabs)/index.tsx` does) because `react-hooks/set-state-in-effect` is an
 * error in this repo and nothing may setState synchronously in an effect body.
 *
 * Net effect: finish an evaluation on the New Answer screen, come back here,
 * and the row has already moved out of the pending queue with its score filled
 * in. No pull-to-refresh required — though there is one anyway, because a
 * change listener is a convenience and a stuck screen is not acceptable.
 */

import { useRouter } from 'expo-router';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Card, ChipPicker, Pill, type ChipOption, type PillTone } from '@/components/controls';
import { useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { ScoreTrend } from '@/components/score-trend';
import { db } from '@/db';
import {
  PAPERS,
  listAnswers,
  scoreTrend,
  weakestDimensions,
  type AnswerSummary,
  type DimensionAverage,
  type PaperValue,
  type TrendPoint,
} from '@/db/answers';
import { answers, evaluations } from '@/db/schema';
import type { EvaluationPhase, PendingItem } from '@/lib/evaluation';
import { listPending, retryAnswer } from '@/lib/queue';

type PaperFilter = PaperValue | 'all';

const FILTER_OPTIONS: readonly ChipOption<PaperFilter>[] = [
  { value: 'all', label: 'All' },
  ...PAPERS.map((paper) => ({ value: paper.value as PaperFilter, label: paper.label })),
];

const STATUS_TONE: Record<string, PillTone> = {
  pending: 'warn',
  queued: 'neutral',
  failed: 'bad',
  evaluated: 'good',
};

const PHASE_LABEL: Record<EvaluationPhase, string> = {
  idle: 'Waiting',
  saving: 'Saving',
  uploading: 'Uploading files',
  streaming: 'Evaluating',
  scoring: 'Scoring',
  saved: 'Saved',
  failed: 'Failed',
  offline: 'Still offline — stays queued',
};

/** Phases during which the retry button must stay disabled. */
const ACTIVE_PHASES: readonly EvaluationPhase[] = ['saving', 'uploading', 'streaming', 'scoring'];

interface RetryState {
  phase: EvaluationPhase;
  error: string | null;
}

function paperLabel(paper: string): string {
  return PAPERS.find((p) => p.value === paper)?.label ?? paper;
}

/** Collapses the newlines a pasted question carries so a row stays two tidy lines. */
function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export default function History() {
  const theme = useTheme();
  const isMounted = useIsMounted();
  const router = useRouter();

  const [filter, setFilter] = useState<PaperFilter>('all');
  const [rows, setRows] = useState<AnswerSummary[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [weakest, setWeakest] = useState<DimensionAverage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retries, setRetries] = useState<Record<number, RetryState>>({});

  // Change signals. Both tables matter: a capture inserts into `answers`, and
  // `saveEvaluation` writes `evaluations` and flips `answers.syncStatus` in one
  // transaction. Selecting one narrow column keeps the listener query cheap.
  const answersChangedAt = useLiveQuery(
    db.select({ id: answers.id, syncStatus: answers.syncStatus }).from(answers),
  ).updatedAt?.getTime();
  const evaluationsChangedAt = useLiveQuery(
    db.select({ id: evaluations.id }).from(evaluations),
  ).updatedAt?.getTime();

  const load = useCallback((isActive: () => boolean) => {
    // The four reads are independent and deliberately not awaited in sequence:
    // the answer log must render even if the queue read or the dimension
    // aggregate fails, and only the log's failure is worth a visible error.
    listAnswers(200)
      .then((next) => {
        if (!isActive()) return;
        setRows(next);
        setLoadError(null);
      })
      .catch((err: Error) => {
        if (isActive()) setLoadError(err.message);
      })
      .finally(() => {
        if (isActive()) setLoaded(true);
      });

    // `scoreTrend()` owns the raw-score-to-percentage conversion; the paper
    // filter is applied to its output rather than re-queried, so tapping a chip
    // is instant and there is still exactly one place that divides by `max`.
    scoreTrend()
      .then((next) => {
        if (isActive()) setTrend(next);
      })
      .catch(() => undefined);

    listPending()
      .then((next) => {
        if (isActive()) setPending(next);
      })
      .catch(() => undefined);

    weakestDimensions()
      .then((next) => {
        if (isActive()) setWeakest(next);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, answersChangedAt, evaluationsChangedAt]);

  const visibleRows = useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => r.answer.paper === filter)),
    [rows, filter],
  );
  const visibleTrend = useMemo(
    () => (filter === 'all' ? trend : trend.filter((p) => p.paper === filter)),
    [trend, filter],
  );

  const retry = useCallback((answerId: number) => {
    setRetries((current) => ({ ...current, [answerId]: { phase: 'saving', error: null } }));

    // `onPhase` preserves any error already recorded, because `queue.ts` emits
    // `onPhase('failed')` immediately before `onFailed` and the reason must
    // survive that ordering.
    retryAnswer(answerId, {
      onPhase: (phase) =>
        setRetries((current) => ({
          ...current,
          [answerId]: { phase, error: current[answerId]?.error ?? null },
        })),
      onFailed: (reason) =>
        setRetries((current) => ({ ...current, [answerId]: { phase: 'failed', error: reason } })),
      onDone: () =>
        setRetries((current) => ({ ...current, [answerId]: { phase: 'saved', error: null } })),
      // `retryAnswer` contracts never to reject, but an unhandled rejection in
      // React Native is a red box over the whole screen. Belt and braces.
    }).catch((err: Error) =>
      setRetries((current) => ({
        ...current,
        [answerId]: { phase: 'failed', error: err.message },
      })),
    );
  }, []);

  const isEmpty = loaded && rows.length === 0 && pending.length === 0;

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load(isMounted);
            // The reads are local SQLite; the spinner exists to acknowledge the
            // gesture, not to time the query.
            setTimeout(() => setRefreshing(false), 350);
          }}
        />
      }
    >
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        History
      </Text>

      {loadError ? (
        <Card>
          <Text style={{ color: theme.text }}>Could not read your answers: {loadError}</Text>
        </Card>
      ) : null}

      <Card title="Score trend">
        <ChipPicker
          label="Paper"
          hint="Scores are normalised to a percentage, so papers with different maxima sit on one axis."
          options={FILTER_OPTIONS}
          selected={filter}
          onSelect={setFilter}
        />
        <ScoreTrend
          points={visibleTrend}
          {...(filter === 'all' ? {} : { paper: filter })}
        />
      </Card>

      {weakest.length > 0 ? (
        <Card title="What keeps costing you marks">
          {weakest.slice(0, 3).map((dimension) => (
            <View key={dimension.name} style={styles.weakRow}>
              <Text style={[styles.weakName, { color: theme.text }]} numberOfLines={2}>
                {dimension.name}
              </Text>
              <Text style={[styles.weakValue, { color: theme.textSecondary }]}>
                {Math.round(dimension.averagePercent)}% over {dimension.count}
              </Text>
            </View>
          ))}
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            Weakest rubric dimensions across your recent evaluations, averaged as percentages.
          </Text>
        </Card>
      ) : null}

      {pending.length > 0 ? (
        <Card title={`Waiting to be evaluated (${pending.length})`}>
          <Text style={[styles.note, { color: theme.textSecondary, marginTop: 0 }]}>
            Captured and saved on this device. Nothing here is lost — retry when you have signal.
          </Text>
          {pending.map((item) => (
            <PendingRow
              key={item.answerId}
              item={item}
              state={retries[item.answerId]}
              theme={theme}
              onRetry={() => retry(item.answerId)}
              onOpen={() => router.push(`/answer/${item.answerId}`)}
            />
          ))}
        </Card>
      ) : null}

      <Card title={filter === 'all' ? 'All answers' : `${paperLabel(filter)} answers`}>
        {!loaded ? (
          <View style={styles.loading}>
            <ActivityIndicator />
          </View>
        ) : isEmpty ? (
          <>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>Nothing here yet</Text>
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              Write an answer by hand, photograph the sheets, and submit it from the New answer
              tab. It saves locally first, so you can capture on a commute with no signal and
              evaluate later. Scores plot here as percentages of each paper&apos;s own maximum.
            </Text>
          </>
        ) : visibleRows.length === 0 ? (
          <Text style={{ color: theme.textSecondary }}>
            No answers for {paperLabel(filter)} yet.
          </Text>
        ) : (
          visibleRows.map((row) => (
            <AnswerRow
              key={row.answer.id}
              summary={row}
              theme={theme}
              onPress={() => router.push(`/answer/${row.answer.id}`)}
            />
          ))
        )}
      </Card>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- fragments */

type Theme = ReturnType<typeof useTheme>;

function AnswerRow({
  summary,
  theme,
  onPress,
}: {
  summary: AnswerSummary;
  theme: Theme;
  onPress: () => void;
}) {
  const { answer, percent } = summary;
  const date = answer.createdAt.slice(0, 10);
  const label = paperLabel(answer.paper);
  const text = snippet(answer.questionText);

  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        percent === null
          ? `${label}, ${date}, ${answer.syncStatus}. ${text}`
          : `${label}, ${date}, ${Math.round(percent)} percent. ${text}`
      }
      style={styles.row}
    >
      <View style={styles.rowBody}>
        <Text style={[styles.rowMeta, { color: theme.textSecondary }]}>
          {date} · {label}
        </Text>
        <Text style={[styles.rowText, { color: theme.text }]} numberOfLines={2}>
          {text}
        </Text>
      </View>
      <View style={styles.rowTrailing}>
        {percent === null ? (
          <Pill text={answer.syncStatus} tone={STATUS_TONE[answer.syncStatus] ?? 'neutral'} />
        ) : (
          <Text style={[styles.rowScore, { color: theme.text }]}>{Math.round(percent)}%</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

/**
 * One queued answer, with its own retry button, progress and error.
 *
 * Per-row rather than a single global "retry all": failures here are usually
 * specific to one answer (a page deleted from the cache, a paper the app no
 * longer recognises) and a shared error line would attribute them to the wrong
 * row.
 */
function PendingRow({
  item,
  state,
  theme,
  onRetry,
  onOpen,
}: {
  item: PendingItem;
  state: RetryState | undefined;
  theme: Theme;
  onRetry: () => void;
  onOpen: () => void;
}) {
  const busy = state !== undefined && ACTIVE_PHASES.includes(state.phase);

  return (
    <View style={styles.pendingRow}>
      <TouchableOpacity
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Open ${paperLabel(item.paper)} answer from ${item.createdAt.slice(0, 10)}`}
        style={styles.rowBody}
      >
        <Text style={[styles.rowMeta, { color: theme.textSecondary }]}>
          {item.createdAt.slice(0, 10)} · {paperLabel(item.paper)} · {item.pageCount}{' '}
          {item.pageCount === 1 ? 'file' : 'files'}
        </Text>
        <Text style={[styles.rowText, { color: theme.text }]} numberOfLines={2}>
          {snippet(item.questionText)}
        </Text>

        {state ? (
          <View style={styles.progressRow}>
            {busy ? <ActivityIndicator size="small" /> : null}
            <Text style={[styles.progressText, { color: theme.textSecondary }]}>
              {PHASE_LABEL[state.phase]}
            </Text>
          </View>
        ) : (
          <View style={styles.progressRow}>
            <Pill text={item.syncStatus} tone={STATUS_TONE[item.syncStatus] ?? 'neutral'} />
          </View>
        )}

        {state?.error ? (
          <Text style={[styles.errorText, { color: theme.text }]}>{state.error}</Text>
        ) : null}
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onRetry}
        disabled={busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        accessibilityLabel={`Retry evaluation for the ${paperLabel(item.paper)} answer from ${item.createdAt.slice(0, 10)}`}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={[
          styles.retryButton,
          { backgroundColor: theme.backgroundSelected, opacity: busy ? 0.4 : 1 },
        ]}
      >
        <Text style={[styles.retryText, { color: theme.text }]}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  h1: { fontSize: 32, fontWeight: '700', marginBottom: 20 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  loading: { paddingVertical: 20, alignItems: 'center' },
  emptyTitle: { fontSize: 15, fontWeight: '600' },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  rowBody: { flex: 1, gap: 2 },
  rowMeta: { fontSize: 12 },
  rowText: { fontSize: 14, lineHeight: 20 },
  rowTrailing: { minWidth: 58, alignItems: 'flex-end' },
  rowScore: { fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },

  pendingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 11 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5 },
  progressText: { fontSize: 12 },
  errorText: { fontSize: 12, lineHeight: 18, marginTop: 6, fontWeight: '500' },
  retryButton: { borderRadius: 9, paddingHorizontal: 14, paddingVertical: 8, marginTop: 2 },
  retryText: { fontSize: 13, fontWeight: '700' },

  weakRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 4,
  },
  // `flex: 1` and two lines, because this card's whole job is naming the
  // dimension. On one line "Structure and directive compliance" truncated to
  // "Structure and directive complian…", losing the word that carries the
  // diagnosis. `flexShrink` alone left the value free to squeeze it further.
  weakName: { fontSize: 14, flex: 1 },
  weakValue: { fontSize: 13, fontVariant: ['tabular-nums'], flexShrink: 0 },
});
