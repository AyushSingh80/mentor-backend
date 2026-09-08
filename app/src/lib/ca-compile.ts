/**
 * The monthly current-affairs compilation, built entirely on the device.
 *
 * ## Why this is pure, and why it never calls the server
 *
 * Three independent reasons, any one of which would be enough:
 *
 * 1. The data is already local. Every item, tag and Anthropology pair is in
 *    SQLite the moment the digest lands. Shipping it to a model to be
 *    reformatted is paying money and latency for a `join` and a `map`.
 * 2. A pure function is deterministic and unit-testable. The month boundary
 *    rule below is the kind of thing that is wrong for eighteen months before
 *    anyone notices; it is asserted in `tests/ca-compile.test.ts` instead.
 * 3. This is the one artefact she needs the week before an exam. Making it
 *    depend on connectivity and a monthly spend cap would be indefensible —
 *    the failure mode is "no compilation, the night before", and there is no
 *    recovery from it.
 *
 * ## Why markdown and not PDF
 *
 * Markdown is diffable, opens anywhere, renders in-app through the existing
 * `<Markdown>` component, and — the actual use — pastes into her own revision
 * notes a paragraph at a time. A PDF needs a new native dependency, is opaque
 * to `git diff`, and is worse at precisely the thing she does with it.
 *
 * The output is deliberately restricted to the subset `lib/markdown-parse.ts`
 * understands: headings, bullets, bold, rules. No tables — the in-app renderer
 * has no table support, so an Anthropology "table" written with pipes would
 * render as a wall of broken paragraphs on the one screen she reads it on.
 *
 * Pure: no RN, no expo-sqlite, no `Date`, no `Date.now()`. `generatedOn` is
 * injected by the caller.
 */

import type { CaItemFacts, CaPaper } from '@/lib/ca-types';
import { PAPERS, paperLabel } from '@/lib/papers';

/**
 * One syllabus section — the `(paper, topic)` grouping `coverageBySection`
 * already uses, carrying the topic ids that resolve into it.
 *
 * The caller supplies the full list, including sections with nothing in them.
 * That is not an accident of the interface; it is the only way this module can
 * report what is missing. See `emptySections`.
 */
export interface CompilationSection {
  readonly paper: CaPaper;
  /** The printed section heading. */
  readonly topic: string;
  /** Every `syllabus_topics.id` filed under this section. */
  readonly topicIds: readonly number[];
}

export interface CompilationOptions {
  /** `YYYY-MM`. Byte-compared against `item.date`; never parsed through `Date`. */
  readonly month: string;
  /**
   * `YYYY-MM-DD`, injected rather than read from the clock.
   *
   * A generator that stamps `new Date()` into its output cannot be asserted
   * against a fixture, so the one property worth guaranteeing — same input,
   * same bytes — becomes untestable.
   */
  readonly generatedOn: string;
}

/** A P1 concept and the P2 Indian instance it was linked to. */
export interface AnthroPair {
  readonly itemId: number;
  readonly date: string;
  readonly headline: string;
  readonly p1Slug: string;
  readonly p2Slug: string;
  readonly link: string | null;
}

export interface SectionRef {
  readonly paper: CaPaper;
  readonly topic: string;
}

export interface CompiledSection extends SectionRef {
  /** Items filed here in full — this is the item's primary (rank-0) section. */
  readonly items: readonly CaItemFacts[];
  /** Items tagged here but written out under another section. */
  readonly crossReferences: readonly CaItemFacts[];
}

export interface CompiledPaper {
  readonly paper: CaPaper;
  readonly label: string;
  readonly sections: readonly CompiledSection[];
  /** Items written out in full under this paper. */
  readonly itemCount: number;
}

