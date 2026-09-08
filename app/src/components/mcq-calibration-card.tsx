/**
 * Calibration — does she know when she does not know?
 *
 * This is the highest-value Prelims skill and the only one on this screen that
 * is a *skill* rather than a score. Under negative marking an attempt pays only
 * above 25% accuracy, so the trainable rule is "guess if and only if you
 * eliminated something", and the reason candidates lose marks is that they
 * BELIEVE they eliminated when they did not. The guess flag measures exactly
 * that belief against the outcome.
 *
 * ## The card has to be able to say its own instrument is broken
 *
 * The "I'm guessing" flag is opt-in and will be under-reported, because
 * guessing feels like knowing. `lib/mcq-score.ts` watches the answers she did
 * NOT flag: if those are barely better than chance over a real sample, the flag
 * is not measuring what it claims and every bucket split by it is fiction.
 * When `instrumentTrusted` is false this card shows NO bucket breakdown at all
 * — not a greyed-out one, not one with a caveat under it — and falls back to
 * aggregate framing that does not depend on the flag. A flattering guess bucket
 * left on screen with a warning beside it is still read as a result.
 *
 * ## Attempt rate is never dropped
 *
 * Over-correcting into skipping everything is the other way to lose marks and
 * is invisible in an accuracy figure. It is on the card in both modes.
 */

import { StyleSheet, Text, View } from 'react-native';

import { Card, Pill, Row, type PillTone } from '@/components/controls';
import { useTheme } from '@/components/form';
import {
  formatPercent,
  formatSignedMarks,
  INSTRUMENT_MIN_ATTEMPTS,
  ONE_ELIMINATION_ACCURACY,
  type Calibration,
  type CalibrationBucket,
} from '@/lib/mcq-score';

export interface McqCalibrationCardProps {
  calibration: Calibration;
  /** Heading. The lifetime view is the default; a caller may scope it. */
  title?: string;
}

export function McqCalibrationCard({
  calibration,
  title = 'Do you know when you are guessing?',
}: McqCalibrationCardProps): React.ReactElement {
  const theme = useTheme();
  const {
    total,
    answered,
    skipped,
    attemptRate,
    accuracyOnAttempted,
    breakEvenAccuracy,
    buckets,
    instrumentTrusted,
    instrumentNote,
    verdict,
    verdictBasis,
    overCorrecting,
  } = calibration;

  if (total === 0) {
    return (
      <Card title={title}>
        <Text style={{ color: theme.textSecondary }}>
          No attempts on record yet. This fills in after your first drill and gets sharper as the
          log grows — the guess check needs {INSTRUMENT_MIN_ATTEMPTS} unflagged answers before it
          can vouch for itself.
        </Text>
      </Card>
    );
  }

  const answeredBuckets = buckets.filter((b) => b.key !== 'skipped');

  return (
    <Card title={title}>
      <View style={styles.verdictRow}>
        <Pill
          text={verdictBasis === 'buckets' ? 'guess flag' : 'totals only'}
          tone={instrumentTrusted ? 'neutral' : 'warn'}
        />
        {overCorrecting ? <Pill text="skipping a lot" tone="warn" /> : null}
      </View>

      <Text style={[styles.verdict, { color: theme.text }]}>{verdict}</Text>

      {instrumentNote ? (
        <View style={[styles.broken, { borderColor: theme.textSecondary }]}>
          <Text style={[styles.brokenTitle, { color: theme.text }]}>
            The guess flag is not measuring what it claims
          </Text>
          <Text style={[styles.note, { color: theme.textSecondary }]}>{instrumentNote}</Text>
        </View>
      ) : null}

      {/* Buckets only when the flag can be believed. See the header note. */}
      {instrumentTrusted && verdictBasis === 'buckets' ? (
        <View style={styles.buckets}>
          {answeredBuckets.map((bucket) => (
            <BucketRow key={bucket.key} bucket={bucket} breakEven={breakEvenAccuracy} />
          ))}
        </View>
      ) : null}

      <View style={[styles.divider, { backgroundColor: theme.textSecondary }]} />

      <Row label="Attempted" value={`${answered} of ${total} · ${formatPercent(attemptRate)}`} />
      <Row label="Skipped" value={String(skipped)} />
      <Row label="Accuracy on attempted" value={formatPercent(accuracyOnAttempted)} />
      <Row label="Break-even" value={formatPercent(breakEvenAccuracy)} />

      <Text style={[styles.note, { color: theme.textSecondary }]}>
        Answering pays above {formatPercent(breakEvenAccuracy)}, so a blind four-way guess is worth
        exactly nothing and eliminating one option ({formatPercent(ONE_ELIMINATION_ACCURACY)}) makes
        guessing pay. Skipping is always worth zero — never a penalty, and never a mark.
      </Text>
    </Card>
  );
}

