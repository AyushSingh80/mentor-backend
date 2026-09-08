/**
 * The offline queue.
 *
 * `answers.imagePaths` stores a JSON array of URIs and nothing else — no
 * names, no mime types, no sizes. That is the whole state a retry has to work
 * from, so this module reconstructs the upload from the paths alone (which is
 * why `scan.ts` copies every captured page into `<documents>/answers/` under a
 * name that keeps its extension: the extension is the only surviving record of
 * what the file is).
 *
 * The one rule that matters here: a retry must never upload a subset. Pages are
 * scans of a handwritten answer; three of five pages is not "most of the
 * answer", it is a different, worse answer, and the model would score it as
 * such and store that score in the trend with no indication anything was
 * missing. So every file is checked for existence before anything is uploaded,
 * and a single missing page fails the retry loudly.
 */

import { File as FsFile } from 'expo-file-system';
import { getAnswerDetail, pendingAnswers, PAPERS, type PaperValue } from '@/db/answers';
import {
  evaluateExistingAnswer,
  type PendingItem,
  type RunEvaluationCallbacks,
} from '@/lib/evaluation';
import { nameFromUri, resolveType, validateSelection, type CapturedFile } from '@/lib/scan-rules';

/**
 * A corrupt `imagePaths` column must degrade to "no pages", never throw: it is
 * read once per row while rendering the queue, and one bad row must not blank
 * the whole screen.
 */
function parseImagePaths(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  } catch {
    return [];
  }
}

function toPaperValue(raw: string): PaperValue | null {
  return PAPERS.find((paper) => paper.value === raw)?.value ?? null;
}

/** Answers captured but not yet evaluated — pending, queued or failed. */
export async function listPending(): Promise<PendingItem[]> {
  const rows = await pendingAnswers();

  return rows.map((row) => ({
    answerId: row.id,
    paper: row.paper,
    questionText: row.questionText,
    createdAt: row.createdAt,
    syncStatus: row.syncStatus,
    pageCount: parseImagePaths(row.imagePaths).length,
  }));
}

interface PageInspection {
  pages: CapturedFile[];
  missing: string[];
}

/**
 * Rebuilds the upload from stored URIs, verifying each file is still on disk.
 *
 * `File.exists` is a synchronous native read; a URI the filesystem cannot even
 * parse throws rather than returning false, and for this purpose that is the
 * same answer.
 */
function inspectPages(uris: string[]): PageInspection {
  const pages: CapturedFile[] = [];
  const missing: string[] = [];

  uris.forEach((uri, index) => {
    const name = nameFromUri(uri, 'jpg', Date.now() + index);

    let file: FsFile;
    try {
      file = new FsFile(uri);
      if (!file.exists) {
        missing.push(name);
        return;
      }
    } catch {
      missing.push(name);
      return;
    }

    let sizeBytes: number | undefined;
    try {
      sizeBytes = file.size ?? undefined;
    } catch {
      sizeBytes = undefined;
    }

    pages.push({
      uri,
      name,
      // The mime type is recoverable only from the extension; the picker's
      // declared type was never persisted.
      type: resolveType(undefined, name),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    });
  });

  return { pages, missing };
}

function describeMissing(missing: string[], total: number): string {
  const named = missing.slice(0, 3).join(', ');
  const rest = missing.length > 3 ? `, and ${missing.length - 3} more` : '';
  return (
    `${missing.length} of ${total} pages are no longer on this device (${named}${rest}). ` +
    'Recapture this answer — uploading the remaining pages would have it scored as if ' +
    'the missing ones were never written.'
  );
}

/**
 * Re-runs a stored answer through the evaluator.
 *
 * Reuses the answer row rather than creating a second one, so the History entry
 * the user has been looking at is the one that becomes evaluated. Never
 * rejects: like `runEvaluation`, every failure path reports through `onFailed`.
 */
export async function retryAnswer(
  answerId: number,
  callbacks: RunEvaluationCallbacks,
): Promise<void> {
  let detail: Awaited<ReturnType<typeof getAnswerDetail>>;
  try {
    detail = await getAnswerDetail(answerId);
  } catch (error) {
    callbacks.onPhase?.('failed');
    callbacks.onFailed?.(
      `Could not read that answer from this device: ${
        error instanceof Error ? error.message : String(error)
      }`,
      answerId,
    );
    return;
  }

  if (!detail) {
    callbacks.onPhase?.('failed');
    callbacks.onFailed?.('That answer is no longer on this device.', answerId);
    return;
  }

  const { answer } = detail;

  const paper = toPaperValue(answer.paper);
  if (paper === null) {
    callbacks.onPhase?.('failed');
    callbacks.onFailed?.(`"${answer.paper}" is not a paper this app can evaluate.`, answerId);
    return;
  }

  const uris = parseImagePaths(answer.imagePaths);
  if (uris.length === 0) {
    callbacks.onPhase?.('failed');
    callbacks.onFailed?.('That answer has no saved pages to upload.', answerId);
    return;
  }

  const { pages, missing } = inspectPages(uris);
  if (missing.length > 0) {
    callbacks.onPhase?.('failed');
    callbacks.onFailed?.(describeMissing(missing, uris.length), answerId);
    return;
  }

  // The same client-side mirror of the server's limits the capture screen
  // applies, so a retry fails legibly here rather than as an opaque 400 after
  // a slow upload.
  const validation = validateSelection(pages);
  if (!validation.ok) {
    callbacks.onPhase?.('failed');
    callbacks.onFailed?.(validation.reason ?? 'Those pages cannot be uploaded.', answerId);
    return;
  }

  await evaluateExistingAnswer(
    {
      answerId,
      paper,
      question: answer.questionText,
      ...(answer.directiveWord === null ? {} : { directiveWord: answer.directiveWord }),
      wordLimit: answer.wordLimit,
      pages,
    },
    callbacks,
  );
}
