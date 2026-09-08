/**
 * Backlog summary card.
 *
 * SKELETON: props are FROZEN. Body is owned by the dashboard agent.
 *
 * Rendered in two places, hence `compact`: full on Progress, condensed on
 * Today. Compact shows only backlog hours, days-to-clear and the alert — the
 * three things worth interrupting a morning for.
 *
 * Copy rules for whoever fills this in:
 * - Never say "pages" or imply lecture counts where hours are meant.
 * - Always show `rate.sampleDays` alongside days-to-clear. "12 days to clear,
 *   at your rate over the last 6 days" is honest; "12 days to clear" implies a
 *   confidence the sample does not support.
 * - `daysToClear === null` means nothing was watched in the window. Render
 *   "nothing watched in the last N days", never "∞" and never "0".
 */

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Card, Pill, type PillTone } from '@/components/controls';
import { useTheme } from '@/components/form';
import { describeBacklog, type BacklogAlert, type BacklogSummary } from '@/lib/backlog';
import type { CatchUpPlan, CatchUpTier } from '@/lib/catchup';

/** Content minutes -> "12h 20m". Hours, never a lecture count. */
function hours(contentMin: number): string {
  const total = Math.max(0, Math.round(contentMin));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Whole days only.
 *
 * `daysToClear` is `backlogContentMin / contentMinPerDay` and is an unrounded
 * float for almost every real input, so formatting it raw prints
 * "14.782608695652174 days to clear". Rounding UP rather than to nearest, to
 * match `lecture/log.tsx` and `catchup.ts`: a projection that says three days
 * when it means three and a half is a promise it cannot keep.
 */
function days(count: number): string {
  const whole = Math.max(0, Math.ceil(count));
  return `${whole} ${whole === 1 ? 'day' : 'days'}`;
}

/**
 * The sample the rate was actually measured over, spelled out every time.
 *
 * Six days of history divided by a fourteen-day window halves the rate and
 * doubles days-to-clear. Showing the sample beside the number is what stops
 * "12 days to clear" reading as a promise it cannot keep.
 */
function clearance(summary: BacklogSummary): string {
  const sample = days(summary.rate.sampleDays);

  if (summary.rate.sampleDays === 0) {
    return 'No history yet, so there is no rate to project from.';
  }
  // Never "∞", never "0" — both read as a number, and neither is true.
  if (summary.daysToClear === null) {
    return `Nothing watched in the last ${sample}, so there is no rate to clear it at.`;
  }
  return `${days(summary.daysToClear)} to clear, at your rate over the last ${sample}.`;
}

function alertSentence(alert: BacklogAlert): string | null {
  if (!alert.fired) return null;
  if (alert.reason === 'growing') {
    const weeks = alert.consecutiveGrowthWeeks;
    return (
      `Growing ${weeks} ${weeks === 1 ? 'week' : 'weeks'} running — ` +
      `${hours(alert.growthContentMin)} more than a fortnight ago.`
    );
  }
  return 'You are watching slower than the course is releasing.';
}

/** Why there is no alert yet. Silence with no explanation reads as "fine". */
const SUPPRESSION_NOTE: Record<NonNullable<BacklogAlert['suppressedBy']>, string> = {
  insufficient_history: 'Not enough history yet to call a trend either way.',
  single_release_date:
    'Every lecture shares one release date, so a trend here would just be the import.',
  backlog_too_small: 'Backlog is small enough that a trend would be noise.',
};

const TIER_TONE: Record<CatchUpTier, PillTone> = {
  within_cap: 'good',
  raise_speed: 'neutral',
  reallocate_reading: 'warn',
  must_drop: 'bad',
};

const TIER_LABEL: Record<CatchUpTier, string> = {
  within_cap: 'fits your week',
  raise_speed: 'needs more speed',
  reallocate_reading: 'needs reading time',
  must_drop: 'cannot be cleared',
};

export interface BacklogCardProps {
  summary: BacklogSummary;
  alert: BacklogAlert;
  plan: CatchUpPlan | null;
  compact?: boolean;
  onLogLecture?: () => void;
}

export function BacklogCard({
  summary,
  alert,
  plan,
  compact = false,
  onLogLecture,
}: BacklogCardProps): React.ReactElement | null {
  const theme = useTheme();

  const scope = summary.course === 'all' ? 'All courses' : summary.course === 'gs' ? 'General Studies' : 'Anthropology';
  const banner = alertSentence(alert);
  const cleared = summary.backlogContentMin <= 0;

  return (
    <Card title={compact ? 'Lecture backlog' : `Lecture backlog · ${scope}`}>
      {/* One focusable element for the figure and its caveat: a screen reader
          announcing "14h" and "at your rate over the last 6 days" as two
          unrelated fragments loses the caveat, which is the honest half. */}
      <View accessible accessibilityLabel={describeBacklog(summary)} style={styles.headline}>
        <Text style={[styles.value, { color: theme.text }]}>{hours(summary.backlogContentMin)}</Text>
        <Text style={[styles.valueMeta, { color: theme.textSecondary }]}>
          {cleared ? 'nothing outstanding' : 'of unwatched lectures'}
        </Text>
        {alert.fired ? <Pill text="behind" tone="bad" /> : null}
      </View>

      <Text style={[styles.line, { color: theme.textSecondary }]}>{clearance(summary)}</Text>

      {banner ? (
        <View style={[styles.banner, { backgroundColor: theme.backgroundSelected }]}>
          <Text style={[styles.bannerText, { color: theme.text }]}>{banner}</Text>
        </View>
      ) : null}

      {!compact ? (
        <>
          <View style={styles.grid}>
            <Figure label="Released" value={hours(summary.releasedContentMin)} theme={theme} />
            <Figure label="Watched" value={hours(summary.watchedContentMin)} theme={theme} />
            <Figure label="Skipped" value={hours(summary.skippedContentMin)} theme={theme} />
          </View>

          <Text style={[styles.line, { color: theme.textSecondary }]}>
            {summary.rate.contentMinPerDay > 0
              ? `Clearing ${Math.round(summary.rate.contentMinPerDay)} content-minutes a day over ` +
                `${days(summary.rate.sampleDays)}, which costs about ` +
                `${Math.round(summary.rate.wallClockMinPerDay)} minutes of your time` +
                `${summary.rate.observedSpeed === null ? '' : ` at ${summary.rate.observedSpeed.toFixed(2).replace(/0$/, '')}×`}.`
              : `Nothing cleared in the last ${days(summary.rate.sampleDays)}.`}
          </Text>

          {!alert.fired && alert.suppressedBy !== null ? (
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              {SUPPRESSION_NOTE[alert.suppressedBy]}
            </Text>
          ) : null}

          {plan && plan.steps.length > 0 ? <PlanBlock plan={plan} theme={theme} /> : null}
        </>
      ) : null}

      {onLogLecture ? (
        <TouchableOpacity
          onPress={onLogLecture}
          accessibilityRole="button"
          accessibilityLabel="Log a lecture"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={[styles.button, { backgroundColor: theme.backgroundSelected }]}
        >
          <Text style={[styles.buttonText, { color: theme.text }]}>Log a lecture</Text>
        </TouchableOpacity>
      ) : null}
    </Card>
  );
}

/* ---------------------------------------------------------------- fragments */

type Theme = ReturnType<typeof useTheme>;

function Figure({ label, value, theme }: { label: string; value: string; theme: Theme }) {
  return (
    <View style={styles.figure}>
      <Text style={[styles.figureValue, { color: theme.text }]}>{value}</Text>
      <Text style={[styles.figureLabel, { color: theme.textSecondary }]}>{label}</Text>
    </View>
  );
}

/**
 * The catch-up plan.
 *
 * Every figure here came out of `deriveStudyBlocks`, so the steps are sized
 * from hours she actually has. `must_drop` is printed as plainly as the rest:
 * a plan that cannot be met is worth more than an encouraging one that cannot.
 */
function PlanBlock({ plan, theme }: { plan: CatchUpPlan; theme: Theme }) {
  return (
    <View style={[styles.plan, { borderTopColor: theme.backgroundSelected }]}>
      <View style={styles.planHead}>
        <Text accessibilityRole="header" style={[styles.planTitle, { color: theme.text }]}>
          Catch-up plan
        </Text>
        <Pill text={TIER_LABEL[plan.tier]} tone={TIER_TONE[plan.tier]} />
      </View>

      <Text style={[styles.planHeadline, { color: theme.text }]}>{plan.headline}</Text>

      {plan.steps.map((step, index) => (
        <View key={step.text} style={styles.step}>
          <Text style={[styles.stepIndex, { color: theme.textSecondary }]}>{index + 1}</Text>
          <View style={styles.stepBody}>
            <Text style={[styles.stepText, { color: theme.text }]}>{step.text}</Text>
            {step.wallClockMinPerWeek > 0 || step.contentMinPerWeek > 0 ? (
              <Text style={[styles.stepMeta, { color: theme.textSecondary }]}>
                {step.wallClockMinPerWeek > 0
                  ? `${step.wallClockMinPerWeek} min of your week`
                  : 'no extra time'}
                {' · '}
                {step.contentMinPerWeek} content-minutes cleared
              </Text>
            ) : null}
          </View>
        </View>
      ))}

      <Text style={[styles.note, { color: theme.textSecondary }]}>
        {plan.clearsBy !== null && plan.weeksToClear !== null
          ? `Clear by ${plan.clearsBy} — ${plan.weeksToClear} ${plan.weeksToClear === 1 ? 'week' : 'weeks'}. ` +
            `Sized from your own schedule: ${plan.capacity.catchupWallClockMinPerWeek} min of ` +
            `catch-up and ${plan.capacity.lectureWallClockMinPerWeek} min of lectures a week.`
          : `Sized from your own schedule: ${plan.capacity.catchupWallClockMinPerWeek} min of ` +
            `catch-up a week is the cap, and answer writing is never touched.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  headline: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 4 },
  value: { fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  valueMeta: { fontSize: 12, flexShrink: 1 },
  line: { fontSize: 13, lineHeight: 19, marginTop: 6 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 8 },

  banner: { borderRadius: 10, padding: 12, marginTop: 10 },
  bannerText: { fontSize: 13, lineHeight: 19, fontWeight: '600' },

  grid: { flexDirection: 'row', gap: 12, marginTop: 14 },
  figure: { flex: 1 },
  figureValue: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  figureLabel: { fontSize: 11, marginTop: 2 },

  plan: { marginTop: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
  planHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  planTitle: { fontSize: 15, fontWeight: '700', flex: 1 },
  planHeadline: { fontSize: 14, lineHeight: 20, fontWeight: '600', marginBottom: 10 },

  step: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  stepIndex: { fontSize: 13, fontWeight: '700', width: 14, lineHeight: 19 },
  stepBody: { flex: 1 },
  stepText: { fontSize: 13, lineHeight: 19 },
  stepMeta: { fontSize: 11, marginTop: 3, fontVariant: ['tabular-nums'] },

  button: { borderRadius: 10, paddingVertical: 11, alignItems: 'center', marginTop: 14 },
  buttonText: { fontSize: 14, fontWeight: '700' },
});
