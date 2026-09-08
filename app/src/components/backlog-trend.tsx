/**
 * Lecture backlog over time, drawn with plain `View`s.
 *
 * The sibling of `score-trend.tsx` and deliberately not a generalisation of
 * it: the two charts share their rectangles (`chart-primitives.tsx`) and
 * nothing else. Score is a percentage on a clamped 0–100 axis; backlog is
 * hours on an unbounded one, and the geometry modules stay apart so that
 * clamp cannot leak in here and silently flatten a 140-hour backlog.
 *
 * All coordinate arithmetic — including the top-left origin that makes a
 * LARGER backlog a SMALLER y — lives in `lib/backlog-chart.ts`, which is pure
 * and unit-tested. This file only turns numbers into rectangles.
 *
 * Accessibility: a chart assembled from bare `View`s is silent to a screen
 * reader — no text, no image, nothing to announce. The whole plot is therefore
 * collapsed into one focusable element whose label is the sentence from
 * `describeBacklogChart`. That sentence IS the chart for a non-sighted user.
 */

import { useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { Dot, GridLine, Segment } from '@/components/chart-primitives';
import { useTheme } from '@/components/form';
import { buildBacklogChart, describeBacklogChart } from '@/lib/backlog-chart';
import type { BacklogSeriesPoint } from '@/lib/backlog';

/** Width of the y-axis label gutter. Fits "160h" at 11pt. */
const AXIS_WIDTH = 42;
const DOT_SIZE = 6;
const LINE_THICKNESS = 2;
const DEFAULT_HEIGHT = 150;

/**
 * A backlog that has only ever grown is the one state worth a second colour.
 * Fixed rather than themed: it has to read as a warning against both a white
 * and a black background, and the palette has no semantic slot for that.
 */
const RISING_COLOR = '#E5484D';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-01` -> `1 Sep`. Kept off `Date` so a timezone cannot shift the day. */
function shortDate(iso: string): string {
  const [, month, day] = iso.split('-');
  const monthIndex = Number(month) - 1;
  if (!day || monthIndex < 0 || monthIndex > 11) return iso;
  return `${Number(day)} ${MONTHS[monthIndex]}`;
}

function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function BacklogTrend({
  series,
  height = DEFAULT_HEIGHT,
  label,
}: {
  series: BacklogSeriesPoint[];
  height?: number;
  /** Scope shown in the footer, e.g. "General Studies". */
  label?: string;
}): React.ReactElement {
  const theme = useTheme();

  // The plot fills whatever is left after the axis gutter, so its width is only
  // known after layout. Set from an onLayout event — never from an effect —
  // because `react-hooks/set-state-in-effect` is an error in this repo.
  const [seriesWidth, setSeriesWidth] = useState(0);

  const handleLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    // Ignore sub-pixel jitter; a fractional layout width can otherwise
    // ping-pong between two values and re-render forever.
    setSeriesWidth((previous) => (Math.abs(previous - width) < 0.5 ? previous : width));
  };

  const geometry = useMemo(
    () => buildBacklogChart(series, { width: seriesWidth, height }),
    [series, seriesWidth, height],
  );
  const description = useMemo(() => describeBacklogChart(geometry), [geometry]);

  if (series.length === 0) {
    return (
      <View
        accessible
        accessibilityLabel={description}
        style={[styles.empty, { height, backgroundColor: theme.background }]}
      >
        <Text style={[styles.emptyTitle, { color: theme.text }]}>No lecture history yet</Text>
        <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>
          Log the lectures your course has released and the ones you have watched. The gap between
          them plots here, in hours of content.
        </Text>
      </View>
    );
  }

  const first = geometry.points[0];
  const last = geometry.points[geometry.points.length - 1];
  const lineColor = geometry.monotonicallyRising ? RISING_COLOR : theme.text;
  const ready = seriesWidth > 0;

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={description}>
      <View style={styles.headline}>
        <Text style={[styles.headlineValue, { color: lineColor }]}>
          {formatHours(last.backlogHours)}h
        </Text>
        <Text style={[styles.headlineMeta, { color: theme.textSecondary }]}>
          {geometry.points.length === 1
            ? 'behind, on the only day with history'
            : `behind now · ${formatHours(first.backlogHours)}h ${geometry.points.length} days ago`}
        </Text>
      </View>

      <View style={[styles.chartRow, { height: height + DOT_SIZE }]}>
        {/* Labels are positioned by the same pixel values the dots use, so they
            cannot drift apart. */}
        <View style={[styles.axis, { height }]}>
          {geometry.yTicks.map((tick) => (
            <Text
              key={tick.label}
              // The plot already carries a spoken summary; reading "0h 40h 80h"
              // after it adds nothing.
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[styles.tickLabel, { color: theme.textSecondary, top: tick.y - 7 }]}
            >
              {tick.label}
            </Text>
          ))}
        </View>

        <View style={[styles.plot, { height }]}>
          {/* Inset by half a dot each side so the first and last markers sit
              fully inside the plot instead of half-hanging off the edges. The
              gridlines live in here too, so they are measured by the same
              `onLayout` as the dots and cannot end up a few pixels short. */}
          <View style={styles.series} onLayout={handleLayout}>
            {geometry.yTicks.map((tick) => (
              <GridLine
                key={tick.label}
                y={tick.y}
                width={seriesWidth}
                color={theme.textSecondary}
              />
            ))}

            {ready ? (
              <>
                {geometry.points.slice(1).map((to, i) => (
                  <Segment
                    key={`seg-${to.date}-${i}`}
                    from={geometry.points[i]}
                    to={to}
                    color={lineColor}
                    thickness={LINE_THICKNESS}
                    opacity={0.8}
                  />
                ))}

                {geometry.points.map((point, i) => (
                  <Dot
                    key={`${point.date}-${i}`}
                    x={point.x}
                    y={point.y}
                    size={DOT_SIZE}
                    color={lineColor}
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
        <Text style={[styles.footerText, { color: theme.textSecondary }]} numberOfLines={1}>
          {label ?? 'All courses'} · hours of unwatched content
        </Text>
        <Text style={[styles.footerText, { color: theme.textSecondary }]}>
          {shortDate(last.date)}
        </Text>
      </View>
    </View>
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
  series: { position: 'absolute', top: 0, bottom: 0, left: DOT_SIZE / 2, right: DOT_SIZE / 2 },

  footer: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 6 },
  footerText: { fontSize: 11, flexShrink: 1 },

  empty: { borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 16 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
  emptyBody: { fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
