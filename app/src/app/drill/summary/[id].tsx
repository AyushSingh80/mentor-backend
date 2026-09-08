/**
 * The end of a drill, in marks.
 *
 * Ordered by what changes the next drill, not by what is easiest to render.
 *
 * 1. **Net marks, not a percentage.** Prelims is marked negatively: 25 right
 *    and 75 wrong out of 100 is worth exactly zero, and a "25% correct" headline
 *    would have called that a bad-but-real score rather than the nothing it is.
 *    The comparable figure — marks per 100 questions — sits under it, for the
 *    same reason `db/answers.ts` compares answers as percentages rather than raw
 *    totals: a 10-question drill and a 25-question set cannot share an axis
 *    otherwise.
 *
 * 2. **The two counterfactuals**, in her own marks from her own rows. "Guess
 *    only when you have eliminated something" is a rule she has already read;
 *    what her guesses cost her this morning is not.
 *
 * 3. **Calibration**, lifetime rather than this session — one commute cannot
 *    reach the sample the guess check needs, and a guess rate computed from
 *    three rows is not a rate.
 *
 * 4. The marks trend, last.
 *
 * Route params are strings from a URL and can be anything: a deep link, a stale
 * bookmark, a typo. Guarded digits-only exactly as `answer/[id].tsx` does, and
 * anything else is "not found" rather than a thrown NaN query.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Card, Pill, Row } from '@/components/controls';
import { useTheme } from '@/components/form';
import { McqCalibrationCard } from '@/components/mcq-calibration-card';
import { McqScoreCard } from '@/components/mcq-score-card';
import { db } from '@/db';
import { getSessionSummary, type SessionSummary } from '@/db/mcq-stats';
import { mcqAttempts } from '@/db/schema';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { formatSignedMarks, type NetMarksPoint } from '@/lib/mcq-score';

type LoadState = 'loading' | 'ready' | 'notFound' | 'error';

/** Anything that is not a positive integer is "not found", never a NaN query. */
function parseSessionId(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-07` -> `7 Sep`. Kept off `Date` so a timezone cannot shift the day. */
function shortDate(iso: string): string {
  const [, month, day] = iso.split('-');
  const monthIndex = Number(month) - 1;
  if (!day || monthIndex < 0 || monthIndex > 11) return iso;
  return `${Number(day)} ${MONTHS[monthIndex]}`;
}

export default function DrillSummary() {
  const theme = useTheme();
  const router = useRouter();
  const isMounted = useIsMounted();
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionId = useMemo(() => parseSessionId(id), [id]);

  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [state, setState] = useState<LoadState>(sessionId === null ? 'notFound' : 'loading');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Re-reads when attempts land. The runtime agent writes the last answer and
  // the session's `completed` status as the drill finishes, and this screen is
  // pushed at the same moment; without this it can render the session one
  // attempt short of the truth and never correct itself.
  const attemptsChangedAt = useLiveQuery(
    db.select({ id: mcqAttempts.id }).from(mcqAttempts),
  ).updatedAt?.getTime();

  // Promise chain plus a `cancelled` flag rather than an awaited helper:
  // `react-hooks/set-state-in-effect` is an error in this repo, and nothing
  // here may setState synchronously from the effect body.
  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;

    getSessionSummary(sessionId)
      .then((next) => {
        if (cancelled) return;
        setSummary(next);
        setState(next === null ? 'notFound' : 'ready');
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setErrorText(err.message);
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, attemptsChangedAt]);

  // Not an effect, so it needs the mounted check rather than a closure flag:
  // this route really does unmount on back navigation, and a pull-to-refresh
  // left in flight would otherwise setState after that.
  const refresh = useCallback(() => {
    if (sessionId === null) return;
    setRefreshing(true);
    getSessionSummary(sessionId)
      .then((next) => {
        if (isMounted() && next !== null) setSummary(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (isMounted()) setRefreshing(false);
      });
  }, [sessionId, isMounted]);

  const back = (
    <TouchableOpacity
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/progress'))}
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Text style={[styles.back, { color: theme.textSecondary }]}>‹ Back</Text>
    </TouchableOpacity>
  );

  if (state === 'notFound' || state === 'error') {
    return (
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.container}
      >
        {back}
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          {state === 'error' ? 'Could not open this drill' : 'Drill not found'}
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          {state === 'error'
            ? (errorText ?? 'The database read failed.')
            : sessionId === null
              ? `“${id ?? ''}” is not a valid drill id. It may be a stale link.`
              : `Drill ${sessionId} is not in your local database. It may have been deleted.`}
        </Text>
      </ScrollView>
    );
  }

  if (state === 'loading' || summary === null) {
    return (
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.container}
      >
        {back}
        <Text style={{ color: theme.textSecondary }}>Loading…</Text>
      </ScrollView>
    );
  }

  const { score, lifetime, trend } = summary;

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      {back}

      <View style={styles.titleRow}>
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          Drill summary
        </Text>
        {score.scoreable ? null : <Pill text={score.status} tone="warn" />}
      </View>
      <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>
        {shortDate(score.studyDate)} · {score.mode} · {score.seen} of {score.plannedCount} questions
      </Text>

      <McqScoreCard score={score} />

      <McqCalibrationCard calibration={lifetime} />

      <NetMarksTrendCard points={trend} currentSessionId={score.sessionId} />

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- fragments */

/** How many sessions the strip shows. Beyond this the bars stop being readable. */
const TREND_WINDOW = 8;

/**
 * The marks trend, drawn with plain `View`s and deliberately NOT reusing
 * `lib/trend.ts`.
 *
 * That module clamps its axis to 0–100 because it only ever plots percentages;
 * marks per 100 questions runs from −66.7 to +200 and goes NEGATIVE, which is
 * the single most important thing this chart can show. Feeding it through a
 * 0–100 clamp would flatten every losing session against the floor and still
 * look like a plausible chart. Its own header says as much.
 *
 * Bars are zero-centred: right of the line is marks gained, left is marks lost.
 */
function NetMarksTrendCard({
  points,
  currentSessionId,
}: {
  points: NetMarksPoint[];
  currentSessionId: number;
}) {
  const theme = useTheme();
  const window_ = points.slice(-TREND_WINDOW);

  if (window_.length === 0) {
    return (
      <Card title="Marks trend">
        <Text style={{ color: theme.textSecondary }}>
          No finished drills yet. Abandoned sessions stay out of this line on purpose — an
          interrupted commute is not a low score, and letting it in would make the trend a measure
          of your train.
        </Text>
      </Card>
    );
  }

  const scale = Math.max(...window_.map((p) => Math.abs(p.netPer100)), 1);
  const mean = window_.reduce((total, p) => total + p.netPer100, 0) / window_.length;

  return (
    <Card title="Marks trend">
      <Text style={[styles.note, { color: theme.textSecondary, marginTop: 0 }]}>
        Marks per 100 questions, so a 10-question drill and a 25-question set sit on one axis.
        Finished sessions only.
      </Text>

      <View style={styles.trend}>
        {window_.map((point) => {
          const magnitude = (Math.abs(point.netPer100) / scale) * 50;
          const positive = point.netPer100 >= 0;
          return (
            <View
              key={point.sessionId}
              style={styles.trendRow}
              accessible
              accessibilityLabel={`${shortDate(point.date)}, ${Math.round(point.netPer100)} marks per 100 questions over ${point.counted} questions`}
            >
              <Text style={[styles.trendDate, { color: theme.textSecondary }]}>
                {shortDate(point.date)}
              </Text>
              <View style={[styles.trendTrack, { backgroundColor: theme.backgroundSelected }]}>
                <View style={[styles.trendAxis, { backgroundColor: theme.textSecondary }]} />
                <View
                  style={[
                    styles.trendBar,
                    {
                      backgroundColor: theme.text,
                      opacity: point.sessionId === currentSessionId ? 1 : 0.45,
                      width: `${magnitude}%`,
                      left: positive ? '50%' : `${50 - magnitude}%`,
                    },
                  ]}
                />
              </View>
              <Text style={[styles.trendValue, { color: theme.text }]}>
                {Math.round(point.netPer100)}
              </Text>
            </View>
          );
        })}
      </View>

      <Row label="Average over these" value={`${formatSignedMarks(mean)} per 100`} />
      <Text style={[styles.note, { color: theme.textSecondary }]}>
        The real paper is 100 questions for 200 marks, so this number is on the same scale as the
        one that decides the cut-off.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64 },
  back: { fontSize: 15, paddingVertical: 6, marginBottom: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  h1: { fontSize: 30, fontWeight: '700', flexShrink: 1 },
  eyebrow: { fontSize: 13, marginTop: 2, marginBottom: 18 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 8 },

  trend: { gap: 8, marginTop: 12, marginBottom: 8 },
  trendRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  trendDate: { fontSize: 11, width: 46 },
  trendTrack: { flex: 1, height: 14, borderRadius: 4, overflow: 'hidden' },
  trendAxis: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, opacity: 0.6 },
  trendBar: { position: 'absolute', top: 3, height: 8, borderRadius: 2 },
  trendValue: { fontSize: 12, fontWeight: '600', width: 34, textAlign: 'right', fontVariant: ['tabular-nums'] },
});
