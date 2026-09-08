/**
 * The monthly compilation.
 *
 * Pick a month, read it, write it to a file, share it. The build itself is
 * `lib/ca-compile.ts` — pure, on-device, and never a server call: the data is
 * already local, and the one artefact she needs the week before an exam must
 * not depend on connectivity or a spend cap.
 *
 * ## The file is written unconditionally
 *
 * Writing and sharing are two steps, in that order, and the first does not
 * depend on the second. Sharing is the part that can fail for reasons that have
 * nothing to do with this app — no share sheet on web, no target application, a
 * cancelled sheet, an OS that reports `isAvailableAsync() === false`. If the
 * write were contingent on the share, every one of those would silently lose
 * the document. So the file lands on disk first, its path is shown whatever
 * happens next, and sharing is offered as a convenience on top of it.
 *
 * `Paths.document`, not `Paths.cache`: the cache directory is documented as
 * "files that can be deleted by the system when the device runs low on
 * storage", and a compilation that evaporates the week before the exam is the
 * exact failure this screen exists to prevent.
 *
 * ## Verified against the SDK 57 APIs
 *
 * `expo-file-system` is the SDK 54+ class API — `new File(...)`, `file.write()`
 * (synchronous, returns void), `file.uri`, `file.create({ intermediates })`.
 * The legacy `writeAsStringAsync` now lives behind `expo-file-system/legacy`
 * and the deprecated methods on the main export throw at runtime, so calling
 * the old shape here would fail on device rather than at build time.
 *
 * ## Where the items come from
 *
 * `readDigestDay` per day, with ONE shared `TagIndex` threaded through all of
 * them. Reusing the repository rather than writing a month-wide query keeps the
 * compilation showing exactly what she saw on the day — including unknown tags
 * re-resolved after a syllabus re-seed — and the shared index is what stops
 * twenty-two days costing twenty-two reads of the syllabus table.
 */

import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { asc } from 'drizzle-orm';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useTheme } from '@/components/form';
import { Markdown } from '@/components/markdown';
import { db } from '@/db';
import { readDigestDay, readTagFacts } from '@/db/ca';
import { caItems } from '@/db/schema';
import { useIsMounted } from '@/hooks/use-is-mounted';
import {
  buildMonthlyCompilation,
  monthLabel,
  type Compilation,
  type CompilationSection,
} from '@/lib/ca-compile';
import { buildTagIndex, sectionKeyOf, type TagIndex } from '@/lib/ca-tags';
import type { CaItemFacts } from '@/lib/ca-types';
import { localDate } from '@/lib/time';

interface ArchiveIndex {
  /** Every digest day that produced an item, newest first. */
  days: string[];
  sections: CompilationSection[];
  tagIndex: TagIndex;
}

/**
 * The month picker's options and the section list, in two cheap reads.
 *
 * Retired topics are excluded from the sections, for the reason coverage
 * excludes them: a tombstone reported as "a section with no material" is noise
 * in a list whose whole value is that every line in it is actionable.
 */
async function loadIndex(): Promise<ArchiveIndex> {
  const [dayRows, facts] = await Promise.all([
    db.selectDistinct({ date: caItems.date }).from(caItems).orderBy(asc(caItems.date)),
    readTagFacts(),
  ]);

  const sections: CompilationSection[] = [];
  const positionOf = new Map<string, number>();
  for (const fact of facts) {
    if (fact.retiredAt !== null) continue;
    const key = sectionKeyOf(fact.paper, fact.topic);
    const existing = positionOf.get(key);
    if (existing === undefined) {
      positionOf.set(key, sections.length);
      sections.push({ paper: fact.paper, topic: fact.topic, topicIds: [fact.id] });
    } else {
      (sections[existing]!.topicIds as number[]).push(fact.id);
    }
  }

  return {
    days: dayRows.map((row) => row.date).reverse(),
    sections,
    tagIndex: buildTagIndex(facts),
  };
}

/** Every item delivered on the days of one month. */
async function loadMonthItems(
  days: readonly string[],
  month: string,
  tagIndex: TagIndex,
): Promise<CaItemFacts[]> {
  const inMonth = days.filter((day) => day.slice(0, 7) === month).sort();
  const items: CaItemFacts[] = [];
  for (const day of inMonth) {
    const digest = await readDigestDay(day, tagIndex);
    items.push(...digest.items);
  }
  return items;
}

/** Where the write ended up, and what happened to the share afterwards. */
interface ExportResult {
  uri: string;
  fileName: string;
  shared: 'shared' | 'unavailable' | 'failed' | 'pending';
  shareError: string | null;
}

