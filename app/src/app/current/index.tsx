/**
 * Today's digest.
 *
 * Five states, and they are deliberately five rather than "items or spinner":
 * no digest requested, pending, completed-and-quiet, failed, and items ready.
 * Collapsing them loses the only distinction that matters — an empty screen
 * because the news was thin and an empty screen because the fetch died look
 * identical, and one of them means "go read a newspaper" while the other means
 * "your feed is broken". A digest that never ran is a third thing again.
 *
 * The read budget is stated up front. Twenty minutes is the point of the whole
 * feature: current affairs must not eat the 10:15–12:15 reading block, which is
 * what produces the March 2027 first pass.
 *
 * ## The foreground trigger lives here
 *
 * Same decision, and the same reasoning, as `drill/index.tsx`: not a background
 * task, because Android background execution is throttled or silently disabled
 * by most OEM battery managers, and a daily guarantee that depends on it fails
 * on the devices it was written for. This screen mounting and `AppState` going
 * `active` are both real user actions; the cooldown and cap gates inside
 * `digestOnForeground` decide whether either is worth a network call.
 *
 * Without this the screen was read-only and nothing ever wrote `ca_items`: five
 * carefully distinguished states, all of them reachable only by a runner no
 * code called. It rendered "No digest requested today", correctly, forever.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { isNotNull } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
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

import { CaDigestSummaryCard } from '@/components/ca-digest-summary';
import { CaItemCard } from '@/components/ca-item-card';
import { useTheme } from '@/components/form';
import { db } from '@/db';
import { readDigestDay } from '@/db/ca';
import { keepItemAsCard } from '@/db/flashcards';
import { caDigests, caItems, flashcards } from '@/db/schema';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { digestNow, digestOnForeground } from '@/lib/ca-digest';
import { CA_RULES, type CaItemFacts, type DigestDay } from '@/lib/ca-types';
import { canKeep } from '@/lib/flashcards';
import { localDate } from '@/lib/time';

/**
 * Which items already spawned a card.
 *
 * `db/flashcards.ts` counts keeps per day but does not expose the ids, and the
 * card needs to know whether THIS item is already kept. The whole table is
 * capped at two a day for the preparation — a few hundred rows — so one
 * unfiltered read is cheaper than the join it would replace.
 */
async function loadKeptItemIds(): Promise<Set<number>> {
  const rows = await db
    .select({ caItemId: flashcards.caItemId })
    .from(flashcards)
    .where(isNotNull(flashcards.caItemId));
  return new Set(rows.map((row) => row.caItemId).filter((id): id is number => id !== null));
}


