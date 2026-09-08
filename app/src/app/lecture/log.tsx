/**
 * Log a lecture — the two-minute action fired from the pre-shift checkpoint.
 *
 * Optimised for speed of entry over completeness. The form keeps the course,
 * subject and date between saves, because lectures arrive in runs: five Polity
 * classes dropped this morning is five taps on title and runtime, not five
 * passes through the whole form. Playback speed and "notes made" are set ONCE
 * at the top of the outstanding list and reused by every "Mark watched" below
 * it, for the same reason — she is standing up to leave for a shift.
 *
 * Two things on this screen are load-bearing and easy to get wrong:
 *
 * 1. Runtime is CONTENT minutes at 1x, as the platform prints it. It is never
 *    the wall-clock time a faster playback takes. The field says so, and the
 *    backlog line beside it shows both figures so the difference stays visible.
 * 2. "Skip" is a distinct action from "Mark watched" and writes a different
 *    column. Both remove the lecture from the backlog; only watching feeds the
 *    watch rate. Collapsing them would make days-to-clear optimistic at exactly
 *    the moment she has admitted she cannot keep up.
 */

import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Card, ChipPicker, Pill, Row, type ChipOption } from '@/components/controls';
import { Button, Field, useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { db } from '@/db';
import {
  SUBJECTS,
  createLecture,
  lectureFacts,
  listLectures,
  markSkipped,
  markWatched,
  type LectureRow,
} from '@/db/lectures';
import { getProfile, type ProfileRow } from '@/db/profile';
import { lectures } from '@/db/schema';
import { summariseBacklog, type BacklogSummary, type LectureFact } from '@/lib/backlog';
import { COURSES, type CourseId } from '@/lib/papers';
import { localDate } from '@/lib/time';

/** Matches the schema default, used until the profile read lands. */
const FALLBACK_TIMEZONE = 'Asia/Kolkata';
const FALLBACK_TARGET = '2027-03-31';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const COURSE_OPTIONS: readonly ChipOption<CourseId>[] = COURSES.map((course) => ({
  value: course.value,
  label: course.label,
}));

/**
 * The speeds a lecture platform actually offers. Stored as strings because a
 * chip picker is a closed set of labels; the number is parsed at the write.
 */
const SPEED_OPTIONS: readonly ChipOption<string>[] = [
  { value: '1', label: '1x' },
  { value: '1.25', label: '1.25x' },
  { value: '1.5', label: '1.5x' },
  { value: '1.75', label: '1.75x' },
  { value: '2', label: '2x' },
];

const NOTES_OPTIONS: readonly ChipOption<'yes' | 'no'>[] = [
  { value: 'yes', label: 'Notes made' },
  { value: 'no', label: 'No notes' },
];

function hours(contentMin: number): string {
  return `${(contentMin / 60).toFixed(1)} hrs`;
}

function courseLabel(course: string): string {
  return COURSES.find((entry) => entry.value === course)?.label ?? course;
}

function subjectLabel(subject: string): string {
  return SUBJECTS.find((entry) => entry.value === subject)?.label ?? subject;
}

/** Nearest chip to a stored speed, so the profile default lands on a real option. */
function nearestSpeedOption(speed: number): string {
  let best = SPEED_OPTIONS[1].value;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const option of SPEED_OPTIONS) {
    const gap = Math.abs(Number(option.value) - speed);
    if (gap < bestGap) {
      bestGap = gap;
      best = option.value;
    }
  }
  return best;
}

