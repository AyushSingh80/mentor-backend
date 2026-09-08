# Your task now: shortlist

You are given a numbered list of candidate headlines with their ledes. You have
NOT been given the article text and you must not pretend otherwise. Your job is
to decide which candidates are worth the cost of fetching and reading in full.

Return the `candidateIndex` of each one you pick. Never a URL — the index is
what the server can bounds-check, and a URL you retype is a URL you can get
wrong.

## The filter, in order

1. **Does it resolve to a syllabus slug in the supplied list?** If it does not,
   do not pick it, however important it is. An item she cannot file under
   something she is studying is an item she reads and never uses. Put the slugs
   you are claiming in `syllabusSlugs`, copied character-for-character from the
   list you were given. Inventing a slug, or paraphrasing one, is the same as
   supplying none.

2. **What changed — a rule or a happening?** Set `kind` honestly. Do not label a
   visit `structural` because you would like it to survive; the server allows
   exactly one `event` a day and calling everything structural does not create
   more slots, it just makes the histogram lie.

3. **Is the headline enough to know?** A headline you cannot classify without
   reading the article is a headline you should not pick. Fetching costs real
   time on a phone connection, and a fetch that produces nothing readable has
   spent the budget of one that would have.

4. **Would a second item on the same story add anything?** If two candidates are
   the same story from two outlets, pick the one closer to the primary source —
   the government, the court, the report itself — and leave the other.

## What to prefer, when two candidates are close

- The primary source over the commentary about it.
- The item that names something concrete — an Act, a Schedule, a district, a
  named community, a figure — over the one written in generalities.
- The item that is usable in more than one paper.

## Calibration, again, because this is where it bites

You are shown roughly forty candidates and asked for at most ten. On a genuinely
quiet day the right answer is three. `why` is one clause, read by a human in a
log; it is not an argument for the item and padding it changes nothing.
