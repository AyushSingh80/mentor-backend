# Writing the questions

## The design target: elimination, not recall

A UPSC Prelims question is an instrument for converting partial knowledge into
a smaller option set. That is the skill it tests and the skill she is here to
build. A question that can only be answered by someone who already knows every
fact in it teaches nothing — she either knows it or guesses, and neither state
changes on repetition.

**Concretely: for at least one statement in the question, learning whether that
statement is true or false — either way — must rule out at least two of the
four options.** Build the option set so this holds. The server enforces it
mechanically for `foundation` and `standard` questions and drops the ones that
fail.

This is why the option sets below are the shapes they are. Options like
"1 only / 2 only / Both 1 and 2 / Neither 1 nor 2" have this property
automatically. Options like "1 only / 1 and 2 / 1 and 3 / 1, 2 and 3" do not,
because statement 1 is in every option and resolving it buys nothing.

## The two forms

### Form `statements_correct`

Stem ends with: *Which of the statements given above is/are correct?*

Worked example (2 statements):

```
stem:  Consider the following statements regarding the Finance Commission:
       1. It is constituted by the President under Article 280.
       2. Its recommendations on the distribution of taxes are binding on the
          Union Government.
       Which of the statements given above is/are correct?
statements: [ {1, "...", isTrue: true}, {2, "...", isTrue: false} ]
options:    ["1 only", "2 only", "Both 1 and 2", "Neither 1 nor 2"]
answerIndex: 0
```

Statement 1 is true and statement 2 is false, so the true set is {1}, which is
option 0. Note how resolving statement 2 alone kills two options either way.

Worked example (3 statements):

```
stem:  Consider the following statements regarding the Rajya Sabha:
       1. ...   2. ...   3. ...
       Which of the statements given above is/are correct?
statements: [ {1, true}, {2, true}, {3, false} ]
options:    ["1 and 2 only", "2 and 3 only", "3 only", "1, 2 and 3"]
answerIndex: 0
```

The true set is {1,2}, which is option 0. Resolving statement 1 either way
kills two options.

### Form `statements_incorrect`

Stem ends with: *Which of the statements given above is/are NOT correct?*

Identical mechanics with the polarity inverted: the key names the set of FALSE
statements. Use it for roughly one question in four — it forces her to read the
stem rather than pattern-match it, which is a real Prelims failure mode.

## Options

- Exactly four. Each must name a DISTINCT set of statement numbers.
- Acceptable forms: `"1 only"`, `"2 and 3 only"`, `"1, 2 and 3"`,
  `"Both 1 and 2"`, `"Neither 1 nor 2"`, `"None of the statements given above
  is correct"`.
- Never `"All of the above"`, `"None of the above"`, `"Both of the above"`.
  These are answerable by arithmetic on the other options.
- Do not write two options that name the same set in different words. "1 and 2
  only" and "Both 1 and 2" are the same option.
- **Keep the options close in length.** Do not qualify the correct option into
  accuracy while leaving the distractors terse. A conspicuously longer correct
  option is the oldest tell in multiple choice, and the server rejects a
  correct option more than 1.6x the mean length of the others. She would learn
  to pick the long one, and that reflex transfers to nothing.

## Statements and distractors

Each statement must be independently true or false, cleanly, with no "partly".
If a statement needs a qualifier to be true, rewrite it until it does not.

**Draw wrong statements from real misconceptions, not from invented nonsense.**
A distractor that no one would believe eliminates itself and wastes an option.
The useful wrong statement is the one an aspirant halfway through the syllabus
actually holds: the conflated pair of articles, the scheme attributed to the
wrong ministry, the committee whose recommendation was never implemented, the
right institution with the wrong appointing authority.

`eliminationRationale` has one entry per option, in the same order, including
the key.

- For a wrong option: name the specific misconception that leads there.
  "Wrong" is not a rationale. "Confuses Article 32 with Article 226, which is
  the High Court's writ jurisdiction and is not a fundamental right" is.
- For the key: say what makes it correct.

## Hard rules

**Time invariance.** The question must be as true in eighteen months as today.

- Never use the words *current*, *currently*, *latest*, *present*, *recent*,
  or *as of*. The server rejects on these words alone.
- Never ask who holds an office. Offices are fine and are most of the Polity
  syllabus — "The President may promulgate ordinances under Article 123" is
  timeless. Holders are not.
- Never state a count that only grows: Ramsar sites, tiger reserves, GI tags,
  World Heritage sites, districts, unicorns.
- Avoid the most recent budget or Economic Survey figures. Structural facts,
  constitutional provisions, definitions, mechanisms, historical events and
  established scientific principles are what belong here.

**No recall trivia.** Nothing whose answer is a bare date, a bare number, or a
name with no structure attached. "In which year was X established" is not a
question, it is a lookup. Ask what X does, how it is constituted, what it
cannot do, how it differs from the body it is confused with.

**A verifiability anchor per question.** Every question carries
`verifiabilityAnchor`: the specific place the fact can be checked — a
constitutional article, a named Act with its year, a named report, a standard
textbook chapter. If you cannot name where it is checkable, you do not know it
well enough to set a question on it. Write a different question.

**factKey.** A stable lowercase colon-separated identifier for the underlying
FACT, not the wording: `polity:article-368:amendment-procedure`. Two questions
about the same fact must carry the same key even when worded completely
differently, because this is what stops the bank from asking her the same thing
twelve ways over eighteen months.

## Difficulty — defined by structure, not by adjective

Do not interpret these as "easy / medium / hard". They describe what the
question requires.

- **foundation** — every statement is a core, directly-taught fact from the
  standard sources. One statement is decisively resolvable by anyone who has
  read the chapter once. Two statements, or three where one is unmistakable.
  The question is answerable by someone who knows two thirds of the material.

- **standard** — statements are core facts, but at least one turns on a
  distinction that is commonly conflated: two adjacent articles, two similar
  schemes, two bodies with overlapping mandates. Answerable by someone who has
  revised the topic properly and not by someone who has only read it.

- **challenging** — requires connecting two parts of the syllabus, or a
  second-order implication rather than a stated fact. Still checkable against a
  named source; "challenging" never means obscure, and it never means a fact so
  peripheral that knowing it has no value. If your challenging question is
  hard only because the fact is rare, it is a bad question.

## Output

Return the questions in the required JSON structure. Return only questions you
are certain of. Fewer is correct.
