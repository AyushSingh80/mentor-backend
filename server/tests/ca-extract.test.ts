/**
 * HTML to the text the grounding gate reads.
 *
 * Two failure modes matter more than any other here, and both are silent:
 *
 *  - Boilerplate that survives extraction becomes GROUNDABLE. A footer that
 *    says "© 2019" hands a note the authority to date a 2026 judgment to 2019,
 *    and every downstream check would agree with it.
 *  - A paywall stub extracts cleanly and reads like prose. A pipeline that
 *    accepts forty words of teaser writes a digest item about an article
 *    nobody read, and nothing anywhere reports a problem.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-not-real';
process.env.MODEL_EVALUATION ??= 'eval-model-1';
process.env.MODEL_BULK ??= 'bulk-model-1';
process.env.APP_BEARER_TOKEN ??= 'test-token';

const {
  MIN_ARTICLE_CHARS,
  MIN_ARTICLE_WORDS,
  decodeEntities,
  extractArticle,
  extractBlocks,
  extractPublishedAt,
  htmlToText,
  looksPaywalled,
} = await import('../src/ca/extract.js');

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Promise<string> =>
  readFile(join(here, 'fixtures', 'ca', name), 'utf8');

/** A body long enough to clear the floor, built from a repeated clause. */
function longBody(sentence: string, times = 14): string {
  return new Array(times).fill(`<p>${sentence}</p>`).join('');
}

