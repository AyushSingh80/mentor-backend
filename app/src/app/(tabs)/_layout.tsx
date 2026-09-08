/**
 * Tab navigator, ordered by her actual day: check in → revise what is due →
 * write an answer → review progress.
 *
 * Four tabs, not five. Five is roughly the Material legibility floor and
 * "Progress" already needs a two-syllable label; a sixth degrades all of them.
 * History is a weekly-review surface answering the same question Progress does,
 * so it comes off the bar with `href: null` — the file is untouched and it is
 * still reachable by a link from Progress.
 *
 * Icons are drawn with plain Views. `@expo/vector-icons` is not installed and
 * the template's `expo-symbols` is SF Symbols, which is iOS-only.
 */

import { Tabs } from 'expo-router';
import { StyleSheet, View, useColorScheme, type ColorValue } from 'react-native';
import { Colors } from '@/constants/theme';

export default function TabsLayout() {
  const theme = useColorScheme() === 'dark' ? Colors.dark : Colors.light;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.text,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: {
          backgroundColor: theme.background,
          borderTopColor: theme.backgroundElement,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Today', tabBarIcon: ({ color }) => <TodayIcon color={color} /> }}
      />
      <Tabs.Screen
        name="revise"
        options={{ title: 'Revise', tabBarIcon: ({ color }) => <ReviseIcon color={color} /> }}
      />
      <Tabs.Screen
        name="new"
        options={{ title: 'Write', tabBarIcon: ({ color }) => <PlusIcon color={color} /> }}
      />
      <Tabs.Screen
        name="progress"
        options={{ title: 'Progress', tabBarIcon: ({ color }) => <TrendIcon color={color} /> }}
      />
      {/* Reachable from Progress, not from the bar. `href: null` keeps the
          route registered while hiding its tab. */}
      <Tabs.Screen name="history" options={{ href: null, title: 'Score history' }} />
    </Tabs>
  );
}

function TodayIcon({ color }: { color: ColorValue }) {
  return (
    <View style={[styles.box, { borderColor: color }]}>
      <View style={[styles.boxBar, { backgroundColor: color }]} />
    </View>
  );
}

/** Two offset cards — a review stack. */
function ReviseIcon({ color }: { color: ColorValue }) {
  return (
    <View style={styles.icon}>
      <View style={[styles.cardBack, { borderColor: color }]} />
      <View style={[styles.cardFront, { borderColor: color }]} />
    </View>
  );
}

function PlusIcon({ color }: { color: ColorValue }) {
  return (
    <View style={styles.icon}>
      <View style={[styles.plusH, { backgroundColor: color }]} />
      <View style={[styles.plusV, { backgroundColor: color }]} />
    </View>
  );
}

/** Three ascending bars. */
function TrendIcon({ color }: { color: ColorValue }) {
  return (
    <View style={styles.bars}>
      {[7, 12, 18].map((h) => (
        <View key={h} style={[styles.bar, { height: h, backgroundColor: color }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  box: { width: 20, height: 20, borderWidth: 1.8, borderRadius: 4, justifyContent: 'flex-start' },
  boxBar: { height: 3, marginTop: 2, marginHorizontal: 2, borderRadius: 1 },
  cardBack: {
    position: 'absolute',
    width: 14,
    height: 17,
    borderWidth: 1.6,
    borderRadius: 3,
    left: 1,
    top: 1,
    opacity: 0.55,
  },
  cardFront: {
    position: 'absolute',
    width: 14,
    height: 17,
    borderWidth: 1.8,
    borderRadius: 3,
    left: 6,
    top: 4,
  },
  plusH: { position: 'absolute', width: 18, height: 2.2, borderRadius: 1 },
  plusV: { position: 'absolute', width: 2.2, height: 18, borderRadius: 1 },
  bars: { width: 22, height: 22, flexDirection: 'row', alignItems: 'flex-end', gap: 2.5 },
  bar: { width: 4, borderRadius: 1 },
});
