/**
 * Shared UI primitives.
 *
 * Created up front because the capture screen and the history screen both need
 * cards, rows and chip pickers — without a single owner they would each grow
 * their own near-duplicate. `form.tsx` is frozen; new shared controls go here.
 */

import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '@/components/form';

export function Card({
  title,
  children,
  style,
}: {
  title?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }, style]}>
      {title ? (
        <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/**
 * A label/value row.
 *
 * The flex rules are load-bearing. Two `Text` children in a `space-between` row
 * with no constraints BOTH shrink when the combined width overflows, and a
 * shrunk `Text` is clipped with no ellipsis — so a long value silently eats its
 * own label. Found on a device, where "Status" rendered as "Statu".
 *
 * The value never shrinks: it is the number she came to read. The label wraps
 * instead, because a wrapped label is legible and a truncated one is not.
 */
export function Row({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.rowKey, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

export type PillTone = 'neutral' | 'good' | 'warn' | 'bad';

const TONE_BG: Record<PillTone, string> = {
  neutral: 'rgba(128,128,128,0.18)',
  good: 'rgba(52,199,89,0.20)',
  warn: 'rgba(255,169,64,0.22)',
  bad: 'rgba(255,69,58,0.20)',
};

export function Pill({ text, tone = 'neutral' }: { text: string; tone?: PillTone }) {
  const theme = useTheme();
  return (
    <View style={[styles.pill, { backgroundColor: TONE_BG[tone] }]}>
      <Text style={[styles.pillText, { color: theme.text }]}>{text}</Text>
    </View>
  );
}

export interface ChipOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Single-select chips. Used for paper and directive word — both are short,
 * closed sets where a picker modal would cost a tap for no benefit.
 */
export function ChipPicker<T extends string>({
  label,
  hint,
  options,
  selected,
  onSelect,
}: {
  label: string;
  hint?: string;
  options: readonly ChipOption<T>[];
  selected: T | null;
  onSelect: (value: T) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      {hint ? <Text style={[styles.hint, { color: theme.textSecondary }]}>{hint}</Text> : null}
      <View style={styles.chipWrap}>
        {options.map((option) => {
          const active = option.value === selected;
          return (
            <TouchableOpacity
              key={option.value}
              onPress={() => onSelect(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={option.label}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
              style={[
                styles.chip,
                {
                  backgroundColor: active ? theme.backgroundSelected : theme.backgroundElement,
                  borderColor: active ? theme.text : 'transparent',
                },
              ]}
            >
              <Text style={{ color: theme.text, fontWeight: active ? '700' : '400' }}>
                {option.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export function MultilineField({
  label,
  hint,
  value,
  onChangeText,
  placeholder,
  minHeight = 96,
  maxLength,
}: {
  label: string;
  hint?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  minHeight?: number;
  maxLength?: number;
}) {
  const theme = useTheme();
  const overBudget = maxLength !== undefined && value.length > maxLength * 0.9;

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      {hint ? <Text style={[styles.hint, { color: theme.textSecondary }]}>{hint}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textSecondary}
        multiline
        textAlignVertical="top"
        maxLength={maxLength}
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={[
          styles.input,
          { backgroundColor: theme.backgroundElement, color: theme.text, minHeight },
        ]}
      />
      {maxLength !== undefined && overBudget ? (
        <Text style={[styles.hint, { color: theme.textSecondary, textAlign: 'right' }]}>
          {value.length} / {maxLength}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 18, marginBottom: 16, gap: 4 },
  cardTitle: { fontSize: 16, fontWeight: '700', marginBottom: 10 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 4,
  },
  // `flex: 1`, not `flexShrink: 1`. Shrinking a `Text` clips it — the label
  // loses characters with no ellipsis — where taking the remaining space lets
  // it WRAP. "Spend this month" rendered as "Spend this" until this changed.
  rowKey: { flex: 1 },
  rowValue: { fontWeight: '600', flexShrink: 0, textAlign: 'right' },
  field: { gap: 6, marginBottom: 18 },
  label: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 17 },
  input: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  chip: {
    borderRadius: 22,
    borderWidth: 1.5,
    paddingHorizontal: 14,
    paddingVertical: 9,
    // Explicit rather than relying on padding plus font metrics. A single
    // character confidence chip ("1".."5") lands around 40px on padding alone,
    // and these are tapped one-handed on a moving train. 44 is the iOS HIG
    // floor; `DayPicker` in form.tsx sizes the same way.
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: { borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '600' },
});