describe('decodeEntities', () => {
  it('decodes named, decimal and hex references', () => {
    assert.equal(decodeEntities('AT&amp;T &#8377;1,200 &#x20B9;5 &mdash; done'), 'AT&T ₹1,200 ₹5 — done');
  });

  it('decodes in ONE pass, so a double-encoded entity stays text', () => {
    // `&amp;lt;` is the literal text `&lt;`. A decoder that loops until stable
    // turns it into `<` and lets a page smuggle markup past every tag filter.
    assert.equal(decodeEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
  });

  it('leaves an unknown entity exactly as it found it', () => {
    assert.equal(decodeEntities('a &notarealentity; b'), 'a &notarealentity; b');
  });

  it('refuses a lone surrogate rather than emitting one', () => {
    // `normalize()` downstream throws on a lone surrogate.
    assert.equal(decodeEntities('&#xD800;'), '&#xD800;');
    assert.doesNotThrow(() => decodeEntities('&#xD800;').normalize('NFC'));
  });
});

describe('htmlToText', () => {
  it('puts a boundary between adjacent blocks that share no whitespace', () => {
    assert.equal(htmlToText('<p>first</p><p>second</p>'), 'first\nsecond');
  });

  it('treats a newline inside a paragraph as a soft wrap, not a boundary', () => {
    // Source HTML is indented. Reading its indentation as structure would make
    // `splitSentences` see a sentence break in the middle of a clause.
    assert.equal(htmlToText('<p>one\n  two\n  three</p>'), 'one two three');
  });

  it('turns <br> into a boundary', () => {
    assert.equal(htmlToText('<p>one<br>two</p>'), 'one\ntwo');
  });
});

describe('extractBlocks', () => {
  it('counts nesting rather than stopping at the first close tag', () => {
    // The related-story card. A non-greedy regex returns the outer opening tag
    // paired with the INNER close, which truncates the story to its first line.
    const html = '<article>outer <article>inner</article> tail</article>';
    assert.deepEqual(extractBlocks(html, 'article'), [html]);
  });

  it('returns each top-level block separately', () => {
    assert.deepEqual(extractBlocks('<article>a</article><article>b</article>', 'article'), [
      '<article>a</article>',
      '<article>b</article>',
    ]);
  });
});

describe('extractPublishedAt', () => {
  it('prefers JSON-LD datePublished over <meta>', async () => {
    // The fixture's meta says 2026-09-01 and its JSON-LD says 2026-03-12.
    // Several Indian outlets stamp the meta field at render time, so a page
    // trusted through meta would date every archived story to today.
    assert.equal(await fixture('article.html').then(extractPublishedAt), '2026-03-12T04:00:00.000Z');
  });

  it('finds datePublished inside an @graph', async () => {
    const html = await fixture('article.html');
    assert.match(html, /@graph/);
    assert.equal(extractPublishedAt(html), '2026-03-12T04:00:00.000Z');
  });

  it('falls back to <meta> when there is no JSON-LD', () => {
    const html = '<meta property="article:published_time" content="2026-02-01T10:00:00+05:30">';
    assert.equal(extractPublishedAt(html), '2026-02-01T04:30:00.000Z');
  });

  it('falls back to <time datetime> last', () => {
    assert.equal(extractPublishedAt('<time datetime="2026-01-05">Jan 5</time>'), '2026-01-05T00:00:00.000Z');
  });

  it('survives a malformed JSON-LD block instead of losing the article', () => {
    const html = '<script type="application/ld+json">{not json</script><meta name="pubdate" content="2026-04-02">';
    assert.equal(extractPublishedAt(html), '2026-04-02T00:00:00.000Z');
  });

  it('returns null rather than an invented date', () => {
    assert.equal(extractPublishedAt('<html><body><p>no date anywhere</p></body></html>'), null);
  });
});

describe('extractArticle on a real page', () => {
  it('keeps the story', async () => {
    const article = extractArticle(await fixture('article.html'));
    assert.notEqual(article, null);
    if (article === null) return;
    assert.match(article.text, /A three-judge bench of the Supreme Court held on 12 March 2026/);
    assert.match(article.text, /₹1,200 crore to the National Tribal Health Mission/);
    assert.equal(article.charCount, article.text.length);
    assert.equal(article.title, 'Supreme Court reads education access into Article 21');
  });

  it('strips every piece of furniture that would otherwise be groundable', async () => {
    const article = extractArticle(await fixture('article.html'));
    assert.notEqual(article, null);
    if (article === null) return;
    for (const junk of [
      'Archive 1998', // <nav>
      '© 2019', // <footer>
      '1800-123-4567', // <footer>
      'trackingId', // <script>
      'masthead', // <style>
      'Enable JavaScript', // <noscript>
      'UPSC coaching offers', // <nav>
      'related-story card', // <aside>
    ]) {
      assert.equal(article.text.includes(junk), false, `furniture survived extraction: ${junk}`);
    }
    // And the years inside that furniture are gone with it.
    for (const year of ['1998', '2019', '1889', '1911', '1947', '7777']) {
      assert.equal(article.text.includes(year), false, `a furniture year survived: ${year}`);
    }
  });

  it('preserves the typography the page used', async () => {
    // Normalisation happens in ground.ts, on both sides at once. Doing it here
    // instead would mean the stored text no longer matches the page.
    const article = extractArticle(await fixture('article.html'));
    assert.notEqual(article, null);
    if (article === null) return;
    assert.match(article.text, /“a facet of the right to life” —/);
  });
});

describe('extractArticle refuses a paywall stub', () => {
  it('returns null for the fixture stub rather than 40 words of teaser', async () => {
    // The contract with fetch.ts: null here becomes `extract_empty` there.
    // Returning the teaser would produce a digest item about a story whose
    // body nobody ever read, complete with the outlet's name on it.
    assert.equal(extractArticle(await fixture('paywall.html')), null);
  });

  it('refuses a body under the word floor even with no paywall language', () => {
    const html = `<html><body><article><p>${new Array(40).fill('word').join(' ')}</p></article></body></html>`;
    assert.equal(extractArticle(html), null);
  });

  it('refuses a teaser padded out by related-story furniture', () => {
    // Long enough to clear the floor, but the withheld body means there is no
    // semantic root — the outlet did not put what it kept back inside <article>.
    const padding = longBody('A related story headline about something else entirely.');
    const html = `<html><body><div class="wrap"><p>The Cabinet approved an outlay.</p><p>Subscribe to continue reading this story.</p>${padding}</div></body></html>`;
    assert.equal(extractArticle(html), null);
  });

  it('keeps a long story that merely mentions subscribing in surviving furniture', () => {
    const body = longBody(
      'The bench recorded that the Union had allocated a specific sum to the mission in the current financial year and that a share of it was unspent.',
    );
    const html = `<html><body><article>${body}<p>Subscribe to continue reading more from our archives.</p></article></body></html>`;
    const article = extractArticle(html);
    assert.notEqual(article, null, 'a real story must not be lost to a footer promo');
  });

  it('agrees with its own thresholds', () => {
    assert.equal(MIN_ARTICLE_WORDS, 100);
    assert.equal(MIN_ARTICLE_CHARS, 600);
    assert.equal(looksPaywalled('Already a subscriber? Sign in to read the full article.'), true);
    assert.equal(looksPaywalled('The bench delivered the judgment on a Thursday.'), false);
  });

  it('returns null for empty input rather than an empty document', () => {
    assert.equal(extractArticle(''), null);
    assert.equal(extractArticle('   '), null);
  });
});

describe('extractArticle strips non-prose elements inside the story itself', () => {
  it('drops an inline script, style and form that live INSIDE <article>', () => {
    // Where the analytics blob and the newsletter form actually sit on a real
    // outlet page. Furniture in <head> never reaches the output anyway, because
    // the content root is the <article>; furniture INSIDE the article is the
    // case that decides whether `dropElements` is doing anything at all — and a
    // leaked JSON blob is a page full of groundable numbers nobody published.
    const body = longBody('The bench recorded a finding about the allocation and the districts covered.');
    const html = `<html><body><article>
      <script>window.__DATA__ = {"impressions": 4242424, "vintage": 1974};</script>
      <style>.ad { width: 728px; }</style>
      <noscript>Enable JavaScript. Reference 7777.</noscript>
      <form><input value="subscribe-9999"></form>
      ${body}
    </article></body></html>`;
    const article = extractArticle(html);
    assert.notEqual(article, null);
    if (article === null) return;
    for (const leak of ['4242424', '1974', '728', '7777', '9999', '__DATA__', 'Enable JavaScript']) {
      assert.equal(article.text.includes(leak), false, `inline furniture leaked: ${leak}`);
    }
    assert.match(article.text, /The bench recorded a finding/);
  });
});

describe('extractArticle prefers the semantic root', () => {
  it('picks the largest <article>, not the first', () => {
    // Outlets wrap related-story cards in their own <article> elements and
    // render them above the fold. "First" reliably picks the card.
    const card = '<article class="card"><p>A short teaser card.</p></article>';
    const story = `<article class="story">${longBody('The bench recorded a finding of fact about the allocation and the Gram Sabha process.')}</article>`;
    const article = extractArticle(`<html><body>${card}${story}</body></html>`);
    assert.notEqual(article, null);
    if (article === null) return;
    assert.equal(article.text.includes('A short teaser card.'), false);
    assert.match(article.text, /Gram Sabha process/);
  });

  it('falls back to <body> when the page has no semantic root', () => {
    const html = `<html><body><div id="content">${longBody('A wire copy paragraph about the allocation and the districts covered.')}</div></body></html>`;
    const article = extractArticle(html);
    assert.notEqual(article, null);
    if (article === null) return;
    assert.match(article.text, /wire copy paragraph/);
  });
});