export default function LogLecture() {
  const theme = useTheme();
  const isMounted = useIsMounted();
  const router = useRouter();

  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [facts, setFacts] = useState<LectureFact[]>([]);
  const [outstanding, setOutstanding] = useState<LectureRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Separate from `loadError`: an empty list and an unknown list look identical. */
  const [outstandingError, setOutstandingError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Entry form. Course, subject and date deliberately survive a save.
  const [course, setCourse] = useState<CourseId>('gs');
  const [subject, setSubject] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [runtimeText, setRuntimeText] = useState('');
  const [releasedDraft, setReleasedDraft] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Watch settings, applied by every "Mark watched" in the list below.
  const [speedDraft, setSpeedDraft] = useState<string | null>(null);
  const [notes, setNotes] = useState<'yes' | 'no'>('no');

  // A cheap live select over the one table this screen writes, so a save or a
  // "Mark watched" refreshes the backlog line without a manual invalidation.
  const lecturesChangedAt = useLiveQuery(
    db.select({ id: lectures.id, watchedOn: lectures.watchedOn, skippedOn: lectures.skippedOn }).from(lectures),
  ).updatedAt?.getTime();

  const load = useCallback((isActive: () => boolean) => {
    // Three independent reads. The outstanding list must render even if the
    // fact read fails, and the profile only supplies defaults.
    lectureFacts()
      .then((next) => {
        if (!isActive()) return;
        setFacts(next);
        setLoadError(null);
      })
      .catch((err: Error) => {
        if (isActive()) setLoadError(err.message);
      })
      .finally(() => {
        if (isActive()) setLoaded(true);
      });

    listLectures({ unwatchedOnly: true })
      .then((next) => {
        if (!isActive()) return;
        setOutstanding(next);
        setOutstandingError(null);
      })
      .catch((err: Error) => {
        // Swallowing this leaves `outstanding` at its initial `[]`, which
        // renders as "Nothing outstanding. Every lecture is watched or
        // skipped." — a confident wrong answer on the one screen whose whole
        // job is telling her whether she is behind. Worse than a spinner,
        // because nothing suggests anything went wrong.
        if (isActive()) setOutstandingError(err.message);
      });

    getProfile()
      .then((row) => {
        if (isActive()) setProfile(row);
      })
      .catch(() => undefined);
  }, []);

  // Promise chains and a `cancelled` flag, never an awaited helper:
  // `react-hooks/set-state-in-effect` is an error in this repo and nothing may
  // setState synchronously from the effect body.
  useEffect(() => {
    let cancelled = false;
    load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, lecturesChangedAt]);

  const timezone = profile?.timezone ?? FALLBACK_TIMEZONE;
  const targetIso = profile?.targetFirstPassDate ?? FALLBACK_TARGET;
  const todayIso = useMemo(() => localDate(timezone), [timezone]);

  // Untouched, the date field tracks today rather than freezing at mount.
  const releasedOn = releasedDraft ?? todayIso;
  const speed = speedDraft ?? nearestSpeedOption(profile?.defaultPlaybackSpeed ?? 1.5);

  const subjectOptions = useMemo(
    () => SUBJECTS.filter((entry) => entry.course === course).map(({ value, label }) => ({ value, label })),
    [course],
  );

  const combined = useMemo(
    () => summariseBacklog(facts, { asOf: todayIso, targetIso }),
    [facts, todayIso, targetIso],
  );

  // Per course as well as combined: a blended figure hides General Studies
  // exploding while Anthropology is current, which is the one thing a single
  // number on this screen must not do.
  const perCourse = useMemo(
    () =>
      COURSES.map((entry) => ({
        course: entry,
        summary: summariseBacklog(facts, { asOf: todayIso, targetIso, course: entry.value }),
      })),
    [facts, todayIso, targetIso],
  );

  function submit() {
    if (subject === null) {
      setFormError('Choose a subject.');
      return;
    }
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setFormError('Give the lecture a title you will recognise later.');
      return;
    }
    const runtimeMin = Number.parseInt(runtimeText, 10);
    if (!Number.isFinite(runtimeMin) || runtimeMin <= 0) {
      setFormError('Runtime must be a whole number of content minutes above zero.');
      return;
    }
    if (!ISO_DATE.test(releasedOn)) {
      setFormError('Release date must be written as YYYY-MM-DD.');
      return;
    }

    setFormError(null);
    setSaved(null);
    setBusy(true);

    createLecture({ course, subject, title: trimmedTitle, runtimeMin, releasedOn })
      .then(() => {
        // Only the per-lecture fields reset. Course, subject and date stay put
        // so the next lecture in the same run is two fields away.
        setTitle('');
        setRuntimeText('');
        setSaved(`Added “${trimmedTitle}” — ${runtimeMin} content minutes.`);
      })
      .catch((err: Error) => setFormError(err.message))
      .finally(() => setBusy(false));
  }

  function watch(id: number) {
    setBusy(true);
    setFormError(null);
    markWatched(id, { watchedOn: todayIso, playbackSpeed: Number(speed), notesMade: notes === 'yes' })
      .catch((err: Error) => setFormError(err.message))
      .finally(() => setBusy(false));
  }

  function skip(id: number) {
    setBusy(true);
    setFormError(null);
    markSkipped(id, todayIso)
      .catch((err: Error) => setFormError(err.message))
      .finally(() => setBusy(false));
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load(isMounted);
            setTimeout(() => setRefreshing(false), 350);
          }}
        />
      }
    >
      <TouchableOpacity
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Text style={[styles.back, { color: theme.textSecondary }]}>‹ Back</Text>
      </TouchableOpacity>

      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        Log a lecture
      </Text>
      <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>{todayIso}</Text>

      <BacklogLine combined={combined} perCourse={perCourse} loaded={loaded} theme={theme} />

      {loadError ? (
        <Card>
          <Text style={{ color: theme.text }}>Could not read your lectures: {loadError}</Text>
        </Card>
      ) : null}

      <Card title="Add a lecture">
        <ChipPicker
          label="Course"
          options={COURSE_OPTIONS}
          selected={course}
          onSelect={(next) => {
            setCourse(next);
            setSubject(null);
          }}
        />
        <ChipPicker label="Subject" options={subjectOptions} selected={subject} onSelect={setSubject} />
        <Field
          label="Title"
          value={title}
          onChangeText={setTitle}
          placeholder="Fundamental Rights — part 3"
        />
        <Field
          label="Runtime (content minutes at 1x)"
          hint="What the platform prints on the video. Not the time it takes you at 1.5x — the backlog is measured in content, and mixing the two makes it wrong by exactly your playback speed."
          value={runtimeText}
          onChangeText={setRuntimeText}
          placeholder="75"
          keyboardType="numeric"
        />
        <Field
          label="Released on"
          hint="YYYY-MM-DD. Defaults to today; backdate it for a class you are catching up on."
          value={releasedOn}
          onChangeText={setReleasedDraft}
        />

        {formError ? <Text style={[styles.error, { color: theme.text }]}>{formError}</Text> : null}
        {saved ? <Text style={[styles.saved, { color: theme.textSecondary }]}>{saved}</Text> : null}

        <Button title={busy ? 'Saving…' : 'Add lecture'} onPress={submit} disabled={busy} />
      </Card>

      <Card title={`Outstanding — ${outstanding.length}`}>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          Oldest first. These are the lectures that have been sitting longest.
        </Text>

        <ChipPicker
          label="Watched at"
          hint="Set once; every ‘Mark watched’ below uses it. Speed changes how long a lecture costs you, never how much content it clears."
          options={SPEED_OPTIONS}
          selected={speed}
          onSelect={setSpeedDraft}
        />
        <ChipPicker label="Notes" options={NOTES_OPTIONS} selected={notes} onSelect={setNotes} />

        {!loaded ? (
          <Text style={{ color: theme.textSecondary }}>Loading…</Text>
        ) : outstandingError !== null ? (
          <Text style={{ color: theme.text }}>
            Could not read your outstanding lectures ({outstandingError}). This list is not empty —
            it is unknown. Pull to refresh.
          </Text>
        ) : outstanding.length === 0 ? (
          <Text style={{ color: theme.textSecondary }}>
            Nothing outstanding. Every lecture you have logged is watched or skipped.
          </Text>
        ) : (
          outstanding.map((row) => (
            <OutstandingRow
              key={row.id}
              row={row}
              speed={Number(speed)}
              busy={busy}
              theme={theme}
              onOpen={() => router.push(`/lecture/${row.id}`)}
              onWatch={() => watch(row.id)}
              onSkip={() => skip(row.id)}
            />
          ))
        )}
      </Card>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- fragments */

