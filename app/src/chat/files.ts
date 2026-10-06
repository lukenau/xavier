// Opening a file that is in the conversation, from either side.
//
// Receiving a file means three things the app did not need for pictures: get
// the bytes, put them on disk under their own name, and show them. Fetching and
// writing are here; showing is the preview sheet's job, with the share sheet
// still one tap away inside it (openFilePart, unchanged in behaviour).
//
// The bytes come over `fetch` with the same cookie the rest of the chat uses
// (the one hub-api's media route is gated on), not a second HTTP stack with a
// jar of its own to get wrong.
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { HUB_ORIGIN } from '../lib/api';
import type { FilePart } from './types';

export type OpenOutcome = 'opened' | 'unavailable' | 'failed';

/** A file part's bytes, written to disk. `dir` is the containing folder, which
 * the preview WebView is scoped to read. `bytes` is kept only for files small
 * enough to draw as text (see TEXT_BYTE_LIMIT); it is what lets the preview
 * show a file at all, since the Hub serves every non-image as an opaque
 * attachment rather than something a viewer can fetch by URL. */
export interface FetchedFile {
  uri: string;
  dir: string;
  name: string;
  mime?: string;
  bytes?: Uint8Array;
}

/** Above this, the preview does not try to draw the file as text — it offers
 * the share sheet instead. A log or a dump far larger than this is not useful
 * to read in a sheet anyway. */
export const TEXT_BYTE_LIMIT = 512 * 1024;

/** A name that is safe as a file name on disk. hub-api cleaned it on the way
 * in; this is the app's own guard, because the app is what writes it. */
export function safeFileName(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 120) || 'file';
}

/**
 * Get the bytes of a file part onto disk and hand back where they landed, or
 * null when there is nothing to get (no media id, a refusal, a write failure).
 * Callers decide what to say about a null; the reason is deliberately not
 * distinguished, because the app's answer is the same for all of them.
 */
export async function fetchFilePart(part: FilePart): Promise<FetchedFile | null> {
  if (!part.media_id) return null;
  try {
    const res = await fetch(`${HUB_ORIGIN}/api/chat/media/${part.media_id}`, { credentials: 'include' });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // One folder per media id, so two files called "report.pdf" cannot clobber
    // each other and the viewer still shows the real name.
    const dir = new Directory(Paths.cache, 'hub-files', part.media_id);
    dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, safeFileName(part.name));
    file.create({ overwrite: true });
    file.write(bytes);
    return {
      uri: file.uri,
      dir: dir.uri,
      name: safeFileName(part.name),
      mime: part.mime,
      bytes: bytes.length <= TEXT_BYTE_LIMIT ? bytes : undefined,
    };
  } catch {
    return null;
  }
}

/** Hand a file that is already on disk to iOS — the share sheet, from inside
 * the preview. */
export async function shareFile(part: FilePart, uri: string): Promise<OpenOutcome> {
  try {
    if (!(await Sharing.isAvailableAsync())) return 'unavailable';
    await Sharing.shareAsync(uri, { mimeType: part.mime, dialogTitle: part.name ?? 'File' });
    return 'opened';
  } catch {
    return 'failed';
  }
}

/** Fetch, write, then hand straight to the share sheet. Kept for the preview
 * sheet's Share action and for anything that just wants the old behaviour. */
export async function openFilePart(part: FilePart): Promise<OpenOutcome> {
  // A file the agent could not upload (too big, unreadable) is only a chip with
  // a path on the gateway — there are no bytes here to open.
  if (!part.media_id) return 'unavailable';
  if (!(await Sharing.isAvailableAsync())) return 'unavailable';
  const fetched = await fetchFilePart(part);
  if (!fetched) return 'failed';
  return shareFile(part, fetched.uri);
}
