/**
 * One current-affairs item, as it appears in the daily digest.
 *
 * Ordered by what she does with it rather than by what is easiest to render:
 * what changed (the note), then where it hooks onto the syllabus, then the
 * Anthropology link, then the proof, then the one action worth taking.
 *
 * ## Provenance is always on screen
 *
 * The source name and kind sit in the header of every card, unconditionally,
 * and the verbatim quote is one tap away. This is the difference between a
 * revision note and a rumour: when she doubts a claim at 7:45am on a train with
 * no signal, the quote it was drawn from is already on the device, and the URL
 * behind it opens in one tap the moment she has a connection. A summary with no
 * retrievable origin is worse than no summary — she would carry it into an
 * answer booklet with the same confidence as a verified one.
 *
 * ## Why the Anthropology pair is named rather than described
 *
 * The optional's rubric credits a Paper 1 concept carried onto a Paper 2 Indian
 * instance. Printing the two slugs either side of an arrow makes the SHAPE of
 * that move the thing she reads — twenty of them in a month and the move
 * becomes reflex, which is the actual skill. A prose sentence alone reads as a
 * fact about one news story and generalises to nothing.
 */

import { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';

import { Pill, type PillTone } from '@/components/controls';
import { useTheme } from '@/components/form';
import { Markdown } from '@/components/markdown';
import { daysBetween } from '@/lib/days';
import type { CaItemFacts, ItemKind } from '@/lib/ca-types';

type Theme = ReturnType<typeof useTheme>;

/**
 * Kind drives the selection rule, so it is the first thing on the card.
 *
 * A cabinet decision is `structural` and earns a slot; a bilateral visit is an
 * `event` and mostly does not. Showing the classification teaches the same test
 * she should be applying to the newspaper herself.
 */
const KIND_TONE: Record<ItemKind, PillTone> = {
  structural: 'good',
  judgment: 'good',
  scheme: 'good',
  report: 'neutral',
  data: 'neutral',
  event: 'warn',
};

const KIND_LABEL: Record<ItemKind, string> = {
  structural: 'structural',
  judgment: 'judgment',
  scheme: 'scheme',
  report: 'report',
  data: 'data',
  event: 'event',
};

/**
 * `anthro-p1-kinship-and-descent` -> `kinship and descent`.
 *
 * Read, not debugged: the paper prefix is already stated by the arrow's label,
 * so repeating it in both halves is noise. An unrecognised shape falls through
 * unchanged rather than being mangled.
 */
export function slugLabel(slug: string): string {
  const trimmed = slug.trim();
  if (trimmed === '') return trimmed;
  return trimmed
    .replace(/^(anthro[-_])?p[12][-_]/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

function hostOf(url: string): string {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url);
  return match?.[1]?.replace(/^www\./i, '') ?? url;
}

/**
 * When the SOURCE published it, and how long ago that was.
 *
 * The card used to print `item.date`, which is the day the digest DELIVERED it
 * — a different fact, and one the schema comment on `ca_items` explicitly warns
 * must not be conflated with publication. The two agree most days and diverge
 * exactly when it matters: the sweep looks back a week, so a Tuesday editorial
 * can first surface in Monday's digest, and printing the digest day beside the
 * publisher's name reads as "The Hindu published this today". Reported by the
 * user against a 2 September editorial shown as 8 September.
 *
 * Falls back to the digest day, LABELLED as delivery, when a feed shipped no
 * date. Several do. An unlabelled fallback would be the same lie with a
 * different cause.
 */
function published(item: { publishedAt: string | null; date: string }): string {
  if (item.publishedAt === null || item.publishedAt === '') return `delivered ${item.date}`;
  const day = item.publishedAt.slice(0, 10);
  // Measured against the DIGEST day, not against now. The item belongs to that
  // digest, and re-reading Monday's digest on Friday should still say the piece
  // was two days old when it arrived — the age is a property of the delivery,
  // not of when she happens to open the app.
  const age = daysBetween(day, item.date);
  if (age <= 0) return day;
  if (age === 1) return `${day} · yesterday`;
  return `${day} · ${age} days ago`;
}

export function CaItemCard({
  item,
  kept = false,
  keepDisabledReason = null,
  onKeep,
  onPress,
}: {
  item: CaItemFacts;
  /** Already kept as a flashcard. */
  kept?: boolean;
  /**
   * Why Keep is unavailable, in words, or `null` when it is available.
   *
   * A reason rather than a boolean: a disabled control with no explanation
   * reads as a broken app. `CA_RULES.maxKeepsPerDay` is a deliberate limit and
   * saying so is the whole point of having one.
   */
  keepDisabledReason?: string | null;
  onKeep?: (item: CaItemFacts) => void;
  onPress?: (item: CaItemFacts) => void;
}) {
  const theme = useTheme();
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const source = item.sourceName ?? (item.sourceUrl ? hostOf(item.sourceUrl) : null);
  const hasPair = Boolean(item.anthroP1Slug && item.anthroP2Slug);

  // One announcement for the whole provenance strip. Read as separate nodes a
  // screen reader emits "structural", "The Hindu", "2026-11-03" as three
  // unrelated fragments, which is not a sentence anyone can act on.
  const metaLabel = [
    KIND_LABEL[item.kind],
    source ? `from ${source}` : 'no source recorded',
    `published ${published(item)}`,
  ].join(', ');

  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      <View style={styles.headerRow}>
        <Pill text={KIND_LABEL[item.kind]} tone={KIND_TONE[item.kind]} />
        {item.readAt ? <Pill text="read" tone="neutral" /> : null}
        {kept ? <Pill text="kept" tone="good" /> : null}
      </View>

      <TouchableOpacity
        onPress={onPress ? () => onPress(item) : undefined}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : 'header'}
        accessibilityLabel={onPress ? `Open: ${item.headline}` : item.headline}
        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
      >
        <Text style={[styles.headline, { color: theme.text }]}>{item.headline}</Text>
      </TouchableOpacity>

      <Text
        accessible
        accessibilityLabel={metaLabel}
        style={[styles.meta, { color: theme.textSecondary }]}
      >
        {source ?? 'no source recorded'} · {published(item)}
      </Text>

      {item.noteMd.trim() !== '' ? (
        <View style={styles.note}>
          <Markdown source={item.noteMd} theme={theme} />
        </View>
      ) : null}

      <AnthroBlock item={item} hasPair={hasPair} theme={theme} />

      {item.syllabusTags.length > 0 ? (
        <View
          style={styles.tagWrap}
          accessible
          accessibilityLabel={`Syllabus tags: ${item.syllabusTags.join(', ')}`}
        >
          {item.syllabusTags.map((tag, index) => (
            <View
              key={`${tag}-${index}`}
              style={[styles.tag, { backgroundColor: theme.backgroundSelected }]}
            >
              <Text style={[styles.tagText, { color: theme.textSecondary }]}>{tag}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={[styles.caveat, { color: theme.textSecondary }]}>
          No syllabus tag resolved for this item. It is still worth reading; it just will not file
          itself into a section of the monthly compilation.
        </Text>
      )}

      <Evidence
        evidence={item.evidence}
        open={evidenceOpen}
        onToggle={() => setEvidenceOpen((open) => !open)}
        theme={theme}
      />

      <View style={styles.actions}>
        {item.sourceUrl ? (
          <TouchableOpacity
            onPress={() => {
              // Fire-and-forget: a failed browser open must not take the card
              // down, and there is nothing useful to say about it in place.
              openBrowserAsync(item.sourceUrl!, {
                presentationStyle: WebBrowserPresentationStyle.AUTOMATIC,
              }).catch(() => undefined);
            }}
            accessibilityRole="link"
            accessibilityLabel={`Open the source${source ? ` at ${source}` : ''} in a browser`}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={[styles.action, { borderColor: theme.textSecondary }]}
          >
            <Text style={[styles.actionText, { color: theme.text }]}>Open source</Text>
          </TouchableOpacity>
        ) : null}

        {onKeep ? (
          <TouchableOpacity
            onPress={() => onKeep(item)}
            disabled={kept || keepDisabledReason !== null}
            accessibilityRole="button"
            accessibilityState={{ disabled: kept || keepDisabledReason !== null }}
            accessibilityLabel={
              kept
                ? 'Already kept as a flashcard'
                : keepDisabledReason !== null
                  ? `Keep unavailable. ${keepDisabledReason}`
                  : `Keep “${item.headline}” as a flashcard`
            }
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={[
              styles.action,
              {
                borderColor: theme.text,
                backgroundColor: kept ? 'transparent' : theme.backgroundSelected,
                opacity: kept || keepDisabledReason !== null ? 0.45 : 1,
              },
            ]}
          >
            <Text style={[styles.actionText, { color: theme.text }]}>
              {kept ? 'Kept' : 'Keep'}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {keepDisabledReason !== null && !kept ? (
        <Text style={[styles.caveat, { color: theme.textSecondary }]}>{keepDisabledReason}</Text>
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------------- anthro */

/**
 * The P1 concept and the P2 instance, named either side of an arrow.
 *
 * A half-link is shown as a half-link rather than dressed up as a whole one —
 * the rubric gives it nothing, and hiding the gap would hide the one thing she
 * could fix about the note.
 */
function AnthroBlock({
  item,
  hasPair,
  theme,
}: {
  item: CaItemFacts;
  hasPair: boolean;
  theme: Theme;
}) {
  if (!item.anthroLink && !item.anthroP1Slug && !item.anthroP2Slug) return null;

  const p1 = item.anthroP1Slug ? slugLabel(item.anthroP1Slug) : null;
  const p2 = item.anthroP2Slug ? slugLabel(item.anthroP2Slug) : null;

  // The pair and the sentence explaining it are one announcement. Split, a
  // screen reader reads two slugs and then an unattached sentence.
  const spoken = hasPair
    ? `Anthropology link. Paper 1 concept ${p1}, applied to Paper 2 instance ${p2}.${
        item.anthroLink ? ` ${item.anthroLink}` : ''
      }`
    : `Anthropology link, incomplete. ${
        p1 ? `Paper 1 concept ${p1}, with no Paper 2 instance named.` : ''
      }${p2 ? `Paper 2 instance ${p2}, with no Paper 1 concept named.` : ''}${
        item.anthroLink ? ` ${item.anthroLink}` : ''
      }`;

  return (
    <View
      accessible
      accessibilityLabel={spoken}
      style={[styles.anthro, { borderLeftColor: theme.text }]}
    >
      <Text style={[styles.anthroEyebrow, { color: theme.textSecondary }]}>Anthropology</Text>

      {hasPair ? (
        <Text style={[styles.anthroPair, { color: theme.text }]}>
          <Text style={styles.anthroSlug}>{p1}</Text>
          <Text style={{ color: theme.textSecondary }}>{'  →  '}</Text>
          <Text style={styles.anthroSlug}>{p2}</Text>
        </Text>
      ) : (
        <Text style={[styles.anthroPair, { color: theme.text }]}>
          <Text style={styles.anthroSlug}>{p1 ?? 'no P1 concept'}</Text>
          <Text style={{ color: theme.textSecondary }}>{'  →  '}</Text>
          <Text style={styles.anthroSlug}>{p2 ?? 'no P2 instance'}</Text>
        </Text>
      )}

      <Text style={[styles.anthroPapers, { color: theme.textSecondary }]}>
        Paper 1 concept → Paper 2 Indian instance
      </Text>

      {item.anthroLink ? (
        <Text style={[styles.anthroSentence, { color: theme.text }]}>{item.anthroLink}</Text>
      ) : null}

      {!hasPair ? (
        <Text style={[styles.caveat, { color: theme.textSecondary }]}>
          Only one half of the link is named, so this pair will not appear in the monthly
          Anthropology list. The optional credits the move from concept to instance, not either
          end on its own.
        </Text>
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------- evidence */

/**
 * The verbatim quotes, behind a disclosure.
 *
 * Behind a disclosure because the digest is a twenty-minute budget and six
 * quoted paragraphs would eat it; present at all — and stored on the device
 * rather than fetched — because the quote is what makes a claim checkable with
 * no signal. The count is on the closed control, so "this note rests on nothing"
 * is visible without opening it.
 */
function Evidence({
  evidence,
  open,
  onToggle,
  theme,
}: {
  evidence: readonly { quote: string }[];
  open: boolean;
  onToggle: () => void;
  theme: Theme;
}) {
  if (evidence.length === 0) {
    return (
      <Text style={[styles.caveat, { color: theme.textSecondary }]}>
        No source quote was stored for this item, so it cannot be checked offline. Open the source
        before you rely on it in an answer.
      </Text>
    );
  }

  return (
    <View style={styles.evidence}>
      <TouchableOpacity
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? 'Hide' : 'Show'} ${evidence.length} source ${
          evidence.length === 1 ? 'quote' : 'quotes'
        }`}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={styles.evidenceToggle}
      >
        <Text style={[styles.evidenceToggleText, { color: theme.textSecondary }]}>
          {open ? '▾' : '▸'} {evidence.length} source {evidence.length === 1 ? 'quote' : 'quotes'}
        </Text>
      </TouchableOpacity>

      {open
        ? evidence.map((entry, index) => (
            <View
              key={index}
              style={[styles.quote, { borderLeftColor: theme.textSecondary }]}
              accessible
              accessibilityLabel={`Quote ${index + 1} of ${evidence.length}. ${entry.quote}`}
            >
              <Text style={[styles.quoteText, { color: theme.text }]}>{entry.quote}</Text>
            </View>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 18, marginBottom: 16, gap: 10 },
  headerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  headline: { fontSize: 17, fontWeight: '700', lineHeight: 23 },
  meta: { fontSize: 12 },
  note: { marginTop: 2 },

  anthro: { borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 2, gap: 3 },
  anthroEyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  anthroPair: { fontSize: 15, lineHeight: 22 },
  anthroSlug: { fontWeight: '700' },
  anthroPapers: { fontSize: 11 },
  anthroSentence: { fontSize: 14, lineHeight: 21, marginTop: 4 },

  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  tagText: { fontSize: 11 },

  evidence: { gap: 8 },
  // 44pt floor: tapped one-handed on a moving train, same as `DayPicker`.
  evidenceToggle: { minHeight: 44, justifyContent: 'center' },
  evidenceToggleText: { fontSize: 13, fontWeight: '600' },
  quote: { borderLeftWidth: 2, paddingLeft: 10, paddingVertical: 2 },
  quoteText: { fontSize: 13, lineHeight: 20, fontStyle: 'italic' },

  actions: { flexDirection: 'row', gap: 10, marginTop: 2 },
  action: {
    minHeight: 44,
    minWidth: 88,
    borderRadius: 10,
    borderWidth: 1.5,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { fontSize: 14, fontWeight: '600' },

  caveat: { fontSize: 12, lineHeight: 18 },
});