type Theme = ReturnType<typeof useTheme>;

/**
 * The backlog figure, in both units.
 *
 * Content hours are what the backlog IS; the hours-of-your-time line is what it
 * costs at her measured speed. Showing only one of them is how the two get
 * confused, and the sample size travels with days-to-clear because "12 days to
 * clear" implies a confidence six days of history does not support.
 */
function BacklogLine({
  combined,
  perCourse,
  loaded,
  theme,
}: {
  combined: BacklogSummary;
  perCourse: { course: { value: CourseId; label: string }; summary: BacklogSummary }[];
  loaded: boolean;
  theme: Theme;
}) {
  if (!loaded) {
    return (
      <Card>
        <Text style={{ color: theme.textSecondary }}>Reading your backlog…</Text>
      </Card>
    );
  }

  const { rate, daysToClear, backlogContentMin } = combined;
  const cost =
    rate.observedSpeed === null
      ? null
      : `${hours(backlogContentMin / rate.observedSpeed)} of your time at ${rate.observedSpeed.toFixed(2)}x`;

  return (
    <Card title="Backlog">
      <Row label="Outstanding content" value={hours(backlogContentMin)} />
      {cost ? <Row label="At your measured speed" value={cost} /> : null}
      <Row
        label="Clears in"
        value={
          daysToClear === null
            ? `nothing watched in ${rate.sampleDays} ${rate.sampleDays === 1 ? 'day' : 'days'}`
            : `${Math.ceil(daysToClear)} days · rate over ${rate.sampleDays} ${rate.sampleDays === 1 ? 'day' : 'days'}`
        }
      />
      {perCourse.map(({ course, summary }) => (
        <Row key={course.value} label={course.label} value={hours(summary.backlogContentMin)} />
      ))}
      <Text style={[styles.note, { color: theme.textSecondary }]}>
        Split by course on purpose: one blended figure would hide General Studies running away while
        Anthropology is current.
      </Text>
    </Card>
  );
}

