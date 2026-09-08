# `tools/` — Node-only scripts

These run under `tsx` on a laptop. **Nothing here may be imported by the app.**
They use `node:child_process` and `node:fs`, neither of which exists on a phone,
and they live outside `src/` so Metro never sees them.

## `pyq-extract.ts` — question paper PDF + official key PDF → working JSON

Requires poppler's `pdftotext` on `PATH` (`brew install poppler`). Set
`PDFTOTEXT=/path/to/pdftotext` to point at a different one.

```sh
npx tsx tools/pyq-extract.ts \
  --pdf papers/2023-gs1-a.pdf \
  --key papers/2023-gs1-a-key.pdf \
  --exam prelims-gs1 --year 2023 --booklet a \
  --out working/2023-a.json
```

| flag | meaning |
| --- | --- |
| `--pdf` | the question paper, one booklet |
| `--key` | **UPSC's own** answer key for *that* booklet |
| `--exam` | a `PYQ_EXAMS` slug with `form: 'mcq'` (today: `prelims-gs1`) |
| `--year` | the exam year |
| `--booklet` | `a`–`d`, lowercase. Not case-corrected — see below |
| `--out` | where the working JSON goes |

Exit codes: `0` extracted, `1` refused, `2` bad arguments.

### What it will not do

Read what is printed and refuse everything else. It never completes a stem,
never infers an answer from anything but `--key`, and never mints an external id
by hand (`pyqExternalId` does that). Output ships with `verification: null` and
every `syllabusSlug` null, because both are human acts — `planPyqImport` refuses
the whole set until a person fills `verification` in.

Every question is either extracted or recorded in `dropped` with a reason, and
`extracted + dropped === keyEntries` by construction. A silent omission would be
indistinguishable from a bug in the extractor.

It refuses outright — no output file — when:

- the key PDF yields no answers (without UPSC's key nothing can be extracted);
- the key gives one question two different answers;
- the key PDF names exactly one booklet and it is not `--booklet` (UPSC's four
  booklets have different option orders and different keys; extracting one
  against another's key produces a hundred questions that read correctly and are
  wrong);
- two questions segment to the same number, which would mint one id twice.

`--booklet A` is rejected rather than lowercased. The letter goes into the id
byte for byte, and a case fix applied in one code path and not another is how one
question ends up with two ids.

### Drop reasons

`PyqDropReason` is the app's closed union, so that is what lands in the JSON. The
specific cause is a greppable prefix on `note`:

| note prefix | `reason` |
| --- | --- |
| `map_or_diagram` | `map_or_diagram` |
| `match_the_following` | `match_the_following` |
| `table_in_stem` | `table_in_stem` |
| `more_than_four_options`, `missing_options`, `malformed_options`, `empty_stem`, `garbled_text`, `no_text_layer` | `unreadable_scan` |
| `key_absent`, `key_letter_not_printed` | `no_verified_key` |

`no_text_layer` is what an image-only scan produces, one per key entry. **There
is no OCR here and there must not be.** `withdrawn_by_upsc` is never emitted —
a withdrawal is announced separately from the paper and the key, so inferring one
would be guessing at exactly the thing the reason records.

### Known limits

- Segmentation is driven by `(a)`–`(d)` option blocks and `-layout` indentation.
  A paper whose columns `pdftotext` collapses will produce warnings and drops
  rather than wrong questions, but it will not extract well.
- `table_in_stem` is decided partly on columnar whitespace, so heavily justified
  prose can be dropped as a table. A false drop costs one glance at the paper;
  the note carries the line count that triggered it.
- `difficulty` is `'medium'` on every question. It is required by `PyqMcq` and
  the tool has no way to know it; a uniform constant asserts nothing.

## Then

`pyq-verify.ts` and `pyq-map.ts` are owned separately — see those files for their
own flags. The order is extract → verify the keys against the published key by
hand → map the syllabus slugs → paste into `src/data/pyq/dataset.ts` and bump
its `version`.

## Tests

```sh
node --import tsx --test tests/pyq-extract.test.ts
npx tsc --noEmit -p tests/tsconfig.json
```

The tests cover the pure parsers against inline fixtures. They do **not** test
`pdftotext`, and no real UPSC PDF was available when they were written — the
fixtures are hand-typed `-layout` output.
