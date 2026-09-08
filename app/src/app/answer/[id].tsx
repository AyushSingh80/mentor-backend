/**
 * One evaluated answer, in full.
 *
 * Ordered by what changes the next answer, not by what is easiest to render:
 * directive compliance first (the single most costly Mains error), then the one
 * highest-leverage fix, then the score breakdown, then the prose. Scrolling to
 * the bottom to find out you answered the wrong question is the wrong shape for
 * this screen.
 *
 * Counts here say "files", never "pages". `meta.pages` from the server is a
 * count of uploaded FILES: a four-sheet scanned PDF is one. Calling it "1 page"
 * would be wrong in the other direction, so the word is avoided entirely.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Card, Pill, Row, type PillTone } from '@/components/controls';
import { useTheme } from '@/components/form';
import { Markdown } from '@/components/markdown';
import { db } from '@/db';
import { PAPERS, getAnswerDetail, type AnswerDetail, type DimensionRow } from '@/db/answers';
import { evaluations } from '@/db/schema';

type LoadState = 'loading' | 'ready' | 'notFound' | 'error';

/**
 * Route params are strings from a URL and can be anything — a deep link, a
 * stale bookmark, a typo. Anything that is not a positive integer is "not
 * found", never a thrown `NaN` query.
 */
function parseAnswerId(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** `imagePaths` is a JSON string written by us, but a corrupt row must not crash the screen. */
function parseFilePaths(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function isPdfPath(uri: string): boolean {
  return /\.pdf$/i.test(uri.split('?')[0].split('#')[0]);
}

function fileNameOf(uri: string): string {
  const last = uri.split('/').pop() ?? uri;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function paperLabel(paper: string): string {
  return PAPERS.find((p) => p.value === paper)?.label ?? paper;
}

function percentOf(score: number, max: number): number | null {
  return max > 0 ? (score / max) * 100 : null;
}

export default function AnswerDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const answerId = useMemo(() => parseAnswerId(id), [id]);

  const [detail, setDetail] = useState<AnswerDetail | null>(null);
  const [state, setState] = useState<LoadState>(answerId === null ? 'notFound' : 'loading');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Re-reads when an evaluation lands, so an answer opened while it was still
  // queued fills itself in instead of sitting on "not evaluated yet".
  const evaluationsChangedAt = useLiveQuery(
    db.select({ id: evaluations.id }).from(evaluations),
  ).updatedAt?.getTime();

  // Promise chains rather than an awaited helper: `react-hooks/set-state-in-effect`
  // is an error in this repo, and nothing here may setState synchronously from
  // the effect body.
  useEffect(() => {
    if (answerId === null) return;
    let cancelled = false;

    getAnswerDetail(answerId)
      .then((row) => {
        if (cancelled) return;
        setDetail(row);
        setState(row === null ? 'notFound' : 'ready');
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setErrorText(err.message);
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [answerId, evaluationsChangedAt]);

  const back = (
    <TouchableOpacity
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/history'))}
      accessibilityRole="button"
      accessibilityLabel="Back to history"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Text style={[styles.back, { color: theme.textSecondary }]}>‹ History</Text>
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
          {state === 'error' ? 'Could not open this answer' : 'Answer not found'}
        </Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>
          {state === 'error'
            ? (errorText ?? 'The database read failed.')
            : answerId === null
              ? `“${id ?? ''}” is not a valid answer id. It may be a stale link.`
              : `Answer ${answerId} is not in your local database. It may have been deleted.`}
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

  const { answer, evaluation, percent, dimensions } = detail;
  const files = parseFilePaths(answer.imagePaths);
  const pdfCount = files.filter(isPdfPath).length;
  const directive = evaluation?.directiveWord ?? answer.directiveWord;

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            getAnswerDetail(answer.id)
              .then((row) => {
                if (row) setDetail(row);
              })
              .catch(() => undefined)
              .finally(() => setRefreshing(false));
          }}
        />
      }
    >
      {back}

      <View style={styles.titleRow}>
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          {paperLabel(answer.paper)}
        </Text>
        {percent === null ? (
          <Pill text={answer.syncStatus} tone={answer.syncStatus === 'failed' ? 'bad' : 'warn'} />
        ) : (
          <Text style={[styles.score, { color: theme.text }]}>{Math.round(percent)}%</Text>
        )}
      </View>
      <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>
        {answer.createdAt.slice(0, 10)} · {answer.wordLimit} words
        {evaluation ? ` · ${evaluation.total} of ${evaluation.max}` : ''}
      </Text>

      <Card title="Question">
        <Text style={[styles.question, { color: theme.text }]}>{answer.questionText}</Text>
        {directive ? (
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            Directive: {directive}
          </Text>
        ) : null}
      </Card>

      {evaluation ? (
        <>
          <DirectiveCompliance
            complied={evaluation.directiveCompliance}
            directive={directive}
            theme={theme}
          />

          {evaluation.highestLeverageFix ? (
            <Card title="Fix this first">
              <Text style={[styles.leverage, { color: theme.text }]}>
                {evaluation.highestLeverageFix}
              </Text>
              <Text style={[styles.note, { color: theme.textSecondary }]}>
                The single change with the most marks behind it. One fix, next answer.
              </Text>
            </Card>
          ) : null}

          <Card title="Score breakdown">
            {dimensions.length === 0 ? (
              <Text style={{ color: theme.textSecondary }}>
                This evaluation returned no per-dimension scores.
              </Text>
            ) : (
              dimensions.map((dimension) => (
                <DimensionBar key={dimension.id} dimension={dimension} theme={theme} />
              ))
            )}
            <View style={[styles.divider, { backgroundColor: theme.textSecondary }]} />
            <Row
              label="Total"
              value={`${evaluation.total} / ${evaluation.max}${
                percent === null ? '' : ` · ${Math.round(percent)}%`
              }`}
            />
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              Percentages, not raw totals, are what the trend plots — a 9/15 and a 12/20 are the
              same performance.
            </Text>
          </Card>

          <Card title="Feedback">
            <Markdown source={evaluation.feedbackMd} theme={theme} />
          </Card>

          {evaluation.modelSkeletonMd ? (
            <Card title="Model skeleton">
              <Markdown source={evaluation.modelSkeletonMd} theme={theme} />
            </Card>
          ) : null}

          <Card title="Writing mechanics">
            <Row label="Word limit respected" value={yesNo(evaluation.wordLimitRespected)} />
            <Row label="Legibility" value={evaluation.legibility ?? 'not assessed'} />
            <Row label="Evaluator confidence" value={evaluation.confidence ?? 'not stated'} />
          </Card>
        </>
      ) : (
        <Card title="Not evaluated yet">
          <Text style={{ color: theme.textSecondary }}>
            This answer is saved locally with status “{answer.syncStatus}”. Retry it from the
            pending queue on the History screen; nothing is lost in the meantime.
          </Text>
        </Card>
      )}

      <Card title={`Submitted ${files.length} ${files.length === 1 ? 'file' : 'files'}`}>
        {files.length === 0 ? (
          <Text style={{ color: theme.textSecondary }}>No files recorded for this answer.</Text>
        ) : (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbRow}>
              {files.map((uri, index) => (
                <FileThumb key={`${uri}-${index}`} uri={uri} index={index} theme={theme} />
              ))}
            </ScrollView>
            {pdfCount > 0 ? (
              <Text style={[styles.note, { color: theme.textSecondary }]}>
                A scanned PDF counts as one file however many sheets of paper it holds, which is
                why this says files rather than pages.
              </Text>
            ) : null}
          </>
        )}
      </Card>

      {evaluation ? (
        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: theme.textSecondary }]}>
            {evaluation.model} · rubric {evaluation.rubricVersion}
          </Text>
          <Text style={[styles.footerText, { color: theme.textSecondary }]}>
            Rubrics are versioned by content hash. If your scores jump, compare this hash against
            an older answer before concluding your writing changed.
          </Text>
        </View>
      ) : null}

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- fragments */

