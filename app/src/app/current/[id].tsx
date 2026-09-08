/**
 * One current-affairs item, in full.
 *
 * The digest card is a summary you decide from; this is the page you decide
 * ON. So the evidence is inline rather than behind a disclosure — at the point
 * of keeping something into a deck you will see for eighteen months, the
 * verbatim quote is the thing worth reading, not an optional extra.
 *
 * Opening the item marks it read. Volume discipline has to be measured against
 * something, and `readAt` is the only input to it — a cap that shrinks when she
 * is not keeping up is only fair if "keeping up" is observed rather than
 * assumed.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Pill } from '@/components/controls';
import { useTheme } from '@/components/form';
import { Markdown } from '@/components/markdown';
import { slugLabel } from '@/components/ca-item-card';
import { db } from '@/db';
import { markCaItemRead, readDigestDay } from '@/db/ca';
import { keepItemAsCard } from '@/db/flashcards';
import { fileCaItemAsMaterial } from '@/db/material';
import { topicFacts } from '@/db/syllabus';
import { caItems, flashcards } from '@/db/schema';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { CA_RULES, type CaItemFacts } from '@/lib/ca-types';
import { canKeep, type KeepDecision } from '@/lib/flashcards';
import { paperLabel } from '@/lib/papers';
import type { TopicFact } from '@/lib/syllabus-coverage';

/**
 * Route params are strings from a URL and can be anything — a deep link, a
 * stale bookmark, a typo. Anything that is not a positive integer is "not
 * found", never a thrown `NaN` query. Same guard as `answer/[id].tsx`.
 */
