/**
 * Progress — the weekly-audit surface: what is covered, what is behind, and
 * what to do about it this week.
 *
 * Everything here is a view over local SQLite, so it renders in full with no
 * network. Three reads run independently on purpose: the coverage card must
 * still render when the lecture table fails, and the required-rate figure —
 * the earliest warning on this screen — comes from the profile alone and must
 * survive both.
 *
 * ## Why required-vs-actual sits at the top
 *
 * The growth alert needs three weeks of history before it can honestly say
 * anything. `gsCourseTotalRuntimeMin / daysToTarget` needs none: it is a
 * required content-minutes-per-day that exists the moment onboarding is
 * finished. Comparing it against the observed rate warns in week one instead of
 * week three, which is the difference between a course that can still be
 * rescued and one that cannot.
 *
 * ## Reactivity
 *
 * `enableChangeListener` is on, so `useLiveQuery` gives a change signal for
 * free. It cannot wrap `lectureFacts()` / `topicFacts()` directly — it takes a
 * drizzle query builder and those are repository functions — so it is used for
 * what it can do: a cheap live select over the two tables logging writes to,
 * whose `updatedAt` then drives a reload. The effect uses promise chains and a
 * `cancelled` flag (as `(tabs)/history.tsx` does) because
 * `react-hooks/set-state-in-effect` is an error in this repo and nothing may
 * setState synchronously in an effect body.
 */

import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useRouter } from 'expo-router';
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

