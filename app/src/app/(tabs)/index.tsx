/**
 * Today — the session-opening briefing.
 *
 * Reads entirely from local SQLite so it renders with no network. The server
 * status card degrades to "offline" rather than blocking the screen.
 */

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { BacklogCard } from '@/components/backlog-card';
import { useTheme } from '@/components/form';
import { readDigestDay } from '@/db/ca';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { CA_RULES, type DigestDay } from '@/lib/ca-types';
import { derivePlan, getProfile, type ProfileRow } from '@/db/profile';
import { lectureFacts } from '@/db/lectures';
import { readBankSnapshot } from '@/db/mcq-bank';
import { buildDeck, type RevisionDeck } from '@/db/revision';
import { computeRunway, dailyDemand } from '@/lib/mcq-bank';
import type { BankRunway } from '@/lib/mcq-types';
import { evaluateBacklogAlert, summariseBacklog, type BacklogAlert, type BacklogSummary } from '@/lib/backlog';
import { checkHealth, type HealthResponse } from '@/lib/api';
import { hasPermission, refreshNotifications } from '@/lib/notifications';
import { buildNotifyContext, profileForSchedule } from '@/lib/steady-context';
import { formatClock, localDate } from '@/lib/time';
import { DecisionCard } from '@/components/decision-card';
import { buildDecisionContext } from '@/db/today-context';
import { PRELIMS_2028, DEFAULT_FIRST_PASS_TARGET } from '@/lib/exam-dates';
import { decideToday, type DecisionContext } from '@/lib/today-decision';