/* ---------------------------------------------------------------- parts */

/** One bucket: how often it lands, and what it is worth per 10 questions. */
function BucketRow({ bucket, breakEven }: { bucket: CalibrationBucket; breakEven: number }) {
  const theme = useTheme();

  if (bucket.attempts === 0) {
    return (
      <View style={styles.bucket}>
        <Text style={[styles.bucketLabel, { color: theme.text }]}>{bucket.label}</Text>
        <Text style={[styles.note, { color: theme.textSecondary }]}>None on record.</Text>
      </View>
    );
  }

  const per10 = bucket.marksPer10 ?? 0;
  const tone: PillTone = Math.abs(per10) < 0.05 ? 'warn' : per10 > 0 ? 'good' : 'bad';

  return (
    <View style={styles.bucket}>
      <View style={styles.bucketHeader}>
        <Text style={[styles.bucketLabel, { color: theme.text }]} numberOfLines={2}>
          {bucket.label}
        </Text>
        <Pill text={`${formatSignedMarks(per10)} per 10`} tone={tone} />
      </View>
      <Text style={[styles.bucketDetail, { color: theme.textSecondary }]}>
        {bucket.attempts} attempts · {bucket.correct} right ({formatPercent(bucket.accuracy)}) ·{' '}
        {formatSignedMarks(bucket.netMarks)} marks in total
      </Text>
      <Track fraction={bucket.accuracy} breakEven={breakEven} />
    </View>
  );
}

/**
 * Accuracy against the break-even mark.
 *
 * The tick is the whole point of the bar: a fill without it is just a
 * percentage, and the only thing that matters about this percentage is which
 * side of 25% it lands on. Built from bare `View`s, so the surrounding row
 * carries the text — this is decoration and is hidden from screen readers.
 */
function Track({ fraction, breakEven }: { fraction: number | null; breakEven: number }) {
  const theme = useTheme();
  if (fraction === null) return null;

  const width = Math.max(0, Math.min(100, fraction * 100));
  const tick = Math.max(0, Math.min(100, breakEven * 100));

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.track, { backgroundColor: theme.backgroundSelected }]}
    >
      <View style={[styles.fill, { width: `${width}%`, backgroundColor: theme.text }]} />
      <View style={[styles.breakEvenTick, { left: `${tick}%`, backgroundColor: theme.text }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  verdictRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  verdict: { fontSize: 15, lineHeight: 22, fontWeight: '600' },
  note: { fontSize: 12, lineHeight: 18, marginTop: 8 },

  broken: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, marginTop: 14 },
  brokenTitle: { fontSize: 13, fontWeight: '700' },

  buckets: { marginTop: 16, gap: 14 },
  bucket: { gap: 4 },
  bucketHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  bucketLabel: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  bucketDetail: { fontSize: 12, lineHeight: 17 },
  track: { height: 7, borderRadius: 4, marginTop: 4, overflow: 'hidden' },
  fill: { height: 7, borderRadius: 4 },
  breakEvenTick: { position: 'absolute', top: 0, width: 2, height: 7, opacity: 0.75 },

  divider: { height: StyleSheet.hairlineWidth, opacity: 0.3, marginVertical: 16 },
});
