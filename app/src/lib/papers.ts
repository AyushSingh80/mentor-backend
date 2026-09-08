/**
 * Paper and directive constants.
 *
 * Extracted out of `db/answers.ts` because that module imports `db/index`,
 * which imports `expo-sqlite` — a native module that cannot load under
 * `node --import tsx`. Any pure module doing a VALUE import of `PAPERS` from
 * the repository would take the whole test run down with a confusing native
 * error. `import type` from `@/db/*` stays fine, since types are erased.
 *
 * Rule of thumb for pure modules in this codebase: `@/lib/papers`,
 * `@/lib/schedule` and `@/lib/time` are safe value imports. `@/db/*` is
 * type-only. `@/components/*` and `@/constants/*` are never importable —
 * `constants/theme.ts` pulls in `global.css`.
 */

export const PAPERS = [
  { value: 'gs1', label: 'GS1' },
  { value: 'gs2', label: 'GS2' },
  { value: 'gs3', label: 'GS3' },
  { value: 'gs4', label: 'GS4 / Ethics' },
  { value: 'essay', label: 'Essay' },
  { value: 'anthro_p1', label: 'Anthro P1' },
  { value: 'anthro_p2', label: 'Anthro P2' },
] as const;

export type PaperValue = (typeof PAPERS)[number]['value'];

export function isPaperValue(value: unknown): value is PaperValue {
  return typeof value === 'string' && PAPERS.some((p) => p.value === value);
}

export function paperLabel(paper: string): string {
  return PAPERS.find((p) => p.value === paper)?.label ?? paper;
}

/**
 * The eight directives UPSC actually uses. Answering "critically examine" as
 * though it were "describe" is the most common and most costly Mains error,
 * which is why the directive is captured explicitly rather than inferred.
 */
export const DIRECTIVES = [
  'discuss',
  'examine',
  'critically examine',
  'elucidate',
  'comment',
  'evaluate',
  'analyse',
  'substantiate',
] as const;

export type Directive = (typeof DIRECTIVES)[number];

/** Courses that release lectures. Anthropology drips; GS is bulk-released. */
export const COURSES = [
  { value: 'gs', label: 'General Studies' },
  { value: 'anthro', label: 'Anthropology' },
] as const;

export type CourseId = (typeof COURSES)[number]['value'];

export function isCourseId(value: unknown): value is CourseId {
  return typeof value === 'string' && COURSES.some((c) => c.value === value);
}
