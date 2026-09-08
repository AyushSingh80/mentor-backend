/**
 * Revise — today's spaced-repetition list, one topic at a time.
 *
 * Entirely a view over local SQLite, so it works on a train with no signal.
 *
 * ## Reveal, then grade
 *
 * The topic name alone is the cue. Nothing else is shown until she taps
 * through, because seeing the interval or the past grades first anchors the
 * self-assessment — an item labelled "you found this easy" gets graded easy.
 * The scheduling numbers appear only alongside the buttons, once the recall
 * attempt is already over.
 *
 * ## One item at a time
 *
 * There is no index or cursor. The current item is always the head of the due
 * list, and grading it moves its `dueAt` at least a day into the future, so it
 * drops out of the rebuilt list and the next one takes its place. That is
 * guaranteed rather than hoped for: `SM2.firstInterval` is 1, so even a
 * failure schedules for tomorrow. A cursor would have to be reconciled against
 * a list that changes underneath it on every write; this cannot desynchronise.
 *
 * ## Reactivity
 *
 * `enableChangeListener` is on, so `useLiveQuery` over the queue gives a
 * change signal for free. It cannot wrap `buildDeck()` directly — that runs
 * several queries and does work in JS — so it is used for what it can do: a
 * cheap live select whose `updatedAt` drives a reload. Building the deck also
 * lazily enrols new topics, so the first build after a topic reaches first
 * pass writes, which re-fires the listener and rebuilds once more. That
 * settles immediately: enrolment is idempotent, and the second build writes
 * nothing.
 *
 * The effect uses promise chains and a `cancelled` flag (as `history.tsx`
 * does) because `react-hooks/set-state-in-effect` is an error in this repo and
 * nothing may setState synchronously in an effect body.
 *
 * ## Two decks, never one
 *
 * Fact cards kept from the current-affairs digest are a SEPARATE list below the
 * topic deck — separate exactly as `leeches` is separate, and never merged into
 * `due`. The reason is concrete rather than cosmetic: a topic review is a
 * ~90-second recall over a whole syllabus leaf, a fact card is a ~10-second
 * one. Merged, `DAILY_REVIEW_CAP = 20` would mean two different things at once
 * and would stop sizing the morning block, which is the one thing that number
 * is for. They have separate caps, separate counts and separate empty states.
 *
 * The grading control is shared, though — `ReviewControls`, unchanged. There is
 * one SM-2 grader in this app and its previews come from `applyReview` itself.
 *
 * ## Two 1–5 scales, kept apart
 *
 * `syllabusTopics.confidence` is a standing self-report and is edited on the
 * syllabus screen. The grades here are recall performance right now. Neither
 * is derived from the other and they never appear in the same control.
 */

import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
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

