# UPSC Mentor

Offline-first Android app and backend. A personal preparation mentor for CSE
2028, built for a working aspirant on a 2:30pm–11:30pm Monday–Friday shift with
recorded GS classes and Anthropology as the optional.

Single user by design. No accounts, no Play Store, no multi-tenancy.

```
project/
├── app/          Expo (React Native + TypeScript) — the phone app
└── server/       Express 5 + Node — holds the API key, serves rubrics, caps spend
```

## Phase 0 — what is built

**App**
- Expo SDK 57, Expo Router, TypeScript
- SQLite via `expo-sqlite` + Drizzle ORM — 14 tables, migrations generated
- Onboarding that captures the shift and **previews the derived plan before
  saving**, so a wrong assumption is caught at setup rather than three weeks in
- Today screen: countdowns, today's blocks, capacity, server and spend status
- Schedule planner (`src/lib/schedule.ts`)
- Everything reads from local SQLite — the app is fully usable with no network

**Server**
- `GET  /health` — unauthenticated liveness, rubric versions, cap status
- `POST /evaluate` — scanned pages in, SSE-streamed rubric evaluation out
- `GET  /usage` — spend ledger
- `POST /rubrics/reload` — picks up rubric edits without a restart
- Bearer auth with constant-time comparison
- Spend caps: monthly USD + daily request count, enforced **before** any API
  call, with day boundaries in IST rather than UTC

**Rubrics** live in `server/src/rubrics/*.md`, versioned by content hash. Editing
one changes how answers are scored with no app rebuild. Every evaluation stores
the hash that produced it, so a jump in scores after a rubric edit is visible
rather than mysterious.

## Phase 1 — what is built

**Answer evaluation, end to end.** Scan or photograph an answer → submit →
rubric-scored feedback streams in as it is written → saved with its dimensions →
plotted on a score trend.

- **Capture** — `expo-document-picker` for scanned PDFs (the primary workflow),
  camera and gallery for single sheets. Every accepted file is copied out of the
  OS cache into the documents directory, keeping its extension: `imagePaths`
  stores URIs only, so a retried upload has to recover its MIME type from the
  path alone.
- **Streaming feedback** — tokens are buffered and flushed on a ~100ms timer;
  one `setState` per token drops frames at model speed.
- **Orchestration** — the answer row is written *before* any network call, so an
  answer captured with no signal is never lost. Completion is proven by
  observing `meta` + `scores` + `done`; a truncated stream is marked failed
  rather than saved as if complete. Connect (20s) and idle (90s) timers, since
  the evaluation request itself deliberately has no timeout.
- **Offline queue** — `pending` → `queued` → retry, with every file's existence
  verified before re-upload. Three of five pages of a handwritten answer is a
  different, worse answer, and the model would score it as one.
- **History** — score trend, paper filter, weakest-dimension card, and live
  updates via drizzle's `useLiveQuery` over the two tables an evaluation writes.
- **Detail** — ordered by what changes the next answer: directive compliance,
  then the one highest-leverage fix, then the breakdown, then the prose.

**Tests** — 159 passing (116 app, 43 server): the planner's guarantees, the SSE
parser and wire contract, spend-cap admission under concurrency, upload limits
enforced during streaming, the score mapper's edge cases, trend geometry, and a
full end-to-end run.

## Phase 2 — what is built

**Lecture backlog, syllabus coverage, and spaced revision.**

Four tabs — **Today · Revise · Write · Progress** — plus stack routes for logging
a lecture and browsing the syllabus. History moved off the tab bar (it answers
the same question Progress does) and is reached from there.

- **Backlog tracker** — hours released vs watched, current backlog, days-to-clear
  at your *actual* recent rate, and a trend chart. Per course as well as
  combined, because a blended figure hides GS exploding while Anthropology is
  current.
- **Catch-up plan** — sized from `deriveStudyBlocks`, never invented. It cannot
  propose more than the derived weekend cap and cannot touch answer-writing or
  timed-set blocks, because those minutes never enter the budget it spends from.
  `must_drop` is a real tier: sometimes the honest advice is that the backlog
  cannot be cleared.
- **Syllabus** — 438 leaves across seven papers, seeded idempotently by slug.
  Coverage per section as well as per paper, projected against 31 March 2027.
- **SM-2 revision** — daily due list, four-button grading, audit log of every
  review.

**Tests** — 378 passing (335 app, 43 server).

### The backlog rules, and why they are what they are

The rate window is **14 days and equals the alert window deliberately**. Measured
over 28, the banner could say "grown two weeks running" while the number beside
it still looked healthy, because half its window predates the slowdown. Two
figures on one card contradicting each other is worse than either being slightly
wrong.

The alert has six guards. Two are load-bearing: a 21-day history floor, and a
distinct-release-dates check so importing your course catalogue in one sitting
does not read as a collapse.

