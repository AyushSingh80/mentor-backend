/**
 * One paper, section by section.
 *
 * The status control and the confidence control sit side by side on every leaf
 * and mean different things. `status` is where the topic is in the plan;
 * `confidence` is a standing 1–5 self-report. Neither is the SM-2 recall grade
 * from Revise, and none of the three is ever derived from another — a topic can
 * be `revised` and still rate a 2, and that gap is the useful signal.
 *
 * Around ninety rows in a plain ScrollView. A FlatList would virtualise them,
 * but it would also unmount rows as they scroll, which is the wrong trade when
 * every row holds two controls and the whole list is one sitting's work.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Card, ChipPicker, Pill, type ChipOption, type PillTone } from '@/components/controls';
import { useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { SYLLABUS_V1 } from '@/data/syllabus-v1';
import { db } from '@/db';
import { syllabusTopics } from '@/db/schema';
import { listTopics, setTopicStatus } from '@/db/syllabus';
import {
  coverageBySection,
  type Coverage,
  type TopicFact,
  type TopicStatus,
} from '@/lib/syllabus-coverage';
import { isPaperValue, paperLabel, type PaperValue } from '@/lib/papers';

type LoadState = 'loading' | 'ready' | 'notFound' | 'error';

const STATUS_OPTIONS: readonly ChipOption<TopicStatus>[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'Reading' },
  { value: 'first_pass', label: 'First pass' },
  { value: 'revised', label: 'Revised' },
];

const CONFIDENCE_OPTIONS: readonly ChipOption<string>[] = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5', label: '5' },
];

const STATUS_TONE: Record<TopicStatus, PillTone> = {
  not_started: 'neutral',
  in_progress: 'warn',
  first_pass: 'good',
  revised: 'good',
};

/**
 * A route param is a string from a URL and can be anything — a deep link, a
 * stale bookmark, a typo. Anything that is not one of the seven papers is "not
 * found", never a query on a value the schema has never seen.
 */
function parsePaper(raw: string | undefined): PaperValue | null {
  return isPaperValue(raw) ? raw : null;
}

