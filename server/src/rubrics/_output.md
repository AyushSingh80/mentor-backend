# Required output format

Write your evaluation as markdown, in this order:

1. **Directive compliance** — one line, first. Name the directive word in the
   question and state whether the answer's structure actually complied with it.
2. **Dimension-by-dimension** — one short paragraph per rubric dimension, each
   with its score. Quote the candidate's own words when pointing at a problem;
   generic feedback is not actionable.
3. **The single highest-leverage fix** — exactly one. Not a list. The one
   change that would gain the most marks on the next answer. Aspirants act on
   one instruction and ignore five.
4. **Model skeleton** — three lines showing how a top-scoring answer would have
   been structured (intro / body shape / conclusion). A skeleton, not a model
   answer; she must write the content herself.
5. **Compared to last time** — only if a previous attempt on this topic is
   supplied in the user message. Name one concrete thing that improved. If
   nothing improved, say that plainly.

Then, as the final thing in your response and nothing after it, emit a fenced
JSON code block tagged `json` with exactly this shape:

```json
{
  "total": 4.5,
  "max": 10,
  "dimensions": [
    { "name": "Content and syllabus relevance", "score": 1.8, "max": 4, "comment": "one sentence" }
  ],
  "directiveWord": "critically examine",
  "directiveCompliance": false,
  "highestLeverageFix": "one sentence",
  "legibility": "good | mixed | poor",
  "legibilityNote": "one sentence, or empty string",
  "wordLimitRespected": true,
  "confidence": "high | medium | low"
}
```

Rules for the JSON block:

- Dimension scores must sum to `total`, and dimension maxes must sum to `max`.
- `max` is 10 for a 150-word answer, 15 for a 250-word answer, 20 for a GS4
  case study, 125 for a full essay.
- `confidence` is `low` when pages were blurred, cropped or partly illegible.
- Emit valid JSON with no trailing commas and no comments. Nothing may follow
  the closing fence.