It detects a **trend, not a state**. It goes quiet once you catch up, even while
you are still hours behind — and a fortnightly course (Anthropology) can never
grow in two consecutive weeks, so it can never fire there at all. Both are
pinned by tests. That is why Progress leads with the summary and with
**required-rate vs actual-rate**, which exists from day one rather than waiting a
fortnight for a trend.

### SM-2

Wozniak's published variant, **not Anki's** — they differ on lapse handling. Ease
floored at 1.3, first two intervals fixed at 1 and 6 days (driven by
`repetitions`, which is why it is a stored column), intervals capped at 180 days.
`dueAt` is always written at start-of-day and compared by date prefix: a card
reviewed at 22:00 must be due from midnight, not from 22:00 the next evening.

## Phase 3 — what is built

**A Prelims MCQ engine that works with no signal.** Questions are generated in
batches on the server, banked locally, and drilled entirely from SQLite — the
drilling path contains no network call at any point.

- **Micro-sessions** — 10 questions, one-handed, ~12 minutes. Reveal after each
  question, no countdown, resumable within the day.
- **Timed sets** — 25 questions at UPSC pace (72 s each), reveal at the end
  only, never resumable. A set that shows the answer mid-way is not a
  measurement.
- **Negative marking**, because it is the point. Every attempt is written the
  moment it is committed, so a killed app loses nothing.
- **Dispute** — one tap on the reveal quarantines a question, voids its mark and
  reverses its schedule, all offline in one transaction.

**Tests** — 1,259 passing (806 app, 453 server).

### Why negative marking is the feature, not a detail

UPSC Prelims: +2 correct, **−2/3 wrong**, 0 for a skip. So the expected value of
answering with probability *p* is `(8/3)p − 2/3`, positive exactly when
**p > 1/4**. A blind four-way guess is precisely EV-neutral; eliminating even one
option makes guessing pay.

The trainable skill is therefore *guess if and only if you eliminated something*
— and candidates lose marks because they **believe** they eliminated when they
did not. A drill without negative marking trains the opposite habit.

So the app records three outcomes (never two — a skip is `chosenIndex IS NULL`,
enforced by a table CHECK), plus a one-tap "I'm guessing" flag, and reports
counterfactuals in marks: *"You guessed 4 times and got 1. Skipping those would
have scored 1.3 marks more."* The instrument also knows when it is broken: if
confident-bucket accuracy falls below 70%, the flag is not being used honestly
and the card shows no bucket breakdown at all rather than a flattering one with
a caveat beside it.

Two numbers that must never be confused, and a test asserts they differ: **25%**
is break-even; **33.3%** is the accuracy of a guess after eliminating one of
four — the trainable target, not the threshold.

### Quality control on generated questions

A wrong answer key does not merely fail to teach — spaced repetition drills the
falsehood to mastery, and she cannot tell. So the endpoint is **allowed to
under-deliver**, and every ambiguous case resolves toward dropping.

Free checks run before the paid one: structural validation, an **elimination
power** test (knowing one statement must rule out ≥2 options — the mechanical
expression of "a Prelims question tests elimination, not recall"), a
self-consistency recompute of the key from the model's own statement verdicts,
and prohibitions on time-varying facts. Then **blind verification**: a second
model sees stem and options only, enforced by a projection type so a future edit
cannot leak the key. It flags *ambiguous* / *time-dependent* / *disputed*
independently, and any one flag drops the question even when the answer matched.

On disagreement the question is dropped, never re-keyed — the distractor
rationales were written around the wrong key and are already incoherent.

### The offline bank

Depth is measured in **days, not rows**: "six days of runway" is actionable
while she is still on wifi; "60 questions" means nothing before a commute.
Refills fire after every drill, on foreground below three days' runway, or
manually — never as a background job, because the offline guarantee must not
depend on Android background execution.

When the bank runs low mid-commute the drill walks four tiers rather than
showing an empty screen: unseen-and-targeted, unseen-anywhere, re-drills due
today, then correct answers older than 21 days. Tiers 3 and 4 are flagged as
repeats and kept out of headline accuracy — a remembered answer is not a known
one.

Wrong answers enrol the **question** in its own SM-2 queue, never the syllabus
topic. `revision_queue` holds one row per topic, so a failing grade there would
reset the entire spaced schedule for a whole leaf over a single missed fact.

### Phase 3 findings fixed

Found the same way as Phase 4's, and after them: by writing the contract test
that had never existed. Every one passed both packages' full suites while broken.

