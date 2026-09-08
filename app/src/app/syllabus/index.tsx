/**
 * Syllabus coverage, by paper.
 *
 * A view over local SQLite, so it renders in full with no network. The seed
 * itself runs from the root layout, not here — this screen only reads.
 *
 * Reactivity follows `(tabs)/history.tsx`: a cheap `useLiveQuery` over the one
 * table that changes gives a change signal, whose `updatedAt` drives a reload
 * of the repository function. The effect uses a promise chain and a `cancelled`
 * flag because `react-hooks/set-state-in-effect` is an error in this repo and
 * nothing may setState synchronously in an effect body.
 */

import { useRouter } from 'expo-router';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Card } from '@/components/controls';
import { CoverageCard } from '@/components/coverage-card';
import { useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { db } from '@/db';
import { getProfile } from '@/db/profile';
import { syllabusTopics } from '@/db/schema';
import { topicFacts } from '@/db/syllabus';
import { coverageByPaper, projectFirstPass, type TopicFact } from '@/lib/syllabus-coverage';
import type { PaperValue } from '@/lib/papers';
import { localDate } from '@/lib/time';

/** The schema default, used until a profile exists. Deliberately not the exam year. */
const DEFAULT_TARGET = '2027-03-31';
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export default function SyllabusIndex() {
  const theme = useTheme();
  const isMounted = useIsMounted();
  const router = useRouter();

  const [facts, setFacts] = useState<TopicFact[]>([]);
  const [target, setTarget] = useState(DEFAULT_TARGET);
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Marking a topic on the detail screen writes here, so coming back shows the
  // new figure without a manual refresh. One narrow column keeps it cheap.
  const topicsChangedAt = useLiveQuery(
    db.select({ id: syllabusTopics.id, status: syllabusTopics.status }).from(syllabusTopics),
  ).updatedAt?.getTime();

  useEffect(() => {
    let cancelled = false;

    topicFacts()
      .then((rows) => {
        if (cancelled) return;
        setFacts(rows);
        setLoadError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    // The target date is hers, not a constant: onboarding can move it. Its
    // failure is not worth a visible error — the schema default is a good
    // enough answer for a projection.
    getProfile()
      .then((row) => {
        if (cancelled || !row) return;
        setTarget(row.targetFirstPassDate);
        setTimezone(row.timezone);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [topicsChangedAt]);

  const coverage = useMemo(() => coverageByPaper(facts), [facts]);
  const projection = useMemo(
    () => projectFirstPass(facts, { asOf: localDate(timezone), targetIso: target }),
    [facts, timezone, target],
  );

  const openPaper = (paper: PaperValue) => router.push(`/syllabus/${paper}`);

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            topicFacts()
              .then((rows) => {
                // Stack route: back-navigation unmounts it, and a refresh in
                // flight at that moment would setState on a dead component.
                if (isMounted()) setFacts(rows);
              })
              .catch(() => undefined)
              .finally(() => {
                if (isMounted()) setRefreshing(false);
              });
          }}
        />
      }
    >
      <TouchableOpacity
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/progress'))}
        accessibilityRole="button"
        accessibilityLabel="Back to progress"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Text style={[styles.back, { color: theme.textSecondary }]}>‹ Progress</Text>
      </TouchableOpacity>

      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        Syllabus
      </Text>
      <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>
        Seven papers, tracked to first pass and then to revision.
      </Text>

      {loadError ? (
        <Card title="Could not read the syllabus">
          <Text style={{ color: theme.textSecondary }}>{loadError}</Text>
        </Card>
      ) : !loaded ? (
        <Text style={{ color: theme.textSecondary }}>Loading…</Text>
      ) : (
        <>
          <CoverageCard coverage={coverage} projection={projection} onOpenPaper={openPaper} />

          <Card title="How this is counted">
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              A topic retired by a syllabus correction leaves these totals but keeps whatever you
              recorded against it, so restoring it later restores your progress too.
            </Text>
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              Confidence is your own 1–5 rating of a topic. It is deliberately separate from the
              recall grade you give a card in Revise — one is how well you think you know it, the
              other is how the schedule reacts.
            </Text>
          </Card>
        </>
      )}

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64 },
  back: { fontSize: 15, paddingVertical: 6, marginBottom: 6 },
  h1: { fontSize: 30, fontWeight: '700' },
  eyebrow: { fontSize: 13, marginTop: 2, marginBottom: 18 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 6 },
});