type Theme = ReturnType<typeof useTheme>;

function yesNo(value: boolean | null): string {
  if (value === null) return 'not assessed';
  return value ? 'yes' : 'no';
}

/**
 * The directive line, given its own block above everything else.
 *
 * Answering "critically examine" as if it were "describe" caps the score no
 * matter how good the content is, and it is invisible in a total. It gets the
 * loudest treatment on the screen.
 */
function DirectiveCompliance({
  complied,
  directive,
  theme,
}: {
  complied: boolean | null;
  directive: string | null;
  theme: Theme;
}) {
  const tone: PillTone = complied === null ? 'neutral' : complied ? 'good' : 'bad';
  const headline =
    complied === null
      ? 'Directive compliance not assessed'
      : complied
        ? `Answered the directive${directive ? `: ${directive}` : ''}`
        : `Did NOT answer the directive${directive ? `: ${directive}` : ''}`;

  return (
    <Card>
      <View style={styles.directiveRow}>
        <Pill text={complied === null ? 'unknown' : complied ? 'on directive' : 'off directive'} tone={tone} />
      </View>
      <Text
        accessibilityRole="header"
        style={[styles.directiveHeadline, { color: theme.text }]}
      >
        {headline}
      </Text>
      <Text style={[styles.note, { color: theme.textSecondary }]}>
        {complied === false
          ? 'This caps the score whatever the content is worth. Re-read the directive before writing, not after.'
          : 'Directive compliance is checked first because it is the most common and most costly Mains error.'}
      </Text>
    </Card>
  );
}