| Severity | Defect | Fix |
|---|---|---|
| Critical | **`POST /mcq/generate` answered 400 to every refill ever attempted**, so the offline bank could never fill. The app sent `{batchSize, sections[], rationale}`; the server read `{paper, topic, difficulty, count}` | The app plans in sections and the server generates per topic — both right for their own job — so the ROUTE loops the sections and calls the existing single-topic pipeline once each, multiplexed onto one stream |
| Critical | The server sends `eliminationRationale` (one string per option); the app read `eliminationLogic` and **rejected every question that lacked it**. Fixing the 400 alone would have left the bank empty, blaming the model | The array is folded into the one block the reveal shows, labelled with its option letters |
| High | The two packages have **different difficulty vocabularies** — `foundation\|standard\|challenging` against `easy\|medium\|hard` — so every banked question fell through to `medium` and `mcq-select.ts`'s difficulty mix would have drawn from one bucket | An explicit translation, tested in both directions. Two vocabularies on purpose: one is the register a prompt writes in, the other is how hard a question is to answer |
| High | The app read the server's `generated` as "what the server actually emitted". They are different numbers and the gap is large — a run producing seventeen and delivering nine would have reported nine banked questions as seventeen | Reads `delivered`; `generated` is kept as a diagnostic |
| Medium | `usage` omitted `estCostUsd` and `model`, both of which the app reads and displays | Both sent |
| Medium | A three-minute client ceiling on a batch that now spans four to six sections, each two model calls | Raised to seven minutes, with a `progress` frame per section — emitted **before** its model calls, because a section that rejects everything it generates is silent for a minute and the idle timer cuts a silent stream |

### Token-free end-to-end

`app/tests/e2e.test.ts` spawns the real server as a child process with
`EVAL_RUNNER=fake`, posts a real multipart request, parses the response with the
app's own `SSEParser`, and maps the result through the app's own mapper into the
exact row the database expects. Everything is the production path except the
model call. No API key, no spend.

The same switch works for testing on your phone:

```bash
cd server && npm run dev:fake
```

It refuses to start with `NODE_ENV=production` — a fake evaluator serving
real-looking marks is worse than an outage, because an outage is obvious and
invented scores are trusted.

### Review findings fixed

Four specialist agents reviewed Phase 0. Everything below was a real, verified
defect, not a style opinion:

| Severity | Defect | Fix |
|---|---|---|
| Critical | `expo/fetch` rejects React Native's `{uri,name,type}` FormData shape — **every** evaluation upload threw before reaching the network | Read bytes via `expo-file-system`'s `File` and append a real `Blob` |
| Critical | "Edit schedule" was unreachable; the redirect bounced straight back to Today | Gate is first-run only; onboarding doubles as the edit route |
| Critical | Onboarding never loaded the existing profile, so saving overwrote a real schedule with form defaults | Pre-populates from the stored row |
| Critical | An unreachable server could hang onboarding forever, blocking first launch | 8s timeout; local save happens first, server check is best-effort |
| Critical | A `getProfile()` rejection stranded the app on the loading spinner with no retry | Explicit error state |
| High | Spend cap was check-then-act — concurrent requests all passed. Reproduced: 8 admitted against a cap of 5 | Atomic reserve/release, with a regression test |
| High | Multipart body fully buffered before any size check; text fields uncapped | `hono/body-limit` ahead of parsing, plus per-field ceilings |
| High | One failed ledger write poisoned the promise chain, silently stopping all future spend tracking | Chain recovers; the error still surfaces to the caller |
| High | `stripTrailingJson` backtracked from the first fence to the last, deleting real feedback in between | Locate the last fence and slice |
| Medium | SQLite `current_timestamp` (space separator) mixed with JS ISO (`T`) — byte comparison silently inverts same-day due-date checks | One JS-side format everywhere via `$defaultFn` |
| Medium | Foreign keys absent, and SQLite ignores them unless `PRAGMA foreign_keys = ON` is set per connection | 8 FKs declared, pragma set at open |
| Medium | `regenerateStudyBlocks` deleted then inserted without a transaction — a kill in between left the schedule empty | Wrapped in `db.transaction` |
| Medium | Plain `http://` server URLs accepted, exposing the bearer token | https enforced except on localhost/LAN |
| Low | Mid-stream failures billed nothing, under-counting real spend | Usage tracked from stream events as they arrive |

### Phase 2 review findings fixed

