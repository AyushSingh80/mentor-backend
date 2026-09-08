/**
 * The drill. One hand, on a moving train, twelve minutes.
 *
 * ## Offline by construction
 *
 * There is no server status, no network spinner and no connectivity error
 * anywhere on this screen, because there is no network call on this screen.
 * The questions were banked on wifi and every answer is written to local
 * SQLite. A drill that could show "reconnecting…" would be a drill she cannot
 * trust in a tunnel, which is the only place it is ever used.
 *
 * ## Save per question, never "review then submit"
 *
 * Phase 1's save-before-network rule applied per question. The app can be
 * killed between any two taps, so an answer is durable the moment it is
 * committed — `recordAttempt` is a synchronous transaction and returns only
 * once the row and its re-drill consequence are both on disk. The position in
 * the set is then DERIVED from those rows on mount rather than stored, so a
 * crash cannot leave a cursor pointing at a question that was never answered.
 *
 * *Transient* interruption (pocketed, backgrounded, a phone call): nothing to
 * do — every committed attempt is already durable and the clock simply stops
 * counting. *Terminal* interruption: the session stays `in_progress` and is
 * resumable for the rest of the local calendar day, then auto-closes as
 * `abandoned` the next time a session list is built. Leaving this screen
 * therefore writes nothing at all.
 *
 * ## Two presets, one screen
 *
 * `micro` reveals after each question and shows no clock. `timed` reveals only
 * at the end — a set that shows the answer mid-way is not a measurement — and
 * runs a visible countdown that auto-submits the remainder as SKIPS at zero.
 * Both go through the same pad, the same machine and the same persistence;
 * `lib/mcq-session.ts` holds the four differences and this file branches on
 * them rather than duplicating a flow.
 *
 * ## Layout
 *
 * The stem scrolls in the middle. The pad is pinned above the safe-area inset
 * and holds every control the drill loop uses, so her thumb never travels. The
 * only control outside it is the back link, which is navigation rather than
 * part of the loop and sits where it does on every other screen in the app.
 *
 * There is deliberately **no horizontal swipe to advance**: it fights the
 * router's back gesture and is unreliable with the thumb that is also holding
 * the phone. Every transition is an explicit tap.
 *
 * ## Lint
 *
 * `react-hooks/set-state-in-effect` is an error in this repo, so nothing here
 * setStates synchronously from an effect body: loads use promise chains with a
 * `cancelled` flag, the countdown setStates from an interval callback, and
 * `useIsMounted` guards the handlers that are not effects.
 */

import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Card, Pill } from '@/components/controls';
import { useTheme } from '@/components/form';
import { McqElimination } from '@/components/mcq-elimination';
import { DisputeTrigger, McqDisputeSheet } from '@/components/mcq-dispute-sheet';
import { McqAdvanceButton, McqOptionPad } from '@/components/mcq-option-pad';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { disputeQuestion } from '@/db/mcq-questions';
import { getProfile } from '@/db/profile';
import {
  closeStaleSessions,
  extendSession,
  finishSession,
  loadRun,
  recordAttempt,
  type DrillRun,
} from '@/db/mcq-sessions';
import {
  activeMillis,
  activeSeconds,
  advance,
  autoSubmitSkips,
  canExtend,
  commit,
  commitAnswer,
  EXTEND_STEP,
  remainingSeconds,
  sessionBudgetSeconds,
  startMachine,
  toggleGuess,
  type ClockEvent,
  type DrillMachine,
} from '@/lib/mcq-session';
import { paperLabel } from '@/lib/papers';
import { localDate } from '@/lib/time';
import type { AttemptRecord, DisputeReason } from '@/lib/mcq-types';

type LoadState = 'loading' | 'ready' | 'notFound' | 'error';

const FALLBACK_TIMEZONE = 'Asia/Kolkata';

/**
 * Route params are strings from a URL and can be anything — a deep link, a
 * stale bookmark, a typo. Anything that is not a positive integer is "not
 * found", never a thrown NaN query. Exactly as `answer/[id].tsx` guards.
 */
