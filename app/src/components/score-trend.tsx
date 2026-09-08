/**
 * Score trend chart, drawn with plain `View`s.
 *
 * No `react-native-svg` and no charting library. A line chart of a few dozen
 * points is a handful of absolutely-positioned rectangles; `react-native-svg`
 * is a native module that has to be rebuilt into the APK, and the charting
 * packages on top of it drag in peer dependencies this app is not taking on
 * for one screen.
 *
 * The whole coordinate system — including the top-left origin that makes a
 * higher percent a LOWER y — lives in `lib/trend.ts`, which is pure and
 * unit-tested. This file only turns numbers into rectangles.
 *
 * Accessibility: a chart assembled from bare `View`s is silent to a screen
 * reader. There is no text to read and no image to describe, so the whole plot
 * is collapsed into a single focusable element whose label is a sentence
 * summarising the trend (`describeTrend`). Without that this component is
 * literally nothing to a non-sighted user.
 */

import { useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { useTheme } from '@/components/form';
import { PAPERS, type PaperValue, type TrendPoint } from '@/db/answers';
import { buildTrendGeometry, describeTrend, summariseTrend } from '@/lib/trend';

/** Width of the y-axis label gutter. Fits "100%" at 11pt. */
const AXIS_WIDTH = 40;
const DOT_SIZE = 7;
const LINE_THICKNESS = 2;
const AVERAGE_THICKNESS = 2;
const DEFAULT_HEIGHT = 168;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-01` -> `1 Sep`. Kept off `Date` so a timezone cannot shift the day. */
function shortDate(iso: string): string {
  const [, month, day] = iso.split('-');
  const monthIndex = Number(month) - 1;
  if (!day || monthIndex < 0 || monthIndex > 11) return iso;
  return `${Number(day)} ${MONTHS[monthIndex]}`;
}

function paperLabel(paper: PaperValue | undefined): string | undefined {
  if (!paper) return undefined;
  return PAPERS.find((p) => p.value === paper)?.label;
}

export function ScoreTrend({
  points,
  height = DEFAULT_HEIGHT,
  paper,
}: {
  points: TrendPoint[];
  height?: number;
  paper?: PaperValue;
}): React.ReactElement {
  const theme = useTheme();

  // The plot fills the space left over after the axis gutter, so its width is
  // only known after layout. Set from an onLayout event — not from an effect —
  // so no state is written synchronously during render.
  const [seriesWidth, setSeriesWidth] = useState(0);

  const handleLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    // Ignore sub-pixel jitter; without this a fractional layout width can
    // ping-pong between two values and re-render forever.
    setSeriesWidth((previous) => (Math.abs(previous - width) < 0.5 ? previous : width));
  };

  const geometry = useMemo(
    () => buildTrendGeometry(points, { width: seriesWidth, height }),
    [points, seriesWidth, height],
  );

  const label = paperLabel(paper);
  const summary = useMemo(() => summariseTrend(points), [points]);
  const description = useMemo(() => describeTrend(points, label), [points, label]);

  if (points.length === 0) {
    return (
      <View
        accessible
        accessibilityLabel={description}
        style={[styles.empty, { height, backgroundColor: theme.background }]}
      >
        <Text style={[styles.emptyTitle, { color: theme.text }]}>No scores yet</Text>
        <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>
          {label
            ? `Nothing scored for ${label} yet. Evaluated answers plot here.`
            : 'Submit an answer for evaluation and its score plots here, normalised to a percentage so papers with different maxima are comparable.'}
        </Text>
      </View>
    );
  }

  const first = geometry.points[0];
  const last = geometry.points[geometry.points.length - 1];
  const ready = seriesWidth > 0;

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={description}>
      <View style={styles.headline}>
        <Text style={[styles.headlineValue, { color: theme.text }]}>
          {Math.round(summary.latest ?? 0)}%
        </Text>
        <Text style={[styles.headlineMeta, { color: theme.textSecondary }]}>
          latest{summary.changePoints === null ? '' : ` · ${formatDelta(summary.changePoints)}`} ·{' '}
          {Math.round(summary.mean ?? 0)}% average over {summary.count}
        </Text>
      </View>

      <View style={[styles.chartRow, { height: height + DOT_SIZE }]}>
        {/* Y-axis gutter. Labels are positioned by the same pixel values the
            dots use, so they cannot drift apart. */}
        <View style={[styles.axis, { height }]}>
          {geometry.yTicks.map((tick) => (
            <Text
              key={tick.label}
              // The chart already carries a spoken summary; reading "40% 60%
              // 80%" after it adds nothing.
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[styles.tickLabel, { color: theme.textSecondary, top: tick.y - 7 }]}
            >
              {tick.label}
            </Text>
          ))}
        </View>

        <View style={[styles.plot, { height }]}>
          {geometry.yTicks.map((tick) => (
            <View
              key={tick.label}
              style={[styles.gridline, { top: tick.y, backgroundColor: theme.textSecondary }]}
            />
          ))}

          {/* Inset by half a dot on each side so the first and last markers sit
              fully inside the plot instead of half-hanging off the edges. */}
          <View style={styles.series} onLayout={handleLayout}>
            {ready ? (
              <>
                {/* Moving average underneath: context, not the reading. */}
                {geometry.average.slice(1).map((to, i) => (
                  <Segment
                    key={`avg-${i}`}
                    from={geometry.average[i]}
                    to={to}
                    color={theme.textSecondary}
                    thickness={AVERAGE_THICKNESS}
                    opacity={0.35}
                  />
                ))}

                {geometry.points.slice(1).map((to, i) => (
                  <Segment
                    key={`seg-${i}`}
                    from={geometry.points[i]}
                    to={to}
                    color={theme.text}
                    thickness={LINE_THICKNESS}
                    opacity={0.75}
                  />
                ))}

                {geometry.points.map((point, i) => (
                  <View
                    key={`${point.date}-${i}`}
                    style={[
                      styles.dot,
                      {
                        left: point.x - DOT_SIZE / 2,
                        top: point.y - DOT_SIZE / 2,
                        backgroundColor: theme.text,
                      },
                    ]}
                  />
                ))}
              </>
            ) : null}
          </View>
        </View>
      </View>

      <View style={styles.footer}>
        <Text style={[styles.footerText, { color: theme.textSecondary }]}>
          {shortDate(first.date)}
        </Text>
        <Text style={[styles.footerText, { color: theme.textSecondary }]}>
          {label ?? 'All papers'} · % of the paper&apos;s own maximum
        </Text>
        <Text style={[styles.footerText, { color: theme.textSecondary }]}>
          {shortDate(last.date)}
        </Text>
      </View>
    </View>
  );
}

function formatDelta(points: number): string {
  const rounded = Math.round(points);
  if (rounded === 0) return 'flat';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} pts`;
}