import { BacklogCard } from '@/components/backlog-card';
import { McqCalibrationCard } from '@/components/mcq-calibration-card';
import type { Calibration } from '@/lib/mcq-score';
import { BacklogTrend } from '@/components/backlog-trend';
import { Card, ChipPicker, Pill, type ChipOption, type PillTone } from '@/components/controls';
import { CoverageCard } from '@/components/coverage-card';
import { useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { db } from '@/db';
import { lectureFacts } from '@/db/lectures';
import { lifetimeCalibration } from '@/db/mcq-stats';
import { derivePlan, getProfile, type ProfileRow } from '@/db/profile';
import { lectures, syllabusTopics } from '@/db/schema';
import { topicFacts } from '@/db/syllabus';
import {
  evaluateBacklogAlert,
  summariseBacklog,
  type BacklogAlert,
  type BacklogSummary,
  type CourseId,
  type LectureFact,
} from '@/lib/backlog';
import { planCatchUp, type CatchUpPlan } from '@/lib/catchup';
import { COURSES, type PaperValue } from '@/lib/papers';
import { coverageByPaper, projectFirstPass, type Coverage, type MilestoneProjection } from '@/lib/syllabus-coverage';
import { localDate } from '@/lib/time';

type Scope = CourseId | 'all';

const SCOPE_OPTIONS: readonly ChipOption<Scope>[] = [
  { value: 'all', label: 'Both courses' },
  ...COURSES.map((course) => ({ value: course.value as Scope, label: course.label })),
];

const SCOPE_LABEL: Record<Scope, string> = {
  all: 'All courses',
  gs: 'General Studies',
  anthro: 'Anthropology',
};

interface ScopeView {
  scope: Scope;
  summary: BacklogSummary;
  alert: BacklogAlert;
  plan: CatchUpPlan;
}

interface BacklogView {
  today: string;
  targetIso: string;
  scopes: Record<Scope, ScopeView>;
  /** From the catalogue total and the days left. Available on day one. */
  requiredContentMinPerDay: number | null;
  actualContentMinPerDay: number;
  sampleDays: number;
  catalogueContentMin: number | null;
  daysToTarget: number;
  weeklyCapacityHours: number;
}

interface CoverageView {
  coverage: Coverage[];
  projection: MilestoneProjection;
}

/** Whole days between two `YYYY-MM-DD` dates, parsed at UTC so no offset shifts them. */
function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

/** Content minutes -> "12h 20m". Hours of content, never a lecture count. */
function hoursLabel(contentMin: number): string {
  const total = Math.max(0, Math.round(contentMin));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** The day the weekly audit lands on — the first day she is not at work. */
function auditDayOfWeek(workDays: number[]): number {
  return [0, 1, 2, 3, 4, 5, 6].find((day) => !workDays.includes(day)) ?? 0;
}

/**
 * Every backlog number on the screen, computed once from one read of the
 * lecture table so the three scopes cannot disagree with each other.
 *
 * The catalogue total is passed only to the General Studies scope: it is the
 * only course whose full runtime onboarding captures, and attaching it to the
 * combined scope would quietly understate the required rate by the size of the
 * anthropology syllabus.
 */
function buildBacklogView(row: ProfileRow, facts: LectureFact[]): BacklogView {
  const derived = derivePlan(row);
  const today = localDate(row.timezone);
  const targetIso = row.targetFirstPassDate;
  const auditDay = auditDayOfWeek(derived.schedule.workDays);
  const catalogueContentMin = row.gsCourseTotalRuntimeMin;

  const build = (scope: Scope): ScopeView => {
    const courseOpt = scope === 'all' ? {} : { course: scope };
    const summary = summariseBacklog(facts, {
      asOf: today,
      targetIso,
      catalogueContentMin: scope === 'gs' ? catalogueContentMin : null,
      ...courseOpt,
    });

    return {
      scope,
      summary,
      alert: evaluateBacklogAlert(facts, { asOf: today, auditDayOfWeek: auditDay, ...courseOpt }),
      plan: planCatchUp({
        summary,
        blocks: derived.blocks,
        workDays: derived.schedule.workDays,
        // The ASSUMED speed. This looks forward at hours not yet spent, unlike
        // the observed throughput inside `summary.rate`.
        playbackSpeed: row.defaultPlaybackSpeed,
        targetIso,
        asOf: today,
      }),
    };
  };

  const gs = build('gs');
  const daysToTarget = Math.max(1, daysBetween(today, targetIso));

  return {
    today,
    targetIso,
    scopes: { all: build('all'), gs, anthro: build('anthro') },
    // Prefer the figure the backlog module already derived; fall back to the
    // profile arithmetic so the number still exists before a single lecture
    // has been logged, which is the whole point of it.
    requiredContentMinPerDay:
      gs.summary.requiredContentMinPerDay ??
      (catalogueContentMin === null ? null : catalogueContentMin / daysToTarget),
    actualContentMinPerDay: gs.summary.rate.contentMinPerDay,
    sampleDays: gs.summary.rate.sampleDays,
    catalogueContentMin,
    daysToTarget,
    weeklyCapacityHours: derived.capacity.totalWeeklyHours,
  };
}

export default function Progress() {
  const theme = useTheme();
  const isMounted = useIsMounted();
  const router = useRouter();

  const [row, setRow] = useState<ProfileRow | null>(null);
  const [backlog, setBacklog] = useState<BacklogView | null>(null);
  const [coverage, setCoverage] = useState<CoverageView | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [backlogError, setBacklogError] = useState<string | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [scope, setScope] = useState<Scope>('all');
  const [calibration, setCalibration] = useState<Calibration | null>(null);

  // Change signals. Logging a lecture or moving a topic must be visible here
  // without a pull-to-refresh; selecting one narrow column keeps them cheap.
  const lecturesChangedAt = useLiveQuery(
    db.select({ id: lectures.id, watchedOn: lectures.watchedOn }).from(lectures),
  ).updatedAt?.getTime();
  const topicsChangedAt = useLiveQuery(
    db.select({ id: syllabusTopics.id, status: syllabusTopics.status }).from(syllabusTopics),
  ).updatedAt?.getTime();

  const load = useCallback((isActive: () => boolean) => {
    // One profile read shared by all three chains. Every chain catches for
    // itself, so a rejection is handled three times rather than escaping as an
    // unhandled rejection — which in React Native is a red box over the screen.
    const profile = getProfile();

    profile
      .then((profileRow) => {
        if (!isActive()) return;
        setRow(profileRow);
        setProfileError(null);
      })
      .catch((err: Error) => {
        if (isActive()) setProfileError(err.message);
      })
      .finally(() => {
        if (isActive()) setLoaded(true);
      });

    // Guess calibration. Independent of the other three: a drill history read
    // failing must not blank the backlog or the coverage figures.
    lifetimeCalibration()
      .then((next) => {
        if (isActive()) setCalibration(next);
      })
      .catch(() => undefined);

    // Backlog needs both reads. A failure here must not blank the coverage card.
    Promise.all([profile, lectureFacts()])
      .then(([profileRow, facts]) => {
        if (!isActive()) return;
        setBacklog(profileRow ? buildBacklogView(profileRow, facts) : null);
        setBacklogError(null);
      })
      .catch((err: Error) => {
        if (isActive()) setBacklogError(err.message);
      });

    Promise.all([profile, topicFacts()])
      .then(([profileRow, facts]) => {
        if (!isActive() || !profileRow) return;
        const asOf = localDate(profileRow.timezone);
        setCoverage({
          coverage: coverageByPaper(facts),
          projection: projectFirstPass(facts, {
            asOf,
            targetIso: profileRow.targetFirstPassDate,
          }),
        });
        setCoverageError(null);
      })
      .catch((err: Error) => {
        if (isActive()) setCoverageError(err.message);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, lecturesChangedAt, topicsChangedAt]);

  const view = backlog ? backlog.scopes[scope] : null;
  const rateVerdict = useMemo(() => (backlog ? judgeRate(backlog) : null), [backlog]);

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
            // The reads are local SQLite; the spinner acknowledges the gesture,
            // it does not time the query.
            setTimeout(() => setRefreshing(false), 350);
          }}
        />
      }
    >
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        Progress
      </Text>

      {!loaded ? (
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      ) : null}

      {profileError ? (
        <Card>
          <Text style={{ color: theme.text }}>Could not read your profile: {profileError}</Text>
        </Card>
      ) : null}

      {loaded && !row && !profileError ? (
        <Card title="Finish setting up first">
          <Text style={[styles.note, { color: theme.textSecondary, marginTop: 0 }]}>
            Progress is built from your shift, your wake time and your course totals. Complete
            onboarding and every figure on this screen appears.
          </Text>
        </Card>
      ) : null}

      {/* The earliest warning available, so it goes first. */}
      {backlog && rateVerdict ? (
        <Card title="Required rate vs your rate">
          <View style={styles.rateRow}>
            <RateFigure
              label="Required"
              value={
                backlog.requiredContentMinPerDay === null
                  ? '—'
                  : `${Math.round(backlog.requiredContentMinPerDay)}`
              }
              unit="content-min / day"
              theme={theme}
            />
            <RateFigure
              label="Yours"
              value={`${Math.round(backlog.actualContentMinPerDay)}`}
              unit={`over ${backlog.sampleDays} ${backlog.sampleDays === 1 ? 'day' : 'days'}`}
              theme={theme}
            />
            <View style={styles.rateVerdict}>
              <Pill text={rateVerdict.label} tone={rateVerdict.tone} />
            </View>
          </View>

          <Text style={[styles.note, { color: theme.textSecondary }]}>{rateVerdict.detail}</Text>

          <Text style={[styles.note, { color: theme.textSecondary }]}>
            {backlog.catalogueContentMin === null
              ? 'Add your General Studies course total in onboarding and the required rate appears immediately — it needs no history at all.'
              : `${Math.round(backlog.catalogueContentMin / 60)} hours of General Studies lectures, ` +
                `${backlog.daysToTarget} days to ${backlog.targetIso}. Your schedule gives you about ` +
                `${backlog.weeklyCapacityHours} study hours a week in total.`}
          </Text>
        </Card>
      ) : null}

      {backlogError ? (
        <Card>
          <Text style={{ color: theme.text }}>Could not read your lectures: {backlogError}</Text>
        </Card>
      ) : null}

      {backlog && view ? (
        <>
          <Card title="Lecture backlog over time">
            <ChipPicker
              label="Course"
              hint="Backlog is hours of released-but-unwatched content, at 1× runtime."
              options={SCOPE_OPTIONS}
              selected={scope}
              onSelect={setScope}
            />

            {/* Both courses, always visible. A combined figure can look calm
                while one course quietly rots; showing them side by side means
                the chip selection cannot hide a problem. */}
            <View style={styles.glanceRow}>
              {COURSES.map((course) => {
                const each = backlog.scopes[course.value];
                return (
                  <View key={course.value} style={styles.glance}>
                    <Text style={[styles.glanceLabel, { color: theme.textSecondary }]}>
                      {course.label}
                    </Text>
                    <View style={styles.glanceValueRow}>
                      <Text style={[styles.glanceValue, { color: theme.text }]}>
                        {hoursLabel(each.summary.backlogContentMin)}
                      </Text>
                      {each.alert.fired ? <Pill text="behind" tone="bad" /> : null}
                    </View>
                  </View>
                );
              })}
            </View>

            <BacklogTrend series={view.summary.series} label={SCOPE_LABEL[scope]} />
          </Card>

          {/* The plan is attached only when the alert has actually fired.
              A catch-up plan under a healthy backlog is noise, and noise is
              how a dashboard teaches you to stop reading it. */}
          <BacklogCard
            summary={view.summary}
            alert={view.alert}
            plan={view.alert.fired ? view.plan : null}
            onLogLecture={() => router.push('/lecture/log')}
          />
        </>
      ) : null}

      {coverageError ? (
        <Card>
          <Text style={{ color: theme.text }}>Could not read your syllabus: {coverageError}</Text>
        </Card>
      ) : null}

      {coverage ? (
        <CoverageCard
          coverage={coverage.coverage}
          projection={coverage.projection}
          onOpenPaper={(paper: PaperValue) => router.push(`/syllabus/${paper}`)}
        />
      ) : null}

      {/* Only once there is enough history to say anything. Rendering a guess
          verdict off four attempts would be a number she could act on and
          should not — the card itself refuses to show buckets when its own
          instrument is untrustworthy, and this is the same rule one level up. */}
      {calibration && calibration.total > 0 ? (
        <McqCalibrationCard calibration={calibration} />
      ) : null}

      <Card title="Go deeper">
        <LinkRow
          title="Score history"
          detail="The score trend, your answer log and anything still queued for evaluation."
          onPress={() => router.push('/history')}
          theme={theme}
        />
        <LinkRow
          title="Syllabus"
          detail="Every topic, its status and your confidence, paper by paper."
          onPress={() => router.push('/syllabus')}
          theme={theme}
        />
        <LinkRow
          title="Keeping it up"
          detail="How consistent you have actually been, anything that looks like strain, and your reminders."
          onPress={() => router.push('/steady')}
          theme={theme}
        />
        <LinkRow
          title="Interview profile"
          detail="Your DAF, and the questions a board would ask from it. Worth opening now — hobbies and your current job are decided long before the form is due."
          onPress={() => router.push('/interview')}
          theme={theme}
        />
      </Card>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- fragments */

type Theme = ReturnType<typeof useTheme>;

/**
 * The one comparison that works in week one.
 *
 * Deliberately refuses to render a verdict from a rate measured over nothing:
 * "you are 40 minutes a day behind" computed from a zero-day sample is a
 * fabrication, and the required figure alone is still worth showing.
 */
function judgeRate(view: BacklogView): { label: string; tone: PillTone; detail: string } {
  const required = view.requiredContentMinPerDay;

  if (required === null) {
    return {
      label: 'not set',
      tone: 'neutral',
      detail:
        'Without a course total there is nothing to compare your rate against, so the first ' +
        'warning would have to wait for three weeks of history.',
    };
  }

  const rounded = Math.round(required);

  if (view.sampleDays === 0) {
    const hoursPerWeek = Math.round((required * 7) / 6) / 10;
    return {
      label: 'no history',
      tone: 'neutral',
      detail:
        `You need ${rounded} content-minutes a day — about ${hoursPerWeek} hours a week — to ` +
        `finish the General Studies course by ${view.targetIso}. Log a few lectures and your own ` +
        `rate appears beside it.`,
    };
  }

  const gap = view.actualContentMinPerDay - required;
  if (gap >= 0) {
    return {
      label: 'on pace',
      tone: 'good',
      detail:
        `You are clearing ${Math.round(gap)} content-minutes a day more than the ${rounded} ` +
        `needed to finish by ${view.targetIso}. Measured over ${view.sampleDays} ` +
        `${view.sampleDays === 1 ? 'day' : 'days'}, so it is a reading, not a promise.`,
    };
  }

  const shortfall = Math.round(-gap);
  return {
    label: `${shortfall} min/day short`,
    tone: shortfall > required / 2 ? 'bad' : 'warn',
    detail:
      `Finishing General Studies by ${view.targetIso} needs ${rounded} content-minutes a day. ` +
      `You are averaging ${Math.round(view.actualContentMinPerDay)} over ${view.sampleDays} ` +
      `${view.sampleDays === 1 ? 'day' : 'days'} — ${shortfall} short. That gap costs about ` +
      `${Math.round((shortfall * view.daysToTarget) / 60)} hours between now and then.`,
  };
}

function RateFigure({
  label,
  value,
  unit,
  theme,
}: {
  label: string;
  value: string;
  unit: string;
  theme: Theme;
}) {
  return (
    <View style={styles.rateFigure}>
      <Text style={[styles.rateLabel, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.rateValue, { color: theme.text }]}>{value}</Text>
      <Text style={[styles.rateUnit, { color: theme.textSecondary }]}>{unit}</Text>
    </View>
  );
}

function LinkRow({
  title,
  detail,
  onPress,
  theme,
}: {
  title: string;
  detail: string;
  onPress: () => void;
  theme: Theme;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={`${title}. ${detail}`}
      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      style={styles.linkRow}
    >
      <View style={styles.linkBody}>
        <Text style={[styles.linkTitle, { color: theme.text }]}>{title}</Text>
        <Text style={[styles.linkDetail, { color: theme.textSecondary }]}>{detail}</Text>
      </View>
      <Text style={[styles.linkChevron, { color: theme.textSecondary }]}>›</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  h1: { fontSize: 32, fontWeight: '700', marginBottom: 20 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  loading: { paddingVertical: 20, alignItems: 'center' },

  rateRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rateFigure: { flex: 1 },
  rateLabel: { fontSize: 11, fontWeight: '600' },
  rateValue: { fontSize: 26, fontWeight: '700', fontVariant: ['tabular-nums'], marginTop: 2 },
  rateUnit: { fontSize: 11, lineHeight: 15, marginTop: 2 },
  rateVerdict: { paddingTop: 14 },

  glanceRow: { flexDirection: 'row', gap: 16, marginBottom: 14 },
  glance: { flex: 1, gap: 3 },
  glanceLabel: { fontSize: 11, fontWeight: '600' },
  glanceValueRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  glanceValue: { fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },

  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  linkBody: { flex: 1, gap: 2 },
  linkTitle: { fontSize: 15, fontWeight: '600' },
  linkDetail: { fontSize: 12, lineHeight: 17 },
  linkChevron: { fontSize: 22, lineHeight: 24 },
});