export default function SyllabusPaper() {
  const theme = useTheme();
  const isMounted = useIsMounted();
  const router = useRouter();
  const { paper: raw } = useLocalSearchParams<{ paper: string }>();
  const paper = useMemo(() => parsePaper(raw), [raw]);

  const [topics, setTopics] = useState<TopicFact[]>([]);
  const [state, setState] = useState<LoadState>(paper === null ? 'notFound' : 'loading');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const topicsChangedAt = useLiveQuery(
    db.select({ id: syllabusTopics.id, status: syllabusTopics.status }).from(syllabusTopics),
  ).updatedAt?.getTime();

  // Promise chains rather than an awaited helper: `react-hooks/set-state-in-effect`
  // is an error in this repo, and nothing here may setState synchronously from
  // the effect body.
  useEffect(() => {
    if (paper === null) return;
    let cancelled = false;

    listTopics(paper)
      .then((rows) => {
        if (cancelled) return;
        setTopics(rows);
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
  }, [paper, topicsChangedAt]);

  const sections = useMemo(
    () => (paper === null ? [] : buildSections(topics, paper)),
    [topics, paper],
  );

  /**
   * Optimistic, then written.
   *
   * The write is cheap but not instant, and a chip that does not move under the
   * thumb reads as a dead control. On failure the rows are reloaded from the
   * repository rather than reverted from remembered state, so the screen always
   * ends up showing what is actually stored.
   *
   * An omitted `confidence` means "leave it alone" all the way down to the
   * UPDATE, which is what keeps a status change from discarding a rating.
   */
  const apply = useCallback(
    (id: number, status: TopicStatus, confidence?: number | null) => {
      setTopics((current) =>
        current.map((topic) =>
          topic.id === id
            ? { ...topic, status, ...(confidence === undefined ? {} : { confidence }) }
            : topic,
        ),
      );
      setSaveError(null);

      setTopicStatus(id, status, confidence).catch((err: Error) => {
        setSaveError(err.message);
        if (paper !== null) listTopics(paper).then(setTopics).catch(() => undefined);
      });
    },
    [paper],
  );

  // A TouchableOpacity rather than a bare `Text onPress`, matching every other
  // back control in the app: `Text` has no `hitSlop` prop, so on its own it was
  // the smallest target in the app — on the screen with the longest scroll to
  // escape from.
  const back = (
    <TouchableOpacity
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/syllabus'))}
      accessibilityRole="button"
      accessibilityLabel="Back to the syllabus"
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
    >
      <Text style={[styles.back, { color: theme.textSecondary }]}>‹ Syllabus</Text>
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
          {state === 'error' ? 'Could not open this paper' : 'Paper not found'}
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          {state === 'error'
            ? (errorText ?? 'The database read failed.')
            : `“${raw ?? ''}” is not one of the seven papers. It may be a stale link.`}
        </Text>
      </ScrollView>
    );
  }

  if (state === 'loading' || paper === null) {
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

  const passed = topics.filter((t) => t.status === 'first_pass' || t.status === 'revised').length;

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            listTopics(paper)
              .then((rows) => {
                // This is a stack route, so back-navigation really does unmount
                // it — and a refresh started just before that would otherwise
                // land its setState on a dead component.
                if (isMounted()) setTopics(rows);
              })
              .catch(() => undefined)
              .finally(() => {
                if (isMounted()) setRefreshing(false);
              });
          }}
        />
      }
    >
      {back}

      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        {paperLabel(paper)}
      </Text>
      <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>
        {passed} of {topics.length} topics past a first pass, across {sections.length}{' '}
        {sections.length === 1 ? 'section' : 'sections'}.
      </Text>

      {paper === 'essay' ? (
        <Card title="Not an official syllabus">
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            UPSC publishes no syllabus for the Essay paper. These are thematic clusters drawn from
            past papers — a scaffold for practice, not a list you can finish. A percentage here
            measures how much of this scaffold you have worked through, and nothing more.
          </Text>
        </Card>
      ) : null}

      {saveError ? (
        <Card title="Not saved">
          <Text style={{ color: theme.textSecondary }}>
            {saveError} The rows below have been reloaded from what is actually stored.
          </Text>
        </Card>
      ) : null}

      {topics.length === 0 ? (
        <Card title="Nothing here yet">
          <Text style={{ color: theme.textSecondary }}>
            This paper has no live topics. The syllabus is seeded on launch; reopening the app will
            fill it in.
          </Text>
        </Card>
      ) : (
        sections.map((section) => (
          <SectionBlock
            key={section.coverage.key}
            section={section}
            onApply={apply}
            theme={theme}
          />
        ))
      )}

      <View style={{ height: 64 }} />
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- fragments */

type Theme = ReturnType<typeof useTheme>;

interface SectionView {
  coverage: Coverage;
  topics: TopicFact[];
}

/**
 * Sections in printed syllabus order, since `listTopics` already sorts by
 * `position`. `coverageBySection` owns the arithmetic, so the header figure and
 * the paper figure can never be computed two different ways.
 */
function buildSections(topics: TopicFact[], paper: PaperValue): SectionView[] {
  const grouped = new Map<string, TopicFact[]>();
  for (const topic of topics) {
    const bucket = grouped.get(topic.topic);
    if (bucket) bucket.push(topic);
    else grouped.set(topic.topic, [topic]);
  }

  const byKey = new Map(coverageBySection(topics, paper).map((c) => [c.label, c] as const));

  const out: SectionView[] = [];
  for (const [name, bucket] of grouped) {
    const coverage = byKey.get(name);
    if (coverage) out.push({ coverage, topics: bucket });
  }
  return out;
}

