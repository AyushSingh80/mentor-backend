/**
 * HTML to the normalised plain text the grounding gate reads.
 *
 * This is the only place the fetched page becomes something a model can be
 * shown, so two properties matter more than fidelity:
 *
 *  1. WHAT IS HERE IS WHAT THE PAGE SAID. Boilerplate that survives extraction
 *     becomes groundable text — a footer that says "© 2026" would let a note
 *     claim 2026 with the page's own authority. Navigation, share widgets and
 *     newsletter promos are stripped before anything else happens.
 *
 *  2. A PAYWALL STUB IS NOT AN ARTICLE. Forty words of teaser extract cleanly,
 *     read like prose, and ground almost nothing — so a note written from one
 *     would be a note about an article nobody read. `extractArticle` returns
 *     `null` for those, which the fetch layer reports as `extract_empty`. A
 *     source that quietly degrades to its own teaser is worse than a source
 *     that fails, because the failure is invisible.
 *
 * No DOM parser. `jsdom`/`cheerio` would be a multi-megabyte dependency and a
 * standing CVE surface for a server that holds an API key, and none of the
 * output here needs a DOM — it needs text with block boundaries preserved. The
 * scanners below are nesting-aware where nesting matters (`<article>` inside
 * `<article>`) and deliberately dumb everywhere else.
 */

/* ------------------------------------------------------------------ entities */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  shy: '­', zwnj: '‌', zwj: '‍',
  ndash: '–', mdash: '—', minus: '−', hyphen: '‐',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“',
  rdquo: '”', bdquo: '„', laquo: '«', raquo: '»',
  lsaquo: '‹', rsaquo: '›', prime: '′', Prime: '″',
  hellip: '…', middot: '·', bull: '•', dagger: '†',
  Dagger: '‡', permil: '‰', deg: '°', copy: '©',
  reg: '®', trade: '™', sect: '§', para: '¶',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  times: '×', divide: '÷', plusmn: '±',
  frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã',
  auml: 'ä', aring: 'å', ccedil: 'ç', egrave: 'è',
  eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì',
  iacute: 'í', ntilde: 'ñ', ograve: 'ò', oacute: 'ó',
  ouml: 'ö', ugrave: 'ù', uacute: 'ú', uuml: 'ü',
};

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;

/**
 * One left-to-right pass, never re-scanned.
 *
 * Re-running the decoder until it stabilises is the obvious implementation and
 * it is wrong: `&amp;lt;` must decode to the literal text `&lt;`, and a second
 * pass would turn it into `<`. A page can therefore never smuggle markup
 * through this function by double-encoding it.
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10)) ?? whole;
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16)) ?? whole;
    if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
    return whole;
  });
}

function fromCodePoint(code: number): string | null {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
  // Surrogate halves are not characters; emitting one produces a lone
  // surrogate that breaks `normalize()` downstream.
  if (code >= 0xd800 && code <= 0xdfff) return null;
  try {
    return String.fromCodePoint(code);
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- tag surgery */

/** Elements whose CONTENT is never prose. Removed opening tag through closing. */
const DROPPED_ELEMENTS = [
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'canvas',
  'iframe', 'object', 'embed', 'form', 'button', 'select', 'textarea',
  'nav', 'footer', 'aside', 'video', 'audio', 'picture', 'dialog',
] as const;

/** Closing tags that end a line of prose. */
const BLOCK_TAGS = [
  'p', 'div', 'section', 'article', 'main', 'header', 'li', 'ul', 'ol',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr', 'td', 'th',
  'table', 'figcaption', 'figure', 'dd', 'dt', 'dl', 'pre',
] as const;

function dropElements(html: string): string {
  let out = html;
  for (const tag of DROPPED_ELEMENTS) {
    // Non-greedy to the first matching close. These elements do not
    // meaningfully nest in published article HTML, and over-removal here is
    // strictly safer than under-removal: the cost is losing prose, the cost of
    // the other direction is grounding a note in a cookie banner.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
    // Unclosed <script> at end of document, and self-closing forms.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/>`, 'gi'), ' ');
  }
  return out;
}

/**
 * Every top-level `<tag>…</tag>` block, counting nesting properly.
 *
 * A non-greedy regex returns the wrong thing for `<article>` on a page that
 * embeds a related-story `<article>` card inside the main one: it stops at the
 * inner `</article>` and yields two paragraphs instead of the story.
 */