| Severity | Defect | Fix |
|---|---|---|
| Critical | **Every `db.transaction` in the app was a no-op.** The expo-sqlite driver is `"sync"` kind: it calls `transaction(tx)` without awaiting and commits on the next line, so an `async` callback committed before any statement ran and each ran as its own autocommit — no atomicity, and no rollback either, since an async function cannot throw synchronously | All five call sites (across all three phases) converted to synchronous callbacks with `.run()`/`.get()` |
| Critical | The backlog alert **could not detect the onset of a slowdown** — a `b2 <= 0` guard meant it only fired if you were already behind a fortnight ago, so 0h → 3h → 6h was silenced. Its stated division-by-zero rationale was also wrong; `grew()` multiplies | Guard removed; the history floor, minimum backlog and distinct-release-dates checks already cover what it was needed for |
| Critical | `planSeed` **lost self-assessment across a multi-hop rename chain** when a device skipped a dataset version — A→B then B→C, on a phone that never held B, tombstoned A and inserted C pristine | Rename targets resolved transitively, with a cycle guard. Mutation-verified |
| High | `daysToClear` rendered raw: "14.782608695652174 days to clear" | Rounded up, matching the sibling implementation |
| High | A failed read on the lecture screen rendered a confident **"Nothing outstanding"** — a wrong answer, stated with certainty, on the screen whose job is telling you whether you are behind | Its own error state, distinct from "empty" |
| High | Pull-to-refresh passed `() => true` as its liveness check, so a refresh could setState after unmount or lose a race with a fresher load. Inherited from the Phase 1 reference pattern and propagated to every screen | Shared `useIsMounted` hook threaded through every refresh handler |
| High | Three touch targets under 44pt, including the back control on the longest-scrolling screen | Raised, with `hitSlop` |
| Medium | The catch-up plan advised raising playback speed **across zero minutes** when the catch-up slot was empty — a lever that does nothing, presented as progress | Gated on real capacity |
| Low | Capped leech list dropped overflow silently, unlike `heldBack` | `leechesHeldBack` counter |
| Low | `revision_reviews` documented "exactly one target" but nothing enforced it | `CHECK` constraint added while no device has the table |
| Low | Unused index on `revision_queue.due_at` — the deck filters in JS and the table is capped at one row per topic | Removed |

## Phase 4 — what is built

**A daily current-affairs digest that cannot cite something it did not read.**
Six items on a weekday, eight on Saturday, ~20 minutes, tagged against the
syllabus and linked to Anthropology Paper 1 where a real Indian instance
supports it. Pulled, never pushed: a week unopened costs nothing.

- **Grounded or dropped** — every quote must be a literal substring of a page
  the server actually fetched, and every number, date and citation in a note
  must appear there too. Substring, not similarity. No model in the loop, free,
  deterministic, and it cannot be talked out of its answer.
- **Per-sentence evidence** — each sentence of a 90-word note names the quote it
  rests on, so an unattributed sentence is a structural failure rather than a
  judgement call.
- **The app owns the taxonomy.** The device ships the syllabus vocabulary on
  every request and the server may tag only from it. A slug is opaque to the
  server and it may not invent one.
- **Two keeps a day** as flashcards, which is a cap on judgement rather than on
  storage — ~700 cards over the preparation, and deciding which two of six items
  are worth carrying for eighteen months is itself the act that makes them stick.
- **Monthly compilation** — the month's items filed by syllabus section, with
  the Paper 1 / Paper 2 pairs tabled separately.

**Tests** — 1,259 passing (806 app, 453 server).

### Why the source text is never stored

The fetched article body is the only text the model may write from, and it never
leaves the server and is never persisted. `ca_items` deliberately has nowhere to
put an article body. That keeps the copyright surface to a paraphrase plus at
most three short quotes, and it keeps the device database small.

### Why a fabricated citation is the failure that matters

She reads a note saying "the Supreme Court held X in March 2026" and writes it
into a Mains answer. If the model half-remembered that case, she has put an
invented citation into a paper worth 250 marks. The evaluation rubric already
forbids inventing current affairs; grounding is the generation-side equivalent,
and a prompt instruction is not it.

### Sources, and the ones that do not exist

Verified by probing them, not by recalling them. Working RSS: PIB, RBI press
releases, Down To Earth, The Hindu (national and editorial), Indian Express
Explained. Two details are load-bearing and were found the hard way — PIB's
`&reg=` parameter is required or it 302s and silently serves **Hindi**, and Down
To Earth's old `/rss/news` path now answers `200 text/html`, so a status-only
health check passes forever while returning no feed.

PRS, the Supreme Court and the Ministry of Tribal Affairs publish **no feed at
all**. They are allowlisted as `kind: 'index'` and reported as fetch failures
rather than skipped, because a source that produced nothing must never be
indistinguishable from a quiet news day. An HTML index reader is the gap.

### SSRF defences on the fetch path

The server fetches arbitrary URLs from feeds, so: HTTPS only, no credentials in
the URL, default ports, a **registrable-domain** allowlist with an explicit
multi-label public-suffix set (naive last-two-labels maps `pib.gov.in` to
`gov.in` and admits every Government of India host), DNS resolution with every
returned address checked against private, loopback, CGNAT, link-local and
multicast ranges for v4 and v6 including `::ffff:`, NAT64 and 6to4, manual
redirect handling capped at three same-domain hops each re-checked from scratch,
content-type enforcement, and a 2 MB cap enforced **while streaming** because
`Content-Length` is a claim.

One residual risk is stated in the file rather than hidden: DNS is resolved and
then re-resolved by `fetch`, so a rebind is theoretically open. Closing it needs
a pinned-IP dispatcher. It is accepted only because rebinding requires
controlling DNS for `pib.gov.in`, `rbi.org.in` or `thehindu.com`.

### Phase 4 findings fixed

