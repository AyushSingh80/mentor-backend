/** Small form primitives. Kept minimal — Phase 0 needs clarity, not a design system. */

import { StyleSheet, Text, TextInput, TouchableOpacity, useColorScheme, View } from 'react-native';
import { Colors } from '@/constants/theme';

export function useTheme() {
  // Ternary rather than indexing: ColorSchemeName includes 'unspecified',
  // which is not a key of Colors.
  return useColorScheme() === 'dark' ? Colors.dark : Colors.light;
}

export function Field({
  label,
  hint,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
}: {
  label: string;
  hint?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'url';
}) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      {hint ? <Text style={[styles.hint, { color: theme.textSecondary }]}>{hint}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.textSecondary}
        keyboardType={keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        // Several fields have no placeholder, so without these a screen reader
        // announces only "text field, blank".
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={[
          styles.input,
          { backgroundColor: theme.backgroundElement, color: theme.text },
        ]}
      />
    </View>
  );
}

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function DayPicker({
  label,
  hint,
  selected,
  onToggle,
}: {
  label: string;
  hint?: string;
  selected: number[];
  onToggle: (day: number) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      {hint ? <Text style={[styles.hint, { color: theme.textSecondary }]}>{hint}</Text> : null}
      <View style={styles.dayRow}>
        {DAY_LABELS.map((d, i) => {
          const active = selected.includes(i);
          return (
            <TouchableOpacity
              key={`${d}-${i}`}
              onPress={() => onToggle(i)}
              // Tapped one-handed on a moving train at 7:45am; 44pt is the
              // iOS HIG floor and 48dp the Material one.
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: active }}
              accessibilityLabel={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]}
              style={[
                styles.day,
                {
                  backgroundColor: active ? theme.backgroundSelected : theme.backgroundElement,
                  borderColor: active ? theme.text : 'transparent',
                },
              ]}
            >
              <Text style={{ color: theme.text, fontWeight: active ? '700' : '400' }}>{d}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export function Button({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={[
        styles.button,
        { backgroundColor: theme.text, opacity: disabled ? 0.4 : 1 },
      ]}
    >
      <Text style={[styles.buttonText, { color: theme.background }]}>{title}</Text>
    </TouchableOpacity>
  );
}

export const styles = StyleSheet.create({
  field: { gap: 6, marginBottom: 18 },
  label: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 17 },
  input: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  dayRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  day: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: { borderRadius: 12, paddingVertical: 15, alignItems: 'center', marginTop: 8 },
  buttonText: { fontSize: 16, fontWeight: '700' },
});