export default function CurrentArchive() {
  const theme = useTheme();
  const router = useRouter();
  const isMounted = useIsMounted();

  const today = localDate('Asia/Kolkata');
  const thisMonth = today.slice(0, 7);

  const [index, setIndex] = useState<ArchiveIndex | null>(null);
  const [items, setItems] = useState<CaItemFacts[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(thisMonth);
  const [exported, setExported] = useState<ExportResult | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Promise chains plus a `cancelled` flag throughout:
  // `react-hooks/set-state-in-effect` is an error in this repo.
  useEffect(() => {
    let cancelled = false;
    loadIndex()
      .then((next) => {
        if (cancelled) return;
        setIndex(next);
        setLoadError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (index === null) return;
    let cancelled = false;
    loadMonthItems(index.days, selected, index.tagIndex)
      .then((next) => {
        if (!cancelled) setItems(next);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [index, selected]);

  const months = useMemo(() => {
    const known = [...new Set((index?.days ?? []).map((day) => day.slice(0, 7)))];
    return known.includes(thisMonth) ? known : [thisMonth, ...known];
  }, [index, thisMonth]);

  const compilation: Compilation | null = useMemo(() => {
    if (index === null || items === null) return null;
    return buildMonthlyCompilation(items, index.sections, {
      month: selected,
      // Injected, never read from the clock inside the builder — that is what
      // makes the output reproducible and the unit tests possible.
      generatedOn: today,
    });
  }, [index, items, selected, today]);

  /**
   * Write, then try to share. Never the other way round.
   *
   * Both file-system calls are synchronous in the SDK 54+ API, so the write has
   * either happened or thrown by the time the share is attempted — there is no
   * window in which a share failure can leave the file unwritten.
   */
  const exportMonth = useCallback(
    (target: Compilation) => {
      setBusy(true);
      setWriteError(null);

      let uri: string;
      try {
        const directory = new Directory(Paths.document, 'compilations');
        if (!directory.exists) directory.create({ intermediates: true });

        const file = new File(directory, target.fileName);
        // `overwrite` so re-exporting a month replaces it rather than throwing.
        file.create({ intermediates: true, overwrite: true });
        file.write(target.markdown);
        uri = file.uri;
      } catch (err) {
        if (isMounted()) {
          setWriteError((err as Error).message);
          setBusy(false);
        }
        return;
      }

      // The file exists from here on. Nothing below can lose it.
      const written: ExportResult = {
        uri,
        fileName: target.fileName,
        shared: 'pending',
        shareError: null,
      };
      setExported(written);

      Sharing.isAvailableAsync()
        .then((available) => {
          if (!available) {
            // Web above all: the Web Share API cannot share a local file by
            // URI. The path is still shown, which is the whole point.
            if (isMounted()) setExported({ ...written, shared: 'unavailable' });
            return;
          }
          return Sharing.shareAsync(uri, {
            mimeType: 'text/markdown',
            dialogTitle: `Current affairs, ${target.monthLabel}`,
            UTI: 'net.daringfireball.markdown',
          }).then(() => {
            if (isMounted()) setExported({ ...written, shared: 'shared' });
          });
        })
        .catch((err: Error) => {
          if (isMounted()) {
            setExported({ ...written, shared: 'failed', shareError: err.message });
          }
        })
        .finally(() => {
          if (isMounted()) setBusy(false);
        });
    },
    [isMounted],
  );

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.container}
    >
      <TouchableOpacity
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/current'))}
        accessibilityRole="button"
        accessibilityLabel="Back to today's digest"
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={styles.tap}
      >
        <Text style={[styles.back, { color: theme.textSecondary }]}>Back to digest</Text>
      </TouchableOpacity>

      <Text accessibilityRole="header" style={[styles.h1, { color: theme.text }]}>
        Monthly compilation
      </Text>
      <Text style={[styles.note, { color: theme.textSecondary }]}>
        Built on this device from notes already saved offline, so it works with no connection and
        costs nothing. Markdown rather than PDF: it opens anywhere, and a paragraph pastes straight
        into your own revision notes.
      </Text>

      {loadError !== null ? (
        <View
          style={[styles.card, { backgroundColor: theme.backgroundElement }]}
          accessible
          accessibilityLabel={`Could not read the archive. ${loadError}`}
        >
          <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
            Could not read the archive
          </Text>
          <Text style={[styles.note, { color: theme.textSecondary }]}>{loadError}</Text>
        </View>
      ) : null}

      <Text style={[styles.label, { color: theme.text }]}>Month</Text>
      <View style={styles.chipWrap}>
        {months.map((month) => {
          const active = month === selected;
          return (
            <TouchableOpacity
              key={month}
              onPress={() => {
                setSelected(month);
                setItems(null);
                setExported(null);
                setWriteError(null);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={monthLabel(month)}
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
                {monthLabel(month)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {compilation === null ? (
        <Text style={{ color: theme.textSecondary }}>Loading…</Text>
      ) : (
        <>
          {/* Counts and the caveat that qualifies them are one node — read as
              separate elements they are three numbers and an orphan sentence. */}
          <View
            accessible
            accessibilityLabel={`${monthLabel(selected)}: ${compilation.itemCount} ${
              compilation.itemCount === 1 ? 'item' : 'items'
            }, ${compilation.anthropologyPairs.length} complete Anthropology ${
              compilation.anthropologyPairs.length === 1 ? 'pair' : 'pairs'
            }, ${compilation.emptySections.length} syllabus ${
              compilation.emptySections.length === 1 ? 'section' : 'sections'
            } with no material. A section that stays empty may be a gap in the source list rather than a quiet month.`}
            style={[styles.card, { backgroundColor: theme.backgroundElement }]}
          >
            <Text style={[styles.figure, { color: theme.text }]}>
              {compilation.itemCount} {compilation.itemCount === 1 ? 'item' : 'items'}
            </Text>
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              {compilation.anthropologyPairs.length} complete Anthropology{' '}
              {compilation.anthropologyPairs.length === 1 ? 'pair' : 'pairs'} ·{' '}
              {compilation.emptySections.length}{' '}
              {compilation.emptySections.length === 1 ? 'section' : 'sections'} with no material
              {compilation.unfiled.length > 0 ? ` · ${compilation.unfiled.length} unfiled` : ''}
            </Text>
            <Text style={[styles.note, { color: theme.textSecondary }]}>
              Items are filed by the day the digest delivered them, not the day the source
              published — so a judgment reported on the 31st and delivered on the 1st is in the
              later month, which is where you read it.
            </Text>
          </View>

          <TouchableOpacity
            onPress={() => exportMonth(compilation)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            accessibilityLabel={`Write ${compilation.fileName} to this device and share it`}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={[styles.primary, { backgroundColor: theme.text, opacity: busy ? 0.4 : 1 }]}
          >
            <Text style={[styles.primaryText, { color: theme.background }]}>
              {busy ? 'Writing…' : 'Save and share'}
            </Text>
          </TouchableOpacity>

          {writeError !== null ? (
            <View
              style={[styles.card, { backgroundColor: theme.backgroundElement }]}
              accessible
              accessibilityLabel={`The file could not be written. ${writeError}`}
            >
              <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
                The file could not be written
              </Text>
              <Text style={[styles.note, { color: theme.textSecondary }]}>{writeError}</Text>
              <Text style={[styles.note, { color: theme.textSecondary }]}>
                Nothing was lost. The compilation is rebuilt from your local notes every time this
                screen opens, so you can try again.
              </Text>
            </View>
          ) : null}

          {exported !== null ? <ExportReport result={exported} /> : null}

          <TouchableOpacity
            onPress={() => setPreviewOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityState={{ expanded: previewOpen }}
            accessibilityLabel={`${previewOpen ? 'Hide' : 'Show'} the compilation preview`}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.tap}
          >
            <Text style={[styles.link, { color: theme.text }]}>
              {previewOpen ? 'Hide preview' : 'Show preview'}
            </Text>
          </TouchableOpacity>

          {previewOpen ? (
            <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
              <Markdown source={compilation.markdown} theme={theme} />
            </View>
          ) : null}
        </>
      )}

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

/**
 * What happened, in two separate statements: where the file is, and what the
 * share sheet did. The first is never contingent on the second.
 */
function ExportReport({ result }: { result: ExportResult }) {
  const theme = useTheme();

  const shareLine =
    result.shared === 'shared'
      ? 'Shared.'
      : result.shared === 'pending'
        ? 'Opening the share sheet…'
        : result.shared === 'unavailable'
          ? 'Sharing is not available on this device, so the file was only saved. That is the whole of the failure — the document is on disk at the path above.'
          : `The share sheet failed${
              result.shareError ? `: ${result.shareError}` : ''
            }. The file is still saved at the path above; nothing was lost.`;

  return (
    <View
      style={[styles.card, { backgroundColor: theme.backgroundElement }]}
      accessible
      accessibilityLabel={`Saved as ${result.fileName} at ${result.uri}. ${shareLine}`}
    >
      <Text accessibilityRole="header" style={[styles.cardTitle, { color: theme.text }]}>
        Saved
      </Text>
      <Text style={[styles.body, { color: theme.text }]}>{result.fileName}</Text>
      <Text style={[styles.path, { color: theme.textSecondary }]} selectable>
        {result.uri}
      </Text>
      <Text style={[styles.note, { color: theme.textSecondary }]}>{shareLine}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingTop: 64 },
  tap: { minHeight: 44, justifyContent: 'center' },
  back: { fontSize: 15 },
  h1: { fontSize: 30, fontWeight: '700', marginTop: 4 },
  label: { fontSize: 15, fontWeight: '600', marginTop: 20, marginBottom: 8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  chip: {
    borderRadius: 22,
    borderWidth: 1.5,
    paddingHorizontal: 14,
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: { borderRadius: 14, padding: 18, marginBottom: 16, gap: 6 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  figure: { fontSize: 24, fontWeight: '700', fontVariant: ['tabular-nums'] },
  body: { fontSize: 15, fontWeight: '600' },
  path: { fontSize: 11, lineHeight: 16 },
  note: { fontSize: 12, lineHeight: 18, marginTop: 4 },
  primary: {
    borderRadius: 12,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  primaryText: { fontSize: 16, fontWeight: '700' },
  link: { fontSize: 15, fontWeight: '600' },
});
