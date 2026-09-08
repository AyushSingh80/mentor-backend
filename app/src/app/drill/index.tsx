/**
 * Drill launcher — the screen that has to be honest before a commute.
 *
 * The hard constraint this whole slice exists for is a twelve-minute
 * one-handed drill on a train with NO SIGNAL. Nothing on that train can be
 * fixed, so everything that decides whether it works has to be visible here,
 * while she is still at home on wifi:
 *
 * - How many DAYS of questions are in hand, not how many rows.
 * - When the last top-up actually landed.
 * - Whether the last few top-ups failed — the failure mode that is otherwise
 *   completely silent until the moment there is no signal left to fix it.
 * - A "Top up now" button that works whenever a top-up is possible.
 *
 * ## Reactivity and the lint rule
 *
 * `react-hooks/set-state-in-effect` is an error in this repo, so nothing sets
 * state synchronously in an effect body. Every load is a promise chain guarded
 * by a `cancelled` flag (effects) or by `useIsMounted` (handlers that are not
 * effects — the pull-to-refresh and the two buttons), exactly as
 * `(tabs)/progress.tsx` and `(tabs)/history.tsx` do.
 *
 * ## The foreground trigger lives here
 *
 * Not in a background task: Android background execution is throttled or
 * silently disabled by most OEM battery managers, and an offline guarantee that
 * depends on it fails on the devices it was written for. `AppState` going
 * `active` and this screen mounting are both real user actions, and the gate
 * inside `refillOnForeground` decides whether either is worth a network call.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { BankStatusCard } from '@/components/bank-status-card';
import { Card, Pill } from '@/components/controls';
import { useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { findResumableSession, startSession } from '@/db/mcq-sessions';
import { PRESETS } from '@/lib/mcq-session';
import type { SessionFacts, SessionMode, SessionPreset } from '@/lib/mcq-types';
import { readBankStatus, refillNow, refillOnForeground, type BankStatus } from '@/lib/mcq-refill';

type Theme = ReturnType<typeof useTheme>;

/** "12 min" from a preset, using the same arithmetic the preset was sized by. */
function presetDuration(preset: SessionPreset): string {
  if (preset.secondsPerQuestion !== null) {
    return `${Math.round((preset.questionCount * preset.secondsPerQuestion) / 60)} min`;
  }
  // 45s to answer plus 30s to actually read the elimination logic — the
  // reading is the part that teaches, so it is counted.
  return `${Math.round((preset.questionCount * 75) / 60)} min`;
}

function presetBlurb(mode: SessionMode): string {
  return mode === 'micro'
    ? 'Answer, see why the other three are wrong, move on. Resumable if the train empties out early.'
    : 'Exam pace, answers revealed only at the end. A set that shows the answer mid-way is not a measurement.';
}