/**
 * One line segment between two plotted points.
 *
 * A `View` can only be an axis-aligned rectangle, so a sloped line is a thin
 * rectangle rotated into place. React Native rotates about a view's CENTRE, but
 * the segment must pivot on its LEFT EDGE to stay anchored at `from`. The
 * translate-rotate-translate sandwich moves the pivot to the left edge:
 * applied right-to-left, it shifts the segment right by half its length,
 * rotates, then shifts back — leaving `from` fixed and landing the far end
 * exactly on `to`.
 */
function Segment({
  from,
  to,
  color,
  thickness,
  opacity,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
  thickness: number;
  opacity: number;
}): React.ReactElement | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);

  // Two answers on the same day at the same score: nothing to draw, and a
  // zero-length rotation is a NaN waiting to happen.
  if (!Number.isFinite(length) || length < 0.5) return null;

  return (
    <View
      style={{
        position: 'absolute',
        left: from.x,
        top: from.y - thickness / 2,
        width: length,
        height: thickness,
        borderRadius: thickness / 2,
        backgroundColor: color,
        opacity,
        transform: [
          { translateX: -length / 2 },
          { rotate: `${Math.atan2(dy, dx)}rad` },
          { translateX: length / 2 },
        ],
      }}
    />
  );
}

const styles = StyleSheet.create({
  headline: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 10 },
  headlineValue: { fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'] },
  headlineMeta: { fontSize: 12, flex: 1 },

  // Half a dot of slack above and below so edge markers are not clipped.
  chartRow: { flexDirection: 'row', paddingVertical: DOT_SIZE / 2 },
  axis: { width: AXIS_WIDTH },
  tickLabel: {
    position: 'absolute',
    right: 8,
    fontSize: 11,
    lineHeight: 14,
    fontVariant: ['tabular-nums'],
  },
  plot: { flex: 1 },
  gridline: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, opacity: 0.25 },
  series: { position: 'absolute', top: 0, bottom: 0, left: DOT_SIZE / 2, right: DOT_SIZE / 2 },
  dot: { position: 'absolute', width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2 },

  footer: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 6 },
  footerText: { fontSize: 11 },

  empty: { borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 16 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  emptyBody: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