function parseSessionId(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** `1830` -> `30:30`. Monospaced digits so the clock does not jitter. */
function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

interface Revealed {
  chosenIndex: number | null;
  correct: boolean;
  guessed: boolean;
}

export default function DrillRunScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isMounted = useIsMounted();
  const { id } = useLocalSearchParams<{ id: string }>();
  const sessionId = useMemo(() => parseSessionId(id), [id]);

  const [timezone, setTimezone] = useState(FALLBACK_TIMEZONE);
  const [run, setRun] = useState<DrillRun | null>(null);
  const [attempts, setAttempts] = useState<AttemptRecord[]>([]);
  const [machine, setMachine] = useState<DrillMachine>({
    index: 0,
    phase: 'answering',
    guessing: false,
  });
  const [state, setState] = useState<LoadState>(sessionId === null ? 'notFound' : 'loading');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  /**
   * Seconds left in a timed set, or `null` where there is no clock.
   *
   * STATE rather than a value derived during render: the elapsed figure comes
   * from `clockRef`, and `react-hooks/refs` forbids reading a ref during render
   * — correctly, since a ref mutation would not re-render the countdown anyway.
   * The interval below owns it.
   */
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [disputeBusy, setDisputeBusy] = useState(false);
  const [disputeError, setDisputeError] = useState<string | null>(null);
  /** Disputed in THIS session — the trigger must not reopen for them. */
  const [disputedIds, setDisputedIds] = useState<ReadonlySet<number>>(new Set());

  /**
   * Foreground-and-focused transitions. A ref rather than state: appending one
   * must not re-render a screen that is mid-question, and `activeSeconds`
   * reads the whole list at commit time anyway.
   */
  const clockRef = useRef<ClockEvent[]>([]);
  const focusedRef = useRef(true);
  // Seeded on load, not here: `Date.now()` during render is impure and
  // `react-hooks/purity` rejects it. Nothing reads either ref before the load
  // settles, because nothing but the loading state renders until then.
  const questionStartRef = useRef<number>(0);
  /** Set synchronously in `commitChoice` — see the note there. */
  const committingRef = useRef(false);
  const sessionStartRef = useRef<number>(0);
  const autoSubmitRef = useRef<() => void>(() => undefined);
  const autoSubmittedRef = useRef(false);

  /* ------------------------------------------------------------- restore */

  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;

    // The timezone comes first: `studyDate`, the re-drill schedule and the
    // resumability window are all keyed on the LOCAL calendar day, and at 02:00
    // in Asia/Kolkata a UTC date is still yesterday.
    getProfile()
      .then((profile) => {
        const zone = profile?.timezone ?? FALLBACK_TIMEZONE;
        if (!cancelled) setTimezone(zone);
        const today = localDate(zone);

        // Lazy closure, on the way past. There is no background job to do this
        // — the app is not running when she closes it — so `in_progress` rows
        // left behind by a terminal interruption are reconciled whenever a
        // drill is opened, exactly as `revision_queue` enrols lazily.
        //
        // THIS session is exempt: a timed set is unresumable by construction,
        // so without the exemption the sweep would close the very set it is
        // about to render.
        //
        // A failed sweep must not block the drill, hence the swallowed catch:
        // tidying old rows is housekeeping and she is standing on a platform.
        return closeStaleSessions(today, sessionId)
          .catch(() => 0)
          .then(() => loadRun(sessionId, today));
      })
      .then((next) => {
        if (cancelled) return;
        if (next === null) {
          setState('notFound');
          return;
        }
        const at = Date.now();
        questionStartRef.current = at;
        sessionStartRef.current = at;
        setRun(next);
        setAttempts(next.attempts);
        setMachine(startMachine(next.questions, next.attempts));
        setRemaining(sessionBudgetSeconds(next.preset, next.facts.plannedCount));
        setState('ready');
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setErrorText(err.message);
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  /* --------------------------------------------------------------- clock */

  const pushClock = useCallback((active: boolean) => {
    clockRef.current.push({ atMs: Date.now(), active });
  }, []);

  // "Active" is the AND of the app being foregrounded and this screen being
  // focused. Either one alone is wrong: a backgrounded app is obviously not
  // being read, and a focused-but-backgrounded screen is the pocketed phone
  // that would otherwise record a forty-minute question.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      pushClock(next === 'active' && focusedRef.current);
    });
    return () => subscription.remove();
  }, [pushClock]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      clockRef.current.push({ atMs: Date.now(), active: AppState.currentState === 'active' });
      return () => {
        focusedRef.current = false;
        clockRef.current.push({ atMs: Date.now(), active: false });
      };
    }, []),
  );

  /* ------------------------------------------------------------ derived */

  const questions = run?.questions ?? [];
  const question = questions[machine.index] ?? null;
  const plannedCount = run?.facts.plannedCount ?? 0;

  // `null` in micro, where there is no clock at all. The countdown reads
  // `remaining` once the first tick has landed and the full budget before that,
  // so it never flashes a wrong number on the first frame.
  const budgetSec = run ? sessionBudgetSeconds(run.preset, run.facts.plannedCount) : null;
  const clockSec = budgetSec === null ? null : (remaining ?? budgetSec);

  /* ------------------------------------------------------------- actions */

  const goToSummary = useCallback(() => {
    if (sessionId === null) return;
    router.replace(`/drill/summary/${sessionId}`);
  }, [router, sessionId]);

  const finish = useCallback(() => {
    if (sessionId === null) return;
    setBusy(true);
    finishSession(sessionId)
      .catch(() => undefined)
      .finally(() => {
        if (!isMounted()) return;
        setBusy(false);
        goToSummary();
      });
  }, [sessionId, isMounted, goToSummary]);

  const commitChoice = useCallback(
    (chosenIndex: number | null) => {
      if (sessionId === null || run === null) return;
      const current = run.questions[machine.index];
      if (!current) return;

      /**
       * Re-entrancy guard, and it has to be a ref rather than state.
       *
       * The write below is synchronous, but React does not re-render until
       * after this handler returns — so between the first tap landing and the
       * pad receiving its new props, the pad is still enabled and `machine`
       * still points at this question. A jostled thumb on a moving train is
       * exactly the input this screen is designed for, and a second touch in
       * that window would insert a SECOND attempt row for one question: the
       * mark counted twice, `attempts.length` pushed past `plannedCount` so the
       * resume position derived from it is wrong, and `redrillEffect` applied
       * twice so the SM-2 interval moves for an answer she gave once.
       *
       * A `useState` flag cannot close this window because it is the render
       * itself that is late. The ref is checked and set in the same synchronous
       * step, before any write.
       */
      if (committingRef.current) return;
      committingRef.current = true;

      const seconds = activeSeconds(clockRef.current, questionStartRef.current, Date.now());
      const pending = commitAnswer(current, chosenIndex, machine.guessing, seconds);

      // Synchronous by design — `recordAttempt` returns only once the attempt
      // row and its re-drill consequence are both committed. Nothing advances
      // until it has, so a failed write leaves her on the same question with
      // the reason on screen rather than silently losing the answer.
      try {
        const recorded = recordAttempt({
          sessionId,
          attempt: pending,
          todayIso: localDate(timezone),
        });
        setAttempts((previous) => [...previous, recorded.attempt]);
        setErrorText(null);
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : 'Could not save that answer.');
        // Released on failure: she is still on this question and must be able
        // to answer it again. Nothing was written, so a retry is safe.
        committingRef.current = false;
        return;
      }

      const next = commit(machine, run.preset, run.questions.length);
      setRevealed(
        run.preset.revealMode === 'per_question'
          ? {
              chosenIndex: pending.chosenIndex,
              correct: pending.correct,
              guessed: pending.guessed,
            }
          : null,
      );
      setMachine(next);
      questionStartRef.current = Date.now();

      // A timed set has no reveal, so `advanceNext` never runs and the guard
      // would latch permanently after the first answer — every later tap
      // silently ignored. Release it here instead: `next.index` has already
      // moved, so a stray second tap now answers the NEXT question, which is
      // indistinguishable from her simply having answered it.
      if (run.preset.revealMode === 'at_end') committingRef.current = false;

      // A timed set ends the moment its last answer lands: there is nothing to
      // reveal on the way out, and the summary is the reveal.
      if (next.phase === 'finished' && run.preset.revealMode === 'at_end') finish();
    },
    [sessionId, run, machine, timezone, finish],
  );

  /**
   * The dispute, and the only place a wrong key can be stopped.
   *
   * `disputeQuestion` does all four effects in ONE synchronous transaction —
   * quarantine, void the mark, delete the re-drill enrolment, record the
   * reason. A partial dispute (quarantined but still scored, or unscored but
   * still queued) is the exact half-state that would make the feature
   * untrustworthy, so there is nothing to coordinate here beyond calling it.
   *
   * Deliberately does NOT advance. She disputed the question she is looking at
   * and should see it acknowledged before moving on; auto-advancing would make
   * the tap feel like it did nothing.
   */
  const submitDispute = useCallback(
    (reason: DisputeReason, note: string | null) => {
      if (run === null) return;
      const current = run.questions[machine.index];
      if (!current) return;

      setDisputeBusy(true);
      setDisputeError(null);

      disputeQuestion({ questionId: current.questionId, reason, note })
        .then(() => {
          if (!isMounted()) return;
          setDisputedIds((previous) => new Set(previous).add(current.questionId));
          setDisputing(false);
        })
        .catch((err: Error) => {
          // Stays open with the reason on screen: a dispute that silently
          // failed would leave her believing a bad question was withdrawn.
          if (isMounted()) setDisputeError(err.message);
        })
        .finally(() => {
          if (isMounted()) setDisputeBusy(false);
        });
    },
    [run, machine, isMounted],
  );

  const advanceNext = useCallback(() => {
    if (run === null) return;
    setRevealed(null);
    setMachine(advance(machine, run.questions.length));
    questionStartRef.current = Date.now();
    // Released only here: between committing and advancing she is looking at
    // the reveal, and no further answer for this question is possible.
    committingRef.current = false;
  }, [run, machine]);

  const extend = useCallback(() => {
    if (sessionId === null) return;
    setBusy(true);
    extendSession(sessionId)
      .then(() => loadRun(sessionId, localDate(timezone)))
      .then((next) => {
        if (!isMounted() || next === null) return;
        setRun(next);
        setAttempts(next.attempts);
        // `startMachine` derives the position from the attempts, so it lands on
        // the first of the newly dealt questions with no cursor arithmetic.
        setMachine(startMachine(next.questions, next.attempts));
        setRevealed(null);
        questionStartRef.current = Date.now();
      })
      .catch((err: Error) => {
        if (isMounted()) setErrorText(err.message);
      })
      .finally(() => {
        if (isMounted()) setBusy(false);
      });
  }, [sessionId, timezone, isMounted]);

  /**
   * The clock hit zero.
   *
   * Every unanswered question is committed as a SKIP, one durable row each,
   * never as a wrong answer: marking them wrong would charge two thirds of a
   * mark apiece for questions she never saw and would enrol every one of them
   * in the re-drill queue as though she had got them wrong.
   */
  const autoSubmit = useCallback(() => {
    if (autoSubmittedRef.current) return;
    if (sessionId === null || run === null) return;
    autoSubmittedRef.current = true;

    const todayIso = localDate(timezone);
    let failed = false;
    try {
      for (const pending of autoSubmitSkips(run.questions, attempts)) {
        recordAttempt({ sessionId, attempt: pending, todayIso });
      }
    } catch (err) {
      failed = true;
      setErrorText(err instanceof Error ? err.message : 'Could not save the remaining questions.');
    }

    // A set whose closing skips did not all land is NOT a completed
    // measurement, so it is deliberately left `in_progress` for the sweep to
    // close as `abandoned`. She still goes to the marks screen: the answers she
    // did give are on record and stranding her on a dead drill helps nobody.
    if (failed) {
      goToSummary();
      return;
    }
    finish();
  }, [sessionId, run, attempts, timezone, finish, goToSummary]);

  // Refreshed in an effect rather than during render: the interval below must
  // call the CURRENT closure, and a ref written during render is unsafe under
  // the React Compiler.
  useEffect(() => {
    autoSubmitRef.current = autoSubmit;
  }, [autoSubmit]);

  /**
   * The countdown, and only in `timed`.
   *
   * `micro` records elapsed time and never displays it: a clock on a commute
   * drill turns twelve useful minutes into pressure, and the recorded duration
   * is advisory anyway. `budgetSec` is `null` for `micro`, so this effect does
   * not even start an interval there.
   *
   * The tick setStates from a timer callback, never synchronously from the
   * effect body, which is what `react-hooks/set-state-in-effect` forbids.
   */
  useEffect(() => {
    if (run === null || state !== 'ready') return;
    if (sessionBudgetSeconds(run.preset, run.facts.plannedCount) === null) return;

    const handle = setInterval(() => {
      // Refs are read here, in a timer callback, never during render.
      const elapsed = activeMillis(clockRef.current, sessionStartRef.current, Date.now()) / 1000;
      const left = remainingSeconds(run.preset, run.facts.plannedCount, elapsed);
      setRemaining(left);
      if (left !== null && left <= 0) autoSubmitRef.current();
    }, 1000);

    return () => clearInterval(handle);
  }, [run, state]);

  /* -------------------------------------------------------------- render */

  const back = (
    <TouchableOpacity
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/drill'))}
      accessibilityRole="button"
      accessibilityLabel="Leave this drill"
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
    >
      <Text style={[styles.back, { color: theme.textSecondary }]}>‹ Drills</Text>
    </TouchableOpacity>
  );

  if (state === 'notFound' || state === 'error') {
    return (
      <Sheet theme={theme} insets={insets}>
        {back}
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          {state === 'error' ? 'Could not open this drill' : 'Drill not found'}
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          {state === 'error'
            ? (errorText ?? 'The database read failed.')
            : sessionId === null
              ? `“${id ?? ''}” is not a valid drill id. It may be a stale link.`
              : `Drill ${sessionId} is not in your local database. It may have been deleted.`}
        </Text>
      </Sheet>
    );
  }

  if (state === 'loading' || run === null) {
    return (
      <Sheet theme={theme} insets={insets}>
        {back}
        <Text style={{ color: theme.textSecondary }}>Loading…</Text>
      </Sheet>
    );
  }

  // Already closed. Nothing to run; the marks are the destination.
  if (run.facts.status !== 'in_progress') {
    return (
      <Sheet theme={theme} insets={insets}>
        {back}
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          This drill is finished
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          It closed as “{run.facts.status}”. Every answer you gave is on record.
        </Text>
        <McqAdvanceButton label="See your marks" onPress={goToSummary} />
      </Sheet>
    );
  }

  /**
   * A measured set that was interrupted is over.
   *
   * `run.attempts` is the load-time snapshot, so answers already on record when
   * this screen mounted mean she left and came back. Resuming a measured set
   * after a break is not a measurement — the break is exactly the variable the
   * set exists to control. The attempts still count toward lifetime accuracy
   * and toward the re-drill queue; only the set-level figure is lost, and it
   * was never valid.
   */
  if (!run.preset.resumableWithinDay && run.attempts.length > 0) {
    return (
      <Sheet theme={theme} insets={insets}>
        {back}
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          A timed set cannot be resumed
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          You answered {run.attempts.length} of {plannedCount} before this set was interrupted.
          Those answers still count toward your accuracy and your re-drill queue — you really did
          answer them — but the set-level score is gone, because a measured set picked back up
          after a break measures the break as much as the questions.
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          Start a fresh timed set when you have the thirty minutes, or do a micro drill now.
        </Text>
        <McqAdvanceButton label="See what you answered" onPress={goToSummary} />
      </Sheet>
    );
  }

  if (questions.length === 0) {
    return (
      <Sheet theme={theme} insets={insets}>
        {back}
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          No questions to drill
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          Your local question bank is empty for the papers that appear in Prelims. Top it up while
          you have wifi — this screen never reaches the network.
        </Text>
      </Sheet>
    );
  }

  const finished = machine.phase === 'finished';
  const answeredCount = attempts.length;

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerRow}>
          {back}
          {clockSec === null ? (
            // No countdown in micro. Elapsed time is recorded, never displayed
            // as pressure.
            <Pill text={run.facts.mode} />
          ) : (
            <Text
              style={[
                styles.clock,
                { color: clockSec <= 60 ? theme.text : theme.textSecondary },
              ]}
              accessibilityRole="text"
              accessibilityLabel={`${Math.ceil(clockSec / 60)} minutes left in this timed set`}
            >
              {formatCountdown(clockSec)}
            </Text>
          )}
        </View>
        <Text style={[styles.progress, { color: theme.textSecondary }]} accessibilityRole="text">
          {finished
            ? `${answeredCount} of ${plannedCount} answered`
            : `Question ${Math.min(machine.index + 1, plannedCount)} of ${plannedCount}`}
          {run.shortBy > 0 ? ` · ${run.shortBy} short in the bank` : ''}
        </Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {errorText ? (
          <Card>
            <Text style={{ color: theme.text }}>{errorText}</Text>
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              That answer was not saved. Nothing you already answered is affected.
            </Text>
          </Card>
        ) : null}

        {finished ? (
          <FinishedPanel
            answered={answeredCount}
            planned={plannedCount}
            revealMode={run.preset.revealMode}
          />
        ) : question === null ? null : revealed ? (
          <>
            <McqElimination
              question={question}
              chosenIndex={revealed.chosenIndex}
              correct={revealed.correct}
              guessed={revealed.guessed}
            />
            {/* The one place a wrong key can be stopped. Only on the reveal —
                before it, "this looks wrong" is a way to dodge committing. */}
            <DisputeTrigger
              revealed
              disputed={disputedIds.has(question.questionId)}
              onPress={() => setDisputing(true)}
            />
          </>
        ) : (
          <>
            <View style={styles.tags}>
              {question.paper ? <Pill text={paperLabel(question.paper)} /> : null}
              {question.source === 'pyq' ? (
                <Pill text={question.pyqYear ? `PYQ ${question.pyqYear}` : 'PYQ'} tone="good" />
              ) : null}
              {question.priorAttempts > 0 ? <Pill text="Seen before" tone="warn" /> : null}
            </View>
            <Text style={[styles.stem, { color: theme.text }]}>{question.stem}</Text>
          </>
        )}
      </ScrollView>

      <View
        style={[
          styles.padWrap,
          {
            backgroundColor: theme.background,
            borderTopColor: theme.backgroundSelected,
            paddingBottom: insets.bottom + 12,
          },
        ]}
      >
        {finished ? (
          <View style={styles.finishActions}>
            {canExtend(run.preset, plannedCount) ? (
              <McqAdvanceButton
                label={`${EXTEND_STEP} more questions`}
                hint={`Extends this set to ${plannedCount + EXTEND_STEP} questions`}
                onPress={extend}
                disabled={busy}
              />
            ) : null}
            <TouchableOpacity
              onPress={finish}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy }}
              accessibilityLabel="Finish and see your marks"
              hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}
              style={[
                styles.secondary,
                { borderColor: theme.backgroundSelected, opacity: busy ? 0.4 : 1 },
              ]}
            >
              <Text style={[styles.secondaryText, { color: theme.text }]}>
                Finish and see your marks
              </Text>
            </TouchableOpacity>
          </View>
        ) : revealed ? (
          <McqAdvanceButton
            label={machine.index + 1 >= questions.length ? 'Finish' : 'Next question'}
            onPress={advanceNext}
            disabled={busy}
          />
        ) : (
          <McqOptionPad
            options={question?.options ?? []}
            guessing={machine.guessing}
            disabled={busy || question === null}
            onToggleGuess={() => setMachine(toggleGuess(machine))}
            onCommit={commitChoice}
          />
        )}
      </View>

      <McqDisputeSheet
        visible={disputing}
        revealed={revealed !== null}
        source={question?.source ?? 'generated'}
        pyqYear={question?.pyqYear ?? null}
        submitting={disputeBusy}
        error={disputeError}
        onDismiss={() => {
          setDisputing(false);
          setDisputeError(null);
        }}
        onSubmit={submitDispute}
      />
    </View>
  );
}

