/**
 * The material bank.
 *
 * Quotes, examples, thinkers and figures, filed by theme. The essay rubric gives
 * them 10%, which understates them: their ABSENCE is what makes an essay read as
 * a competent GS answer with a longer introduction, and that is the diagnosis
 * the rubric asks the evaluator to give most often.
 *
 * ## Sorted by what she has forgotten
 *
 * The list is ordered the way `suggestMaterial` orders it — least-used first —
 * rather than newest first. A quote used in four essays is one she reaches for
 * automatically; the bank exists to surface the one she has not.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { Card, ChipPicker, MultilineField, Pill } from '@/components/controls';
import { Field, useTheme } from '@/components/form';
import { useIsMounted } from '@/hooks/use-is-mounted';
import { addMaterial, readMaterial, retireMaterial } from '@/db/material';
import { MATERIAL_KINDS, type MaterialFacts, type MaterialKind } from '@/lib/drill-types';
import { bankDiagnosis, suggestMaterial, tallyByKind } from '@/lib/material';

const KIND_OPTIONS = MATERIAL_KINDS.map((kind) => ({
  value: kind,
  label: kind[0]!.toUpperCase() + kind.slice(1),
}));

export default function MaterialBank() {
  const theme = useTheme();
  const isMounted = useIsMounted();

  const [bank, setBank] = useState<MaterialFacts[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const [kind, setKind] = useState<MaterialKind>('example');
  const [content, setContent] = useState('');
  const [attribution, setAttribution] = useState('');
  const [sourceNote, setSourceNote] = useState('');

  const load = useCallback(
    (isActive: () => boolean) =>
      readMaterial()
        .then((rows) => {
          if (isActive()) {
            setBank(rows);
            setLoadError(null);
          }
        })
        .catch((err: Error) => {
          if (isActive()) setLoadError(err.message);
        }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const add = useCallback(() => {
    if (content.trim() === '') return;
    setNote(null);
    addMaterial({
      kind,
      content,
      attribution: attribution.trim() || null,
      sourceNote: sourceNote.trim() || null,
    })
      .then((id) => {
        if (!isMounted()) return;
        if (id === null) {
          setNote('You already have that one.');
          return;
        }
        setContent('');
        setAttribution('');
        setSourceNote('');
        return load(isMounted);
      })
      .catch((err: Error) => {
        if (isMounted()) setNote(err.message);
      });
  }, [attribution, content, isMounted, kind, load, sourceNote]);

  const retire = useCallback(
    (id: number) => {
      retireMaterial(id)
        .then(() => load(isMounted))
        .catch((err: Error) => {
          if (isMounted()) setNote(err.message);
        });
    },
    [isMounted, load],
  );

  const tally = tallyByKind(bank);
  const diagnosis = bankDiagnosis(tally);
  // Ordered the way a drill would surface them: least-used first.
  const ordered = suggestMaterial(bank, {
    syllabusTopicId: null,
    siblingTopicIds: [],
    limit: bank.length,
  });

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.background }}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load(isMounted).finally(() => {
                if (isMounted()) setRefreshing(false);
              });
            }}
          />
        }
      >
        <Text style={[styles.eyebrow, { color: theme.textSecondary }]}>Essay & Ethics</Text>
        <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
          Material bank
        </Text>

        <View style={styles.tallyRow}>
          {MATERIAL_KINDS.map((each) => (
            <Pill key={each} text={`${each} ${tally[each]}`} tone="neutral" />
          ))}
        </View>

        {diagnosis !== null && (
          <Card>
            <Text style={[styles.body, { color: theme.textSecondary }]}>{diagnosis}</Text>
          </Card>
        )}

        <Card>
          <Text style={[styles.cardTitle, { color: theme.text }]}>Add something</Text>
          <ChipPicker
            label="Kind"
            options={KIND_OPTIONS}
            selected={kind}
            onSelect={(value) => setKind(value as MaterialKind)}
          />
          <MultilineField
            label="Content"
            hint="The quote, the example, the thinker's position — what actually gets used."
            value={content}
            onChangeText={setContent}
            minHeight={90}
          />
          <Field
            label="Attribution"
            hint="Who said or did it. Leave blank rather than guessing — a misattributed quote costs more than it gains."
            value={attribution}
            onChangeText={setAttribution}
          />
          <Field
            label="Where you found it"
            hint="So a doubtful one can be checked rather than dropped."
            value={sourceNote}
            onChangeText={setSourceNote}
          />
          <TouchableOpacity
            onPress={add}
            disabled={content.trim() === ''}
            accessibilityRole="button"
            accessibilityState={{ disabled: content.trim() === '' }}
            accessibilityLabel="Add to the material bank"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.tap}
          >
            <Text
              style={[
                styles.link,
                { color: content.trim() === '' ? theme.textSecondary : theme.text },
              ]}
            >
              Add to bank
            </Text>
          </TouchableOpacity>
          {note !== null && (
            <Text style={[styles.hint, { color: theme.textSecondary }]}>{note}</Text>
          )}
        </Card>

        {loadError !== null && (
          <Card>
            <Text style={[styles.body, { color: theme.textSecondary }]}>{loadError}</Text>
          </Card>
        )}

        {bank.length === 0 && loadError === null ? (
          <Card>
            <Text style={[styles.body, { color: theme.textSecondary }]}>
              Nothing yet. Anything specific you would want to reach for in an essay eight months
              from now belongs here — a figure, a case, a line worth quoting exactly.
            </Text>
          </Card>
        ) : (
          ordered.map(({ material, reason }) => (
            <Card key={material.id}>
              <View style={styles.headRow}>
                <Pill text={material.kind} tone="neutral" />
                <Text style={[styles.hint, { color: theme.textSecondary }]}>{reason}</Text>
              </View>
              <Text style={[styles.content, { color: theme.text }]}>{material.content}</Text>
              <Text style={[styles.hint, { color: theme.textSecondary }]}>
                {material.attribution ?? 'unattributed'}
                {material.sourceNote !== null ? ` · ${material.sourceNote}` : ''}
              </Text>
              <TouchableOpacity
                onPress={() => retire(material.id)}
                accessibilityRole="button"
                accessibilityLabel={`Retire: ${material.content.slice(0, 60)}`}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={styles.tap}
              >
                <Text style={[styles.hint, { color: theme.textSecondary }]}>Retire</Text>
              </TouchableOpacity>
            </Card>
          ))
        )}

        <View style={{ height: 64 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 72 },
  eyebrow: { fontSize: 13, marginBottom: 2 },
  h1: { fontSize: 30, fontWeight: '700', marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 13, lineHeight: 19 },
  hint: { fontSize: 12, lineHeight: 17 },
  content: { fontSize: 14, lineHeight: 21, marginTop: 6 },
  tallyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 16 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  tap: { minHeight: 44, justifyContent: 'center' },
  link: { fontSize: 15, fontWeight: '600' },
});