export interface Compilation {
  readonly month: string;
  readonly monthLabel: string;
  readonly generatedOn: string;
  /** `current-affairs-2026-11.md`. Sorts chronologically in a file listing. */
  readonly fileName: string;
  readonly markdown: string;
  /** Every item filed into this month, including unfiled ones. */
  readonly itemCount: number;
  readonly papers: readonly CompiledPaper[];
  readonly anthropologyPairs: readonly AnthroPair[];
  /** Sections that saw nothing at all this month. Diagnostic, not filler. */
  readonly emptySections: readonly SectionRef[];
  /** In the month, but no tag resolved to any known section. */
  readonly unfiled: readonly CaItemFacts[];
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * `2026-11` -> `November 2026`, by lookup rather than by `Date`.
 *
 * `new Date('2026-11')` is parsed as UTC midnight and then rendered in the
 * device's zone, so east of Greenwich it is still October when it prints. That
 * is the identical bug this module exists to avoid one layer down.
 */
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const index = Number(match[2]) - 1;
  const name = MONTH_NAMES[index];
  return name === undefined ? month : `${name} ${match[1]}`;
}

/** The `YYYY-MM` an item belongs to. See `filedMonth` below for the choice. */
function filedMonth(item: CaItemFacts): string {
  return item.date.slice(0, 7);
}

/**
 * Free text going into a markdown document.
 *
 * Newlines are the load-bearing case: a headline containing one would end the
 * heading and silently restructure the document. Whitespace runs collapse to a
 * single space. Deliberately NOT backslash-escaping `*` and `_` — the in-app
 * renderer has no escape support, so escaping would trade a rare cosmetic
 * italic for a guaranteed visible backslash on the screen she actually reads.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Builds the compilation for one month.
 *
 * ## Items are filed by `date`, never by `publishedAt`
 *
 * They differ, and they differ most often exactly at a month boundary: a
 * judgment delivered on Sunday the 31st lands in Monday the 1st's digest. The
 * compilation is the artefact she carries into an exam, and it must match the
 * month she read — she looks for the item where she saw it, which is the day it
 * appeared on this screen. `publishedAt` is kept and printed when it differs,
 * so the source's own date is never lost, but it does not decide the filing.
 */
export function buildMonthlyCompilation(
  items: readonly CaItemFacts[],
  sections: readonly CompilationSection[],
  opts: CompilationOptions,
): Compilation {
  const { month, generatedOn } = opts;

  // Filed by digest day. This one `.slice` is the whole month-boundary rule.
  const monthItems = items
    .filter((item) => filedMonth(item) === month)
    .slice()
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));

  // topicId -> section index. First section claiming a topic wins, so the
  // caller's order is the tiebreak and the result stays deterministic.
  const sectionOfTopic = new Map<number, number>();
  sections.forEach((section, index) => {
    for (const topicId of section.topicIds) {
      if (!sectionOfTopic.has(topicId)) sectionOfTopic.set(topicId, index);
    }
  });

  const filed: CaItemFacts[][] = sections.map(() => []);
  const crossed: CaItemFacts[][] = sections.map(() => []);
  const unfiled: CaItemFacts[] = [];

  for (const item of monthItems) {
    // Rank order is preserved by the repository, so the first resolvable tag is
    // the primary one and decides where the item is written out in full.
    const matched: number[] = [];
    for (const topicId of item.topicIds) {
      const index = sectionOfTopic.get(topicId);
      if (index !== undefined && !matched.includes(index)) matched.push(index);
    }

    if (matched.length === 0) {
      unfiled.push(item);
      continue;
    }

    filed[matched[0]!]!.push(item);
    for (const index of matched.slice(1)) crossed[index]!.push(item);
  }

  // Papers in syllabus order, and only those the caller supplied sections for.
  const papers: CompiledPaper[] = [];
  for (const paper of PAPERS) {
    const compiledSections: CompiledSection[] = [];
    let itemCount = 0;

    sections.forEach((section, index) => {
      if (section.paper !== paper.value) return;
      const own = filed[index]!;
      const refs = crossed[index]!;
      itemCount += own.length;
      if (own.length > 0 || refs.length > 0) {
        compiledSections.push({
          paper: section.paper,
          topic: section.topic,
          items: own,
          crossReferences: refs,
        });
      }
    });

    if (compiledSections.length > 0) {
      papers.push({
        paper: paper.value,
        label: paperLabel(paper.value),
        sections: compiledSections,
        itemCount,
      });
    }
  }

  /**
   * Sections that saw nothing at all — not even a cross-reference.
   *
   * This list is the reason the caller passes every section rather than only
   * the populated ones. Zero items means one of two things, and she cannot tell
   * them apart from a screen that simply omits the section: either the month
   * was genuinely quiet there, or the source allowlist does not reach it. The
   * second is a fixable bug in the feed, and it is invisible unless named.
   */
  const emptySections: SectionRef[] = [];
  sections.forEach((section, index) => {
    if (filed[index]!.length === 0 && crossed[index]!.length === 0) {
      emptySections.push({ paper: section.paper, topic: section.topic });
    }
  });

  // BOTH slugs or it is not a pair. A P1 concept with no Indian instance is
  // the half of the link the rubric gives no credit for.
  const anthropologyPairs: AnthroPair[] = monthItems
    .filter((item) => nonEmpty(item.anthroP1Slug) && nonEmpty(item.anthroP2Slug))
    .map((item) => ({
      itemId: item.id,
      date: item.date,
      headline: item.headline,
      p1Slug: item.anthroP1Slug!,
      p2Slug: item.anthroP2Slug!,
      link: item.anthroLink,
    }));

  const markdown = render({
    month,
    monthLabel: monthLabel(month),
    generatedOn,
    items: monthItems,
    papers,
    anthropologyPairs,
    emptySections,
    unfiled,
    sectionCount: sections.length,
  });

  return {
    month,
    monthLabel: monthLabel(month),
    generatedOn,
    fileName: `current-affairs-${month}.md`,
    markdown,
    itemCount: monthItems.length,
    papers,
    anthropologyPairs,
    emptySections,
    unfiled,
  };
}