export default function DrillLauncher() {
  const theme = useTheme();
  const router = useRouter();
  const isMounted = useIsMounted();

  const [status, setStatus] = useState<BankStatus | null>(null);
  const [resumable, setResumable] = useState<SessionFacts | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState<SessionMode | null>(null);

  const reload = useCallback((isActive: () => boolean) => {
    readBankStatus()
      .then(async (next) => ({ next, session: await findResumableSession(next.asOfDay) }))
      .then(({ next, session }) => {
        if (!isActive()) return;
        setStatus(next);
        setResumable(session);
        setStatusError(null);
      })
      .catch((error: Error) => {
        if (isActive()) setStatusError(error.message);
      })
      .finally(() => {
        if (isActive()) setLoaded(true);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    reload(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [reload]);

  /**
   * The foreground trigger.
   *
   * Sets no state synchronously — every write happens inside a `.then`, which
   * is what keeps it usable from both an effect body and an event listener.
   * `refillOnForeground` never rejects and does its own gating: if the bank is
   * comfortable, or the six-hour cooldown has not expired, or she is inside a
   * commute window, it returns `skipped` without touching the network.
   */
  const runForeground = useCallback(() => {
    refillOnForeground()
      .then((outcome) => {
        if (!isMounted()) return;
        // Silent when nothing happened: a toast saying "no top-up needed" every
        // time she opens the screen is how a user learns to ignore the one that
        // matters.
        if (outcome.status === 'skipped') return;
        setNote(outcome.reason);
        reload(isMounted);
      })
      .catch(() => undefined);
  }, [isMounted, reload]);

  useEffect(() => {
    runForeground();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') runForeground();
    });
    return () => subscription.remove();
  }, [runForeground]);

  const onTopUp = useCallback(() => {
    setBusy(true);
    setNote(null);
    refillNow(
      {},
      {
        // A top-up runs for minutes across four to six sections, and a section
        // that rejects everything it generates banks nothing while it works.
        // Without this the button reads as hung for the whole of it.
        onSection: (detail, done, total) => {
          if (isMounted()) setNote(`Generating ${done + 1} of ${total}: ${detail}`);
        },
      },
    )
      .then((outcome) => {
        if (!isMounted()) return;
        setNote(outcome.reason);
        reload(isMounted);
      })
      .catch(() => undefined)
      .finally(() => {
        if (isMounted()) setBusy(false);
      });
  }, [isMounted, reload]);

  const onStart = useCallback(
    (mode: SessionMode) => {
      const studyDate = status?.asOfDay;
      if (studyDate === undefined || starting !== null) return;

      setStarting(mode);
      setStartError(null);
      startSession({ mode, studyDate })
        .then((facts) => {
          if (!isMounted()) return;
          router.push(`/drill/${facts.sessionId}`);
        })
        .catch((error: Error) => {
          if (isMounted()) setStartError(error.message);
        })
        .finally(() => {
          if (isMounted()) setStarting(null);
        });
    },
    [isMounted, router, starting, status?.asOfDay],
  );

  const runway = status?.runway ?? null;
  // A drill with nothing to deal is worse than no drill: it teaches that the
  // button is unreliable. Redrills count here even though they are not runway —
  // a set of due repeats is a real, useful twelve minutes.
  const dry =
    runway !== null && runway.unseenEligible === 0 && runway.redrillDueToday === 0;

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            reload(isMounted);
            // Local SQLite. The spinner acknowledges the gesture; it does not
            // time the query.
            setTimeout(() => setRefreshing(false), 350);
          }}
        />
      }
    >
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        Drill
      </Text>

      {!loaded ? (
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      ) : null}

      {statusError !== null ? (
        <Card>
          <Text style={{ color: theme.text }}>Could not read your bank: {statusError}</Text>
        </Card>
      ) : null}

      {resumable !== null ? (
        <Card title="Unfinished set from today">
          <Text style={[styles.note, { color: theme.textSecondary, marginTop: 0 }]}>
            {resumable.plannedCount} questions, started earlier today. Picking it up keeps one sitting
            as one row — starting again would split the day’s figures in two.
          </Text>
          <TouchableOpacity
            onPress={() => router.push(`/drill/${resumable.sessionId}`)}
            accessibilityRole="button"
            accessibilityLabel="Resume today’s set"
            style={[styles.primary, { backgroundColor: theme.text }]}
          >
            <Text style={[styles.primaryText, { color: theme.background }]}>Resume</Text>
          </TouchableOpacity>
        </Card>
      ) : null}

      <BankStatusCard status={status} busy={busy} note={note} onTopUp={onTopUp} />

      <Card title="Start a set">
        {dry ? (
          <Text style={[styles.note, { color: theme.textSecondary, marginTop: 0 }]}>
            There is nothing to deal yet. Top up above while you have signal — the whole point is that
            the drill itself needs none.
          </Text>
        ) : null}

        {startError !== null ? (
          <Text style={[styles.note, { color: theme.text, marginTop: 0 }]}>
            Could not open the set: {startError}
          </Text>
        ) : null}

        {(['micro', 'timed'] as const).map((mode) => (
          <PresetRow
            key={mode}
            mode={mode}
            preset={PRESETS[mode]}
            theme={theme}
            disabled={dry || status === null || starting !== null}
            busy={starting === mode}
            onPress={() => onStart(mode)}
          />
        ))}
      </Card>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- fragments */

function PresetRow({
  mode,
  preset,
  theme,
  disabled,
  busy,
  onPress,
}: {
  mode: SessionMode;
  preset: SessionPreset;
  theme: Theme;
  disabled: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const title = mode === 'micro' ? 'Commute drill' : 'Timed set';

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      accessibilityLabel={`${title}, ${preset.questionCount} questions, about ${presetDuration(preset)}`}
      accessibilityHint={presetBlurb(mode)}
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      style={[styles.preset, { opacity: disabled ? 0.45 : 1 }]}
    >
      <View style={styles.presetBody}>
        <View style={styles.presetHeader}>
          <Text style={[styles.presetTitle, { color: theme.text }]}>{title}</Text>
          <Pill
            text={`${preset.questionCount} · ${presetDuration(preset)}`}
            tone={mode === 'micro' ? 'good' : 'neutral'}
          />
        </View>
        <Text style={[styles.presetDetail, { color: theme.textSecondary }]}>
          {presetBlurb(mode)}
        </Text>
      </View>
      {busy ? (
        <ActivityIndicator />
      ) : (
        <Text style={[styles.chevron, { color: theme.textSecondary }]}>›</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  h1: { fontSize: 32, fontWeight: '700', marginBottom: 20 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  loading: { paddingVertical: 20, alignItems: 'center' },

  primary: {
    marginTop: 14,
    borderRadius: 12,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontSize: 16, fontWeight: '700' },

  preset: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  presetBody: { flex: 1, gap: 4 },
  presetHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  presetTitle: { fontSize: 15, fontWeight: '600' },
  presetDetail: { fontSize: 12, lineHeight: 17 },
  chevron: { fontSize: 22, lineHeight: 24 },
});
