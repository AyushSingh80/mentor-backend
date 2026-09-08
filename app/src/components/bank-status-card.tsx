/**
 * Bank status — the card that decides whether a commute works.
 *
 * Copy rules, all of them load-bearing:
 *
 * - The headline is DAYS, not rows. "60 questions" is not a decision she can
 *   act on while standing at home with wifi; "six days left" is. The row count
 *   is still shown, but small and second, because it is the audit trail for the
 *   number above it rather than the number itself.
 * - The demand the days were divided by is stated. A runway figure with no
 *   divisor is a number she has to trust; with one, it is a number she can
 *   check against her own week.
 * - FAILURES ARE SHOUTED. A bank that quietly stopped filling looks exactly
 *   like a healthy one until the moment there is no signal left to fix it, so
 *   "the last three top-ups failed" is the single most valuable sentence this
 *   card can show and it is never collapsed into an icon.
 * - "Top up now" is always tappable when a top-up is possible. It is the honest
 *   answer to "I have wifi and I am about to travel", and gating it behind the
 *   same low-water rule as the automatic trigger would refuse her at exactly
 *   the moment she is being sensible.
 */

import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Card, Pill, type PillTone } from '@/components/controls';
import { useTheme } from '@/components/form';
import { BANK_RULES } from '@/lib/mcq-bank';
import type { BankStatus } from '@/lib/mcq-refill';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Mar, 09:20" from an ISO instant. Local, and deliberately not relative. */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso.slice(0, 16).replace('T', ' ');
  const month = MONTHS[at.getMonth()] ?? '';
  const hours = String(at.getHours()).padStart(2, '0');
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `${at.getDate()} ${month}, ${hours}:${minutes}`;
}

/**
 * The runway, in the words she would use.
 *
 * Whole days below ten, one decimal above nothing: "0.4 days" is precise and
 * useless, "less than a day" is what she needs to hear before leaving the
 * house.
 */
function runwayLabel(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return 'empty';
  if (days < 1) return 'under a day';
  if (days < 10) return `${days.toFixed(1)} days`;
  return `${Math.round(days)} days`;
}

function runwayTone(days: number, belowLowWater: boolean): PillTone {
  if (days <= 0) return 'bad';
  if (belowLowWater) return 'warn';
  if (days >= BANK_RULES.targetRunwayDays) return 'good';
  return 'neutral';
}

function runwayVerdict(status: BankStatus): string {
  const { runway } = status;

  if (runway.unseenEligible === 0) {
    return (
      'There are no unseen questions aimed at topics you have started. A drill right now would have ' +
      'nothing to deal — top up while you have signal.'
    );
  }

  if (runway.unseenEligible < BANK_RULES.hardFloor) {
    return (
      `Only ${runway.unseenEligible} unseen questions in hand. Below ${BANK_RULES.hardFloor} the days ` +
      'figure stops meaning much — two sets in one evening would clear it.'
    );
  }

  if (runway.belowLowWater) {
    return (
      `Under the ${BANK_RULES.lowWaterRunwayDays}-day mark. The app will top up on its own next time ` +
      'you open it on wifi, but doing it now is the safe version.'
    );
  }

  return (
    `Comfortable. The bank aims for ${BANK_RULES.targetRunwayDays} days rather than a month on purpose: ` +
    'questions generated before your weak areas changed get aimed at the wrong topics.'
  );
}

export interface BankStatusCardProps {
  status: BankStatus | null;
  /** A top-up is running right now. */
  busy: boolean;
  /** The outcome of the last top-up started from this screen, if any. */
  note: string | null;
  onTopUp: () => void;
}

