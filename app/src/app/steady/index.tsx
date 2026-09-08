/**
 * Consistency, strain, and reminders.
 *
 * Three things that look separate and are one question: is this sustainable for
 * eighteen more months?
 *
 * ## What is shown first, and why it is not the streak
 *
 * The rate leads. `lib/streaks.ts` sets out the reasoning at length; the short
 * version is that a chain broken by one missed day says the same thing about
 * someone who studied forty of the last forty-one days as about someone who has
 * never opened the app, and that is the moment people quit. The streak is here,
 * because a run of days is genuinely motivating — but it is second, and a
 * broken one is never rendered as loss.
 *
 * ## The strain card is usually absent
 *
 * `detectBurnout` returns at most one finding and null is the expected output.
 * A card that always has a concern is one that gets scrolled past, so when
 * there is nothing to say this screen says something plain instead — or nothing.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Card, ChipPicker, Pill } from '@/components/controls';
import { useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { hasCheckedIn, readActivityEvents, readSelfReports, saveCheckIn } from '@/db/activity';
import { getProfile } from '@/db/profile';
import { activityByDay, dayRange, type ActivityDay } from '@/lib/activity';
import { detectBurnout, describeSteadiness, type BurnoutFinding } from '@/lib/burnout';
import {
  hasPermission,
  cancelAll,
  refreshNotifications,
  requestPermission,
  scheduledCount,
} from '@/lib/notifications';
import { consistency, describeConsistency, STREAK_RULES, type Consistency } from '@/lib/streaks';
import { localDate } from '@/lib/time';
import { buildNotifyContext, profileForSchedule } from '@/lib/steady-context';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
/** Two windows of history, so the burnout comparison has something to compare. */
const HISTORY_DAYS = 56;

const SCORE_OPTIONS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }));

interface Snapshot {
  days: ActivityDay[];
  state: Consistency;
  finding: BurnoutFinding | null;
  steadiness: string | null;
  today: string;
  checkedIn: boolean;
}

