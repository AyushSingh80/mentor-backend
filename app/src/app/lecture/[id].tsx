/**
 * One lecture.
 *
 * This is where the unit rule is spelled out in words rather than implied: the
 * runtime is CONTENT minutes at 1x, and the time it actually costs is that
 * divided by the speed she watched at. The two are printed on adjacent rows
 * with their units in their labels, because a 90-minute lecture watched at 1.5x
 * is 60 minutes of her evening, and every plan built on the wrong one of those
 * is wrong by a third.
 *
 * A route param is a string from a URL and can be anything — a deep link, a
 * stale bookmark, a typo. `/lecture/log` would also match `[id]` with
 * id = 'log'; Expo Router prefers the static segment, but the guard rejects
 * non-numeric ids regardless and renders "not found" rather than throwing.
 */

import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Card, ChipPicker, Pill, Row, type ChipOption, type PillTone } from '@/components/controls';
import { Button, useTheme } from '@/components/form';
import { db } from '@/db';
import { SUBJECTS, listLectures, markSkipped, markWatched, type LectureRow } from '@/db/lectures';
import { getProfile, type ProfileRow } from '@/db/profile';
import { lectures } from '@/db/schema';
import { COURSES } from '@/lib/papers';
import { localDate } from '@/lib/time';

type LoadState = 'loading' | 'ready' | 'notFound' | 'error';

const FALLBACK_TIMEZONE = 'Asia/Kolkata';

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

/**
 * Route params are strings from a URL and can be anything. Anything that is not
 * a positive integer is "not found", never a thrown `NaN` query.
 */
