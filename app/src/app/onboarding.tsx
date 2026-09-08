/**
 * Onboarding — captures the shift, then shows the plan it derives BEFORE
 * saving. Seeing the schedule the app inferred is the moment to catch a wrong
 * assumption; discovering it three weeks later as a stream of badly-timed
 * notifications is how people abandon study apps.
 *
 * Doubles as the edit screen, so it must load the existing profile first —
 * otherwise "edit" silently overwrites a real schedule with form defaults.
 */

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Button, DayPicker, Field, useTheme } from '@/components/form';
import { getProfileForm, saveProfile } from '@/db/profile';
import {
  deriveNotifications,
  deriveStudyBlocks,
  notificationsRespectWorkHours,
  summariseCapacity,
} from '@/lib/schedule';
import { formatClock, fromMinutes, parseClock } from '@/lib/time';
import { checkAuth, checkHealth } from '@/lib/api';
import { setServerBaseUrl, setServerToken, validateServerBaseUrl } from '@/lib/secure';

const TARGET_FIRST_PASS = '2027-03-31';

export default function Onboarding() {
  const theme = useTheme();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);

  const [jobStart, setJobStart] = useState('14:30');
  const [jobEnd, setJobEnd] = useState('23:30');
  const [workDays, setWorkDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [commute, setCommute] = useState('0');
  const [wake, setWake] = useState('07:15');
  const [sleep, setSleep] = useState('00:45');
  const [speed, setSpeed] = useState('1.5');
  const [gsLectures, setGsLectures] = useState('');
  const [gsRuntime, setGsRuntime] = useState('');
  const [anthroDays, setAnthroDays] = useState<number[]>([]);
  const [serverUrl, setServerUrl] = useState('');
  const [serverToken, setServerTokenValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Pre-populate from the stored profile, so saving never clobbers it.
  useEffect(() => {
    let cancelled = false;
    getProfileForm()
      .then((form) => {
        if (cancelled) return;
        if (form.exists) {
          setIsEditing(true);
          setJobStart(fromMinutes(form.jobStartMinutes));
          setJobEnd(fromMinutes(form.jobEndMinutes));
          setWorkDays(form.workDays);
          setCommute(String(form.commuteMinutesEachWay));
          setWake(fromMinutes(form.wakeMinutes));
          setSleep(fromMinutes(form.sleepMinutes));
          setSpeed(String(form.defaultPlaybackSpeed));
          setGsLectures(form.gsCourseTotalLectures ? String(form.gsCourseTotalLectures) : '');
          setGsRuntime(
            form.gsCourseTotalRuntimeMin ? String(form.gsCourseTotalRuntimeMin / 60) : '',
          );
          setAnthroDays(form.anthroClassDays);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const times = useMemo(
    () => ({
      jobStart: parseClock(jobStart),
      jobEnd: parseClock(jobEnd),
      wake: parseClock(wake),
      sleep: parseClock(sleep),
    }),
    [jobStart, jobEnd, wake, sleep],
  );

  const timesValid =
    times.jobStart !== null && times.jobEnd !== null && times.wake !== null && times.sleep !== null;

  const sched = useMemo(
    () => ({
      jobStartMinutes: times.jobStart ?? 0,
      jobEndMinutes: times.jobEnd ?? 0,
      workDays,
      commuteMinutesEachWay: Math.max(0, Number(commute) || 0),
      wakeMinutes: times.wake ?? 0,
      sleepMinutes: times.sleep ?? 0,
    }),
    [times, workDays, commute],
  );

  const preview = useMemo(() => {
    const blocks = deriveStudyBlocks(sched);
    const capacity = summariseCapacity(blocks, sched.workDays);
    const notifications = deriveNotifications(sched);
    return {
      blocks,
      capacity,
      notifications,
      guard: notificationsRespectWorkHours(sched, notifications),
      projected: capacity.projectedHoursTo(TARGET_FIRST_PASS),
    };
  }, [sched]);

  const sleepHours = useMemo(() => {
    if (times.wake === null || times.sleep === null) return null;
    const span =
      times.sleep < times.wake ? times.wake - times.sleep : times.wake + 24 * 60 - times.sleep;
    return span / 60;
  }, [times]);

  function toggle(list: number[], setList: (v: number[]) => void, day: number) {
    setList(list.includes(day) ? list.filter((d) => d !== day) : [...list, day].sort());
  }

  async function onSave() {
    if (!timesValid) {
      Alert.alert('Check your times', 'Times must be in HH:MM format, for example 14:30.');
      return;
    }
    if (workDays.length === 0) {
      Alert.alert('Pick your work days', 'Select at least one working day.');
      return;
    }

    setSaving(true);
    try {
      // Local save first. This is offline-only work and must never be blocked
      // by an unreachable server — otherwise a bad connection can strand the
      // user on this screen and out of the app entirely.
      await saveProfile({
        ...sched,
        defaultPlaybackSpeed: Number(speed) || 1.5,
        gsCourseTotalLectures: gsLectures ? Number(gsLectures) : null,
        gsCourseTotalRuntimeMin: gsRuntime ? Number(gsRuntime) * 60 : null,
        anthroClassDays: anthroDays,
        targetFirstPassDate: TARGET_FIRST_PASS,
        examYear: 2028,
      });

      // Server config is optional and best-effort. A failure here is a warning,
      // never a reason to lose the schedule that was just saved.
      if (serverUrl.trim()) {
        const validated = validateServerBaseUrl(serverUrl);
        if (!validated.ok) {
          Alert.alert('Schedule saved', `Server not configured: ${validated.reason}`);
        } else {
          try {
            await checkHealth(validated.url);
            if (serverToken.trim() && !(await checkAuth(validated.url, serverToken.trim()))) {
              Alert.alert('Schedule saved', 'The server is reachable but rejected the token.');
            } else {
              await setServerBaseUrl(validated.url);
              if (serverToken.trim()) await setServerToken(serverToken.trim());
            }
          } catch (err) {
            Alert.alert(
              'Schedule saved',
              `Could not reach the server (${(err as Error).message}). You can set it later from this screen.`,
            );
          }
        }
      }

      router.replace('/');
    } catch (err) {
      Alert.alert('Could not save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={[styles.loading, { backgroundColor: theme.background }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        {isEditing ? 'Edit your schedule' : 'Set up your schedule'}
      </Text>
      <Text style={[styles.lede, { color: theme.textSecondary }]}>
        Every study block and notification is derived from these. Nothing is hardcoded — an
        evening shift breaks the defaults a study app would normally assume.
      </Text>

      <Section title="Work" theme={theme} />
      <Field
        label="Job starts"
        hint="24-hour time, HH:MM"
        value={jobStart}
        onChangeText={setJobStart}
        placeholder="14:30"
      />
      <Field label="Job ends" value={jobEnd} onChangeText={setJobEnd} placeholder="23:30" />
      <DayPicker
        label="Working days"
        hint="Tap to toggle. Days left unselected become full study days."
        selected={workDays}
        onToggle={(d) => toggle(workDays, setWorkDays, d)}
      />
      <Field
        label="Commute each way (minutes)"
        hint="Used to schedule offline MCQ and flashcard drills. Enter 0 if you work from home."
        value={commute}
        onChangeText={setCommute}
        keyboardType="numeric"
      />

      <Section title="Sleep" theme={theme} />
      <Field label="Wake time" value={wake} onChangeText={setWake} placeholder="07:15" />
      <Field label="Sleep time" value={sleep} onChangeText={setSleep} placeholder="00:45" />
      {!timesValid ? (
        <Warning theme={theme}>
          One of your times is not in HH:MM format, so the plan below cannot be calculated.
        </Warning>
      ) : sleepHours !== null && sleepHours < 7 ? (
        <Warning theme={theme}>
          That is {sleepHours.toFixed(1)} hours of sleep. On a night shift, under 7 hours is the
          fastest route to the burnout this app is meant to catch. Consider a later start rather
          than a shorter night.
        </Warning>
      ) : null}

      <Section title="Classes" theme={theme} />
      <Field
        label="Default playback speed"
        hint="1.5× raises your effective capacity by about a third. The planner accounts for it."
        value={speed}
        onChangeText={setSpeed}
        keyboardType="numeric"
      />
      <Field
        label="GS course — total lectures (optional)"
        value={gsLectures}
        onChangeText={setGsLectures}
        keyboardType="numeric"
      />
      <Field
        label="GS course — total runtime in hours (optional)"
        hint="Lets the backlog tracker tell you days-to-clear from day one."
        value={gsRuntime}
        onChangeText={setGsRuntime}
        keyboardType="numeric"
      />
      <DayPicker
        label="Anthropology class days"
        selected={anthroDays}
        onToggle={(d) => toggle(anthroDays, setAnthroDays, d)}
      />

      <Section title="Server (optional for now)" theme={theme} />
      <Field
        label="Backend URL"
        hint="Leave blank until the server is deployed. Must be https. Answer evaluation needs it; everything else works offline."
        value={serverUrl}
        onChangeText={setServerUrl}
        placeholder="https://your-server.run.app"
        keyboardType="url"
      />
      <Field
        label="Bearer token"
        hint="From your server .env file."
        value={serverToken}
        onChangeText={setServerTokenValue}
      />

      {/* The sanity check: what the app inferred, before it commits to it. */}
      <View style={[styles.preview, { backgroundColor: theme.backgroundElement }]}>
        <Text accessibilityRole="header" style={[styles.previewTitle, { color: theme.text }]}>
          Your derived plan
        </Text>
        <Row theme={theme} k="Weekday study" v={`${preview.capacity.weekdayHours.toFixed(1)} hrs`} />
        <Row theme={theme} k="Weekend study" v={`${preview.capacity.weekendHours.toFixed(1)} hrs`} />
        <Row
          theme={theme}
          k="Weekly total"
          v={`${preview.capacity.totalWeeklyHours.toFixed(1)} hrs`}
        />
        <Row theme={theme} k="By 31 Mar 2027" v={`~${preview.projected.toLocaleString()} hrs`} />

        <Text style={[styles.previewSub, { color: theme.textSecondary }]}>A working day</Text>
        {preview.blocks
          .filter((b) => b.dayOfWeek === (workDays[0] ?? 1))
          .map((b) => (
            <Text key={b.id} style={[styles.block, { color: theme.text }]}>
              {formatClock(b.startMinutes)}–{formatClock(b.endMinutes)}  {b.label}
            </Text>
          ))}

        <Text style={[styles.previewSub, { color: theme.textSecondary }]}>Notifications</Text>
        {preview.notifications.map((n) => (
          <Text key={n.id} style={[styles.block, { color: theme.text }]}>
            {formatClock(n.minutes)}  {n.label}
          </Text>
        ))}
        {preview.guard.ok ? (
          <Text style={[styles.ok, { color: theme.textSecondary }]}>
            ✓ No notification falls inside your work hours.
          </Text>
        ) : (
          <Warning theme={theme}>
            A notification lands during your shift. Adjust your wake or job times.
          </Warning>
        )}
      </View>

      <Button
        title={saving ? 'Saving…' : isEditing ? 'Save changes' : 'Save and continue'}
        onPress={onSave}
        disabled={saving || !timesValid}
      />
      {isEditing ? (
        <TouchableOpacity
          onPress={() => router.replace('/')}
          disabled={saving}
          accessibilityRole="button"
        >
          <Text style={[styles.cancel, { color: theme.textSecondary }]}>Cancel</Text>
        </TouchableOpacity>
      ) : null}
      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

function Section({ title, theme }: { title: string; theme: { text: string } }) {
  return (
    <Text accessibilityRole="header" style={[styles.section, { color: theme.text }]}>
      {title}
    </Text>
  );
}

function Row({
  theme,
  k,
  v,
}: {
  theme: { text: string; textSecondary: string };
  k: string;
  v: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={{ color: theme.textSecondary }}>{k}</Text>
      <Text style={{ color: theme.text, fontWeight: '600' }}>{v}</Text>
    </View>
  );
}

function Warning({ children, theme }: { children: React.ReactNode; theme: { text: string } }) {
  return (
    <View style={styles.warning}>
      <Text style={[styles.warningText, { color: theme.text }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 24, paddingTop: 72 },
  h1: { fontSize: 26, fontWeight: '700', marginBottom: 8 },
  lede: { fontSize: 14, lineHeight: 20, marginBottom: 28 },
  section: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 12, marginBottom: 14, opacity: 0.6 },
  preview: { borderRadius: 14, padding: 18, marginTop: 12, marginBottom: 20, gap: 6 },
  previewTitle: { fontSize: 17, fontWeight: '700', marginBottom: 8 },
  previewSub: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 14, marginBottom: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  block: { fontSize: 13, lineHeight: 20, fontVariant: ['tabular-nums'] },
  ok: { fontSize: 12, marginTop: 10 },
  cancel: { fontSize: 15, textAlign: 'center', paddingVertical: 16 },
  warning: { backgroundColor: 'rgba(255,169,64,0.18)', borderRadius: 10, padding: 12, marginTop: 10, marginBottom: 8 },
  warningText: { fontSize: 13, lineHeight: 19 },
});