/* -------------------------------------------------------------- fragments */

type Theme = ReturnType<typeof useTheme>;

/** The non-drill states: scrolling page, safe-area padding, nothing pinned. */
function Sheet({
  theme,
  insets,
  children,
}: {
  theme: Theme;
  insets: { top: number; bottom: number };
  children: React.ReactNode;
}) {
  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[
        styles.sheet,
        { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 },
      ]}
    >
      {children}
    </ScrollView>
  );
}

function FinishedPanel({
  answered,
  planned,
  revealMode,
}: {
  answered: number;
  planned: number;
  revealMode: 'per_question' | 'at_end';
}) {
  const theme = useTheme();
  return (
    <View style={styles.finished}>
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        Set finished
      </Text>
      <Text style={[styles.note, { color: theme.textSecondary }]}>
        {answered} of {planned} answered. Every one is already saved.
      </Text>
      <Text style={[styles.note, { color: theme.textSecondary }]}>
        {revealMode === 'at_end'
          ? 'The keys and the elimination logic are on the marks screen — a timed set holds them back until the end so it stays a measurement.'
          : 'Add five more if the train is still moving, or take the marks now. Both are honest; a set you finish beats a set you abandon.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  sheet: { padding: 24, gap: 12 },

  header: { paddingHorizontal: 20, paddingBottom: 10, gap: 2 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { fontSize: 15, paddingVertical: 6 },
  clock: { fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  progress: { fontSize: 13 },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 24, gap: 14 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  // 17pt with a 1.4 line-height. A UPSC stem is three or four dense lines and
  // is read on a moving train; anything smaller is not readable there.
  stem: { fontSize: 17, lineHeight: 24 },

  finished: { gap: 8 },
  finishActions: { gap: 10 },
  secondary: {
    minHeight: 56,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { fontSize: 16, fontWeight: '600' },

  // Pinned. Everything the drill loop touches lives in here, above the
  // safe-area inset, inside the thumb arc.
  padWrap: { paddingHorizontal: 20, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },

  h1: { fontSize: 26, fontWeight: '700' },
  note: { fontSize: 13, lineHeight: 20 },
});
