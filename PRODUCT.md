# Product review, and the plan that follows from it

Written 2026-09-08, after seven phases, 1,619 passing tests, and a week of
device testing. The engineering is not the problem. This document is about why
it still does not feel like a product, and what to build next.

## The verdict

**You asked for a mentor. What exists is an instrument panel.**

The original brief was "a companion and mentor who could guide me throughout
the journey, help me improve myself, and evaluate my answers." Seven phases
later the app measures, records and supplies. It does not guide.

Every one of the seven cards on the Today screen reports state:

```
Your blocks today · Capacity · Server · Due to revise
Today's digest · Commute drill · Lecture backlog
```

Not one of them decides anything. A grep across the entire app for a
recommendation turns up exactly one source — `burnout.ts` — and what it produces
is a *warning*, not a study prescription.

That is the whole gap in one line. The app knows 438 syllabus leaves, that one
of them has been touched, that there are 204 days to the first-pass date and
36.3 hours a week available. It renders those as four separate numbers on four
separate cards. It never puts them together and says the obvious thing:

> *At one topic so far and 204 days left, you need 2.1 topics a day. Today,
> start Polity — Federalism, the Governor's discretionary powers, and Centre-State
> financial relations. Here is a past question on each.*

Every input for that sentence already exists in the database. Nothing computes it.

---

## Three gaps, named

### 1. Nothing tells her what to do next

"Your blocks today" is her own schedule played back to her. It is a calendar,
not a plan. The app has the coverage arithmetic (`coverageBySection`), the
capacity projection (~1,058 hrs to 2027-03-31), the deadline and the syllabus.
It has everything needed to answer *"what should I open right now"* and it
answers *"here is when you said you would study"*.

This is the single largest reason it feels like a dashboard. A dashboard tells
you the state of the engine. A mentor tells you where to fly.

### 2. Performance changes nothing

The one evaluated answer scored 45%. The three weakest rubric dimensions were
named on the History screen. Then the loop ends. No targeted practice appeared,
no topic was flagged for revisit, no drill was queued, the next answer capture
offered no reminder of what cost marks last time.

Assessment without prescription is a report card. The value of a mentor is
entirely in the arrow from *"here is what went wrong"* to *"so do this next"*,
and that arrow does not exist anywhere in the app.

### 3. There is nobody to ask

"Companion" implies you can talk to it. The only free-text input in the entire
app is the question field when capturing an answer. There is no way to ask *how
do I structure a 15-marker*, *is my optional on track*, *what did I get wrong
about federalism last month* — even though the app holds the data to answer the
last two precisely.

---

## What is genuinely good, and should not be rebuilt

Being fair about this matters, because the next stage should build on it rather
than around it.

- **The syllabus is real and complete.** 438 leaves transcribed from the
  notification, including both Anthropology papers (89 + 54). This is the
  asset everything else can hang off.
- **Current affairs is now real.** Nine live sources, honest provenance,
  publisher text never paraphrased, and quality gates that visibly work.
- **Offline-first actually works.** A failed upload kept the answer, copied the
  PDF into the app's own sandbox, and retried successfully days later.
- **The honesty discipline is unusual and valuable.** "The digest kept nothing —
  on this rule that is a normal day." "2 sources failed to fetch, so this may be
  a broken feed rather than a quiet day." Drop reasons shown in words.
  `[SAMPLE]` on every fake item. Most products would have hidden all of it.
- **Spend caps, streaks and burnout detection** are designed with more care than
  the features they protect.

None of this is wasted. It is the substrate a mentor would stand on. It is just
not, by itself, a mentor.

---

## The emptiness map

Measured from the device database, not estimated. What a real user sees today:

| Screen | State | Why |
|---|---|---|
| Today | Works, reports only | See gap 1 |
| Current affairs | **Real** — 6 items from live feeds | Just built |
| Syllabus | **Real** — 438 topics | Ships with the app |
| Write → History | Works | 1 answer evaluated |
| Revise | **Empty** | 0 revision rows — nothing has reached first pass |
| Practice (MCQ) | **7 fake questions** | Nothing real ships |
| Drills | **12 fake prompts** | Nothing real ships |
| Interview | **Empty** | 0 DAF rows, 0 questions |
| Lecture log | **Empty** | 0 lectures |

Five of nine screens are empty or fake on a fresh install. That is the other
half of "it doesn't feel like a product" — and unlike gap 1, it is a content
problem rather than a design one.

---

## The plan

Three stages. The ordering is deliberate: content first, because a mentor with
nothing to assign is still not a mentor; then the mentor layer; then
intelligence and deployment.

### Stage 8 — Fill it (removes "empty shell")

**8a. Past-year questions.** UPSC publishes every paper it has ever set, free.
Prelims GS1 with official answer keys, Mains GS1–4, Essay topics, GS4 case
studies, Anthropology P1 and P2. The schema already anticipates this:
`mcq_questions` carries `source`, `pyq_year`, `pyq_paper` and has never had a
`pyq` row written to it. Build the importer and the data format; start with two
or three recent years and scale backwards.

**8b. Real drill prompts.** Essay topics and ethics cases come from the same
past papers. No model needed.

**8c. Retention policy for scans.** ~1.5 GB/year at your target answer rate,
with no delete path anywhere in the app today. Not urgent, but it is the only
unbounded growth in the system.

### Stage 9 — The mentor layer (removes "instrument panel")

**9a. Today's decision.** One card, above everything else, that answers *what
should I do right now* — computed from coverage, capacity, days remaining and
the weakest dimension of the last evaluation. Pure function over data that
already exists; no model, no network.

**9b. Close the assessment loop.** A weak rubric dimension queues a targeted
drill. A topic that scored badly returns to the revision queue. The next answer
capture reminds her what cost marks last time.

**9c. A place to ask.** Free-text question → answered against her own data
(coverage, scores, backlog) plus the model when configured.

### Stage 10 — Intelligence and reach

**10a. Groq adapter.** Seven `messages.parse()` call sites behind runner seams
that already exist. Restores written digest notes, proper syllabus tagging,
generated MCQs, and drill marking — at zero cost on the free tier.

**10b. Deployment.** The three blockers in `DEPLOYMENT.md`: durable spend
ledger, health-check timeout versus cold start, single instance.

**10c. Answer evaluation on a real model.** Ten real evaluations to establish a
quality baseline before trusting any of it.

---

## Running it in parallel

Stages 8 and 10a touch disjoint files and can run concurrently. Stage 9 depends
on 8a for content to prescribe, so it follows.

| Track | Owns | Depends on |
|---|---|---|
| PYQ importer | `app/src/data/`, `app/src/db/mcq-*` | — |
| Groq adapter | `server/src/*/runner.ts`, `anthropic.ts` | — |
| Scan retention | `app/src/lib/scan.ts`, settings | — |
| Deployment blockers | `server/src/usage.ts`, config | — |
| Mentor layer | `app/src/lib/`, `app/src/app/(tabs)/index.tsx` | PYQ importer |

Four independent tracks, then integrate, then device-test — because device
testing is the one part that cannot be parallelised. Every serious bug this
project has produced was found by running the thing on hardware, in order,
one fix at a time.