/**
 * One outstanding lecture.
 *
 * "Skip" sits beside "Mark watched" rather than behind a menu, because the
 * honest answer for a lecture that is four weeks old is often that she is never
 * going to watch it — and burying that choice is how it becomes a permanent
 * entry in a number designed to make her anxious.
 */
function OutstandingRow({
  row,
  speed,
  busy,
  theme,
  onOpen,
  onWatch,
  onSkip,
}: {
  row: LectureRow;
  speed: number;
  busy: boolean;
  theme: Theme;
  onOpen: () => void;
  onWatch: () => void;
  onSkip: () => void;
}) {
  const wallClockMin = speed > 0 ? Math.round(row.runtimeMin / speed) : row.runtimeMin;

  return (
    <View style={[styles.item, { borderColor: theme.backgroundSelected }]}>
      <TouchableOpacity
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Open ${row.title}`}
        accessibilityHint={`${row.runtimeMin} content minutes, released ${row.releasedOn}`}
      >
        <Text style={[styles.itemTitle, { color: theme.text }]} numberOfLines={2}>
          {row.title}
        </Text>
        <Text style={[styles.itemMeta, { color: theme.textSecondary }]}>
          {courseLabel(row.course)} · {subjectLabel(row.subject)} · released {row.releasedOn}
        </Text>
        <View style={styles.pillRow}>
          <Pill text={`${row.runtimeMin} min content`} />
          <Pill text={`≈ ${wallClockMin} min at ${speed}x`} tone="neutral" />
        </View>
      </TouchableOpacity>

      <View style={styles.actions}>
        <TouchableOpacity
          onPress={onWatch}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Mark ${row.title} watched`}
          style={[styles.action, { backgroundColor: theme.text, opacity: busy ? 0.4 : 1 }]}
        >
          <Text style={[styles.actionText, { color: theme.background }]}>Mark watched</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onSkip}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Skip ${row.title}`}
          accessibilityHint="Removes it from the backlog without counting towards your watch rate"
          style={[
            styles.action,
            styles.skip,
            { borderColor: theme.textSecondary, opacity: busy ? 0.4 : 1 },
          ]}
        >
          <Text style={[styles.actionText, { color: theme.text }]}>Skip</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64 },
  back: { fontSize: 15, paddingVertical: 6, marginBottom: 6 },
  h1: { fontSize: 30, fontWeight: '700' },
  eyebrow: { fontSize: 13, marginTop: 2, marginBottom: 18 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  error: { fontSize: 13, lineHeight: 19, marginBottom: 6, fontWeight: '600' },
  saved: { fontSize: 13, lineHeight: 19, marginBottom: 6 },

  item: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 14, marginTop: 14, gap: 8 },
  itemTitle: { fontSize: 15, fontWeight: '600' },
  itemMeta: { fontSize: 12, marginTop: 3 },
  pillRow: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },

  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  action: {
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 16,
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  skip: { backgroundColor: 'transparent', borderWidth: 1.5, flexGrow: 0 },
  actionText: { fontSize: 14, fontWeight: '700' },
});