export default function Today() {
  const theme = useTheme();
  const router = useRouter();
  const [row, setRow] = useState<ProfileRow | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deck, setDeck] = useState<RevisionDeck | null>(null);
  const [bank, setBank] = useState<BankRunway | null>(null);
  const [backlog, setBacklog] = useState<{ summary: BacklogSummary; alert: BacklogAlert } | null>(
    null,
  );
  const [digest, setDigest] = useState<DigestDay | null>(null);
  /**
   * The CONTEXT is state; the decision is derived from it.
   *
   * Storing the decision instead would mean recomputing it in an effect every
   * time the revision deck resolved, and `react-hooks/set-state-in-effect` is an
   * error here. Deriving keeps the deck flowing in reactively with no third
   * effect and no setState reachable from an effect body.
   */
  const [decisionContext, setDecisionContext] = useState<DecisionContext | null>(null);
  const isMounted = useIsMounted();

  /**
   * Loads local state first, then the optional server status.
   *
   * The two are deliberately independent: the profile read is local and must
   * render even when the server call fails or times out. `isActive` prevents a
   * late response from a previous load overwriting a newer one.
   */
  async function load(isActive: () => boolean) {
    try {
      const profileRow = await getProfile();
      if (isActive()) setRow(profileRow);
    } catch (err) {
      if (isActive()) setServerError((err as Error).message);
    }

    try {
      const h = await checkHealth();
      if (isActive()) {
        setHealth(h);
        setServerError(null);
      }
    } catch (err) {
      if (isActive()) {
        setHealth(null);
        setServerError((err as Error).message);
      }
    }

    try {
      const glance = await readDigestDay(localDate('Asia/Kolkata'));
      if (isActive()) setDigest(glance);
    } catch {
      // A failed local read leaves the previous card up rather than blanking
      // it; the digest card is not worth a visible error on this screen.
    }
  }

  // Written as promise chains rather than an awaited helper so that no setState
  // is reachable synchronously from the effect body — the two fetches are
  // independent, and the local profile read must not wait on the server one.
  /**
   * Keep the scheduled reminders' numbers current.
   *
   * A `DAILY` OS trigger fixes the notification body at SCHEDULING time, so
   * "6 due for revision" is the count from whenever the schedule was last
   * rebuilt. Rebuilding on every open of the tab she opens daily keeps that at
   * most one app-open stale — which for a morning briefing means last evening
   * at worst. See the header of `lib/notifications.ts`.
   *
   * Silent and best-effort: it does nothing at all until she has turned
   * reminders on, and a failure here must never disturb the Today screen.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (!(await hasPermission())) return;
        const profileRow = await getProfile();
        const schedule = profileForSchedule(profileRow);
        if (schedule === null || cancelled) return;
        const ctx = await buildNotifyContext(schedule.timezone);
        if (cancelled) return;
        await refreshNotifications(schedule.profile, ctx);
      } catch {
        // Nothing here is worth surfacing on the screen she opens first.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    getProfile()
      .then((profileRow) => {
        if (!cancelled) setRow(profileRow);
      })
      .catch((err: Error) => {
        if (!cancelled) setServerError(err.message);
      });

    checkHealth()
      .then((h) => {
        if (!cancelled) {
          setHealth(h);
          setServerError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setHealth(null);
          setServerError(err.message);
        }
      });

    // The two daily prompts: what is due to revise, and how far behind the
    // lectures are. Both are local reads and independent of each other and of
    // the server, so one failing must not blank the others.
    buildDeck(localDate('Asia/Kolkata'))
      .then((next) => {
        if (!cancelled) setDeck(next);
      })
      .catch(() => undefined);

    // Runway in DAYS, not a question count. "Six days" is actionable while she
    // is still at home on wifi; "60 questions" means nothing before a commute.
    readBankSnapshot({ asOfDay: localDate('Asia/Kolkata') })
      .then((snapshot) => {
        if (cancelled) return;
        const demand = dailyDemand(snapshot.drillCounts, {
          asOfDay: localDate('Asia/Kolkata'),
        });
        setBank(computeRunway(snapshot.inventory, demand));
      })
      .catch(() => undefined);

    // The current-affairs entry point. Deliberately NOT gated on a `micro`
    // study block existing: `deriveStudyBlocks` only emits those when the
    // commute is 10 minutes or more, and hers is currently 0 — gating on it
    // would hide the digest from the person it was built for.
    readDigestDay(localDate('Asia/Kolkata'))
      .then((glance) => {
        if (!cancelled) setDigest(glance);
      })
      .catch(() => undefined);

    /**
     * The decision context, chained off the profile read the screen already does.
     *
     * `revisionDue` is deliberately NOT read here — it is supplied at decide
     * time from `deck.totalDue`, which this screen already computes. A second
     * count would be a second definition of "due today" on one card.
     */
    getProfile()
      .then(async (profileRow) => {
        if (cancelled || profileRow === null) return;
        const plan = derivePlan(profileRow);
        const day = localDate(profileRow.timezone);
        const dow = new Date(`${day}T12:00:00`).getDay();
        const context = await buildDecisionContext({
          today: day,
          timezone: profileRow.timezone,
          targetFirstPassIso: profileRow.targetFirstPassDate ?? DEFAULT_FIRST_PASS_TARGET,
          prelimsIso: PRELIMS_2028,
          projectedHours: plan.projectedHours,
          todayBlocks: plan.blocks.filter((block) => block.dayOfWeek === dow),
          revisionDue: null,
          serverReachable: false,
        });
        if (!cancelled) setDecisionContext(context);
      })
      .catch(() => undefined);

    lectureFacts()
      .then(async (facts) => {
        const profileRow = await getProfile();
        if (cancelled || facts.length === 0) return;

        const asOf = localDate(profileRow?.timezone ?? 'Asia/Kolkata');
        const workDays: number[] = profileRow ? (JSON.parse(profileRow.workDays) as number[]) : [];
        // The weekly audit lands on the first day off, and the alert samples on
        // that same weekday — so the banner and the Sunday review agree.
        const auditDayOfWeek = [0, 1, 2, 3, 4, 5, 6].find((d) => !workDays.includes(d)) ?? 0;

        setBacklog({
          summary: summariseBacklog(facts, {
            asOf,
            targetIso: profileRow?.targetFirstPassDate ?? '2027-03-31',
            catalogueContentMin: profileRow?.gsCourseTotalRuntimeMin ?? null,
          }),
          alert: evaluateBacklogAlert(facts, { asOf, auditDayOfWeek }),
        });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  const plan = useMemo(() => (row ? derivePlan(row) : null), [row]);

  /**
   * Derived, not stored.
   *
   * `deck.totalDue` and server reachability arrive later than the context, and
   * deriving is what lets them flow in without an effect that setStates.
   * `decideToday` is pure and cheap, so recomputing on every change is free.
   */
  const decision = useMemo(
    () =>
      decisionContext === null
        ? null
        : decideToday({
            ...decisionContext,
            revisionDue: deck?.totalDue ?? null,
            serverReachable: health !== null,
          }),
    [decisionContext, deck, health],
  );

  const today = row ? localDate(row.timezone) : localDate('Asia/Kolkata');
  const todayDow = new Date(`${today}T12:00:00`).getDay();
  const todayBlocks = plan?.blocks.filter((b) => b.dayOfWeek === todayDow) ?? [];
  // A 404 feed and a quiet news day produce the same small number and mean
  // opposite things, so the count is surfaced rather than folded away.
  const digestSourceFailures = digest?.summary?.sourceFailures ?? 0;

  const daysTo = (iso: string) =>
    Math.max(
      0,
      Math.ceil((new Date(iso).getTime() - new Date(today).getTime()) / (24 * 60 * 60 * 1000)),
    );

  if (!row || !plan) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <Text style={{ color: theme.text }}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            // `useIsMounted`, not the old `() => true` default: a flag that is
            // never false is not a guard, and this screen's reads settle in
            // unrelated orders.
            load(isMounted).finally(() => {
              if (isMounted()) setRefreshing(false);
            });
          }}
        />
      }
    >
      <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>{today}</Text>
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        Today
      </Text>

      <View style={styles.countdowns}>
        <Countdown theme={theme} value={daysTo(row.targetFirstPassDate)} label="days to first pass" />
        <Countdown theme={theme} value={daysTo(PRELIMS_2028)} label={`days to Prelims ${row.examYear}`} />
      </View>

      {/*
        First, and above every card that only reports.

        The blocks below are her own schedule played back; the capacity and
        countdown are measurements. This is the one card that puts them together
        and commits to an answer, and it earns the top slot by being the only
        thing on the screen she can act on without deciding anything herself.
      */}
      <DecisionCard decision={decision} today={today} onOpen={(route) => router.push(route as never)} />

      <Card theme={theme} title="Your blocks today">
        {todayBlocks.length === 0 ? (
          <Text style={{ color: theme.textSecondary }}>No blocks scheduled.</Text>
        ) : (
          todayBlocks.map((b) => (
            <View key={b.id} style={styles.blockRow}>
              <Text style={[styles.blockTime, { color: theme.textSecondary }]}>
                {formatClock(b.startMinutes)}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.blockLabel, { color: theme.text }]}>{b.label}</Text>
                <Text style={[styles.blockMeta, { color: theme.textSecondary }]}>
                  {Math.round((b.endMinutes - b.startMinutes) / 5) * 5} min · {b.kind}
                </Text>
              </View>
            </View>
          ))
        )}
      </Card>

      <Card theme={theme} title="Capacity">
        <Row theme={theme} k="This week" v={`${plan.capacity.totalWeeklyHours.toFixed(1)} hrs`} />
        <Row theme={theme} k="Weekdays" v={`${plan.capacity.weekdayHours.toFixed(1)} hrs`} />
        <Row theme={theme} k="Weekends" v={`${plan.capacity.weekendHours.toFixed(1)} hrs`} />
        <Row
          theme={theme}
          k={`To ${row.targetFirstPassDate}`}
          v={`~${plan.projectedHours.toLocaleString()} hrs`}
        />
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          Projected from your derived plan. Once you start logging sessions, this recalculates from
          hours you actually studied rather than hours you intended to.
        </Text>
      </Card>

      <Card theme={theme} title="Server">
        {health ? (
          <>
            <Row theme={theme} k="Status" v="Connected" />
            <Row
              theme={theme}
              k="Spend this month"
              v={`$${health.caps.monthUsd.toFixed(2)} / $${health.caps.monthlyCapUsd}`}
            />
            <Row
              theme={theme}
              k="Requests today"
              v={`${health.caps.todayRequests} / ${health.caps.dailyRequestCap}`}
            />
            {!health.caps.allowed ? (
              <Text style={[styles.warn, { color: theme.text }]}>
                Spend cap reached. Evaluation is blocked until it resets.
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <Row theme={theme} k="Status" v="Not connected" />
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              {serverError ?? 'No server configured.'} Everything on this screen works offline —
              only answer evaluation needs the server.
            </Text>
          </>
        )}
      </Card>

      {/* The two things worth interrupting a morning for, in the order they
          should be acted on: revision decays if skipped, backlog compounds. */}
      <Card theme={theme} title="Due to revise">
        {deck === null ? (
          <Text style={{ color: theme.textSecondary }}>Loading…</Text>
        ) : deck.totalDue > 0 ? (
          <>
            <Row
              theme={theme}
              k="Topics due today"
              v={`${deck.totalDue}${deck.heldBack > 0 ? ` (${deck.heldBack} held over)` : ''}`}
            />
            {deck.leeches.length > 0 ? (
              <Row theme={theme} k="Stuck topics" v={String(deck.leeches.length)} />
            ) : null}
            <TouchableOpacity
              onPress={() => router.push('/revise')}
              accessibilityRole="button"
              accessibilityLabel={`Start revising, ${deck.totalDue} topics due`}
            >
              <Text style={[styles.link, { color: theme.text }]}>Start revising</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            {deck.queued > 0
              ? 'Nothing due today. That is a good day, not a broken screen.'
              : 'No topic has reached its first pass yet, so there is nothing to revise.'}
          </Text>
        )}
      </Card>

      {/* Today's current affairs, as ONE entry card. The digest is perishable
          in a way nothing else on this screen is — anything older than
          `catchUpDays` is archive, not debt — so it earns a place next to
          revision rather than below the fold. */}
      <Card theme={theme} title="Today's digest">
        {digest === null ? (
          <Text style={{ color: theme.textSecondary }}>Loading…</Text>
        ) : digest.status === 'failed' ? (
          <>
            <Text
              accessible
              accessibilityLabel={
                "Today's digest failed. No items were produced, which is a fact about the fetch " +
                'and not about the news. Do not read today as a quiet day.'
              }
              style={[styles.warn, { color: theme.text }]}
            >
              The fetch failed. No items today.
            </Text>
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              That is a fact about the fetch, not about the news — do not read it as a quiet day.
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/current')}
              accessibilityRole="button"
              accessibilityLabel="Open current affairs to see what failed"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={[styles.link, { color: theme.text }]}>See what happened</Text>
            </TouchableOpacity>
          </>
        ) : digest.status === 'pending' ? (
          <>
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              A digest is being fetched. Nothing to wait on it for — it fills itself in.
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/current')}
              accessibilityRole="button"
              accessibilityLabel="Open current affairs"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={[styles.link, { color: theme.text }]}>Open current affairs</Text>
            </TouchableOpacity>
          </>
        ) : digest.items.length > 0 ? (
          <>
            {/* Figure and cost as ONE node: "6", "20" and "2" announced
                separately are three numbers, not a claim about the day. */}
            <Text
              accessible
              accessibilityLabel={`Today's digest: ${digest.items.length} ${
                digest.items.length === 1 ? 'item' : 'items'
              }, about ${digest.estimatedMinutes} ${
                digest.estimatedMinutes === 1 ? 'minute' : 'minutes'
              } of reading, ${digest.unread} still unread.`}
              style={[styles.digestFigure, { color: theme.text }]}
            >
              {digest.items.length} {digest.items.length === 1 ? 'item' : 'items'} · ~
              {digest.estimatedMinutes} min
            </Text>
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              {digest.unread === 0
                ? 'All read.'
                : `${digest.unread} unread. The budget is ${CA_RULES.dailyBudgetMinutes} minutes — it must not eat the reading block.`}
            </Text>
            {digestSourceFailures > 0 ? (
              <Text style={[styles.note, { color: theme.text }]}>
                {digestSourceFailures} {digestSourceFailures === 1 ? 'source' : 'sources'} failed to
                fetch, so today may be short for the wrong reason.
              </Text>
            ) : null}
            <TouchableOpacity
              onPress={() => router.push('/current')}
              accessibilityRole="button"
              accessibilityLabel={`Read today's digest, ${digest.items.length} items, about ${digest.estimatedMinutes} minutes`}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={[styles.link, { color: theme.text }]}>Read the digest</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              {digest.status === 'none'
                ? 'No digest has been requested today. There is no backlog to clear — current affairs older than a few days is archive, not debt.'
                : 'The digest ran and kept nothing. On this selection rule that is a normal day, not a malfunction.'}
            </Text>
            {digestSourceFailures > 0 ? (
              <Text style={[styles.note, { color: theme.text }]}>
                {digestSourceFailures} {digestSourceFailures === 1 ? 'source' : 'sources'} failed to
                fetch, so this may be a broken feed rather than a quiet day.
              </Text>
            ) : null}
            <TouchableOpacity
              onPress={() => router.push('/current')}
              accessibilityRole="button"
              accessibilityLabel="Open current affairs"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={[styles.link, { color: theme.text }]}>Open current affairs</Text>
            </TouchableOpacity>
          </>
        )}
      </Card>

      {/* The commute drill. Deliberately NOT gated on a `micro` study block
          existing — `deriveStudyBlocks` only emits those when the commute is
          10 minutes or more, and she drills on work breaks too. */}
      <Card theme={theme} title="Commute drill">
        {bank === null ? (
          <Text style={{ color: theme.textSecondary }}>Loading…</Text>
        ) : bank.unseenEligible > 0 || bank.redrillDueToday > 0 ? (
          <>
            <Row
              theme={theme}
              k="Questions ready"
              v={`${bank.unseenEligible}${bank.redrillDueToday > 0 ? ` + ${bank.redrillDueToday} to redo` : ''}`}
            />
            <Row
              theme={theme}
              k="Offline runway"
              v={
                bank.runwayDays >= 1
                  ? `${Math.floor(bank.runwayDays)} ${Math.floor(bank.runwayDays) === 1 ? 'day' : 'days'}`
                  : 'under a day'
              }
            />
            {bank.belowLowWater ? (
              <Text style={[styles.note, { color: theme.text }]}>
                Running low. Top up on wifi before you travel.
              </Text>
            ) : null}
            <TouchableOpacity
              onPress={() => router.push('/drill')}
              accessibilityRole="button"
              accessibilityLabel={`Start a drill, ${bank.unseenEligible} questions ready`}
            >
              <Text style={[styles.link, { color: theme.text }]}>Start a drill</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              No questions banked yet. Top up on wifi and they will be there on the train.
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/drill')}
              accessibilityRole="button"
              accessibilityLabel="Open the question bank"
            >
              <Text style={[styles.link, { color: theme.text }]}>Open the bank</Text>
            </TouchableOpacity>
          </>
        )}
      </Card>

      {backlog ? (
        <BacklogCard
          summary={backlog.summary}
          alert={backlog.alert}
          plan={null}
          compact
          onLogLecture={() => router.push('/lecture/log')}
        />
      ) : (
        <Card theme={theme} title="Lecture backlog">
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            No lectures logged yet. Log the ones your course has released and this starts tracking
            how far ahead or behind you are.
          </Text>
          <TouchableOpacity
            onPress={() => router.push('/lecture/log')}
            accessibilityRole="button"
            accessibilityLabel="Log a lecture"
          >
            <Text style={[styles.link, { color: theme.text }]}>Log a lecture</Text>
          </TouchableOpacity>
        </Card>
      )}

      <TouchableOpacity onPress={() => router.push('/onboarding')} accessibilityRole="button">
        <Text style={[styles.link, { color: theme.textSecondary }]}>Edit schedule</Text>
      </TouchableOpacity>
      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

type Theme = { text: string; textSecondary: string; backgroundElement: string };

function Card({
  title,
  children,
  theme,
}: {
  title: string;
  children: React.ReactNode;
  theme: Theme;
}) {
  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/**
 * A label/value row.
 *
 * The flex rules are load-bearing and were added after a device check showed
 * "Status" rendering as "Statu" and "This week" as "This". Two `Text` children
 * in a `space-between` row with no constraints BOTH shrink when the combined
 * width overflows, and a shrunk `Text` is clipped with no ellipsis — so a long
 * value silently eats its own label.
 *
 * The value never shrinks: it is the number she came to read. The label wraps
 * instead, because a wrapped label is legible and a truncated one is not.
 */
function Row({ theme, k, v }: { theme: Theme; k: string; v: string }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowKey, { color: theme.textSecondary }]}>{k}</Text>
      <Text style={[styles.rowValue, { color: theme.text }]}>{v}</Text>
    </View>
  );
}