Found by integration tests written after the five build agents reported. Every
one passed both packages' full suites — 745 app and 407 server tests — while
broken, which is the point: each lives in the gap between two packages that are
never compiled together.

| Severity | Defect | Fix |
|---|---|---|
| Critical | **`POST /ca/digest` answered 400 to every request ever made.** The app sent `{vocabulary, excludeCanonicalUrls, excludeHeadlineFingerprints}`; the server read `{syllabusSlugs, sections, seenCanonicalUrls, seenFingerprints}`. Not one field name matched, so the parser took the empty-list branch and refused the body | One wire shape, pinned by `ca-request-contract.test.ts` on both sides. The server derives its allowlist from `vocabulary` and renders the labels it was already being sent |
| Critical | **Nothing ever triggered a digest.** All five screen states were reachable only through a runner no code called, so the tab rendered "No digest requested today" correctly and forever | Foreground trigger on mount and on `AppState` active, plus an explicit fetch control — the same pattern, and the same reasoning, as `drill/index.tsx` |
| High | **The server's cross-request duplicate rule never fired once.** The device sent 64-bit hashes as `seenFingerprints`; the server tested sorted word stems against that set. It failed silently in the expensive direction — a running story was re-shortlisted, re-noted (billed) and given one of six daily slots every day, after which the device discarded it on ingest | `storyFingerprint` on the device, byte-identical to the server's, pinned by a table of literals held on both sides |
| High | The allowlist would have been built from leaf slugs only — and `tagVocabulary` withholds leaves for sections she has not started, so on a **fresh install** the vocabulary is sections and nothing else and every item would have dropped as `no_syllabus_tag` | One flat allowlist holding both levels, which is how the device resolves them |
| Medium | `itemCapFor` and `digestBudget` disagreed about Sunday: one asked the server for eight items, the other told her six. Sunday already carries a timed answer set and the lecture catch-up, and is the worst day of the week to hand a bigger pile of reading | `itemCapFor` delegates to `digestBudget`. One weekend rule |
| Medium | The read-rate feedback loop was built, tested and **never connected** — a digest she had stopped finishing kept asking for the full cap | `readRate` wired through `readIngestContext`; below `readRateFloor` the cap drops by one |
| Medium | The section-diversity cap was seeded from an empty object, so it bound within a day but reset every morning — one section could take its whole weekly allowance seven days running | Weekly counts read from `ca_item_topics`, keyed the way the vocabulary names sections |
| Medium | `CA_SOURCES_FILE` defaulted to a **cwd-relative** path, which works in development and breaks on a dist-only deploy — at the first request rather than at boot | Resolved from `import.meta.url`, like the prompt files |
| Low | A non-Latin headline stripped to the empty string, making every Hindi headline "the same story" as every other — and PIB serves Hindi outright when its `reg` parameter is wrong | Identical fallback on both sides, pinned by the contract table |

### Known gaps

- No HTML index reader, so three allowlisted sources are never read.
- `db/ca.ts` has no single-item read; the detail screen looks an item's date up
  and reuses `readDigestDay`. It works and avoids a fourth row mapper.

## Phase 5 — what is built

**Essay and Ethics, drilled at a fifth of the length.** Together they are 375 of
1750 Mains marks — over a fifth — and they are the two papers where the SHAPE of
a good answer is knowable in advance, which is exactly what Phase 1's
"scan a full answer, get a score" loop cannot teach.

- **Essay outline drills**, 20 minutes: a thesis, a dimension map, an opening
  and a closing. That is thesis coherence (25%), multi-dimensional coverage
  (25%) and the opening/closing pair (20%) — **70% of the essay rubric's weight**
  at a fifth of the time cost of a full essay.
- **Ethics case drills**, scored **part by part** against the five moves the
  rubric names: keywords, stakeholders, options with honest merits AND demerits,
  a committed decision, and explicit theory anchoring.
- **A prompt bank**, generated ahead in small batches and drilled entirely
  offline. Her writing block is 8:00–10:00 on a weekday morning.
- **A material bank** — quotes, examples, thinkers, figures — filed against the
  syllabus taxonomy that already exists, and fed by Phase 4: an item she kept
  from the digest can be filed as essay material in one tap.

**Tests** — 1,420 passing (917 app, 503 server).

### Why an outline and not an essay

An essay is ninety minutes. The only uninterrupted block that long is Saturday's
timed set, which GS also needs. At one essay a week she writes about sixty before
the exam, with nothing between attempts telling her why the last one was flat.

The three rubric dimensions that carry 70% of the marks are all decidable
without writing the prose. Narrative flow and quotation are not, and that is what
the occasional Saturday full essay is for — through the Phase 1 path, unchanged.

### Why a case study is scored per part

"16 out of 20" says something went wrong. "Options 2/5, decision 4/4" says the
alternatives were straw men and the decision was fine — which is a thing she can
fix tomorrow morning. The rubric already names the five parts; scoring them
separately is just declining to throw that structure away.