export default function CurrentDigest() {
  const theme = useTheme();
  const router = useRouter();
  const isMounted = useIsMounted();

  const today = localDate('Asia/Kolkata');

  const [day, setDay] = useState<DigestDay | null>(null);
  const [keptIds, setKeptIds] = useState<ReadonlySet<number>>(new Set());
  const [keepNotice, setKeepNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  // Re-reads when the digest runner writes, so a screen left open while the
  // fetch is in flight fills itself in rather than sitting on "pending".
  const itemsChangedAt = useLiveQuery(
    db.select({ id: caItems.id, readAt: caItems.readAt }).from(caItems),
  ).updatedAt?.getTime();
  const digestsChangedAt = useLiveQuery(
    db.select({ id: caDigests.id, status: caDigests.status }).from(caDigests),
  ).updatedAt?.getTime();
  const cardsChangedAt = useLiveQuery(
    db.select({ id: flashcards.id }).from(flashcards),
  ).updatedAt?.getTime();

  const load = useCallback(
    (isActive: () => boolean) =>
      Promise.all([readDigestDay(today), loadKeptItemIds()])
        .then(([next, kept]) => {
          if (!isActive()) return;
          setDay(next);
          setKeptIds(kept);
          setLoadError(null);
        })
        .catch((err: Error) => {
          if (isActive()) setLoadError(err.message);
        }),
    [today],
  );

  const keep = useCallback(
    (item: CaItemFacts) => {
      setKeepNotice(null);
      keepItemAsCard(item.id, new Date().toISOString())
        .then((outcome) => {
          // A refusal is a returned outcome carrying words, not an exception.
          if (!outcome.kept && isMounted()) setKeepNotice(outcome.decision.reason);
          return load(isMounted);
        })
        .catch((err: Error) => {
          if (isMounted()) setKeepNotice(err.message);
        });
    },
    [load, isMounted],
  );

  /**
   * The automatic attempt. Never rejects and does its own gating: inside the
   * cooldown, over the daily cap, or already completed for today, it returns
   * `skipped` without touching the network.
   */
  const runForeground = useCallback(() => {
    digestOnForeground()
      .then((outcome) => {
        if (!isMounted()) return;
        // Silent when nothing happened. A note saying "no digest needed" every
        // time she opens the tab is how a user learns to ignore the one that
        // matters — `drill/index.tsx` makes the same call for the same reason.
        if (outcome.status === 'skipped') return;
        setFetchNote(outcome.reason);
        void load(isMounted);
      })
      .catch(() => undefined);
  }, [isMounted, load]);

  useEffect(() => {
    runForeground();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') runForeground();
    });
    return () => subscription.remove();
  }, [runForeground]);

  /** The explicit tap. Bypasses the cooldown; the spend cap still binds. */
  const fetchToday = useCallback(() => {
    setFetching(true);
    setFetchNote(null);
    digestNow()
      .then((outcome) => {
        if (!isMounted()) return;
        setFetchNote(outcome.reason);
        return load(isMounted);
      })
      .catch((err: Error) => {
        if (isMounted()) setFetchNote(err.message);
      })
      .finally(() => {
        if (isMounted()) setFetching(false);
      });
  }, [isMounted, load]);

  // Promise chain plus a `cancelled` flag: `react-hooks/set-state-in-effect` is
  // an error in this repo, so nothing may setState synchronously from the body.
  useEffect(() => {
    let cancelled = false;
    void load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, itemsChangedAt, digestsChangedAt, cardsChangedAt]);

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            // `useIsMounted`, not `() => true`: this route unmounts on back
            // navigation, and a flag that is never false is not a guard.
            void load(isMounted).finally(() => {
              if (isMounted()) setRefreshing(false);
            });
          }}
        />
      }
    >
      <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>{today}</Text>
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        Current affairs
      </Text>

      {loadError !== null ? (
        <View
          style={[styles.card, { backgroundColor: theme.backgroundElement }]}
          accessible
          accessibilityLabel={`Could not read today's digest. ${loadError}`}
        >
          <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
            Could not read today&apos;s digest
          </Text>
          <Text style={[styles.note, { color: theme.textSecondary }]}>{loadError}</Text>
        </View>
      ) : null}

      {day === null ? (
        <Text style={{ color: theme.textSecondary }}>Loading…</Text>
      ) : (
        <DigestBody
          day={day}
          keptIds={keptIds}
          keepNotice={keepNotice}
          onKeep={keep}
          onOpen={(item) => router.push(`/current/${item.id}`)}
        />
      )}

      {fetchNote !== null && (
        <View
          style={[styles.card, { backgroundColor: theme.backgroundElement }]}
          accessible
          accessibilityLabel={fetchNote}
        >
          <Text style={[styles.note, { color: theme.textSecondary }]}>{fetchNote}</Text>
        </View>
      )}

      <View style={{ height: 8 }} />
      <TouchableOpacity
        onPress={fetchToday}
        disabled={fetching}
        accessibilityRole="button"
        accessibilityState={{ disabled: fetching }}
        accessibilityLabel={
          fetching ? 'Fetching today\u2019s digest' : 'Fetch today\u2019s digest now'
        }
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={styles.tap}
      >
        {fetching ? (
          <View style={styles.row}>
            <ActivityIndicator size="small" color={theme.textSecondary} />
            <Text style={[styles.link, { color: theme.textSecondary }]}>  Fetching…</Text>
          </View>
        ) : (
          <Text style={[styles.link, { color: theme.text }]}>
            {day !== null && day.status === 'completed' && day.items.length > 0
              ? 'Fetch again'
              : 'Fetch today\u2019s digest'}
          </Text>
        )}
      </TouchableOpacity>

      <View style={{ height: 8 }} />
      <TouchableOpacity
        onPress={() => router.push('/current/archive')}
        accessibilityRole="button"
        accessibilityLabel="Open the monthly compilation archive"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={styles.tap}
      >
        <Text style={[styles.link, { color: theme.text }]}>Monthly compilation →</Text>
      </TouchableOpacity>
      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ states */

