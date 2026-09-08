import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Imports the pure rules, not `scan.ts` — that file pulls in native Expo
// modules which cannot load under Node.
import {
  ACCEPTED_TYPES,
  describeSelection,
  LIMITS,
  resolveType,
  validateSelection,
  type CapturedFile,
} from '../src/lib/scan-rules';

const page = (over: Partial<CapturedFile> = {}): CapturedFile => ({
  uri: 'file:///cache/page-1.jpg',
  name: 'page-1.jpg',
  type: 'image/jpeg',
  sizeBytes: 1_000_000,
  ...over,
});

describe('validateSelection', () => {
  it('accepts a normal multi-page answer', () => {
    assert.deepEqual(validateSelection([page(), page(), page()]), { ok: true });
  });

  it('accepts a scanned PDF', () => {
    const result = validateSelection([
      page({ name: 'answer.pdf', type: 'application/pdf', sizeBytes: 2_000_000 }),
    ]);
    assert.equal(result.ok, true);
  });

  it('rejects an empty selection', () => {
    const result = validateSelection([]);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /at least one file/i);
  });

  it('rejects more pages than the server accepts', () => {
    const files = Array.from({ length: LIMITS.maxFiles + 1 }, () => page());
    const result = validateSelection(files);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /at most 12 files/i);
  });

  it('rejects an unsupported file type', () => {
    const result = validateSelection([page({ name: 'notes.docx', type: 'application/msword' })]);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /not a supported file type/i);
  });

  it('rejects a single oversized page', () => {
    const result = validateSelection([page({ sizeBytes: LIMITS.maxFileBytes + 1 })]);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /larger than 8MB/i);
  });

  it('rejects a selection that is individually fine but too large in total', () => {
    // Four 7MB pages: each under the per-file cap, 28MB over the 25MB total.
    const files = Array.from({ length: 4 }, () => page({ sizeBytes: 7 * 1024 * 1024 }));
    const result = validateSelection(files);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /25MB in total/i);
  });

  it('does not reject pages whose size the picker did not report', () => {
    // Android camera captures often omit fileSize; an unknown size must not
    // block submission — the server enforces the real limit anyway.
    const result = validateSelection([page({ sizeBytes: undefined })]);
    assert.equal(result.ok, true);
  });
});

describe('resolveType', () => {
  it('resolves a PDF the picker reported no mime type for', () => {
    // Real on several Android file providers: `getDocumentAsync` returns an
    // asset with `mimeType: undefined`. Falling through to the declared value
    // would send 'application/octet-stream', which the server rejects outright,
    // so a perfectly good scan would fail upload for a metadata gap.
    assert.equal(resolveType(undefined, 'answer.pdf'), 'application/pdf');
  });

  it('resolves an uppercase extension', () => {
    // Scanner apps that write ANSWER.PDF are common enough to matter, and the
    // extension lookup table is lowercase.
    assert.equal(resolveType(undefined, 'ANSWER.PDF'), 'application/pdf');
  });

  it('prefers the extension over a declared type the server would reject', () => {
    // Android content providers routinely declare the generic binary type for
    // files they cannot sniff. The extension is the better evidence.
    assert.equal(resolveType('application/octet-stream', 'page-3.jpg'), 'image/jpeg');
  });

  it('gives an unknown extension no accepted type', () => {
    const resolved = resolveType(undefined, 'notes.docx');
    assert.equal(resolved, 'application/octet-stream');
    // The point of the assertion above: whatever it resolves to must not
    // sneak past the allow-list and fail late at the server instead.
    assert.equal((ACCEPTED_TYPES as readonly string[]).includes(resolved), false);
    assert.equal(validateSelection([page({ name: 'notes.docx', type: resolved })]).ok, false);
  });

  it('resolves nothing usable from a name with no extension at all', () => {
    assert.equal(resolveType(undefined, 'scan'), 'application/octet-stream');
  });
});

describe('describeSelection', () => {
  it('counts files, never pages', () => {
    // A four-sheet scanned PDF is ONE file against the twelve. Wording this as
    // pages would misreport the remaining budget by the page count of every
    // scan, and push her to split PDFs she never needed to split.
    const text = describeSelection([
      page({ name: 'answer.pdf', type: 'application/pdf', sizeBytes: 2 * 1024 * 1024 }),
    ]);
    assert.equal(text, '1 of 12 files · 2.0 MB of 25 MB');
    assert.doesNotMatch(text, /page/i);
  });

  it('reports an empty selection without dividing by zero', () => {
    assert.equal(describeSelection([]), '0 of 12 files · 0.0 MB of 25 MB');
  });

  it('ignores sizes the picker did not report rather than showing NaN', () => {
    const text = describeSelection([page({ sizeBytes: undefined }), page({ sizeBytes: 1_048_576 })]);
    assert.equal(text, '2 of 12 files · 1.0 MB of 25 MB');
  });
});