/* ------------------------------------------------------------- rendering */

interface RenderInput {
  month: string;
  monthLabel: string;
  generatedOn: string;
  items: readonly CaItemFacts[];
  papers: readonly CompiledPaper[];
  anthropologyPairs: readonly AnthroPair[];
  emptySections: readonly SectionRef[];
  unfiled: readonly CaItemFacts[];
  sectionCount: number;
}

function render(input: RenderInput): string {
  const lines: string[] = [];
  const push = (line = '') => lines.push(line);

  const days = new Set(input.items.map((item) => item.date));
  const sources = [...new Set(input.items.map((i) => i.sourceName).filter(nonEmpty))].sort();
  const withMaterial = input.sectionCount - input.emptySections.length;

  push(`# Current affairs — ${input.monthLabel}`);
  push();
  push(`Generated on ${input.generatedOn} on this device, from notes already saved offline.`);
  push();
  push(`- **Items:** ${input.items.length}`);
  push(`- **Digest days:** ${days.size}`);
  push(`- **Sections with material:** ${withMaterial} of ${input.sectionCount}`);
  push(`- **Anthropology P1 to P2 pairs:** ${input.anthropologyPairs.length}`);
  if (input.unfiled.length > 0) push(`- **Unfiled items:** ${input.unfiled.length}`);
  push(`- **Sources:** ${sources.length === 0 ? 'none recorded' : sources.join(', ')}`);
  push();
  push(
    'Items are filed by the day the digest delivered them, not the day the source published. ' +
      'A judgment reported on the 31st and delivered on the 1st is filed under the later month — ' +
      'which is the month you read it in, and where you will look for it.',
  );
  push();
  push('---');

  if (input.items.length === 0) {
    push();
    push('## Nothing was filed this month');
    push();
    push(
      'No digest produced an item for this month. That is a fact about the feed, not about ' +
        'the news: check the digest history for failed runs before concluding the month was quiet.',
    );
  }

  for (const paper of input.papers) {
    push();
    push(`## ${paper.label}`);
    push();
    push(`${paper.itemCount} ${paper.itemCount === 1 ? 'item' : 'items'}.`);

    for (const section of paper.sections) {
      push();
      push(`### ${oneLine(section.topic)}`);

      for (const item of section.items) {
        renderItem(item, push);
      }

      if (section.crossReferences.length > 0) {
        push();
        push('Also tagged here, written out in full elsewhere:');
        push();
        for (const item of section.crossReferences) {
          push(`- ${item.date} — ${oneLine(item.headline)}`);
        }
      }
    }
  }

  /**
   * The Anthropology table, as a list.
   *
   * Named pairs rather than prose, because the optional's rubric weights a P1
   * concept carried onto a P2 Indian instance above everything else — so the
   * *shape* of the link is the thing to revise, and a month of them read
   * together is where the shape becomes visible.
   */
  push();
  push('---');
  push();
  push('## Anthropology — Paper 1 concept to Paper 2 instance');
  push();
  if (input.anthropologyPairs.length === 0) {
    push(
      'No item this month carried both a Paper 1 concept and a Paper 2 Indian instance. ' +
        'Only complete pairs are listed here — half a link earns nothing in the optional.',
    );
  } else {
    push(
      `${input.anthropologyPairs.length} complete ${
        input.anthropologyPairs.length === 1 ? 'pair' : 'pairs'
      }. Items carrying only one side of the link are not listed.`,
    );
    push();
    for (const pair of input.anthropologyPairs) {
      push(`- **${pair.p1Slug}** to **${pair.p2Slug}** — ${oneLine(pair.headline)} (${pair.date})`);
      if (nonEmpty(pair.link)) push(`  - ${oneLine(pair.link)}`);
    }
  }

  if (input.unfiled.length > 0) {
    push();
    push('---');
    push();
    push('## Unfiled');
    push();
    push(
      'These items are in the month but no tag resolved to a syllabus section this build knows ' +
        'about. They are printed in full rather than dropped — an untagged item is still a ' +
        'readable item — and their raw tags are shown, because a tag that never resolves is a ' +
        'syllabus vocabulary drift worth fixing.',
    );
    for (const item of input.unfiled) {
      renderItem(item, push);
    }
  }

  push();
  push('---');
  push();
  push('## Sections with no material this month');
  push();
  if (input.emptySections.length === 0) {
    push('Every syllabus section saw at least one item this month.');
  } else {
    push(
      `${input.emptySections.length} of ${input.sectionCount} sections saw nothing. This list is ` +
        'a diagnostic, not padding: a quiet section and a section the source allowlist does not ' +
        'reach look identical from the digest, and only the second is a bug you can fix. Any ' +
        'section that stays empty for two months running is worth checking against the feeds.',
    );
    push();

    let currentPaper: CaPaper | null = null;
    for (const section of input.emptySections) {
      if (section.paper !== currentPaper) {
        currentPaper = section.paper;
        push();
        push(`**${paperLabel(section.paper)}**`);
        push();
      }
      push(`- ${oneLine(section.topic)}`);
    }
  }

  push();
  return lines.join('\n');
}

function renderItem(item: CaItemFacts, push: (line?: string) => void): void {
  push();
  push(`#### ${item.date} — ${oneLine(item.headline)}`);
  push();

  const meta: string[] = [item.kind];
  if (nonEmpty(item.sourceName)) meta.push(oneLine(item.sourceName));
  // Only when it disagrees with the filing date, which is the case the reader
  // needs flagged and the only case where printing both adds anything.
  if (nonEmpty(item.publishedAt) && item.publishedAt.slice(0, 10) !== item.date) {
    meta.push(`published ${item.publishedAt.slice(0, 10)}`);
  }
  push(`*${meta.join(' · ')}*`);

  const note = item.noteMd.trim();
  if (note !== '') {
    push();
    push(note);
  }

  if (nonEmpty(item.anthroLink)) {
    push();
    push(`**Anthropology:** ${oneLine(item.anthroLink)}`);
  }

  if (item.syllabusTags.length > 0) {
    push();
    push(`**Tags:** ${item.syllabusTags.map((t) => oneLine(t)).join(', ')}`);
  }

  if (nonEmpty(item.sourceUrl)) {
    push();
    push(`Source: ${item.sourceUrl}`);
  }
}