export function extractBlocks(html: string, tagName: string): string[] {
  const pattern = new RegExp(`<(\\/?)${tagName}\\b[^>]*?(\\/?)>`, 'gi');
  const blocks: string[] = [];
  let depth = 0;
  let start = 0;
  for (let m = pattern.exec(html); m !== null; m = pattern.exec(html)) {
    const closing = m[1] === '/';
    const selfClosing = m[2] === '/';
    if (selfClosing) continue;
    if (!closing) {
      if (depth === 0) start = m.index;
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) blocks.push(html.slice(start, m.index + m[0].length));
    }
  }
  return blocks;
}

/**
 * Tags removed, entities decoded, block boundaries kept as newlines.
 *
 * The break marker is a sentinel rather than a literal newline because source
 * HTML is indented: a `<p>` element in a hand-authored page contains real
 * newlines that are soft wrap, not structure. Collapsing ALL whitespace first
 * and splitting on the sentinel afterwards is what keeps "one paragraph, one
 * line" true — which matters because `splitSentences` treats a newline as a
 * hard sentence boundary.
 */
export function htmlToText(html: string): string {
  const BREAK = '\u0000';
  const withBreaks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Any sentinel already in the input would forge a block boundary.
    .replace(/\u0000/g, ' ')
    .replace(/<br\b[^>]*>/gi, BREAK)
    .replace(/<hr\b[^>]*>/gi, BREAK)
    .replace(new RegExp(`</(?:${BLOCK_TAGS.join('|')})\\s*>`, 'gi'), BREAK)
    .replace(new RegExp(`<(?:${BLOCK_TAGS.join('|')})\\b[^>]*>`, 'gi'), BREAK)
    .replace(/<[^>]*>/g, '');

  return decodeEntities(withBreaks)
    .split(BREAK)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** Inner text of the first matching element, or null. */
function firstText(html: string, tagName: string): string | null {
  const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`, 'i').exec(html);
  if (match?.[1] === undefined) return null;
  const text = htmlToText(match[1]).replace(/\n+/g, ' ').trim();
  return text === '' ? null : text;
}

/* -------------------------------------------------------------- publishedAt */

/** `datePublished` anywhere in a JSON-LD graph, including inside `@graph`. */
function findDatePublished(node: unknown, depth = 0): string | null {
  if (depth > 8 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findDatePublished(child, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = node as Record<string, unknown>;
  const direct = record['datePublished'];
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  for (const value of Object.values(record)) {
    const found = findDatePublished(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const pattern =
    /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (let m = pattern.exec(html); m !== null; m = pattern.exec(html)) {
    const raw = (m[1] ?? '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
    if (raw === '') continue;
    for (const candidate of [raw, decodeEntities(raw)]) {
      try {
        out.push(JSON.parse(candidate));
        break;
      } catch {
        // A malformed block is skipped, never fatal: publication date is
        // advisory metadata and a broken <script> must not lose the article.
      }
    }
  }
  return out;
}

const META_DATE_KEYS = [
  'article:published_time',
  'og:article:published_time',
  'article:published',
  'datePublished',
  'publish-date',
  'publishdate',
  'pubdate',
  'date',
  'dc.date.issued',
  'dc.date',
  'sailthru.date',
  'parsely-pub-date',
] as const;

function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(
      `<meta\\b[^>]*(?:property|name|itemprop)\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
      'i',
    ),
    new RegExp(
      `<meta\\b[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name|itemprop)\\s*=\\s*["']${escaped}["']`,
      'i',
    ),
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(html)?.[1]?.trim();
    if (value !== undefined && value !== '') return value;
  }
  return null;
}

