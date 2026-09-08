/**
 * What to do today. The one card on the screen that decides.
 *
 * Presentation only: no arithmetic, no `Date`, no formatting of a number the
 * pure module did not compute. Every figure here comes from `TodayDecision`,
 * because a card that derived its own would be a second answer capable of
 * disagreeing with the engine that produced the advice.
 *
 * ## Copy rules, and they matter more than the layout
 *
 * - **The act leads, the pace follows.** "You need 2.1 a day" printed every
 *   morning against a rate of 0.4 is an accusation repeated daily, and the
 *   streak discussion already covers why that backfires. The same fact stated
 *   as an achievable date — "at your rate the first pass lands in August" — is
 *   information rather than a verdict.
 * - **`actualPerDay === null` is "no rate yet", never "0.0/day".** No history is
 *   not a rate of zero, and rendering it as one tells a first-time user she is
 *   failing at something she has not started.
 * - **Never render a figure the engine returned as null.** Leave the line out.
 * - The restraint line, when present, sits with the act. The decision has
 *   already deferred to it; the copy must not argue with it.
 */

import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { Card } from '@/components/controls';
import { useTheme } from '@/components/form';
import { achievableDate, type DecisionAct, type Pace, type TodayDecision } from '@/lib/today-decision';

/** "2.1 a day" — one decimal, because two implies a precision nothing supports. */
function rate(value: number): string {
  return `${value.toFixed(1)} a day`;
}

/** "2.4 hours each", or null when the engine could not compute it. */
function hoursEach(pace: Pace): string | null {
  if (pace.hoursPerTopic === null) return null;
  const value = pace.hoursPerTopic;
  return value >= 10 ? `about ${Math.round(value)} hours each` : `about ${value.toFixed(1)} hours each`;
}

/**
 * The pace line.
 *
 * Reads as a budget on a fresh install and as a position once there is history.
 * Both are true statements about the same numbers; only one of them is useful
 * before anything has been marked.
 */
function paceLine(pace: Pace, today: string): string {
  const horizon = pace.against === 'prelims' ? 'Prelims' : 'the first pass';
  const remaining = `${pace.remainingTopics} topics · ${pace.daysToTarget} days to ${horizon}`;

  if (pace.requiredPerDay === null) return remaining;

  const needed = `${rate(pace.requiredPerDay)}`;
  const each = hoursEach(pace);

  if (pace.actualPerDay === null) {
    // Fresh. Both figures are computable on day one and are the two most
    // motivating true facts available — but nothing here claims a rate.
    return each === null
      ? `${remaining} · ${needed}`
      : `${remaining} · ${needed}, ${each}`;
  }

  const lands = achievableDate(pace, today);
  if (lands === null) return `${remaining} · ${needed}`;
  return `${remaining} · at ${rate(pace.actualPerDay)} this lands ${lands}`;
}

function ActRow({ act, onOpen }: { act: DecisionAct; onOpen: (route: string) => void }) {
  const theme = useTheme();
  const body = (
    <View style={styles.act}>
      <Text style={[styles.actTitle, { color: theme.text }]}>{act.title}</Text>
      <Text style={[styles.because, { color: theme.textSecondary }]}>{act.because}</Text>
      {act.leaves.length > 0 ? (
        <View style={styles.leaves}>
          {act.leaves.map((leaf) => (
            <Text key={leaf.topicId} style={[styles.leaf, { color: theme.text }]}>
              · {leaf.label}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );

  if (act.route === null) return body;
  return (
    <TouchableOpacity accessibilityRole="button" onPress={() => onOpen(act.route as string)}>
      {body}
    </TouchableOpacity>
  );
}

export function DecisionCard({
  decision,
  today,
  onOpen,
}: {
  decision: TodayDecision | null;
  today: string;
  onOpen: (route: string) => void;
}) {
  const theme = useTheme();

  // Not yet loaded. Renders nothing rather than a placeholder that could be
  // mistaken for an answer.
  if (decision === null) return null;

  if (decision.state === 'no_syllabus') {
    return (
      <Card title="Today">
        <Text style={[styles.because, { color: theme.textSecondary }]}>
          Setting up your syllabus. This card will tell you what to work on next.
        </Text>
      </Card>
    );
  }

  if (decision.state === 'complete') {
    return (
      <Card title="Today">
        <Text style={[styles.actTitle, { color: theme.text }]}>First pass complete.</Text>
        <Text style={[styles.because, { color: theme.textSecondary }]}>
          Every live topic has been through once. From here the work is revision and volume.
        </Text>
      </Card>
    );
  }

  return (
    <Card title="Today">
      {decision.headline !== null ? (
        <ActRow act={decision.headline} onOpen={onOpen} />
      ) : null}

      {decision.restraint !== null ? (
        <Text style={[styles.restraint, { color: theme.textSecondary }]}>
          {decision.restraint}
        </Text>
      ) : null}

      {decision.pace !== null ? (
        <Text style={[styles.pace, { color: theme.textSecondary }]}>
          {paceLine(decision.pace, today)}
        </Text>
      ) : null}

      {decision.then.map((act) => (
        <View key={act.kind} style={styles.then}>
          <ActRow act={act} onOpen={onOpen} />
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  act: { gap: 4 },
  actTitle: { fontSize: 17, fontWeight: '600' },
  // `flex: 1` rather than `flexShrink` throughout: shrinking a Text clips it
  // with no ellipsis, where taking the remaining space lets it wrap.
  because: { fontSize: 14, lineHeight: 20, flex: 1 },
  leaves: { marginTop: 6, gap: 2 },
  leaf: { fontSize: 15, lineHeight: 21, flex: 1 },
  restraint: { fontSize: 14, lineHeight: 20, marginTop: 10, fontStyle: 'italic', flex: 1 },
  pace: { fontSize: 13, lineHeight: 18, marginTop: 12, flex: 1 },
  then: { marginTop: 16 },
});
