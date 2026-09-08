# Your task now: notes

You are given the full extracted text of the articles you shortlisted, each one
between an `=== ARTICLE ===` marker and its `=== END ARTICLE ===`. That text is
the ONLY thing you may write from.

Write at most one note per article, and only for the articles whose text
actually supports one. An article that turned out to be a stub, a photo caption,
a paywall page or a liveblog gets no note. Omitting it is correct and costs
nothing.

## The note

- At most **90 words**, markdown, no heading.
- Answer "what changed, and why does it matter for an answer?" — in that order.
  Do not open with background she already has.
- Use the words the source used for anything precise: figures, statute names,
  the name of the body, the name of the scheme. Paraphrase the argument, never
  the facts.
- No adjectives doing work that the fact should do. "A significant step" is
  filler; "raises the threshold from X to Y" is the note.

## `url`

Copy it character-for-character from the `SOURCE URL:` line of the article you
are writing about. A url that is not one of the supplied documents is discarded
along with its note — there would be nothing to check it against.

## `evidence` — verbatim, not remembered

One to three quotes, each **copied** out of the article text. Not tidied, not
shortened with an ellipsis, not corrected. The server searches for each quote as
a literal substring of the page it fetched; a quote that has been improved in
any way will not be found, and the whole item is then discarded.

Choose quotes that carry the load: the sentence stating the change, the sentence
carrying the figure, the sentence naming the authority. A quote that supports
nothing in your note is a wasted slot.

## `sentenceEvidence` — one index per sentence

For each sentence of `noteMd`, in order, give the index into your `evidence`
array of the quote that supports it.

This is the check that closes the gap the substring test leaves open. A 90-word
note can be 80 words grounded and 10 words invented, and the invented 10 are the
ones that would end up in her answer. If a sentence has no quote behind it, the
fix is to delete the sentence, not to point it at the nearest quote.

## `syllabusSlugs` and `sectionKeys`

Verbatim from the supplied lists. No slug from that list means the item earns no
slot, whatever else is true about it.

## What gets an item discarded

All of these are checked without a model and without appeal:

- a quote that is not a literal substring of the fetched text
- a number, year, month or "Article N" in the note that is not in the text
- fewer evidence indices than the note has sentences
- a note over 90 words
- a url that was not one of the supplied documents

None of these are recoverable, so none of them are worth risking to make a note
read slightly better.
