/**
 * Chart building blocks shared by the score trend and the backlog trend.
 *
 * `Segment` is COPIED from `score-trend.tsx`, not moved. Moving it would edit a
 * Phase 1 file that ships a tested guarantee, to no benefit — the two charts
 * are otherwise unrelated and their geometry modules deliberately stay
 * separate (`trend.ts` is percentage-only and clamps 0–100; a backlog measured
 * in hours would silently flatten against that ceiling and still look like a
 * plausible chart).
 *
 * If you are here to deduplicate: the duplication is the point. Merge the
 * geometry modules and you delete the 0–100 clamp that `tests/trend.test.ts`
 * exists to enforce.
 */

import { View } from 'react-native';

/**
 * A straight line between two points, drawn with a rotated View.
 *
 * The translate-rotate-translate sandwich is required because React Native
 * rotates about a view's centre, not its origin: shifting back by half the
 * length, rotating, then shifting forward again makes the segment pivot on
 * `from` and land exactly on `to`.
 */
export function Segment({
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

  // Two samples at the same point: nothing to draw, and a zero-length rotation
  // is a NaN waiting to happen.
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

/** A plotted point. */
export function Dot({
  x,
  y,
  size,
  color,
}: {
  x: number;
  y: number;
  size: number;
  color: string;
}): React.ReactElement {
  return (
    <View
      style={{
        position: 'absolute',
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
      }}
    />
  );
}

/** A horizontal gridline at a given y. */
export function GridLine({
  y,
  width,
  color,
}: {
  y: number;
  width: number;
  color: string;
}): React.ReactElement {
  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        top: y,
        width,
        height: 1,
        backgroundColor: color,
        opacity: 0.18,
      }}
    />
  );
}