### The dimension counter runs offline

Multi-dimensional coverage is the one rubric dimension a machine can check
without judgement: a lens is either named or it is not. So the outline editor
counts them locally and instantly — "3 of 7 · open: environmental, historical,
international" — with no model call and no signal.

It is a **label** parser, not a substring search. `content.includes('political')`
is true of any outline that uses the word in a sentence, and an outline that
mentions politics in passing has not worked the topic through a political lens.
Telling her she has covered ground she has not is the direction that costs marks.

### Phase 5 findings fixed

Found by writing the contract tests and the seam test BEFORE the screens, which
is the one process change this phase makes over Phases 3 and 4.

| Severity | Defect | Fix |
|---|---|---|
| Medium | The server's `MAX_PART_CHARS` (1600) was **tighter than the device's own 220-word gate** (up to 1760 characters). A part the local submit button called ready could come back as a 400, after twenty minutes of writing | Raised to 2000. The two bounds are not redundant and must not be equal: the local one shapes behaviour and explains itself in words, the server one bounds a request body, and a safety limit that fires first is a bug rather than a defence |
| Medium | The `**Ethical**:` label failed to parse — the bullet rule ate the first `*` and left `*Ethical**:`, which then failed the label match for starting with punctuation | Emphasis markers stripped BEFORE list furniture. Same ordering trap as invisible characters before whitespace in `ca-map.ts` |
| Low | `namedDimensions` returned lenses in the order written while its comment claimed declared order, so a screen listing them could reshuffle between renders | Filtered from the declared list |
| Low | `promptFingerprint`'s comment claimed it collapsed synonym rewrites. It collapses **reorderings**; catching a rewrite needs an embedding, which is a paid call to save a two-cent prompt | Comment corrected to what the code does, and both behaviours pinned |
| Low | `retryEvaluation` re-ran the submit step, re-stamping `submittedAt` and recomputing `minutesSpent` as the interval to whenever she found wifi | Marking split from submitting; a retry marks only |
| Low | `fileCaItemAsMaterial` — the Phase 4 → Phase 5 bridge — had no caller. Exactly the shape of the "nothing ever triggered a digest" defect | Wired into the current-affairs detail screen, as its own action rather than folded into Keep: keeping is capped at two a day and filing is a cheaper judgement |

## Phase 6 — what is built

**Consistency, strain, and reminders that know what they are about.** Phase 0
derived three notification times and asserted none can fire during her shift;
this phase actually schedules them, gives them real content, and adds the two
things an eighteen-month campaign needs more than a scoreboard.

- **Reminders** with built bodies — "6 due for revision · 3 unread in the
  digest" — that **decline to fire when there is nothing to say**.
- **Consistency** as a rolling rate over 28 days, with a streak alongside it.
- **Burnout detection** from work she was already doing, returning at most one
  finding and, on a normal week, none.
- **An optional check-in** for mood and energy that nothing depends on.

**Tests** — 1,492 passing (989 app, 503 server).

### Why the streak is not the headline

A conventional streak — one number, broken by one missed day — is a bad fit for
this schedule, for three specific reasons:

1. **It punishes the recoverable.** One late shift and a forty-day count reads
   as zero. The counter then says the same thing about someone who studied forty
   of the last forty-one days as about someone who has never opened the app.
   That is not a motivational quirk; it is where people quit, and she has until
   2028.
2. **It rewards the wrong act.** A chain any interaction preserves rewards
   *opening the app*. Within a fortnight the rational move is a thirty-second
   tap, and the number then measures nothing while looking like it measures
   everything.
3. **It argues against rest.** Seven days a week, on a schedule where rest is
   the scarce input, is a burnout driver sitting next to a burnout detector.

So the streak counts **study days** — a planned rest day neither breaks it nor
counts against her — and the **rate leads**: "22 of the last 28 study days"
survives a bad Tuesday where a chain does not. A broken streak is never rendered
as loss, and the longest run is kept as a record, which is the one thing a live
counter can never be.

### Why the burnout signals are passive

A detector that depends on a daily mood slider has no data exactly when it is
needed — filling in a mood slider is among the first things to go when someone
is running on empty, and a detector that stops working at the onset of the thing
it detects is worse than none, because its silence reads as reassurance.

So every signal is a by-product of work already logged: an answer written, a
question attempted, a revision reviewed, an outline submitted, a lecture
watched, a digest item opened. Mood and energy only ever *enrich* what is
already known.

The signals are about SHAPE rather than volume, because hours fall on a week she
was ill and on a week she was fine and busy:

| Signal | What it looks for |
|---|---|
| Small-hours drift | Work starting before 04:00, five days in a fortnight, on a shift that ends at 23:30 |
| Volume collapse | Down 45% against the fortnight before — a 20% dip is a normal fortnight |
| Narrowing | Eight days on one surface alone, and it names which: MCQ drilling is the easiest thing to do tired and the least like the paper that decides the result |
| Low energy | Self-reported, and only once there are four or more reports |
| Effort without absorption | Volume holding while answer scores fall |