export default function Steady() {
  const theme = useTheme();
  const router = useRouter();
  const isMounted = useIsMounted();

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [notifyOn, setNotifyOn] = useState(false);
  const [queued, setQueued] = useState(0);
  const [mood, setMood] = useState<string | null>(null);
  const [energy, setEnergy] = useState<string | null>(null);

  const load = useCallback(
    (isActive: () => boolean) =>
      getProfile()
        .catch(() => null)
        .then(async (profile) => {
          const timezone = profile?.timezone ?? DEFAULT_TIMEZONE;
          const today = localDate(timezone);
          const days = dayRange(today, HISTORY_DAYS);
          const since = days[0]!;

          const [events, reports, checkedIn, granted, count] = await Promise.all([
            readActivityEvents({ since, timezone }),
            readSelfReports({ since, timezone }),
            hasCheckedIn(today),
            hasPermission(),
            scheduledCount(),
          ]);
          if (!isActive()) return;

          const assembled = activityByDay(events, days, reports);
          setSnapshot({
            days: assembled,
            state: consistency({
              days: assembled.slice(-STREAK_RULES.windowDays),
              // No plan means every day counts, which is the honest default.
              studyDays: new Set<string>(),
            }),
            finding: detectBurnout({ days: assembled }),
            steadiness: describeSteadiness(assembled),
            today,
            checkedIn,
          });
          setNotifyOn(granted);
          setQueued(count);
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

  const reschedule = useCallback(async () => {
    const profile = await getProfile().catch(() => null);
    const schedule = profileForSchedule(profile);
    if (schedule === null) {
      setNote('Finish onboarding first — the reminder times are derived from your shift.');
      return;
    }
    const ctx = await buildNotifyContext(schedule.timezone);
    const result = await refreshNotifications(schedule.profile, ctx);
    if (!isMounted()) return;
    setNote(result.reason);
    setQueued(await scheduledCount());
  }, [isMounted]);

  const toggleNotifications = useCallback(
    (next: boolean) => {
      setNote(null);
      if (!next) {
        setNotifyOn(false);
        void cancelAll().then(async () => {
          if (isMounted()) {
            setQueued(await scheduledCount());
            setNote('Reminders are off. Nothing is scheduled.');
          }
        });
        return;
      }

      void requestPermission()
        .then(async (granted) => {
          if (!isMounted()) return;
          setNotifyOn(granted);
          if (!granted) {
            setNote(
              'Android declined. If you refused before, it has to be turned back on in system settings.',
            );
            return;
          }
          await reschedule();
        })
        .catch(() => undefined);
    },
    [isMounted, reschedule],
  );

  const submitCheckIn = useCallback(() => {
    if (snapshot === null) return;
    setNote(null);
    saveCheckIn({
      date: snapshot.today,
      mood: mood === null ? null : Number(mood),
      energy: energy === null ? null : Number(energy),
    })
      .then(() => {
        if (!isMounted()) return;
        setNote('Recorded.');
        return load(isMounted);
      })
      .catch((err: Error) => {
        if (isMounted()) setNote(err.message);
      });
  }, [energy, isMounted, load, mood, snapshot]);

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
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
        Keeping it up
      </Text>

      {loadError !== null ? (
        <Card>
          <Text style={[styles.cardTitle, { color: theme.text }]}>Could not read your history</Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>{loadError}</Text>
        </Card>
      ) : snapshot === null ? (
        <ActivityIndicator />
      ) : (
        <>
          <Card>
            <Text style={[styles.cardTitle, { color: theme.text }]}>Consistency</Text>
            <Text style={[styles.headline, { color: theme.text }]}>
              {describeConsistency(snapshot.state)}
            </Text>
            <View style={styles.pillRow}>
              {snapshot.state.currentStreak > 0 && (
                <Pill text={`${snapshot.state.currentStreak} in a row`} tone="good" />
              )}
              {snapshot.state.longestStreak > 0 && (
                <Pill text={`best ${snapshot.state.longestStreak}`} tone="neutral" />
              )}
            </View>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>
              The rate is the number that matters. A run of days is worth having and worth losing
              cheaply — it is measured over {STREAK_RULES.windowDays} days precisely so one bad
              week moves it a little rather than resetting it.
            </Text>
          </Card>

          {snapshot.finding !== null ? (
            <Card>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Worth noticing</Text>
              <Text style={[styles.body, { color: theme.text }]}>
                {snapshot.finding.observation}
              </Text>
              <Text style={[styles.suggestion, { color: theme.textSecondary }]}>
                {snapshot.finding.suggestion}
              </Text>
            </Card>
          ) : snapshot.steadiness !== null ? (
            <Card>
              <Text style={[styles.body, { color: theme.textSecondary }]}>
                {snapshot.steadiness}
              </Text>
            </Card>
          ) : null}

          <Card>
            <View style={styles.headRow}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Reminders</Text>
              <Switch
                value={notifyOn}
                onValueChange={toggleNotifications}
                accessibilityLabel="Study reminders"
              />
            </View>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>
              Three a day at most, derived from your shift, and a test asserts none can fire between
              2:30pm and 11:30pm. A reminder with nothing to say is not sent.
            </Text>
            {notifyOn && (
              <>
                <Text style={[styles.hint, { color: theme.textSecondary }]}>
                  {queued} scheduled with the system.
                </Text>
                <TouchableOpacity
                  onPress={() => void reschedule()}
                  accessibilityRole="button"
                  accessibilityLabel="Refresh the scheduled reminders"
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={styles.tap}
                >
                  <Text style={[styles.link, { color: theme.text }]}>Refresh with today&apos;s counts</Text>
                </TouchableOpacity>
              </>
            )}
          </Card>

          <Card>
            <Text style={[styles.cardTitle, { color: theme.text }]}>
              {snapshot.checkedIn ? 'Today, recorded' : 'How was today?'}
            </Text>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>
              Optional, and nothing above depends on it — every number on this screen is derived
              from work you already did. This only sharpens it.
            </Text>
            <ChipPicker label="Mood" options={SCORE_OPTIONS} selected={mood} onSelect={setMood} />
            <ChipPicker
              label="Energy"
              options={SCORE_OPTIONS}
              selected={energy}
              onSelect={setEnergy}
            />
            <TouchableOpacity
              onPress={submitCheckIn}
              disabled={mood === null && energy === null}
              accessibilityRole="button"
              accessibilityState={{ disabled: mood === null && energy === null }}
              accessibilityLabel="Record today"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={styles.tap}
            >
              <Text
                style={[
                  styles.link,
                  { color: mood === null && energy === null ? theme.textSecondary : theme.text },
                ]}
              >
                Record
              </Text>
            </TouchableOpacity>
          </Card>

          {note !== null && (
            <Card>
              <Text style={[styles.body, { color: theme.textSecondary }]}>{note}</Text>
            </Card>
          )}
        </>
      )}

      <TouchableOpacity
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={styles.tap}
      >
        <Text style={[styles.link, { color: theme.text }]}>← Back</Text>
      </TouchableOpacity>
      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  h1: { fontSize: 32, fontWeight: '700', marginBottom: 20 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  headline: { fontSize: 17, lineHeight: 25, fontWeight: '600', marginTop: 4 },
  body: { fontSize: 14, lineHeight: 21 },
  suggestion: { fontSize: 13, lineHeight: 20, marginTop: 6 },
  hint: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  pillRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tap: { minHeight: 44, justifyContent: 'center' },
  link: { fontSize: 15, fontWeight: '600' },
});