import { Card, Pill, Row } from '@/components/controls';
import { FlashcardReview } from '@/components/flashcard-review';
import { useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { ReviewControls } from '@/components/review-controls';
import { db } from '@/db';
import { buildCardDeck, gradeCard, type CardDeck, type DueCard } from '@/db/flashcards';
import { getProfile } from '@/db/profile';
import { buildDeck, gradeTopic, type DueTopic, type RevisionDeck } from '@/db/revision';
import { flashcards, revisionQueue } from '@/db/schema';
import { SM2, type ReviewGrade } from '@/lib/sm2';
import { localDate } from '@/lib/time';

const FALLBACK_TIMEZONE = 'Asia/Kolkata';

export default function Revise() {
  const theme = useTheme();
  const isMounted = useIsMounted();

  const [timezone, setTimezone] = useState(FALLBACK_TIMEZONE);
  const [deck, setDeck] = useState<RevisionDeck | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [grading, setGrading] = useState(false);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The card half. Separate state throughout, so grading a card never disables
  // the topic buttons and a failure in one deck cannot blank the other.
  const [cardDeck, setCardDeck] = useState<CardDeck | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [cardRevealed, setCardRevealed] = useState(false);
  const [cardGrading, setCardGrading] = useState(false);

  // Change signals only — one narrow column keeps each listener query cheap.
  const queueChangedAt = useLiveQuery(
    db.select({ id: revisionQueue.id, dueAt: revisionQueue.dueAt }).from(revisionQueue),
  ).updatedAt?.getTime();
  // Cards are never lazily enrolled, so unlike `buildDeck` this listener cannot
  // be re-fired by the load it triggers.
  const cardsChangedAt = useLiveQuery(
    db.select({ id: flashcards.id, dueAt: flashcards.dueAt }).from(flashcards),
  ).updatedAt?.getTime();

  const today = useMemo(() => localDate(timezone), [timezone]);

  const load = useCallback((isActive: () => boolean) => {
    // The timezone has to come first: the whole schedule is keyed on the local
    // calendar day, and at 02:00 in Asia/Kolkata a UTC date is still yesterday.
    getProfile()
      .then((row) => {
        const zone = row?.timezone ?? FALLBACK_TIMEZONE;
        if (isActive()) setTimezone(zone);
        const day = localDate(zone);

        // Two independent reads, deliberately not chained: the topic deck must
        // render even if the card deck read fails, and vice versa. Same shape
        // as `history.tsx`'s secondary loads — except the error is kept rather
        // than swallowed, because a card deck that silently stops appearing
        // looks exactly like a card deck she has finished.
        buildCardDeck(day)
          .then((next) => {
            if (!isActive()) return;
            setCardDeck(next);
            setCardError(null);
          })
          .catch((err: Error) => {
            if (isActive()) setCardError(err.message);
          });

        return buildDeck(day);
      })
      .then((next) => {
        if (!isActive()) return;
        setDeck(next);
        setError(null);
      })
      .catch((err: Error) => {
        if (isActive()) setError(err.message);
      })
      .finally(() => {
        if (isActive()) setLoaded(true);
      });
    // No dependencies: `load` receives its liveness check as a parameter rather
    // than closing over one, so the effect and the refresh handler can each
    // supply their own.
  }, []);

  useEffect(() => {
    let cancelled = false;
    load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, queueChangedAt, cardsChangedAt]);

  /**
   * The item on screen: whatever she tapped in the stuck list, else the head
   * of the due list, else the first stuck topic. That last fallback is what
   * makes a leech-only day workable rather than an empty screen with a
   * separate pile of untouchable rows.
   */
  const current = useMemo<DueTopic | null>(() => {
    if (!deck) return null;
    if (focusId !== null) {
      const focused = [...deck.due, ...deck.leeches].find((t) => t.topicId === focusId);
      if (focused) return focused;
    }
    return deck.due[0] ?? deck.leeches[0] ?? null;
  }, [deck, focusId]);

  /**
   * The card on screen: the head of the due list, else the first stuck card.
   * No cursor, for the topic list's reason — grading moves `dueAt` at least a
   * day out (`SM2.firstInterval` is 1, so even a failure schedules tomorrow),
   * so the graded card drops out of the rebuilt list and the next takes its
   * place. Nothing can desynchronise.
   */
  const currentCard = useMemo<DueCard | null>(() => {
    if (!cardDeck) return null;
    return cardDeck.due[0] ?? cardDeck.leeches[0] ?? null;
  }, [cardDeck]);

  const gradeFact = useCallback(
    (cardId: number, value: ReviewGrade) => {
      setCardGrading(true);
      // Hide the answer immediately: the next card must never appear with the
      // previous one's grading panel already open.
      setCardRevealed(false);

      gradeCard({ cardId, grade: value, todayIso: today })
        .then(() => {
          setCardError(null);
          load(isMounted);
        })
        .catch((err: Error) => setCardError(err.message))
        .finally(() => setCardGrading(false));
    },
    [today, load, isMounted],
  );

  const grade = useCallback(
    (topicId: number, value: ReviewGrade) => {
      setGrading(true);
      // Hide the answer immediately: the next item must never appear with the
      // previous one's grading panel already open.
      setRevealed(false);

      gradeTopic({ topicId, grade: value, todayIso: today })
        .then(() => {
          setFocusId(null);
          setError(null);
          // The change listener would rebuild anyway; doing it here as well
          // means the list never depends on the listener having fired.
          load(isMounted);
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => setGrading(false));
    },
    [today, load, isMounted],
  );

  const remaining = deck ? deck.due.length : 0;

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
            // Local SQLite: the spinner acknowledges the gesture, it does not
            // time the query.
            setTimeout(() => setRefreshing(false), 350);
          }}
        />
      }
    >
      <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>{today}</Text>
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        Revise
      </Text>

      {error ? (
        <Card>
          <Text style={{ color: theme.text }}>Could not build today&apos;s list: {error}</Text>
        </Card>
      ) : null}

      {!loaded ? (
        <View style={styles.loading}>
          <ActivityIndicator />
        </View>
      ) : !deck || current === null ? (
        <EmptyState queued={deck?.queued ?? 0} theme={theme} />
      ) : (
        <>
          <Card>
            <View style={styles.pills}>
              <Pill text={current.paperLabel} />
              {current.daysOverdue > 0 ? (
                <Pill
                  text={
                    current.daysOverdue === 1 ? '1 day late' : `${current.daysOverdue} days late`
                  }
                  tone="warn"
                />
              ) : null}
              {current.isLeech ? <Pill text="Stuck" tone="bad" /> : null}
            </View>

            <Text style={[styles.topic, { color: theme.text }]}>{current.topic}</Text>
            {current.subtopic ? (
              <Text style={[styles.subtopic, { color: theme.textSecondary }]}>
                {current.subtopic}
              </Text>
            ) : null}

            {revealed ? (
              <View style={styles.gradePanel}>
                <Row
                  label="Last reviewed"
                  value={current.lastReviewedAt ? current.lastReviewedAt.slice(0, 10) : 'Never'}
                />
                <Row
                  label="Current interval"
                  value={
                    current.state.repetitions === 0
                      ? 'First recall'
                      : `${current.state.intervalDays} days`
                  }
                />
                <Row
                  label="Ease"
                  value={
                    current.state.easeFactor <= SM2.minEase
                      ? `${current.state.easeFactor.toFixed(2)} — at the floor`
                      : current.state.easeFactor.toFixed(2)
                  }
                />
                {current.state.lapses > 0 ? (
                  <Row label="Times forgotten" value={String(current.state.lapses)} />
                ) : null}

                <Text style={[styles.gradePrompt, { color: theme.text }]}>How did that go?</Text>
                <ReviewControls
                  state={current.state}
                  todayIso={today}
                  disabled={grading}
                  onGrade={(value) => grade(current.topicId, value)}
                />
              </View>
            ) : (
              <>
                <Text style={[styles.prompt, { color: theme.textSecondary }]}>
                  Recall it before you look — the arguments, the examples, the counterpoint. Out
                  loud or on paper. Grading yourself on what you actually retrieved is what makes
                  the schedule mean anything.
                </Text>
                <TouchableOpacity
                  onPress={() => setRevealed(true)}
                  accessibilityRole="button"
                  accessibilityLabel="I have recalled what I can. Show the grading buttons."
                  style={[styles.reveal, { backgroundColor: theme.text }]}
                >
                  <Text style={[styles.revealText, { color: theme.background }]}>
                    I&apos;ve recalled what I can
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </Card>

          <Text
            accessibilityRole="text"
            style={[styles.remaining, { color: theme.textSecondary }]}
          >
            {remaining === 0
              ? 'Nothing left in the main list today.'
              : remaining === 1
                ? '1 topic left today.'
                : `${remaining} topics left today.`}
            {deck.heldBack > 0
              ? ` ${deck.heldBack} more are due but held back — a capped day you finish beats a hundred-item day you abandon. They lead tomorrow's list.`
              : ''}
          </Text>
        </>
      )}

      {deck && deck.leeches.length > 0 ? (
        <LeechCard
          leeches={deck.leeches}
          currentId={current?.topicId ?? null}
          theme={theme}
          onFocus={(topicId) => {
            setFocusId(topicId);
            setRevealed(false);
          }}
        />
      ) : null}

      <FactCards
        deck={cardDeck}
        card={currentCard}
        error={cardError}
        today={today}
        revealed={cardRevealed}
        grading={cardGrading}
        theme={theme}
        onReveal={() => setCardRevealed(true)}
        onGrade={gradeFact}
      />

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- fragments */

type Theme = ReturnType<typeof useTheme>;

/**
 * Nothing due.
 *
 * Worth saying out loud that this is the system working. An empty revision
 * screen looks exactly like a broken one, and the instinct it provokes —
 * "let me revise something anyway" — is precisely what spaced repetition
 * exists to stop.
 */
function EmptyState({ queued, theme }: { queued: number; theme: Theme }) {
  if (queued === 0) {
    return (
      <Card title="Nothing in the queue yet">
        <Text style={[styles.body, { color: theme.textSecondary }]}>
          Topics join this queue on their own, the day after you mark them as a first pass on the
          syllabus screen. There is nothing to add by hand.
        </Text>
      </Card>
    );
  }

  return (
    <Card title="Nothing due today">
      <Text style={[styles.body, { color: theme.textSecondary }]}>
        This is the schedule working, not a broken screen. Spaced repetition shows a topic back to
        you just before you would have forgotten it — and today, none of your {queued} topics has
        reached that point.
      </Text>
      <Text style={[styles.body, { color: theme.textSecondary }]}>
        Spend the block on a new topic or an answer instead. Revising something that is not due
        costs the time and adds almost nothing to how well you will remember it.
      </Text>
    </Card>
  );
}

/**
 * Leeches — items ground down to the ease floor that get failed every time.
 *
 * Kept out of the main list on purpose. Left in, a handful of them would eat
 * the daily cap every single day and crowd out material that is actually
 * moving. Hidden, they would quietly rot. So they get their own list, their
 * own count, and different advice: re-read the source, do not grind the recall.
 */
function LeechCard({
  leeches,
  currentId,
  theme,
  onFocus,
}: {
  leeches: DueTopic[];
  currentId: number | null;
  theme: Theme;
  onFocus: (topicId: number) => void;
}) {
  return (
    <Card title={`Stuck on these (${leeches.length})`}>
      <Text style={[styles.body, { color: theme.textSecondary }]}>
        You have forgotten each of these at least {SM2.leechThreshold} times, so they are back
        every day and getting nowhere. Re-read the source material once, properly, before you try
        to recall them again — another failed attempt teaches nothing.
      </Text>
      {leeches.map((item) => (
        <TouchableOpacity
          key={item.topicId}
          onPress={() => onFocus(item.topicId)}
          accessibilityRole="button"
          accessibilityState={{ selected: item.topicId === currentId }}
          accessibilityLabel={`${item.topic}, ${item.paperLabel}, forgotten ${item.state.lapses} times. Review this one now.`}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          style={styles.leechRow}
        >
          <View style={styles.leechBody}>
            <Text style={[styles.leechMeta, { color: theme.textSecondary }]}>
              {item.paperLabel}
            </Text>
            <Text style={[styles.leechTopic, { color: theme.text }]} numberOfLines={2}>
              {item.topic}
            </Text>
          </View>
          <Text style={[styles.leechCount, { color: theme.textSecondary }]}>
            {item.state.lapses}×
          </Text>
        </TouchableOpacity>
      ))}
    </Card>
  );
}

/**
 * The card deck — a second list, below the topic deck and never inside it.
 *
 * Rendered as its own section with its own heading and its own count, so the
 * "N topics left today" line above it keeps meaning topics. Merging the two
 * would make one number stand for two different units of work; see the header.
 *
 * Nothing renders at all until she has kept something, because an empty section
 * explaining a feature she has not used yet is just noise on the screen she
 * opens every morning.
 */
function FactCards({
  deck,
  card,
  error,
  today,
  revealed,
  grading,
  theme,
  onReveal,
  onGrade,
}: {
  deck: CardDeck | null;
  card: DueCard | null;
  error: string | null;
  today: string;
  revealed: boolean;
  grading: boolean;
  theme: Theme;
  onReveal: () => void;
  onGrade: (cardId: number, grade: ReviewGrade) => void;
}) {
  if (error) {
    return (
      <Card title="Fact cards">
        <Text style={[styles.body, { color: theme.text }]}>
          Could not build the card list: {error}
        </Text>
      </Card>
    );
  }

  if (!deck || deck.queued === 0) return null;

  const remaining = deck.due.length;

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.h2, { color: theme.text }]}>
        Fact cards
      </Text>

      {card === null ? (
        <Card>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            None of your {deck.queued} cards is due today. Like the topics above, this is the
            schedule working rather than a short list.
          </Text>
        </Card>
      ) : (
        <>
          <FlashcardReview
            card={card}
            todayIso={today}
            revealed={revealed}
            disabled={grading}
            onGrade={(value) => onGrade(card.cardId, value)}
            onReveal={onReveal}
          />
          <Text style={[styles.remaining, { color: theme.textSecondary }]}>
            {remaining === 0
              ? 'No ordinary cards left today.'
              : remaining === 1
                ? '1 card left today.'
                : `${remaining} cards left today.`}
            {' Ten seconds each — these are facts, not topics.'}
            {deck.heldBack > 0 ? ` ${deck.heldBack} more are held back until tomorrow.` : ''}
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  eyebrow: { fontSize: 13, marginBottom: 2 },
  h1: { fontSize: 32, fontWeight: '700', marginBottom: 20 },
  h2: { fontSize: 20, fontWeight: '700', marginBottom: 10 },
  section: { marginTop: 8 },
  loading: { paddingVertical: 40, alignItems: 'center' },
  body: { fontSize: 13, lineHeight: 20, marginTop: 6 },

  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  topic: { fontSize: 22, fontWeight: '700', lineHeight: 29 },
  subtopic: { fontSize: 15, lineHeight: 21, marginTop: 4 },
  prompt: { fontSize: 13, lineHeight: 20, marginTop: 14 },

  reveal: {
    borderRadius: 12,
    // 44pt is the iOS HIG floor; this is the only control on screen, so it
    // gets more.
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 18,
  },
  revealText: { fontSize: 16, fontWeight: '700' },

  gradePanel: { marginTop: 16, gap: 2 },
  gradePrompt: { fontSize: 15, fontWeight: '600', marginTop: 14 },

  remaining: { fontSize: 13, lineHeight: 20, marginTop: -4, marginBottom: 16 },

  leechRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  leechBody: { flex: 1, gap: 2 },
  leechMeta: { fontSize: 12 },
  leechTopic: { fontSize: 14, lineHeight: 20 },
  leechCount: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