function SectionBlock({
  section,
  onApply,
  theme,
}: {
  section: SectionView;
  onApply: (id: number, status: TopicStatus, confidence?: number | null) => void;
  theme: Theme;
}) {
  const { coverage } = section;
  const percent = Math.round(coverage.percentFirstPass);

  return (
    <Card>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${coverage.label}: ${percent} percent of ${coverage.total} topics past a first pass`}
      >
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>{coverage.label}</Text>
          <Text style={[styles.sectionValue, { color: theme.text }]}>
            {percent}%
            <Text style={[styles.sectionCount, { color: theme.textSecondary }]}>
              {' '}
              of {coverage.total}
            </Text>
          </Text>
        </View>
        <View style={[styles.track, { backgroundColor: theme.backgroundSelected }]}>
          <View style={[styles.fill, { width: `${percent}%`, backgroundColor: theme.text }]} />
        </View>
      </View>

      {section.topics.map((topic) => (
        <TopicRow key={topic.id} topic={topic} onApply={onApply} theme={theme} />
      ))}
    </Card>
  );
}

function TopicRow({
  topic,
  onApply,
  theme,
}: {
  topic: TopicFact;
  onApply: (id: number, status: TopicStatus, confidence?: number | null) => void;
  theme: Theme;
}) {
  return (
    <View style={[styles.topic, { borderTopColor: theme.backgroundSelected }]}>
      <View style={styles.topicHeader}>
        <Text style={[styles.topicText, { color: theme.text }]}>{leafText(topic)}</Text>
        <Pill text={statusLabel(topic.status)} tone={STATUS_TONE[topic.status]} />
      </View>

      <ChipPicker
        label="Status"
        options={STATUS_OPTIONS}
        selected={topic.status}
        // Confidence is deliberately not passed: changing a status must not
        // touch a rating she set weeks ago, and must never derive one from it.
        onSelect={(status) => onApply(topic.id, status)}
      />

      <ChipPicker
        label="Confidence"
        hint="Your own 1–5 rating. Not the recall grade you give a card in Revise."
        options={CONFIDENCE_OPTIONS}
        selected={topic.confidence === null ? null : String(topic.confidence)}
        onSelect={(value) => {
          // Tapping the selected chip clears the rating, which is the only way
          // back to "not rated" from a five-chip row.
          const next = topic.confidence === Number(value) ? null : Number(value);
          onApply(topic.id, topic.status, next);
        }}
      />
    </View>
  );
}

function statusLabel(status: TopicStatus): string {
  return STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status;
}

/**
 * The leaf bullet, looked up by slug in the dataset.
 *
 * `TopicFact` carries the section but not the bullet, and its shape is fixed by
 * `lib/syllabus-coverage`. The dataset is the same text `ensureSyllabusSeeded`
 * wrote into the row, so reading it here cannot disagree with the database —
 * and a slug the current build does not ship still renders as something legible
 * rather than blank.
 */
const LEAF_TEXT = new Map(
  SYLLABUS_V1.entries.map((entry) => [entry.slug, entry.subtopic ?? entry.topic] as const),
);

function leafText(topic: TopicFact): string {
  const known = LEAF_TEXT.get(topic.slug);
  if (known !== undefined) return known;
  const tail = topic.slug.split('-').slice(1).join(' ');
  return tail.length > 0 ? tail.replace(/^./, (c) => c.toUpperCase()) : topic.slug;
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64 },
  back: { fontSize: 15, paddingVertical: 12, marginBottom: 6, minHeight: 44 },
  h1: { fontSize: 30, fontWeight: '700' },
  eyebrow: { fontSize: 13, marginTop: 2, marginBottom: 18 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 6 },

  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 10,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', flexShrink: 1 },
  sectionValue: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  sectionCount: { fontSize: 12, fontWeight: '400' },
  track: { height: 6, borderRadius: 3, marginTop: 6, marginBottom: 4, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },

  topic: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 14, marginTop: 14 },
  topicHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 },
  topicText: { fontSize: 15, lineHeight: 21, flexShrink: 1, fontWeight: '500' },
});