Reported one at a time, sleep first, each with **one small thing to do**. "You
may be burning out" is not actionable and reads as an accusation.

### Phase 6 findings fixed

| Severity | Defect | Fix |
|---|---|---|
| High | The small-hours check tested `lastMinute >= (24×60+30) % 1440`, which is **30** — matching almost every day. It would have fired constantly and trained the whole feature into furniture | Her shift ends at 23:30, so a 01:40 session falls on the NEXT calendar day at minute 100 — a *small* number. Testing a late `lastMinute` looks right and is backwards: it catches a healthy 23:45 session and misses the 01:40 one |
| Medium | Notification bodies are fixed at scheduling time by a `DAILY` OS trigger, and `refreshNotifications` was only reachable from the settings screen — so the counts would go stale for anyone who never opened it | Refreshed on every open of the Today tab. The bodies are deliberately about *stock* ("6 due"), which stays true enough to act on for a day |
| Low | The Phase 0 work-hours guard was asserted only in a test, so a profile edit could derive valid times for the *old* shift and fire them during the new one | Enforced at the point of scheduling; a violation cancels everything and says so |

## Phase 7 — what is built

**The DAF, and the questions a board would ask from it.** The Detailed
Application Form is submitted with the Mains application — around August 2028 —
and the Personality Test follows in early 2029. Every line on it is fair game,
which means the questions are **knowable two years early**.

- **The form**, filled slowly over two years rather than in a hurry.
- **Question generation** from her own entries, grouped into areas and ordered
  by how likely a board is to reach them.
- **Preparation state per question** — not started, notes made, said out loud.
- **Readiness per area**, because a board opens an area and follows it down.

**Tests** — 1,583 passing (1,052 app, 531 server).

### The rule the whole phase rests on

**The server generates questions and never answers.** Nothing on it is ever
asked to state a fact about her life, her district, her university or her
employer, and the JSON Schema has no field a fact could travel in — no
`context`, no `background`, no `suggestedAnswer`. A field like that would be
filled, and once filled it would be read.

The asymmetry is the argument. A fabricated *question* costs her an hour
preparing something the board will not ask. A fabricated *fact* — "your
district, known for its silk weaving" — is repeated to a board that knows
better, in the one examination where being confidently wrong about your own home
town cannot be recovered from.

The prompt says so, and a prompt instruction is a request. So `looksLikeAnAnswer`
enforces it mechanically, with no model in the loop: appositive glosses,
superlative claims, parenthetical figures, relative clauses handing her a
number. Crude on purpose — a false positive costs one question out of eight.
It has the same relationship to this prompt that `ca/ground.ts` has to the
current-affairs one, and the `EVAL_RUNNER=fake` fixture emits one deliberately
malformed question on every run so the guard cannot rot unnoticed.

### Why this is open in 2026 and not in 2028

A form to fill in 2028 would be useful for four months and dead for two years.
What makes it worth opening now is that three of its fields are **commitments
about things she must already have done**:

- **Hobbies.** A board takes any hobby to its floor in ninety seconds. Writing
  "reading" in July 2028 because there is nothing better is a decision made
  under deadline about two years already spent — so a one-word entry is counted
  as a *gap*, not as filled.
- **Employment.** She has a job right now. What she can say about it depends on
  what she notices while doing it, not on what she reconstructs in 2028.
- **Home district.** She cannot change it and can absolutely learn it. Most
  candidates cannot name their district's main crop or its live administrative
  dispute.

### Two smaller decisions worth naming

**Flagged questions sort first, not last.** The question she flinches at is the
one to prepare, and an app that let her bury it would be helping her avoid the
interview rather than prepare for it.

**Notes count half.** Reading about an area and saying it out loud under a
board's gaze are different skills, and an interview is entirely the second — so
the ready threshold sits above 0.5 and an area of pure notes can never reach it.

### Phase 7 findings fixed

| Severity | Defect | Fix |
|---|---|---|
| High | The parenthetical-figure pattern could not match `(literacy 74%)` — `%` is not a word character and neither is `)`, so the trailing `\b` never matched. The most obvious way to write the check was the broken way | Boundary required only on the word-ish units. The unit test that caught it is now the regression test |
| Medium | A DAF value over 600 characters was capped only at the server, so a long employment description came back as a 400 naming no field | Capped at the input. A safety limit that fires before the behavioural one is a bug, not a defence — the same finding as Phase 5's `MAX_PART_CHARS`, and now asserted in both seam tests |
| Low | Four repository functions had no caller — the exact dead surface this project has spent two phases removing elsewhere | Deleted. The `batch_id` and `prompt_version` columns remain, so a purge is five lines when something needs one |

## The planner's rules

Two things are enforced in code rather than left to discipline:

1. **Energy order.** Active work — answer writing, active recall — is scheduled
   into the freshest hours. Passive lecture watching goes last. Spending a sharp
   morning on recorded lectures is the most common way a working aspirant wastes
   their best time.
2. **Active work is protected.** When a day is short, lectures get cut, never
   answer writing. That pushes the shortfall into the lecture backlog, where the
   Phase 2 tracker can see it, instead of silently eroding the habit that takes
   longest to build.

Weekend backlog catch-up is capped at 3 hours total. If it consistently
overflows, the weekday lecture pace is wrong — fix the weekday plan rather than
sacrificing both weekend days.

Derived for the reference profile (2:30pm–11:30pm Mon–Fri, wake 7:15am,
sleep 12:45am):

```
MONDAY          8:00–10:00   Answer writing & active recall
               10:15–12:15   Reading & note consolidation
               12:30–14:10   Recorded lectures

SATURDAY        8:00–10:00   Timed answer set (exam conditions)
               10:15–12:00   Anthropology depth work
               12:15–14:15   Reading & note consolidation
               14:30–16:15   Recorded lectures
               16:30–18:00   Lecture backlog catch-up (capped)

Weekdays 28.3 hrs · Weekends 18 hrs · Weekly 46.3 hrs
~1,357 hours to 31 March 2027
```

Notification times are derived and validated (a test asserts none can fire
during work hours). Actually scheduling them is Phase 6.

## Setup

### Server

```bash
cd server
npm install
cp .env.example .env      # fill in ANTHROPIC_API_KEY and APP_BEARER_TOKEN
openssl rand -hex 32      # generate the bearer token
npm run dev               # or: npm run dev:fake  (no model, no spend)
```

Deploy to any scale-to-zero host (Cloud Run, Fly.io, Railway). It idles at zero
cost between uses.

> The Anthropic key lives on the server and only on the server. Anything bundled
> into an APK can be extracted from it — this is the one unrecoverable mistake in
> this architecture.

**Verify your pricing.** The `PRICE_*` values in `.env` drive the local spend
cap. They are estimates, not billing truth. Check current Anthropic pricing and
update them, or your cap is calibrated to the wrong numbers.

### App

```bash
cd app
npm install
npm start          # then scan the QR code with Expo Go
npm test           # 17 tests
npm run typecheck
```

### Local Android builds

The toolchain is installed and the native project generates cleanly:

| Component | Version | Location |
|---|---|---|
| JDK | OpenJDK 17.0.20.1 | `/opt/homebrew/opt/openjdk@17` |
| Android cmdline-tools | latest | `/opt/homebrew/share/android-commandlinetools` |
| Platforms | android-35, android-36 | Expo 57 compiles against **36** |
| Build tools | 35.0.0, 36.0.0 | Expo's gradle plugin defaults to **35.0.0** |
| platform-tools | includes `adb` | |

`~/.zshrc` exports `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT` and puts
`adb` and `sdkmanager` on `PATH`. Open a new terminal to pick them up.

```bash
adb devices                 # confirm your phone is connected
npx expo run:android        # first run downloads Gradle + deps (~2GB, 10+ min)
```

The `android/` directory is generated by `expo prebuild` and is gitignored —
that's Expo's Continuous Native Generation model. Regenerate it any time with
`npx expo prebuild -p android --clean`; never hand-edit it.

API 37 exists but is preview-channel only and cannot be installed from the
stable channel. 36 is the latest stable (Android 16).

**Disk:** ~2 GB used so far; the first Gradle build will take several more.
Started at 18 GB free.

### Regenerating migrations

After editing `app/src/db/schema.ts`:

```bash
cd app && npx drizzle-kit generate
```

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Foundation, onboarding, schema, backend, spend caps | ✅ done |
| 1 | Scan → rubric evaluation → score trend | ✅ done |
| 2 | Lecture backlog tracker + syllabus tracker + SM-2 revision | ✅ done |
| 3 | MCQ engine + offline commute micro-sessions | ✅ done |
| 4 | Current affairs digest with syllabus tagging | ✅ done |
| 5 | Essay and Ethics drills | ✅ done |
| 6 | Notifications, streaks, burnout detection | ✅ done |
| 7 | DAF / interview profile builder | ✅ done |

Each phase is independently usable. Stopping after any of them leaves a working
app.

## Milestone definition

**By March 2027** — first full pass of GS1–4, Anthropology P1 and P2, and Essay,
with answer writing established as a daily habit. Not "complete and revised".

**April 2027 – March 2028** — revision cycles, answer volume, full-length mocks.

**April – September 2028** — final revision and exam execution.

At ~46 hrs/week the March 2027 first pass fits in roughly 1,350 available hours
with very little slack. That is why the lecture backlog tracker is Phase 2 and
not an afterthought: a two-week work crunch or one illness consumes the entire
margin, and you need to see it the week it happens. Mid-May 2027 is the honest
buffer. The only date that actually matters is Prelims 2028.