function Countdown({ theme, value, label }: { theme: Theme; value: number; label: string }) {
  return (
    <View style={[styles.countdown, { backgroundColor: theme.backgroundElement }]}>
      <Text style={[styles.countdownValue, { color: theme.text }]}>{value}</Text>
      <Text style={[styles.countdownLabel, { color: theme.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  eyebrow: { fontSize: 13, marginBottom: 2 },
  h1: { fontSize: 32, fontWeight: '700', marginBottom: 20 },
  countdowns: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  countdown: { flex: 1, borderRadius: 14, padding: 16 },
  countdownValue: { fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  countdownLabel: { fontSize: 12, marginTop: 2 },
  card: { borderRadius: 14, padding: 18, marginBottom: 16, gap: 4 },
  cardTitle: { fontSize: 16, fontWeight: '700', marginBottom: 10 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 4,
  },
  // `flex: 1`, not `flexShrink: 1`. Shrinking a `Text` clips it — the label
  // loses characters with no ellipsis — where taking the remaining space lets
  // it WRAP. "Spend this month" rendered as "Spend this" until this changed.
  rowKey: { flex: 1 },
  rowValue: { fontWeight: '600', flexShrink: 0, textAlign: 'right' },
  blockRow: { flexDirection: 'row', gap: 14, paddingVertical: 7 },
  blockTime: { width: 62, fontSize: 13, fontVariant: ['tabular-nums'], paddingTop: 1 },
  blockLabel: { fontSize: 15, fontWeight: '500' },
  blockMeta: { fontSize: 12, marginTop: 1 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  digestFigure: { fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  warn: { fontSize: 13, lineHeight: 19, marginTop: 10, fontWeight: '600' },
  link: { fontSize: 14, textAlign: 'center', paddingVertical: 12, textDecorationLine: 'underline' },
});
