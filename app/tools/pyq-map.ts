/**
 * Working JSON in, syllabus slugs out — one question at a time, by a human.
 *
 * The other half of `src/lib/pyq-section-guess.ts`. That file is the pure
 * proposer and holds the matching rules; this one holds the filesystem, the
 * terminal and the session, and it exists separately so the rules stay
 * testable without either.
 *
 * ## Why the work is split in two steps
 *
 * Mapping a question to one of 438 syllabus leaves takes about a minute of
 * scrolling and second-guessing, and a hundred-question paper is therefore an
 * evening that does not get started. The split is what makes it ten seconds:
 *
 *   1. A machine proposes SECTIONS — 86 candidates, keyword-scored, wrong
 *      about a quarter of the time and legibly wrong when it is.
 *   2. A human confirms one, and then picks a leaf from inside it: three to
 *      thirteen candidates rather than four hundred and thirty-eight.
 *
 * Step 1 is safe to mechanise because a section is where the value is. Every
 * consumer of `syllabusSlug` — `coverageBySection`, the refill aim, MCQ
 * eligibility, every mentor prescription built on those — groups at
 * `(paper, topic)`. Exactly one screen reads the leaf.
 *
 * ## What this tool refuses to do
 *
 * **It never accepts a proposal by itself.** Not when there is one candidate,
 * not when the score is 100, not on a bare Enter — Enter does nothing here, on
 * purpose, because Enter is what a tired hand presses. The proposer is a
 * shortlist. A person is the decision, every time.
 *
 * **It never invents a slug.** Every value written comes out of `SYLLABUS_V1`
 * and is checked against it again before the file is saved. A slug that is not
 * in the syllabus is not a typo, it is a row the seeder will never match and
 * the app will never show.
 *
 * ## Why SKIP is a first-class answer
 *
 * `s` maps to null and moves on, and that is a pressure valve rather than a
 * convenience. After the third hour everything starts to look like Modern
 * Indian History, and a forced guess at that point is worse than a null: an
 * unmapped question still drills, it simply does not aim, whereas a mis-mapped
 * one silently poisons `mcqWeakTopics` and everything downstream of it, and
 * nothing can later tell it from a good row. Skipping must therefore cost no
 * more than choosing, which is why both are one key.
 *
 * A skip is recorded as a DECISION in the sidecar, not as an absence. Otherwise
 * a resumed session re-asks every question the last one deliberately declined,
 * and the twentieth time it does that the answer stops being considered.
 *
 * ## Crash safety
 *
 * Both files are rewritten, atomically, after every single answer. Losing an
 * hour of mapping to a crash is not an inconvenience, it is the last time
 * anybody does this job.
 *
 * ## Usage
 *
 *   npx tsx tools/pyq-map.ts working/2023-a.json
 *   npx tsx tools/pyq-map.ts working/2023-a.json --papers gs1,gs2,gs3,anthro_p2
 *
 * Reads the working file `pyq-extract.ts` writes (a `PyqSet` under `set`, or a
 * bare one at the root) and writes it back in place with `syllabusSlug` filled
 * in. Progress lives beside it in `<file>.pyq-map.json`.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface, emitKeypressEvents } from 'node:readline';

import { SYLLABUS_V1 } from '@/data/syllabus-v1';
import {
  isPyqExam,
  pyqExamSpec,
  pyqExternalId,
  type PyqBooklet,
  type PyqExam,
} from '@/data/pyq/types';
import {
  DEFAULT_PROPOSAL_LIMIT,
  leavesOfSection,
  proposeSections,
  searchSections,
  sectionsOf,
  type SectionGuessEntry,
  type SectionProposal,
} from '@/lib/pyq-section-guess';

/* ------------------------------------------------------------------- shapes */

/**
 * The working file, loosely.
 *
 * Deliberately not typed as `PyqSet`. The document is parsed, MUTATED and
 * written back rather than reconstructed, because `pyq-extract.ts` wraps the
 * set in provenance — source PDFs, their SHA-256s, its own warnings — and
 * rebuilding the file from a narrow type would silently throw all of that away.
 * The only field this tool assigns is `syllabusSlug`.
 */
interface LooseQuestion {
  number?: unknown;
  stem?: unknown;
  promptText?: unknown;
  options?: unknown;
  syllabusSlug?: unknown;
}

interface LooseSet {
  exam?: unknown;
  year?: unknown;
  booklet?: unknown;
  mcqs?: unknown;
  written?: unknown;
}