/** ISO 8601 UTC, or null when the value is missing or unparseable. */
function toIso(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Publication date, JSON-LD first.
 *
 * JSON-LD wins over `<meta>` because it is the date the CMS asserts to search
 * engines and is maintained; `article:published_time` is frequently the date
 * the template was rendered, and on several Indian outlets it is today's date
 * on every archived page. A publication date that silently means "now" would
 * make a three-year-old explainer look like this morning's news.
 */
export function extractPublishedAt(html: string): string | null {
  for (const block of jsonLdBlocks(html)) {
    const iso = toIso(findDatePublished(block));
    if (iso !== null) return iso;
  }
  for (const key of META_DATE_KEYS) {
    const iso = toIso(metaContent(html, key));
    if (iso !== null) return iso;
  }
  const timeAttr = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? null;
  return toIso(timeAttr);
}

/* ------------------------------------------------------------------ paywalls */

/**
 * The floor below which "extracted successfully" is a lie.
 *
 * A The Hindu or Indian Express teaser runs 25-60 words. A genuine PIB release
 * — the shortest thing this pipeline reads — runs 150 words and up, and a
 * judgment summary or a PRS bill note runs far longer. 100 words sits in the
 * gap with room on both sides, and a stub that clears it still has to survive
 * the paywall phrases below.
 */
export const MIN_ARTICLE_WORDS = 100;
export const MIN_ARTICLE_CHARS = 600;

const PAYWALL_MARKERS: readonly RegExp[] = [
  /subscribe to (?:continue|read|keep reading)/i,
  /subscri(?:be|ption) (?:now )?to (?:read|continue|access)/i,
  /premium (?:article|story|content)/i,
  /already (?:a|an) (?:subscriber|member)\b/i,
  /sign ?in to (?:read|continue|access)/i,
  /log ?in to (?:read|continue|access)/i,
  /this (?:article|story) is (?:for|available to) subscribers/i,
  /subscriber[- ]only/i,
  /continue reading (?:this|with|the)/i,
  /to read the (?:full|complete) (?:story|article)/i,
  /unlock (?:this|the full) (?:article|story)/i,
  /you have (?:reached|exhausted) your (?:free )?(?:article )?limit/i,
  /register to (?:read|continue)/i,
];

export function looksPaywalled(text: string): boolean {
  return PAYWALL_MARKERS.some((marker) => marker.test(text));
}

function wordCount(text: string): number {
  const words = text.match(/\S+/g);
  return words === null ? 0 : words.length;
}

/* ------------------------------------------------------------------- extract */

export interface ExtractedArticle {
  title: string | null;
  publishedAt: string | null;
  /** Block boundaries preserved as single newlines. Never persisted. */
  text: string;
  charCount: number;
}

/**
 * Longest `<article>`, else longest `<main>`, else the `<body>`, else the lot.
 *
 * Longest rather than first: outlets wrap related-story cards in their own
 * `<article>` elements and the story is reliably the biggest of them, while
 * "first" picks whichever card the template happened to render above the fold.
 */
function contentRoot(html: string): { html: string; semantic: boolean } {
  for (const tag of ['article', 'main'] as const) {
    const blocks = extractBlocks(html, tag);
    let best: string | null = null;
    for (const block of blocks) {
      if (best === null || block.length > best.length) best = block;
    }
    if (best !== null && htmlToText(best).length >= MIN_ARTICLE_CHARS) {
      return { html: best, semantic: true };
    }
  }
  const body = extractBlocks(html, 'body');
  const largestBody = body.reduce<string | null>(
    (acc, block) => (acc === null || block.length > acc.length ? block : acc),
    null,
  );
  return { html: largestBody ?? html, semantic: false };
}

/**
 * HTML in, groundable text out — or `null`, which the caller reports as
 * `extract_empty`.
 *
 * Returning `null` rather than a short string is the point of this function's
 * signature. There is no "partial" extraction: a caller handed 40 words has no
 * way to know they are 40 words of teaser rather than 40 words of press note,
 * and the one that guesses wrong writes a digest item about an article nobody
 * read.
 */
export function extractArticle(html: string): ExtractedArticle | null {
  if (typeof html !== 'string' || html.trim() === '') return null;

  const publishedAt = extractPublishedAt(html);
  const title =
    metaContent(html, 'og:title') ??
    firstText(dropElements(html), 'h1') ??
    firstText(html, 'title');

  const cleaned = dropElements(html.replace(/<!--[\s\S]*?-->/g, ' '));
  const root = contentRoot(cleaned);
  const text = htmlToText(root.html);

  if (text.length < MIN_ARTICLE_CHARS || wordCount(text) < MIN_ARTICLE_WORDS) return null;

  // Three ways the same stub tries to pass. A teaser under a paywall notice is
  // short (caught above); a teaser padded out by related-story furniture is
  // long but has no semantic root, because the outlet did not put the body it
  // withheld inside an <article>; a genuinely long story that merely mentions
  // "subscribe to continue" in surviving furniture clears both and is kept.
  if (looksPaywalled(text)) {
    if (!root.semantic) return null;
    if (text.length < MIN_ARTICLE_CHARS * 3) return null;
  }

  return { title, publishedAt, text, charCount: text.length };
}