function parseLectureId(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function courseLabel(course: string): string {
  return COURSES.find((entry) => entry.value === course)?.label ?? course;
}

function subjectLabel(subject: string): string {
  return SUBJECTS.find((entry) => entry.value === subject)?.label ?? subject;
}

function minutes(value: number): string {
  const whole = Math.round(value);
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)}h ${String(whole % 60).padStart(2, '0')}m`;
}

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

export default function LectureDetail() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const lectureId = useMemo(() => parseLectureId(id), [id]);

  const [row, setRow] = useState<LectureRow | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [state, setState] = useState<LoadState>(lectureId === null ? 'notFound' : 'loading');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [speedDraft, setSpeedDraft] = useState<string | null>(null);
  const [notes, setNotes] = useState<'yes' | 'no'>('no');

  const lecturesChangedAt = useLiveQuery(
    db.select({ id: lectures.id, watchedOn: lectures.watchedOn, skippedOn: lectures.skippedOn }).from(lectures),
  ).updatedAt?.getTime();

  const load = useCallback(
    (isActive: () => boolean) => {
      if (lectureId === null) return;

      // The repository has no single-row getter and its signatures are frozen,
      // so this filters the list. The table holds one row per lecture of a
      // two-year course — a few hundred rows out of local SQLite.
      listLectures()
        .then((rows) => {
          if (!isActive()) return;
          const found = rows.find((candidate) => candidate.id === lectureId) ?? null;
          setRow(found);
          setState(found === null ? 'notFound' : 'ready');
        })
        .catch((err: Error) => {
          if (!isActive()) return;
          setErrorText(err.message);
          setState('error');
        });

      getProfile()
        .then((next) => {
          if (isActive()) setProfile(next);
        })
        .catch(() => undefined);
    },
    [lectureId],
  );

  // Promise chains plus a `cancelled` flag — `react-hooks/set-state-in-effect`
  // is an error here, so nothing may setState synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load, lecturesChangedAt]);

  const timezone = profile?.timezone ?? FALLBACK_TIMEZONE;
  const todayIso = useMemo(() => localDate(timezone), [timezone]);
  const speed = speedDraft ?? nearestSpeedOption(row?.playbackSpeed ?? profile?.defaultPlaybackSpeed ?? 1.5);

  const back = (
    <TouchableOpacity
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/lecture/log'))}
      accessibilityRole="button"
      accessibilityLabel="Back to the lecture log"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Text style={[styles.back, { color: theme.textSecondary }]}>‹ Lecture log</Text>
    </TouchableOpacity>
  );

  if (state === 'notFound' || state === 'error') {
    return (
      <ScrollView style={{ backgroundColor: theme.background }} contentContainerStyle={styles.container}>
        {back}
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          {state === 'error' ? 'Could not open this lecture' : 'Lecture not found'}
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          {state === 'error'
            ? (errorText ?? 'The database read failed.')
            : lectureId === null
              ? `“${id ?? ''}” is not a valid lecture id. It may be a stale link.`
              : `Lecture ${lectureId} is not in your local database. It may have been deleted.`}
        </Text>
      </ScrollView>
    );
  }

  if (state === 'loading' || row === null) {
    return (
      <ScrollView style={{ backgroundColor: theme.background }} contentContainerStyle={styles.container}>
        {back}
        <Text style={{ color: theme.textSecondary }}>Loading…</Text>
      </ScrollView>
    );
  }

  const status: { text: string; tone: PillTone } =
    row.skippedOn !== null
      ? { text: 'skipped', tone: 'warn' }
      : row.watchedOn !== null
        ? { text: 'watched', tone: 'good' }
        : { text: 'outstanding', tone: 'bad' };

  // The speed actually recorded when it was watched, if it was. For a lecture
  // still outstanding there is nothing to observe, so the chip selection is used
  // as an estimate and labelled as one.
  //
  // Screened for zero and NaN before it is ever divided by: `cleanSpeed` keeps
  // those out on the write path, but a row from a hand-edited database would
  // otherwise render "Infinityh 00m" on the one row that explains the units.
  const storedSpeed =
    row.playbackSpeed !== null && Number.isFinite(row.playbackSpeed) && row.playbackSpeed > 0
      ? row.playbackSpeed
      : null;
  const recordedSpeed = row.watchedOn !== null && row.skippedOn === null ? storedSpeed : null;
  const estimateSpeed = Number(speed);
  const rowId = row.id;

  function watch() {
    setBusy(true);
    setErrorText(null);
    markWatched(rowId, {
      watchedOn: todayIso,
      playbackSpeed: Number(speed),
      notesMade: notes === 'yes',
    })
      .catch((err: Error) => setErrorText(err.message))
      .finally(() => setBusy(false));
  }

  /** Writes `skippedOn` only. Never `watchedOn` — see the note in `db/lectures.ts`. */
  function skip() {
    setBusy(true);
    setErrorText(null);
    markSkipped(rowId, todayIso)
      .catch((err: Error) => setErrorText(err.message))
      .finally(() => setBusy(false));
  }

  return (
    <ScrollView style={{ backgroundColor: theme.background }} contentContainerStyle={styles.container}>
      {back}

      <View style={styles.titleRow}>
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          {row.title}
        </Text>
        <Pill text={status.text} tone={status.tone} />
      </View>
      <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>
        {courseLabel(row.course)} · {subjectLabel(row.subject)} · released {row.releasedOn}
      </Text>

      <Card title="Time">
        <Row label="Runtime (content, at 1x)" value={minutes(row.runtimeMin)} />
        {recordedSpeed === null ? (
          <Row label={`Your time at ${estimateSpeed}x (estimate)`} value={minutes(row.runtimeMin / estimateSpeed)} />
        ) : (
          <Row label={`Your time at ${recordedSpeed}x`} value={minutes(row.runtimeMin / recordedSpeed)} />
        )}
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          The backlog counts the first figure, not the second. Content minutes are what the course
          contains; the second row is what watching them costs you at your speed. Swapping them makes
          every backlog number wrong by exactly your playback speed.
        </Text>
      </Card>

      <Card title="Status">
        <Row label="Released on" value={row.releasedOn} />
        <Row label="Watched on" value={row.watchedOn ?? 'not yet'} />
        <Row label="Skipped on" value={row.skippedOn ?? 'no'} />
        <Row label="Playback speed" value={row.playbackSpeed === null ? 'not recorded' : `${row.playbackSpeed}x`} />
        <Row label="Notes made" value={row.notesMade ? 'yes' : 'no'} />
        {row.skippedOn !== null ? (
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            A skipped lecture has left the backlog but was never counted towards your watch rate — it
            cleared without costing you any time, so counting it would make days-to-clear optimistic.
          </Text>
        ) : null}
      </Card>

      <Card title={row.watchedOn === null && row.skippedOn === null ? 'Log it' : 'Correct the record'}>
        <ChipPicker
          label="Watched at"
          hint="Recorded with the watch, so the measured rate reflects the speed you really used."
          options={SPEED_OPTIONS}
          selected={speed}
          onSelect={setSpeedDraft}
        />
        <ChipPicker label="Notes" options={NOTES_OPTIONS} selected={notes} onSelect={setNotes} />

        {errorText ? <Text style={[styles.error, { color: theme.text }]}>{errorText}</Text> : null}

        <Button title={busy ? 'Saving…' : `Mark watched today (${todayIso})`} onPress={watch} disabled={busy} />

        <TouchableOpacity
          onPress={skip}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Skip this lecture"
          accessibilityHint="Removes it from the backlog without counting towards your watch rate"
          style={[styles.skip, { borderColor: theme.textSecondary, opacity: busy ? 0.4 : 1 }]}
        >
          <Text style={[styles.skipText, { color: theme.text }]}>Skip this lecture</Text>
        </TouchableOpacity>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          Skipping is a real answer for something four weeks old. It clears the backlog honestly
          instead of leaving a number designed to worry you carrying a lecture you will never watch.
        </Text>
      </Card>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64 },
  back: { fontSize: 15, paddingVertical: 6, marginBottom: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  h1: { fontSize: 28, fontWeight: '700', flexShrink: 1 },
  eyebrow: { fontSize: 13, marginTop: 2, marginBottom: 18 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 8 },
  error: { fontSize: 13, lineHeight: 19, marginBottom: 6, fontWeight: '600' },
  skip: { borderRadius: 12, borderWidth: 1.5, paddingVertical: 13, alignItems: 'center', marginTop: 10 },
  skipText: { fontSize: 15, fontWeight: '700' },
});