/** One question as this tool works with it, plus where to write the answer back. */
interface Question {
  /** The permanent external id. The sidecar's key — see `pyqExternalId`. */
  id: string;
  number: number;
  /** `mcqs` or `written`, for the header line only. */
  form: 'mcq' | 'written';
  text: string;
  options: readonly string[];
  /** The object inside the parsed document. Assigning to it edits the file. */
  target: LooseQuestion;
}

type Decision =
  | { action: 'mapped'; slug: string; section: string; at: string }
  | { action: 'skipped'; slug: null; section: null; at: string };

interface Progress {
  version: 1;
  /** Keyed by external id, so a renumbered array cannot shift a decision. */
  decisions: Record<string, Decision>;
}

/* --------------------------------------------------------------- constants */

/**
 * Papers a Prelims GS booklet can draw on.
 *
 * `pyqExamSpec('prelims-gs1').paper` is null, and `data/pyq/types.ts` says why:
 * the booklet mixes GS1, GS2 and GS3 and is not any one of them. So the null is
 * expanded to exactly those three rather than to everything. Leaving Essay and
 * the two Anthropology papers out of the candidate set is not tidiness — a
 * Prelims question tagged to an Anthropology leaf lands in her OPTIONAL's
 * coverage, which is a separate body of work with a separate plan.
 *
 * `--papers` overrides this when a paper genuinely reaches outside the default.
 */
const PRELIMS_PAPERS = ['gs1', 'gs2', 'gs3'] as const;

/** Terminal width to wrap at. Narrow enough for a split screen beside the PDF. */
const WRAP = 78;

/* ----------------------------------------------------------------- printing */

function wrap(text: string, indent = 0): string {
  const pad = ' '.repeat(indent);
  const width = Math.max(20, WRAP - indent);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(pad + line);
      line = word;
    }
  }
  if (line !== '') lines.push(pad + line);
  return lines.join('\n');
}

function out(text = ''): void {
  process.stdout.write(`${text}\n`);
}

/* ------------------------------------------------------------------- files */

/**
 * Write via a temporary file and rename.
 *
 * `writeFileSync` truncates before it writes, so a crash inside it leaves a
 * zero-length working file where an evening of mapping used to be. A rename
 * within the same directory is atomic on every filesystem this runs on, so the
 * file on disk is always either the previous answer or this one.
 */