function parseItemId(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

interface ItemDetail {
  item: CaItemFacts;
  /** Resolved syllabus topics, in `ca_item_topics` rank order. */
  topics: TopicFact[];
  kept: boolean;
  keptToday: number;
  decision: KeepDecision;
}

/**
 * Everything this screen needs, assembled from the repositories that own it.
 *
 * `db/ca.ts` has no read-one-item entry point, so the item's digest day is
 * looked up first and `readDigestDay` supplies the rest. That is deliberately a
 * reuse rather than a fourth hand-rolled row mapper: `readDigestDay` also
 * re-resolves unknown tags and counts today's keeps, and a second mapper would
 * be a second place for the two to drift apart.
 */
async function loadDetail(id: number): Promise<ItemDetail | null> {
  const [row] = await db
    .select({ date: caItems.date })
    .from(caItems)
    .where(eq(caItems.id, id))
    .limit(1);
  if (!row) return null;

  const [day, facts, cardRows] = await Promise.all([
    readDigestDay(row.date),
    topicFacts(),
    db.select({ id: flashcards.id }).from(flashcards).where(eq(flashcards.caItemId, id)).limit(1),
  ]);

  const item = day.items.find((candidate) => candidate.id === id);
  if (item === undefined) return null;

  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const topics = item.topicIds
    .map((topicId) => byId.get(topicId))
    .filter((fact): fact is TopicFact => fact !== undefined);

  const kept = cardRows.length > 0;

  return {
    item,
    topics,
    kept,
    keptToday: day.keptToday,
    // The same gate the write path applies, so the button and the outcome can
    // never disagree — and `reason` is always populated, which is why a
    // disabled button here can say why.
    decision: canKeep({
      keptToday: day.keptToday,
      hasTopic: topics.some((topic) => topic.retiredAt === null),
      alreadyKept: kept,
    }),
  };
}

type LoadState = 'loading' | 'ready' | 'notFound' | 'error';

export default function CurrentItem() {
  const theme = useTheme();
  const router = useRouter();
  const isMounted = useIsMounted();

  const { id } = useLocalSearchParams<{ id: string }>();
  const itemId = useMemo(() => parseItemId(id), [id]);

  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [state, setState] = useState<LoadState>(itemId === null ? 'notFound' : 'loading');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [keepError, setKeepError] = useState<string | null>(null);

  const cardsChangedAt = useLiveQuery(
    db.select({ id: flashcards.id }).from(flashcards),
  ).updatedAt?.getTime();

  const load = useCallback(
    (isActive: () => boolean) => {
      if (itemId === null) return Promise.resolve();
      return loadDetail(itemId)
        .then((next) => {
          if (!isActive()) return;
          setDetail(next);
          setState(next === null ? 'notFound' : 'ready');
        })
        .catch((err: Error) => {
          if (!isActive()) return;
          setErrorText(err.message);
          setState('error');
        });
    },
    [itemId],
  );

  // Promise chain plus a `cancelled` flag: `react-hooks/set-state-in-effect` is
  // an error in this repo, so nothing may setState synchronously from the body.
  useEffect(() => {
    let cancelled = false;
    void load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, cardsChangedAt]);

  // Marking read is a side effect of opening, not of rendering. It sets no
  // state, so it cannot loop, and a failure to record it must not block the
  // read itself.
  useEffect(() => {
    if (itemId === null) return;
    markCaItemRead(itemId).catch(() => undefined);
  }, [itemId]);

  const back = (
    <TouchableOpacity
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/current'))}
      accessibilityRole="button"
      accessibilityLabel="Back to today's digest"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      style={styles.tap}
    >
      <Text style={[styles.back, { color: theme.textSecondary }]}>Back to digest</Text>
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
          {state === 'error' ? 'Could not open this item' : 'Item not found'}
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          {state === 'error'
            ? (errorText ?? 'The database read failed.')
            : itemId === null
              ? `“${id ?? ''}” is not a valid item id. It may be a stale link.`
              : `Item ${itemId} is not in your local database. Digests older than ${CA_RULES.catchUpDays} days are archive, and items can be cleared with the digest that produced them.`}
        </Text>
      </ScrollView>
    );
  }

  if (state === 'loading' || detail === null) {
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

  const { item, topics, kept, keptToday, decision } = detail;
  const source = item.sourceName ?? null;
  const hasPair = Boolean(item.anthroP1Slug && item.anthroP2Slug);

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            // `useIsMounted`, never `() => true` — this route unmounts on back
            // navigation, and a flag that is never false is not a guard.
            void load(isMounted).finally(() => {
              if (isMounted()) setRefreshing(false);
            });
          }}
        />
      }
    >
      {back}

      <View style={styles.pillRow}>
        <Pill text={item.kind} tone={item.kind === 'event' ? 'warn' : 'neutral'} />
        {kept ? <Pill text="kept" tone="good" /> : null}
      </View>

      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        {item.headline}
      </Text>

      {/* One node: kind, source and both dates are a single claim about where
          this came from, not four unrelated fragments. */}
      <Text
        accessible
        accessibilityLabel={`${item.kind} item${
          source ? ` from ${source}` : ', no source recorded'
        }, delivered ${item.date}${
          item.publishedAt && item.publishedAt.slice(0, 10) !== item.date
            ? `, published ${item.publishedAt.slice(0, 10)}`
            : ''
        }.`}
        style={[styles.eyebrow, { color: theme.textSecondary }]}
      >
        {source ?? 'No source recorded'} · delivered {item.date}
        {item.publishedAt && item.publishedAt.slice(0, 10) !== item.date
          ? ` · published ${item.publishedAt.slice(0, 10)}`
          : ''}
      </Text>

      <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
        <Markdown source={item.noteMd} theme={theme} />
      </View>

      {item.anthroLink || item.anthroP1Slug || item.anthroP2Slug ? (
        <View
          style={[styles.card, { backgroundColor: theme.backgroundElement }]}
          accessible
          accessibilityLabel={
            hasPair
              ? `Anthropology link. Paper 1 concept ${slugLabel(
                  item.anthroP1Slug ?? '',
                )}, applied to Paper 2 instance ${slugLabel(item.anthroP2Slug ?? '')}.${
                  item.anthroLink ? ` ${item.anthroLink}` : ''
                }`
              : `Anthropology link, incomplete — only one half of the pair is named.${
                  item.anthroLink ? ` ${item.anthroLink}` : ''
                }`
          }
        >
          <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
            Anthropology
          </Text>
          <Text style={[styles.pair, { color: theme.text }]}>
            <Text style={styles.pairSlug}>
              {item.anthroP1Slug ? slugLabel(item.anthroP1Slug) : 'no P1 concept'}
            </Text>
            <Text style={{ color: theme.textSecondary }}>{'  to  '}</Text>
            <Text style={styles.pairSlug}>
              {item.anthroP2Slug ? slugLabel(item.anthroP2Slug) : 'no P2 instance'}
            </Text>
          </Text>
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            Paper 1 concept, applied to a Paper 2 Indian instance
          </Text>
          {item.anthroLink ? (
            <Text style={[styles.body, { color: theme.text }]}>{item.anthroLink}</Text>
          ) : null}
          {!hasPair ? (
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              Only one half is named, so this will not appear in the monthly Anthropology list.
              The optional credits the move from concept to instance, not either end alone.
            </Text>
          ) : null}
        </View>
      ) : null}

      {/* Inline, not disclosed. This is the page you decide to keep from. */}
      <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
        <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
          Evidence
        </Text>
        {item.evidence.length === 0 ? (
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            No source quote was stored, so this note cannot be checked without a connection. Open
            the source before you rely on it in an answer.
          </Text>
        ) : (
          <>
            {item.evidence.map((entry, index) => (
              <View
                key={index}
                style={[styles.quote, { borderLeftColor: theme.textSecondary }]}
                accessible
                accessibilityLabel={`Quote ${index + 1} of ${item.evidence.length}. ${entry.quote}`}
              >
                <Text style={[styles.quoteText, { color: theme.text }]}>{entry.quote}</Text>
              </View>
            ))}
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              Verbatim from the fetched page and stored on this device. It is what makes the note
              checkable with no signal.
            </Text>
          </>
        )}

        {item.sourceUrl ? (
          <TouchableOpacity
            onPress={() => {
              openBrowserAsync(item.sourceUrl!, {
                presentationStyle: WebBrowserPresentationStyle.AUTOMATIC,
              }).catch(() => undefined);
            }}
            accessibilityRole="link"
            accessibilityLabel={`Open the source${source ? ` at ${source}` : ''} in a browser`}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={[styles.action, { borderColor: theme.textSecondary }]}
          >
            <Text style={[styles.actionText, { color: theme.text }]}>Open source</Text>
          </TouchableOpacity>
        ) : (
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            No source URL was recorded for this item.
          </Text>
        )}
      </View>

      <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
        <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
          Syllabus
        </Text>
        {topics.length === 0 ? (
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            No syllabus topic resolved for this item
            {item.syllabusTags.length > 0
              ? `. The digest proposed ${item.syllabusTags.join(
                  ', ',
                )}, which this build does not recognise. An item is never rejected for that — it stays readable — but it will not file itself into a section of the monthly compilation until the syllabus is re-seeded.`
              : ' and none was proposed.'}
          </Text>
        ) : (
          topics.map((topic, index) => (
            <TouchableOpacity
              key={topic.id}
              onPress={() => router.push(`/syllabus/${topic.paper}`)}
              accessibilityRole="link"
              accessibilityLabel={`${index === 0 ? 'Primary tag' : 'Also tagged'}: ${paperLabel(
                topic.paper,
              )}, ${topic.topic}${
                topic.retiredAt === null ? '' : ', retired from the syllabus'
              }. Opens the syllabus.`}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
              style={styles.topicRow}
            >
              <Text style={[styles.topicPaper, { color: theme.textSecondary }]}>
                {paperLabel(topic.paper)}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={[styles.topicName, { color: theme.text }]}>{topic.topic}</Text>
                {topic.retiredAt !== null ? (
                  <Text style={[styles.note, { color: theme.textSecondary }]}>
                    Retired from the syllabus, so it cannot cue a card.
                  </Text>
                ) : null}
              </View>
            </TouchableOpacity>
          ))
        )}
      </View>

      <TouchableOpacity
        onPress={() => {
          setKeepError(null);
          keepItemAsCard(item.id, new Date().toISOString())
            .then((outcome) => {
              // A refusal is a returned outcome, not a thrown error, so it is
              // rendered as words rather than as a crash.
              if (!outcome.kept && isMounted()) setKeepError(outcome.decision.reason);
              return load(isMounted);
            })
            .catch((err: Error) => {
              if (isMounted()) setKeepError(err.message);
            });
        }}
        disabled={!decision.allowed}
        accessibilityRole="button"
        accessibilityState={{ disabled: !decision.allowed }}
        accessibilityLabel={
          decision.allowed
            ? `Keep this item as a flashcard. ${decision.remaining} of ${CA_RULES.maxKeepsPerDay} keeps left today.`
            : `Keep unavailable. ${decision.reason}`
        }
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={[
          styles.keep,
          { backgroundColor: theme.text, opacity: decision.allowed ? 1 : 0.4 },
        ]}
      >
        <Text style={[styles.keepText, { color: theme.background }]}>
          {kept ? 'Kept as a flashcard' : 'Keep'}
        </Text>
      </TouchableOpacity>

      {/*
        The Phase 4 → Phase 5 bridge, and separate from Keep on purpose.
        Keeping is a spaced-repetition decision capped at two a day, because a
        deck of two thousand cards takes an hour a morning. Filing as essay
        material is a different and much cheaper judgement — "this is a specific
        Indian example I would want in an essay eight months from now" — and
        capping it at two would throw away most of what the digest is for.
      */}
      <TouchableOpacity
        onPress={() => {
          setKeepError(null);
          fileCaItemAsMaterial(item.id)
            .then((id) => {
              if (!isMounted()) return;
              setKeepError(
                id === null
                  ? 'Already in your material bank.'
                  : 'Filed in the material bank, under Essay & Ethics practice.',
              );
            })
            .catch((err: Error) => {
              if (isMounted()) setKeepError(err.message);
            });
        }}
        accessibilityRole="button"
        accessibilityLabel="File this item in the essay material bank"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={styles.tap}
      >
        <Text style={[styles.link, { color: theme.text }]}>File as essay material →</Text>
      </TouchableOpacity>

      {/* The reason is always populated, so a disabled button always says why.
          A control that refuses silently reads as a broken app. */}
      <Text style={[styles.note, { color: theme.textSecondary }]}>
        {decision.reason}
      </Text>
      <Text style={[styles.note, { color: theme.textSecondary }]}>
        {keptToday} of {CA_RULES.maxKeepsPerDay} kept from this digest day.
      </Text>

      {keepError !== null ? (
        <Text style={[styles.note, { color: theme.text }]}>{keepError}</Text>
      ) : null}

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64 },
  tap: { minHeight: 44, justifyContent: 'center' },
  link: { fontSize: 15, fontWeight: '600' },
  back: { fontSize: 15 },
  pillRow: { flexDirection: 'row', gap: 6, marginBottom: 8 },
  h1: { fontSize: 28, fontWeight: '700', lineHeight: 34 },
  eyebrow: { fontSize: 13, marginTop: 6, marginBottom: 18 },
  card: { borderRadius: 14, padding: 18, marginBottom: 16, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  note: { fontSize: 12, lineHeight: 18 },
  pair: { fontSize: 16, lineHeight: 24 },
  pairSlug: { fontWeight: '700' },
  quote: { borderLeftWidth: 2, paddingLeft: 10, paddingVertical: 2 },
  quoteText: { fontSize: 14, lineHeight: 21, fontStyle: 'italic' },
  action: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1.5,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  actionText: { fontSize: 14, fontWeight: '600' },
  topicRow: { flexDirection: 'row', gap: 12, minHeight: 44, alignItems: 'center' },
  topicPaper: { fontSize: 12, width: 68 },
  topicName: { fontSize: 14, fontWeight: '600' },
  keep: { borderRadius: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  keepText: { fontSize: 16, fontWeight: '700' },
});