export function BankStatusCard({
  status,
  busy,
  note,
  onTopUp,
}: BankStatusCardProps): React.ReactElement {
  const theme = useTheme();

  if (status === null) {
    return (
      <Card title="Question bank">
        <Text style={[styles.line, { color: theme.textSecondary }]}>
          Reading your bank…
        </Text>
      </Card>
    );
  }

  const { runway } = status;
  const days = runway.runwayDays;

  return (
    <Card title="Question bank">
      <View style={styles.headline}>
        <Text style={[styles.value, { color: theme.text }]}>{runwayLabel(days)}</Text>
        <Pill text={runway.belowLowWater ? 'top up' : 'stocked'} tone={runwayTone(days, runway.belowLowWater)} />
      </View>

      <Text style={[styles.subhead, { color: theme.textSecondary }]}>
        of offline drilling — {runway.unseenEligible} unseen questions at{' '}
        {Math.round(status.demandPerDay)} a day, your busy-day rate over the last{' '}
        {BANK_RULES.demandWindowDays} days.
      </Text>

      <Text style={[styles.line, { color: theme.textSecondary }]}>{runwayVerdict(status)}</Text>

      {/* Reported, never counted as runway: an answered question is revision,
          not new material, and counting it as supply would let the card
          promise a week it cannot deal. */}
      {runway.redrillDueToday > 0 ? (
        <Text style={[styles.line, { color: theme.textSecondary }]}>
          Plus {runway.redrillDueToday} due for a second look. Those are revision, so they are not
          counted in the days above.
        </Text>
      ) : null}

      {runway.quarantined > 0 ? (
        <Text style={[styles.line, { color: theme.textSecondary }]}>
          {runway.quarantined} question{runway.quarantined === 1 ? ' is' : 's are'} held back while you
          dispute {runway.quarantined === 1 ? 'it' : 'them'}. They will not be dealt.
        </Text>
      ) : null}

      {status.eligibleSections === 0 ? (
        <Text style={[styles.line, { color: theme.textSecondary }]}>
          No Prelims section has a topic you have started yet, so there is nothing to aim questions at.
          Mark a topic in progress in the syllabus and the bank starts filling against it.
        </Text>
      ) : null}

      {/* ---------------------------------------------------- top-up history */}

      <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />

      <Text style={[styles.line, { color: theme.textSecondary }]}>
        {runway.lastSuccessfulRefillAt === null
          ? 'No top-up has landed yet.'
          : `Last top-up: ${formatWhen(runway.lastSuccessfulRefillAt)}.`}
      </Text>

      {status.consecutiveFailures > 0 ? (
        <View style={styles.failure}>
          <Pill
            text={
              status.consecutiveFailures === 1
                ? 'last top-up failed'
                : `last ${status.consecutiveFailures} top-ups failed`
            }
            tone="bad"
          />
          {status.lastFailure ? (
            <Text style={[styles.line, { color: theme.text }]}>
              {formatWhen(status.lastFailure.at)} — {status.lastFailure.error}
            </Text>
          ) : null}
        </View>
      ) : null}

      {note !== null ? (
        <Text style={[styles.line, { color: theme.text }]}>{note}</Text>
      ) : null}

      <TouchableOpacity
        onPress={onTopUp}
        disabled={busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: busy, busy }}
        accessibilityLabel="Top up now"
        accessibilityHint="Generates a new batch of questions while you have signal"
        style={[
          styles.button,
          { backgroundColor: theme.text, opacity: busy ? 0.45 : 1 },
        ]}
      >
        {busy ? (
          <ActivityIndicator color={theme.background} />
        ) : (
          <Text style={[styles.buttonText, { color: theme.background }]}>Top up now</Text>
        )}
      </TouchableOpacity>
    </Card>
  );
}

const styles = StyleSheet.create({
  headline: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10 },
  value: { fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  subhead: { fontSize: 13, lineHeight: 19, marginTop: 4 },
  line: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  divider: { height: 1, marginTop: 14, marginBottom: 2 },
  failure: { gap: 6, marginTop: 8 },
  button: {
    marginTop: 16,
    borderRadius: 12,
    // Tapped one-handed, often while already moving. 44 is the iOS HIG floor.
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  buttonText: { fontSize: 16, fontWeight: '700' },
});