function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, 'utf8');
  try {
    renameSync(temporary, path);
  } catch (error) {
    // Leaving a stray .tmp behind after a failed rename would be read as a
    // half-written file by the next person to look in the directory.
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function progressPathFor(workingPath: string): string {
  return `${workingPath}.pyq-map.json`;
}

function readProgress(path: string): Progress {
  if (!existsSync(path)) return { version: 1, decisions: {} };
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${path} is not a progress file`);
  }
  const decisions = (parsed as { decisions?: unknown }).decisions;
  if (typeof decisions !== 'object' || decisions === null) {
    throw new Error(`${path} has no decisions`);
  }
  return { version: 1, decisions: decisions as Record<string, Decision> };
}

/* -------------------------------------------------------------- the working set */

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asOptions(value: unknown): string[] {
  return Array.isArray(value) ? value.map((option) => asString(option)) : [];
}

/**
 * Find the `PyqSet` in the parsed document.
 *
 * `pyq-extract.ts` nests it under `set` beside the source hashes; a
 * hand-assembled file may be a bare set. Both are accepted, and anything else
 * is refused rather than guessed at — the alternative is mapping an empty list
 * of questions and reporting "0 of 0 mapped" as a success.
 */
function locateSet(document: unknown): LooseSet {
  if (typeof document !== 'object' || document === null) {
    throw new Error('working file is not a JSON object');
  }
  const nested = (document as { set?: unknown }).set;
  const candidate = (typeof nested === 'object' && nested !== null ? nested : document) as LooseSet;
  if (!Array.isArray(candidate.mcqs) && !Array.isArray(candidate.written)) {
    throw new Error('working file has neither an `mcqs` nor a `written` array');
  }
  return candidate;
}

function collectQuestions(set: LooseSet, exam: PyqExam, year: number, booklet: PyqBooklet): Question[] {
  const questions: Question[] = [];

  const push = (raw: unknown, form: 'mcq' | 'written'): void => {
    if (typeof raw !== 'object' || raw === null) return;
    const question = raw as LooseQuestion;
    const number = typeof question.number === 'number' ? question.number : NaN;
    if (!Number.isInteger(number)) return;
    const text = form === 'mcq' ? asString(question.stem) : asString(question.promptText);
    questions.push({
      id: pyqExternalId(exam, year, booklet, number),
      number,
      form,
      text,
      options: form === 'mcq' ? asOptions(question.options) : [],
      target: question,
    });
  };

  if (Array.isArray(set.mcqs)) for (const raw of set.mcqs) push(raw, 'mcq');
  if (Array.isArray(set.written)) for (const raw of set.written) push(raw, 'written');
  return questions;
}

/* ------------------------------------------------------------------- input */

/**
 * One keystroke, or one typed line when a line is what was asked for.
 *
 * Raw mode is what makes `s` cost exactly as much as `1`. Without it every
 * answer is a keystroke plus Enter, and over a hundred questions the difference
 * between skipping and guessing stops being nothing.
 *
 * When stdin is not a TTY — piped input, a CI run — it falls back to reading
 * lines, so the tool is still driveable by a script rather than simply hanging.
 */
class Input {
  private readonly tty: boolean;
  /**
   * The piped-input reader, created ONCE.
   *
   * A fresh `createInterface` per keystroke reads a chunk of stdin and discards
   * whatever it had buffered when it closes, so the second key of a piped
   * session disappears. One long-lived interface with a queue in front of it is
   * the only arrangement that reads a script through to the end.
   */
  private readonly reader: ReturnType<typeof createInterface> | null = null;
  private readonly pending: string[] = [];
  private readonly waiting: ((line: string | null) => void)[] = [];
  private ended = false;

  constructor() {
    this.tty = process.stdin.isTTY === true;
    if (this.tty) {
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      return;
    }
    this.reader = createInterface({ input: process.stdin, terminal: false });
    this.reader.on('line', (line: string) => {
      const waiter = this.waiting.shift();
      if (waiter === undefined) this.pending.push(line);
      else waiter(line);
    });
    this.reader.on('close', () => {
      this.ended = true;
      while (this.waiting.length > 0) this.waiting.shift()?.(null);
    });
  }

  /** Restore the terminal. Must run even on a throw, or the shell is left raw. */
  close(): void {
    if (this.tty) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    this.reader?.close();
  }

  /** Null at end of input. */
  private nextLine(): Promise<string | null> {
    const buffered = this.pending.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async key(): Promise<string> {
    if (!this.tty) {
      const line = await this.nextLine();
      // Exhausted piped input means the driving script is finished. Quitting is
      // the safe reading of that: every answer is already on disk, and the
      // alternative is a loop that reprompts forever against a closed stdin.
      if (line === null) return 'q';
      return line.trim().slice(0, 1);
    }
    return new Promise((resolve) => {
      const onKeypress = (
        _string: string,
        info: { name?: string; sequence?: string; ctrl?: boolean },
      ): void => {
        process.stdin.off('keypress', onKeypress);
        // Ctrl-C in raw mode does not raise SIGINT, so it has to be honoured
        // here or the only way out of the tool is another terminal.
        if (info.ctrl === true && info.name === 'c') {
          this.close();
          process.exit(130);
        }
        resolve(info.name === 'return' || info.name === 'enter' ? '\r' : (info.sequence ?? ''));
      };
      process.stdin.on('keypress', onKeypress);
    });
  }

  /** A whole typed line, for a search term. Raw mode is lifted for the duration. */
  async line(prompt: string): Promise<string> {
    if (!this.tty) {
      process.stdout.write(prompt);
      return (await this.nextLine()) ?? '';
    }
    process.stdin.setRawMode(false);
    try {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      const answer = await new Promise<string>((resolve) => {
        rl.question(prompt, (value) => resolve(value));
      });
      rl.close();
      return answer;
    } finally {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
  }
}

/* ------------------------------------------------------------------ session */

interface Session {
  workingPath: string;
  progressPath: string;
  document: unknown;
  progress: Progress;
  questions: Question[];
  entries: readonly SectionGuessEntry[];
  /** Every slug the syllabus defines. The gate on what may be written. */
  validSlugs: ReadonlySet<string>;
}

/**
 * Persist one answer.
 *
 * The working file and the sidecar are written together and immediately, which
 * is the whole crash story: at any instant the pair on disk reflects every
 * answer given up to the last one, and never a half of one.
 */
function save(session: Session): void {
  writeAtomic(session.workingPath, `${JSON.stringify(session.document, null, 2)}\n`);
  writeAtomic(session.progressPath, `${JSON.stringify(session.progress, null, 2)}\n`);
}

function record(session: Session, question: Question, decision: Decision): void {
  if (decision.action === 'mapped' && !session.validSlugs.has(decision.slug)) {
    // Unreachable by design — every slug offered came out of `SYLLABUS_V1`.
    // Checked anyway, at the only point where a bad one could reach disk,
    // because "the app silently drops this question" is the failure it causes
    // and that one is invisible until somebody counts.
    throw new Error(`refusing to write ${JSON.stringify(decision.slug)}: not a syllabus slug`);
  }
  question.target.syllabusSlug = decision.slug;
  session.progress.decisions[question.id] = decision;
  save(session);
}

/* ----------------------------------------------------------------- coverage */

function coverageLine(session: Session): string {
  const decisions = Object.values(session.progress.decisions);
  const mapped = decisions.filter((decision) => decision.action === 'mapped');
  const skipped = decisions.length - mapped.length;
  const sections = new Set(mapped.map((decision) => decision.section));
  const total = session.questions.length;
  const left = total - decisions.length;
  return [
    `mapped ${mapped.length}/${total}`,
    `skipped ${skipped}`,
    `${sections.size} section${sections.size === 1 ? '' : 's'} covered`,
    `${left} left`,
  ].join('  |  ');
}

/* ------------------------------------------------------------------ display */

function showQuestion(question: Question, index: number, total: number): void {
  out();
  out('='.repeat(WRAP));
  out(`Q${question.number}  (${index + 1} of ${total} undecided)  ${question.id}`);
  out('-'.repeat(WRAP));
  out(wrap(question.text === '' ? '(no stem text in the working file)' : question.text));
  if (question.options.length > 0) {
    out();
    for (const [position, option] of question.options.entries()) {
      out(wrap(`(${'abcd'[position] ?? position + 1}) ${option}`, 3));
    }
  }
}

/**
 * Show the shortlist.
 *
 * The matched terms and the label that matched are printed beside every
 * proposal. That is the difference between a shortlist a person can dismiss in
 * a second and one they have to re-derive: "Freedom Struggle — matched
 * 'Non-Cooperation and Khilafat movements'" answers itself.
 */
function showProposals(proposals: readonly SectionProposal[]): void {
  out();
  if (proposals.length === 0) {
    out('  no section proposed — the stem restates no syllabus heading or bullet.');
    out('  that is a normal outcome. use / to search, or s to skip.');
    return;
  }
  for (const [position, proposal] of proposals.entries()) {
    // A search result carries no score and no matched terms — it is on the list
    // because a person typed its name, which needs no justifying.
    const scored = proposal.matched.length > 0;
    out(`  ${position + 1}) ${proposal.paper}  ${proposal.topic}${scored ? `   [${proposal.score.toFixed(0)}]` : ''}`);
    out(wrap(scored ? `via "${proposal.evidence}" — matched ${proposal.matched.join(', ')}` : proposal.evidence, 7));
  }
}

function showHelp(): void {
  out();
  out('  1-9  confirm that section, then choose a leaf inside it');
  out('  s    skip — leave this question unmapped, and say so on the record');
  out('  /    search all candidate sections by name');
  out('  u    undo the previous answer and ask it again');
  out('  q    save and quit (progress is already on disk)');
  out('  ?    this list');
}

/* -------------------------------------------------------------- the leaf step */

type LeafChoice =
  | { kind: 'slug'; slug: string }
  | { kind: 'back' }
  | { kind: 'skip' }
  | { kind: 'quit' };

/**
 * Choose a leaf inside a confirmed section, or back out.
 *
 * `s` skips from HERE too, rather than bouncing back to the section list to be
 * pressed again. Realising halfway down a leaf list that none of them is right
 * is the commonest reason to skip, and a pressure valve that costs two presses
 * at the moment it is most needed is not one.
 *
 * A section with exactly one leaf is NOT auto-selected. Skipping the keystroke
 * there would make one question in the run behave differently from all the
 * others, and the property being defended — that every stored slug is one a
 * person chose — is worth more than the keystroke.
 */
async function chooseLeaf(
  input: Input,
  entries: readonly SectionGuessEntry[],
  proposal: { key: string; paper: string; topic: string },
): Promise<LeafChoice> {
  const leaves = leavesOfSection(entries, proposal.key);
  if (leaves.length === 0) {
    out();
    out(`  ${proposal.key} has no leaves in this candidate set. going back.`);
    return { kind: 'back' };
  }

  for (;;) {
    out();
    out(`  ${proposal.paper}  ${proposal.topic}  — ${leaves.length} leaves`);
    for (const [position, leaf] of leaves.entries()) {
      out(wrap(`${position + 1}) ${leaf.subtopic ?? leaf.topic}`, 4));
    }
    out();
    process.stdout.write('  leaf [1-9 / b back / s skip / q quit] > ');

    const key = await input.key();
    out(key === '\r' ? '' : key);

    if (key === 'b') return { kind: 'back' };
    if (key === 's') return { kind: 'skip' };
    if (key === 'q') return { kind: 'quit' };
    const position = Number.parseInt(key, 10);
    if (Number.isInteger(position) && position >= 1 && position <= leaves.length) {
      return { kind: 'slug', slug: leaves[position - 1].slug };
    }
    // Anything else, Enter included, falls through and asks again. A bare Enter
    // must never mean "the first one".
    out('  not a leaf on the list.');
  }
}

/* ------------------------------------------------------------- the main loop */

type Answer =
  | { kind: 'decided'; decision: Decision }
  | { kind: 'undo' }
  | { kind: 'quit' };

/**
 * A skip is a recorded decision, not an absence.
 *
 * Written to the sidecar exactly as a mapping is, so a resumed session does not
 * re-ask what the last one deliberately declined. The twentieth time a tool
 * re-asks a question somebody already answered, the answer stops being
 * considered — and this one's whole value is that it was.
 */
function skip(): Decision {
  return { action: 'skipped', slug: null, section: null, at: new Date().toISOString() };
}

async function askQuestion(
  input: Input,
  session: Session,
  question: Question,
  index: number,
  total: number,
): Promise<Answer> {
  let shortlist = proposeSections(question.text, session.entries, DEFAULT_PROPOSAL_LIMIT);
  showQuestion(question, index, total);

  for (;;) {
    showProposals(shortlist);
    out();
    out(`  ${coverageLine(session)}`);
    process.stdout.write('  section [1-9 / s skip / / search / u undo / q quit / ?] > ');

    const key = await input.key();
    out(key === '\r' ? '' : key);

    if (key === 'q') return { kind: 'quit' };
    if (key === 'u') return { kind: 'undo' };
    if (key === '?') {
      showHelp();
      continue;
    }
    if (key === 's') return { kind: 'decided', decision: skip() };
    if (key === '/') {
      const query = await input.line('  search sections > ');
      const found = searchSections(session.entries, query);
      if (found.length === 0) {
        out(`  nothing matches ${JSON.stringify(query.trim())}.`);
        continue;
      }
      // Search results REPLACE the shortlist, so the number keys keep meaning
      // what is on screen. Two numbering schemes on one prompt is how the wrong
      // section gets confirmed at eleven at night.
      shortlist = found.slice(0, 9).map((section) => ({
        key: section.key,
        paper: section.paper,
        topic: section.topic,
        score: 0,
        evidence: `search: ${query.trim()}`,
        matched: [],
        support: 0,
      }));
      continue;
    }

    const position = Number.parseInt(key, 10);
    if (!Number.isInteger(position) || position < 1 || position > shortlist.length) {
      out('  not an option on the list. ? for help.');
      continue;
    }

    const chosen = shortlist[position - 1];
    const leaf = await chooseLeaf(input, session.entries, chosen);
    if (leaf.kind === 'back') continue;
    if (leaf.kind === 'quit') return { kind: 'quit' };
    if (leaf.kind === 'skip') {
      return { kind: 'decided', decision: skip() };
    }
    return {
      kind: 'decided',
      decision: {
        action: 'mapped',
        slug: leaf.slug,
        section: chosen.key,
        at: new Date().toISOString(),
      },
    };
  }
}

/* -------------------------------------------------------------------- entry */

interface Args {
  workingPath: string;
  papers: string[] | null;
}

function parseArgs(argv: readonly string[]): Args {
  let workingPath: string | null = null;
  let papers: string[] | null = null;

  for (let position = 0; position < argv.length; position += 1) {
    const token = argv[position];
    if (token === '--papers') {
      const value = argv[position + 1];
      if (value === undefined) throw new Error('--papers needs a comma-separated list');
      papers = value.split(',').map((paper) => paper.trim()).filter((paper) => paper !== '');
      position += 1;
    } else if (token.startsWith('--')) {
      throw new Error(`unknown option ${JSON.stringify(token)}`);
    } else if (workingPath === null) {
      workingPath = token;
    } else {
      throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    }
  }

  if (workingPath === null) throw new Error('usage: pyq-map.ts <working.json> [--papers gs1,gs2]');
  return { workingPath, papers };
}

/**
 * The candidate papers, and therefore the entire universe of what may be
 * proposed or searched. Narrowing it is the cheapest precision this tool has.
 */
function candidatePapers(exam: PyqExam, override: string[] | null): string[] {
  if (override !== null) return override;
  const paper = pyqExamSpec(exam).paper;
  return paper === null ? [...PRELIMS_PAPERS] : [paper];
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!existsSync(args.workingPath)) {
    throw new Error(`${args.workingPath} does not exist`);
  }

  const document: unknown = JSON.parse(readFileSync(args.workingPath, 'utf8'));
  const set = locateSet(document);

  if (!isPyqExam(set.exam)) {
    throw new Error(`working file's exam ${JSON.stringify(set.exam)} is not a known exam`);
  }
  if (typeof set.year !== 'number' || !Number.isInteger(set.year)) {
    throw new Error('working file has no integer `year`');
  }
  if (typeof set.booklet !== 'string') {
    throw new Error('working file has no `booklet`');
  }

  const papers = candidatePapers(set.exam, args.papers);
  const entries = SYLLABUS_V1.entries.filter((entry) => papers.includes(entry.paper));
  if (entries.length === 0) {
    throw new Error(`no syllabus entries for papers ${papers.join(', ')}`);
  }

  const session: Session = {
    workingPath: args.workingPath,
    progressPath: progressPathFor(args.workingPath),
    document,
    progress: readProgress(progressPathFor(args.workingPath)),
    questions: collectQuestions(set, set.exam, set.year, set.booklet as PyqBooklet),
    entries,
    validSlugs: new Set(SYLLABUS_V1.entries.map((entry) => entry.slug)),
  };

  out();
  out(`${args.workingPath} — ${pyqExamSpec(set.exam).label} ${set.year}, booklet ${set.booklet}`);
  out(`${session.questions.length} questions  |  candidate papers: ${papers.join(', ')}  |  ${sectionsOf(entries).length} sections, ${entries.length} leaves`);
  out(`progress: ${session.progressPath}`);
  out(`${coverageLine(session)}`);
  showHelp();

  const input = new Input();
  try {
    for (;;) {
      // Recomputed each pass rather than iterated, so an undo can put a
      // question back into the queue simply by deleting its decision.
      const pending = session.questions.filter(
        (question) => session.progress.decisions[question.id] === undefined,
      );
      if (pending.length === 0) break;

      const answer = await askQuestion(input, session, pending[0], 0, pending.length);
      if (answer.kind === 'quit') break;
      if (answer.kind === 'undo') {
        const previous = [...session.questions]
          .reverse()
          .find((question) => session.progress.decisions[question.id] !== undefined);
        if (previous === undefined) {
          out('  nothing to undo.');
          continue;
        }
        delete session.progress.decisions[previous.id];
        previous.target.syllabusSlug = null;
        save(session);
        out(`  undid Q${previous.number}. it is back in the queue.`);
        continue;
      }
      record(session, pending[0], answer.decision);
    }
  } finally {
    input.close();
  }

  out();
  out('-'.repeat(WRAP));
  out(coverageLine(session));
  const mapped = Object.values(session.progress.decisions).filter((d) => d.action === 'mapped');
  const bySection = new Map<string, number>();
  for (const decision of mapped) {
    bySection.set(decision.section, (bySection.get(decision.section) ?? 0) + 1);
  }
  for (const [key, count] of [...bySection].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    out(`  ${String(count).padStart(3)}  ${key}`);
  }
  out();
  out(`wrote ${args.workingPath}`);
  return 0;
}

function main(argv: readonly string[]): Promise<number> {
  return run(argv).catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  });
}

/*
 * `process.argv[1]` rather than `import.meta` or `require.main`: the tests
 * compile as CommonJS and the tool runs under tsx, and this is the one check
 * that means the same thing in both.
 */
if (process.argv[1] !== undefined && /pyq-map\.[cm]?[tj]s$/.test(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
