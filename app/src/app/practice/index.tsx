/**
 * Essay and Ethics practice.
 *
 * ## Why this is not a fifth tab
 *
 * Four is roughly the Material legibility floor and the bar already carries a
 * two-syllable label. This is reached from Write, which is where answer
 * practice already lives — a drill is answer practice at a fifth of the length.
 *
 * ## The foreground trigger lives here
 *
 * Same decision, and the same reasoning, as `drill/index.tsx` and
 * `current/index.tsx`: not a background task, because Android background
 * execution is throttled or silently disabled by most OEM battery managers. The
 * screen mounting and `AppState` going active are real user actions, and the
 * cooldown and cap gates inside `refillOnForeground` decide whether either is
 * worth a network call.
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

import { Card, Pill } from '@/components/controls';
import { useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { nextDrill, readBankCounts, recentDrills } from '@/db/drills';
import { readMaterial } from '@/db/material';
import { getProfile } from '@/db/profile';
import { bankStock, labelOf, type BankStock } from '@/lib/drill-bank';
import { DRILL_RULES, type DrillFacts, type DrillKind } from '@/lib/drill-types';
import { refillNow, refillOnForeground } from '@/lib/drill-run';
import { targetMinutes } from '@/lib/drills';
import { bankDiagnosis, tallyByKind } from '@/lib/material';
import { localDate } from '@/lib/time';

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

interface Snapshot {
  stock: BankStock;
  next: Partial<Record<DrillKind, DrillFacts | null>>;
  recent: DrillFacts[];
  materialCount: number;
  materialNote: string | null;
}

export default function PracticeHub() {
  const theme = useTheme();
  const router = useRouter();
  const isMounted = useIsMounted();

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [today, setToday] = useState(() => localDate(DEFAULT_TIMEZONE));

  const load = useCallback(
    (isActive: () => boolean) =>
      Promise.all([
        readBankCounts(),
        nextDrill('essay_outline'),
        nextDrill('ethics_case'),
        recentDrills(8),
        readMaterial(),
        getProfile().catch(() => null),
      ])
        .then(([counts, essay, ethics, recent, material, profile]) => {
          if (!isActive()) return;
          const zone = profile?.timezone ?? DEFAULT_TIMEZONE;
          setToday(localDate(zone));
          setSnapshot({
            stock: bankStock({ counts, lastRefillAttemptAt: null }),
            next: { essay_outline: essay, ethics_case: ethics },
            recent,
            materialCount: material.length,
            materialNote: bankDiagnosis(tallyByKind(material)),
          });
          setLoadError(null);
        })
        .catch((err: Error) => {
          if (isActive()) setLoadError(err.message);
        }),
    [],
  );

  /** Never rejects and does its own gating — see `shouldRefillPrompts`. */
  const runForeground = useCallback(() => {
    refillOnForeground(today)
      .then((outcome) => {
        if (!isMounted()) return;
        // Silent when nothing happened. A note saying "the bank is fine" every
        // time she opens the screen is how a user learns to ignore the one that
        // matters.
        if (outcome.status === 'skipped') return;
        setNote(outcome.reason);
        void load(isMounted);
      })
      .catch(() => undefined);
  }, [isMounted, load, today]);

  useEffect(() => {
    runForeground();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') runForeground();
    });
    return () => subscription.remove();
  }, [runForeground]);

  useEffect(() => {
    let cancelled = false;
    void load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const topUp = useCallback(() => {
    setBusy(true);
    setNote(null);
    refillNow(today)
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
  }, [isMounted, load, today]);

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
      <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>Essay & Ethics</Text>
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        Practice
      </Text>
      <Text style={[styles.lede, { color: theme.textSecondary }]}>
        An outline in {targetMinutes('essay_outline')} minutes carries the three essay dimensions
        you can decide without writing the prose. A case answered part by part tells you which of
        the five moves failed, which one mark out of twenty cannot.
      </Text>

      {loadError !== null ? (
        <Card>
          <Text style={[styles.cardTitle, { color: theme.text }]}>Could not read your practice</Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>{loadError}</Text>
        </Card>
      ) : snapshot === null ? (
        <ActivityIndicator />
      ) : (
        <>
          {snapshot.stock.kinds.map((entry) => {
            const drill = snapshot.next[entry.kind] ?? null;
            return (
              <Card key={entry.kind}>
                <View style={styles.headRow}>
                  <Text style={[styles.cardTitle, { color: theme.text }]}>
                    {labelOf(entry.kind) === 'essay outline' ? 'Essay outline' : 'Ethics case'}
                  </Text>
                  <Pill
                    text={`${entry.banked} banked`}
                    tone={entry.belowLowWater ? 'bad' : 'good'}
                  />
                </View>

                {drill === null ? (
                  <Text style={[styles.body, { color: theme.textSecondary }]}>
                    Nothing banked. Top up while you have signal — a prompt you cannot open on a
                    morning without it is a drill you do not do.
                  </Text>
                ) : (
                  <>
                    <Text style={[styles.prompt, { color: theme.text }]}>{drill.promptText}</Text>
                    <TouchableOpacity
                      onPress={() => router.push(`/practice/${drill.id}`)}
                      accessibilityRole="button"
                      accessibilityLabel={`${
                        drill.status === 'in_progress' ? 'Resume' : 'Start'
                      } ${labelOf(entry.kind)}: ${drill.promptText}`}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      style={styles.tap}
                    >
                      <Text style={[styles.link, { color: theme.text }]}>
                        {drill.status === 'in_progress' ? 'Resume' : 'Start'} ·{' '}
                        {targetMinutes(entry.kind)} min →
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
              </Card>
            );
          })}

          {note !== null && (
            <Card>
              <Text style={[styles.body, { color: theme.textSecondary }]}>{note}</Text>
            </Card>
          )}

          <TouchableOpacity
            onPress={topUp}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            accessibilityLabel={busy ? 'Topping up the prompt bank' : 'Top up the prompt bank'}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.tap}
          >
            {busy ? (
              <View style={styles.row}>
                <ActivityIndicator size="small" color={theme.textSecondary} />
                <Text style={[styles.link, { color: theme.textSecondary }]}> Topping up…</Text>
              </View>
            ) : (
              <Text style={[styles.link, { color: theme.text }]}>
                Top up prompts (target {DRILL_RULES.targetBankedPrompts} each)
              </Text>
            )}
          </TouchableOpacity>

          <Card>
            <View style={styles.headRow}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Material bank</Text>
              <Pill text={`${snapshot.materialCount}`} tone="neutral" />
            </View>
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              {snapshot.materialNote ??
                'Quotes, examples and thinkers, filed by theme. What stops an essay reading as a long GS answer.'}
            </Text>
            <TouchableOpacity
              onPress={() => router.push('/practice/material')}
              accessibilityRole="button"
              accessibilityLabel="Open the material bank"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={styles.tap}
            >
              <Text style={[styles.link, { color: theme.text }]}>Open the bank →</Text>
            </TouchableOpacity>
          </Card>

          {snapshot.recent.length > 0 && (
            <Card>
              <Text style={[styles.cardTitle, { color: theme.text }]}>Recent attempts</Text>
              {snapshot.recent.map((drill) => (
                <TouchableOpacity
                  key={drill.id}
                  onPress={() => router.push(`/practice/sheet/${drill.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open the mark sheet for ${drill.promptText}`}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  style={styles.recentRow}
                >
                  <Text numberOfLines={2} style={[styles.recentText, { color: theme.text }]}>
                    {drill.promptText}
                  </Text>
                  <Text style={[styles.recentScore, { color: theme.textSecondary }]}>
                    {drill.status === 'evaluated' && drill.total !== null
                      ? `${drill.total}/${drill.max}`
                      : drill.status === 'failed'
                        ? 'unmarked'
                        : '…'}
                  </Text>
                </TouchableOpacity>
              ))}
            </Card>
          )}
        </>
      )}

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  eyebrow: { fontSize: 13, marginBottom: 2 },
  h1: { fontSize: 32, fontWeight: '700', marginBottom: 8 },
  lede: { fontSize: 14, lineHeight: 21, marginBottom: 20 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 13, lineHeight: 19 },
  prompt: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', alignItems: 'center' },
  tap: { minHeight: 44, justifyContent: 'center' },
  link: { fontSize: 15, fontWeight: '600' },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 44,
  },
  recentText: { fontSize: 13, flex: 1 },
  recentScore: { fontSize: 13, fontVariant: ['tabular-nums'] },
});
