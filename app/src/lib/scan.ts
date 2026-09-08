/**
 * Capture layer — turning paper into files the evaluator can read.
 *
 * Deliberately built on first-party Expo modules only. A third-party ML Kit
 * document scanner would add auto-crop and perspective correction, but it is a
 * native module with loose peer ranges, and this is the one screen used every
 * single day — a broken build here blocks the whole app. The functions below
 * are the seam: swapping in a scanner later means adding one function, not
 * touching any screen.
 *
 * The primary workflow is PDF: she scans with her phone's own scanner app and
 * picks the resulting file. Camera and gallery are there for quick single pages.
 *
 * Pure rules (limits, type resolution, validation) live in `scan-rules.ts` so
 * they remain testable — this file cannot load outside a device.
 *
 * DURABILITY. Both pickers hand back URIs inside the OS cache directory:
 * `expo-document-picker` copies there when `copyToCacheDirectory` is set, and
 * `expo-image-picker` writes camera captures and gallery exports there too.
 * Android reclaims that directory under storage pressure with no warning and no
 * callback, which would break two things weeks after the fact — the thumbnails
 * of every saved answer, and the retry of a queued upload, which would silently
 * post a truncated set of pages. So every accepted asset is copied into
 * `<documents>/answers/` before it is returned, and `CapturedFile.uri` always
 * points at that durable copy. Nothing downstream ever sees a cache path.
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { nameFromUri, resolveType, type CapturedFile } from './scan-rules';

export {
  ACCEPTED_TYPES,
  LIMITS,
  validateSelection,
  type CapturedFile,
  type ValidationResult,
} from './scan-rules';

/** Subdirectory of the document directory that holds every captured page. */
const ANSWERS_DIRECTORY = 'answers';

/**
 * Returns `<documents>/answers/`, creating it if this is the first capture.
 *
 * Resolved lazily rather than at module scope: `Paths.document` reads a native
 * constant, and doing that at import time would make merely importing this
 * module fail outside a device.
 */
function answersDirectory(): Directory {
  const directory = new Directory(Paths.document, ANSWERS_DIRECTORY);
  if (!directory.exists) {
    // `idempotent` covers the race where two pickers resolve at once; without
    // it the loser throws "directory already exists" and drops good pages.
    directory.create({ intermediates: true, idempotent: true });
  }
  return directory;
}

/**
 * Monotonic within the process, so two pages captured in the same millisecond
 * cannot land on the same destination path.
 */
let sequence = 0;

/**
 * Builds a collision-proof filename that keeps the original extension.
 *
 * The extension is load-bearing rather than cosmetic. Only the page URIs are
 * persisted (`answers.imagePaths` is a JSON array of URIs — no names, no mime
 * types), so when a queued answer is retried its type has to be recoverable
 * from the path alone. An extensionless durable copy would come back out of
 * `resolveType` as `application/octet-stream`, which the server rejects.
 */
function durableName(originalName: string, uri: string): string {
  const source = originalName.includes('.') ? originalName : uri;
  const extension = source.split('.').pop()?.toLowerCase() ?? '';
  const suffix = /^[a-z0-9]{1,5}$/.test(extension) ? `.${extension}` : '';
  sequence += 1;
  return `page-${Date.now()}-${sequence}${suffix}`;
}

/**
 * Copies one picked asset out of the cache and into the documents directory.
 *
 * `name` deliberately keeps the picker's original label — that is what the user
 * recognises in the page strip and what the server sees as the multipart
 * filename — while the bytes live under a generated, unique name on disk.
 *
 * A failed copy propagates. Returning the cache URI as a fallback is the one
 * thing this function exists to prevent: it would look like success today and
 * surface as a missing file weeks later, long after the cause is diagnosable.
 */
async function persist(file: CapturedFile): Promise<CapturedFile> {
  const destination = new File(answersDirectory(), durableName(file.name, file.uri));
  await new File(file.uri).copy(destination);

  // The copy is the ground truth for size, and it is worth preferring over
  // whatever the picker claimed: Android camera captures report no size at all,
  // and a document provider may report the original's size rather than the
  // cache copy's. These are the exact bytes that will be uploaded, so measuring
  // them here is what lets `validateSelection` enforce the caps up front
  // instead of the server rejecting the request after a slow upload.
  // `size` is documented as 0 for a file that cannot be read, so a zero falls
  // back rather than silently reporting an empty page.
  const copiedBytes = destination.size;

  return {
    ...file,
    uri: destination.uri,
    sizeBytes: copiedBytes > 0 ? copiedBytes : file.sizeBytes,
  };
}

/** Pick one or more scanned PDFs. The primary path. */
export async function pickPdf(): Promise<CapturedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/pdf',
    multiple: true,
    // Gives a stable file:// URI we can read bytes from. Still the cache, so
    // `persist` below is what actually makes the selection survive.
    copyToCacheDirectory: true,
  });

  if (result.canceled || !result.assets) return [];

  return Promise.all(
    result.assets.map((a) =>
      persist({
        uri: a.uri,
        name: a.name || nameFromUri(a.uri, 'pdf', Date.now()),
        type: resolveType(a.mimeType, a.name || ''),
        sizeBytes: a.size ?? undefined,
      }),
    ),
  );
}

/** Pick existing page photos from the gallery. */
export async function pickImages(): Promise<CapturedFile[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new Error('Photo library permission was declined.');

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: 'images',
    allowsMultipleSelection: true,
    // Answer sheets are text; full quality is wasted bytes on the upload.
    quality: 0.8,
  });

  if (result.canceled || !result.assets) return [];

  return Promise.all(
    result.assets.map((a) =>
      persist({
        uri: a.uri,
        name: a.fileName || nameFromUri(a.uri, 'jpg', Date.now()),
        type: resolveType(a.mimeType, a.fileName || a.uri),
        sizeBytes: a.fileSize,
      }),
    ),
  );
}

/** Photograph a single page. Called repeatedly to build up a multi-page answer. */
export async function takePhoto(): Promise<CapturedFile | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error('Camera permission was declined.');

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: 'images',
    quality: 0.8,
  });

  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  return persist({
    uri: asset.uri,
    name: asset.fileName || nameFromUri(asset.uri, 'jpg', Date.now()),
    type: resolveType(asset.mimeType, asset.fileName || asset.uri),
    sizeBytes: asset.fileSize,
  });
}