/** One rubric dimension: raw score AND percent, because neither alone is enough. */
function DimensionBar({ dimension, theme }: { dimension: DimensionRow; theme: Theme }) {
  const percent = percentOf(dimension.score, dimension.max);
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent));

  return (
    <View style={styles.dimension}>
      <View style={styles.dimensionHeader}>
        <Text style={[styles.dimensionName, { color: theme.text }]} numberOfLines={2}>
          {dimension.name}
        </Text>
        <Text style={[styles.dimensionValue, { color: theme.text }]}>
          {dimension.score} / {dimension.max}
          {percent === null ? '' : ` · ${Math.round(percent)}%`}
        </Text>
      </View>
      <View
        style={[styles.track, { backgroundColor: theme.backgroundSelected }]}
        accessible
        accessibilityLabel={`${dimension.name}: ${dimension.score} out of ${dimension.max}${
          percent === null ? '' : `, ${Math.round(percent)} percent`
        }`}
      >
        <View style={[styles.fill, { width: `${width}%`, backgroundColor: theme.text }]} />
      </View>
      {dimension.comment ? (
        <Text style={[styles.dimensionComment, { color: theme.textSecondary }]}>
          {dimension.comment}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A submitted file.
 *
 * PDFs get a labelled placeholder rather than a thumbnail: rendering the first
 * page of a PDF needs a native renderer, and one is not worth adding to show a
 * tile the user already recognises by name.
 */
function FileThumb({ uri, index, theme }: { uri: string; index: number; theme: Theme }) {
  const name = fileNameOf(uri);

  if (isPdfPath(uri)) {
    return (
      <View
        style={[styles.thumb, styles.pdfThumb, { backgroundColor: theme.backgroundSelected }]}
        accessible
        accessibilityLabel={`File ${index + 1}, PDF, ${name}`}
      >
        <Text style={[styles.pdfBadge, { color: theme.text }]}>PDF</Text>
        <Text style={[styles.pdfName, { color: theme.textSecondary }]} numberOfLines={2}>
          {name}
        </Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri }}
      style={[styles.thumb, { backgroundColor: theme.backgroundSelected }]}
      contentFit="cover"
      transition={120}
      accessible
      accessibilityLabel={`File ${index + 1}, ${name}`}
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64 },
  back: { fontSize: 15, paddingVertical: 6, marginBottom: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  h1: { fontSize: 30, fontWeight: '700', flexShrink: 1 },
  score: { fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  eyebrow: { fontSize: 13, marginTop: 2, marginBottom: 18 },
  question: { fontSize: 15, lineHeight: 22 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 8 },

  directiveRow: { flexDirection: 'row', marginBottom: 8 },
  directiveHeadline: { fontSize: 17, fontWeight: '700', lineHeight: 23 },

  leverage: { fontSize: 15, lineHeight: 22, fontWeight: '600' },

  dimension: { marginBottom: 14 },
  dimensionHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  dimensionName: { fontSize: 14, flexShrink: 1 },
  dimensionValue: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  track: { height: 7, borderRadius: 4, marginTop: 6, overflow: 'hidden' },
  fill: { height: 7, borderRadius: 4 },
  dimensionComment: { fontSize: 12, lineHeight: 18, marginTop: 5 },
  divider: { height: StyleSheet.hairlineWidth, opacity: 0.3, marginVertical: 8 },

  thumbRow: { marginTop: 4 },
  thumb: { width: 92, height: 124, borderRadius: 8, marginRight: 10 },
  pdfThumb: { alignItems: 'center', justifyContent: 'center', padding: 8, gap: 6 },
  pdfBadge: { fontSize: 15, fontWeight: '700', letterSpacing: 1 },
  pdfName: { fontSize: 10, textAlign: 'center' },

  footer: { gap: 6, marginTop: 4 },
  footerText: { fontSize: 11, lineHeight: 16 },
});
