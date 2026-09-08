import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, useColorScheme, View } from 'react-native';

import migrations from '../../drizzle/migrations';
import { db } from '@/db';
import { getProfile } from '@/db/profile';
import { profile } from '@/db/schema';
import { ensurePyqImported } from '@/db/pyq';
import { ensureSyllabusSeeded } from '@/db/syllabus';
import { Colors } from '@/constants/theme';

export default function RootLayout() {
  const isDark = useColorScheme() === 'dark';
  const theme = isDark ? Colors.dark : Colors.light;
  const { success, error } = useMigrations(db, migrations);

  const [profileError, setProfileError] = useState<string | null>(null);
  const router = useRouter();
  const segments = useSegments();

  /**
   * LIVE, not read once.
   *
   * This was a one-shot `getProfile()` in state, and the staleness was a
   * first-run trap that made the app unusable: onboarding saves, calls
   * `router.replace('/')`, the gate below re-runs because the route changed,
   * and `onboarded` is still the `false` it was read as at mount — so it
   * redirects straight back to onboarding, forever. The profile row existed on
   * disk the whole time; nothing ever read it again.
   *
   * `useLiveQuery` re-renders when `profile` is written, which is exactly the
   * event that should end the first-run gate. `enableChangeListener` is on for
   * this reason — see `db/index.ts`.
   */
  const profileRows = useLiveQuery(db.select({ id: profile.id }).from(profile));
  const onboarded = success ? profileRows.data !== undefined && profileRows.data.length > 0 : null;

  useEffect(() => {
    if (!success) return;
    let cancelled = false;

    // Still read once, but only to surface a READ FAILURE. `useLiveQuery`
    // swallows errors into an empty result, which is indistinguishable from
    // "no profile yet" — and silently treating a broken database as a new
    // install would send her through onboarding again and overwrite nothing,
    // leaving her on a spinner with no explanation.
    getProfile().catch((err: Error) => {
      if (!cancelled) setProfileError(err.message);
    });

    /**
     * Seed the syllabus, deliberately NOT awaited and deliberately not gating
     * the app.
     *
     * It is idempotent — a steady-state launch reads 438 rows, plans no
     * changes, and writes nothing — so running it on every start is cheap. But
     * it must never block: the syllabus is one feature among several, and an
     * app that refuses to open because a seed failed would be a far worse
     * outcome than a syllabus screen showing its empty state. A failure is
     * logged and retried on the next launch.
     */
    void ensureSyllabusSeeded()
      .then(() => {
        /**
         * Past papers, AFTER the syllabus and chained rather than parallel.
         *
         * The importer resolves each question's `syllabusSlug` to a topic id
         * through `topicIdBySlug()`. Run before the seed, on a first launch,
         * every slug would resolve to nothing and the whole import would land
         * untagged — which is recoverable (the next launch re-plans and emits
         * updates once the slugs exist) but means her first question bank aims
         * at nothing, on the one launch where the app is being judged.
         *
         * Same discipline as the seed itself: idempotent, so a steady-state
         * launch plans nothing and writes nothing; never awaited, so it cannot
         * delay the first frame; never fatal, because a question bank that
         * failed to import is a smaller bank, not a broken app.
         */
        return ensurePyqImported();
      })
      .catch((err: Error) => {
        console.error('[seed] syllabus or past-paper import failed; retrying next launch', err);
      });

    return () => {
      cancelled = true;
    };
  }, [success]);

  /**
   * First-run gate only.
   *
   * This deliberately does NOT bounce the user out of /onboarding once a
   * profile exists — that route doubles as the "edit schedule" screen, and
   * redirecting away from it made editing unreachable.
   */
  useEffect(() => {
    if (onboarded !== false) return;
    if (segments[0] === 'onboarding') return;
    router.replace('/onboarding');
  }, [onboarded, segments, router]);

  if (error || profileError) {
    return (
      <Centered background={theme.background}>
        <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
          {error ? 'Database migration failed' : 'Could not read your profile'}
        </Text>
        <Text style={[styles.body, { color: theme.textSecondary }]}>
          {error?.message ?? profileError}
        </Text>
      </Centered>
    );
  }

  if (!success || onboarded === null) {
    return (
      <Centered background={theme.background}>
        <ActivityIndicator />
        <Text style={[styles.body, { color: theme.textSecondary }]}>Preparing your database…</Text>
      </Centered>
    );
  }

  return (
    <ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
      <Stack
        screenOptions={{ headerShown: false }}
        initialRouteName={onboarded ? '(tabs)' : 'onboarding'}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" />
        {/* These sit outside the tabs so they push over them with a back
            gesture. Logging a lecture is a two-minute action fired from the
            pre-shift checkpoint, not a destination worth a permanent tab. */}
        <Stack.Screen name="answer/[id]" />
        <Stack.Screen name="lecture/log" />
        <Stack.Screen name="lecture/[id]" />
        <Stack.Screen name="syllabus/index" />
        <Stack.Screen name="syllabus/[paper]" />
        {/* The drill sits outside the tabs deliberately: the tab bar occupies
            49–83pt of exactly the thumb arc the answer pad needs, and during a
            twelve-minute one-handed commute drill that space is worth more
            than the bar's navigational value. */}
        <Stack.Screen name="drill/index" />
        <Stack.Screen name="drill/[id]" />
        <Stack.Screen name="drill/summary/[id]" />
        {/* A daily action pushed over the tabs, not a fifth tab — the four-tab
            ceiling and its reasoning stand. */}
        <Stack.Screen name="current/index" />
        <Stack.Screen name="current/[id]" />
        <Stack.Screen name="current/archive" />
      </Stack>
    </ThemeProvider>
  );
}

function Centered({ children, background }: { children: React.ReactNode; background: string }) {
  return <View style={[styles.centered, { backgroundColor: background }]}>{children}</View>;
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  title: { fontSize: 18, fontWeight: '600' },
  body: { fontSize: 14, textAlign: 'center' },
});