function DigestBody({
  day,
  keptIds,
  keepNotice,
  onKeep,
  onOpen,
}: {
  day: DigestDay;
  keptIds: ReadonlySet<number>;
  keepNotice: string | null;
  onKeep: (item: CaItemFacts) => void;
  onOpen: (item: CaItemFacts) => void;
}) {
  const theme = useTheme();

  if (day.status === 'none') {
    return (
      <StateCard
        title="No digest requested today"
        body={
          'Nothing has been fetched for today yet. This is not an error and there is no backlog ' +
          'to clear — a current-affairs backlog is not recoverable the way a lecture backlog is, ' +
          `so anything older than ${CA_RULES.catchUpDays} days is archive rather than debt.`
        }
      />
    );
  }

  if (day.status === 'pending') {
    return (
      <StateCard
        title="Digest in progress"
        body={
          'The fetch has started and no items have landed yet. This screen updates itself when ' +
          'they do, so there is nothing to wait on it for.'
        }
      />
    );
  }

  if (day.status === 'failed') {
    return (
      <>
        <StateCard
          title="Today's digest failed"
          body={
            'No items were produced, and that is a fact about the fetch rather than about the ' +
            'news. Do not read today as a quiet day. Earlier days are still in the archive, and ' +
            'the standard-book reading block is unaffected.'
          }
          tone="bad"
        />
        <CaDigestSummaryCard summary={day.summary} itemsShown={day.items.length} />
      </>
    );
  }

  // Completed or partial, but nothing came through.
  if (day.items.length === 0) {
    return (
      <>
        <StateCard
          title="A quiet day"
          body={
            'The digest ran and kept nothing. On the selection rule this app uses that is a ' +
            'normal outcome rather than a malfunction: most of what a newspaper prints is an ' +
            'event, and events rarely earn a slot. What was looked at is below.'
          }
        />
        <CaDigestSummaryCard summary={day.summary} itemsShown={0} />
      </>
    );
  }

  return (
    <>
      {/* Figure and its qualifier as one node — a screen reader reading "6",
          "20" and "2" as separate fragments conveys none of the claim. */}
      <View
        accessible
        accessibilityLabel={`${day.items.length} ${
          day.items.length === 1 ? 'item' : 'items'
        } today, about ${day.estimatedMinutes} ${
          day.estimatedMinutes === 1 ? 'minute' : 'minutes'
        } of reading, ${day.unread} still unread. The daily budget is ${
          CA_RULES.dailyBudgetMinutes
        } minutes.`}
        style={[styles.budget, { backgroundColor: theme.backgroundElement }]}
      >
        <Text style={[styles.budgetFigure, { color: theme.text }]}>
          {day.items.length} {day.items.length === 1 ? 'item' : 'items'} · ~{day.estimatedMinutes}{' '}
          min
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          {day.unread} unread. The budget is {CA_RULES.dailyBudgetMinutes} minutes a day, most of
          it for writing the link into your own notes rather than for reading. Current affairs
          must not eat the standard-book block.
        </Text>
        {day.status === 'partial' ? (
          <Text style={[styles.note, { color: theme.text }]}>
            This digest completed only partly. Some sources did not return, so treat the count as
            a floor rather than the day&apos;s full crop.
          </Text>
        ) : null}
      </View>

      {keepNotice !== null ? (
        <Text style={[styles.note, { color: theme.text, marginBottom: 12 }]}>{keepNotice}</Text>
      ) : null}

      {day.items.map((item) => {
        const kept = keptIds.has(item.id);
        // The same gate the write path applies, so the button and the outcome
        // cannot disagree — and `reason` is always populated, which is what
        // lets a disabled Keep say why it is disabled.
        const decision = canKeep({
          keptToday: day.keptToday,
          hasTopic: item.topicIds.length > 0,
          alreadyKept: kept,
        });
        return (
          <CaItemCard
            key={item.id}
            item={item}
            kept={kept}
            keepDisabledReason={decision.allowed ? null : decision.reason}
            onKeep={onKeep}
            onPress={onOpen}
          />
        );
      })}

      <CaDigestSummaryCard summary={day.summary} itemsShown={day.items.length} />
    </>
  );
}

function StateCard({
  title,
  body,
  tone = 'neutral',
}: {
  title: string;
  body: string;
  tone?: 'neutral' | 'bad';
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.backgroundElement },
        tone === 'bad' ? { borderLeftWidth: 3, borderLeftColor: theme.text } : null,
      ]}
      accessible
      accessibilityLabel={`${title}. ${body}`}
    >
      <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
        {title}
      </Text>
      <Text style={[styles.note, { color: theme.textSecondary }]}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  eyebrow: { fontSize: 13, marginBottom: 2 },
  h1: { fontSize: 32, fontWeight: '700', marginBottom: 20 },
  card: { borderRadius: 14, padding: 18, marginBottom: 16, gap: 6 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  budget: { borderRadius: 14, padding: 18, marginBottom: 16, gap: 6 },
  budgetFigure: { fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  note: { fontSize: 12, lineHeight: 18 },
  tap: { minHeight: 44, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  link: { fontSize: 15, fontWeight: '600' },
});
