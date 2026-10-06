// Getting a picture into a message: from the photo library, the Files app, or
// the clipboard.
//
// the user asked for the + button and for pasting pictures (2026-09-23), then for
// files (2026-10-01). Every one of them rides the same route — uploaded to the
// thread, held as an id, sent with the next message — and that route
// (/api/chat/threads/{id}/media) stores pictures only: JPEG, PNG, GIF and WebP,
// anything else is refused with a 422. So the Files app offers only those
// types, and anything else that reaches upload() is turned away here, with a
// message that says why, instead of after a round trip that cannot succeed.
//
// The pieces that decide anything live here rather than in the composer, so
// they can be tested without a camera roll: what the server will take, how big
// is too big, and what to say when a picture or file cannot be used.
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { api } from '../lib/api';

/** hub-api stores at most this per attachment (chat/platform.py
 * MAX_MEDIA_DECODED_BYTES is 7,000,000). This used to say 8 MiB, which is OVER
 * it: a 7.5 MB picture got through the check here and was refused by the
 * server, with nothing more useful to say than "couldn't attach that one". */
export const MAX_BYTES = 7_000_000;
/** The media route's whole allowlist (chat/routes.py MediaUploadRequest.mime). */
export const ACCEPTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
/** Enough for a screenshot to stay readable, small enough to send on LTE. */
const QUALITY = 0.7;

export interface PendingImage {
  id: string;
  uri: string;
  mime: string;
  bytes: number;
  /** Set for a file, which keeps the name it came with. A picture has none. */
  name?: string;
}

export function tooBig(bytes: number): boolean {
  return bytes > MAX_BYTES;
}

export function isImageMime(mime: string): boolean {
  return ACCEPTED.includes(mime);
}

/** base64 has no length header, so this is the decoded size of a data string —
 * checked before the upload rather than after it. */
export function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function mimeOf(asset: { mimeType?: string | null; uri?: string }): string {
  const given = (asset.mimeType || '').toLowerCase();
  if (ACCEPTED.includes(given)) return given;
  const ext = (asset.uri || '').split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

const FILE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,95}$/;

/** A file's declared type, or the one that claims nothing. hub-api refuses
 * anything that is not type/subtype, so a picker that hands back garbage gets
 * a file that opens as bytes rather than an upload that fails. */
export function fileMimeOf(asset: { mimeType?: string | null }): string {
  const given = (asset.mimeType || '').trim().toLowerCase();
  return FILE_MIME.test(given) ? given : 'application/octet-stream';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export type AttachOutcome =
  | { ok: true; images: PendingImage[] }
  | { ok: false; reason: 'cancelled' | 'denied' | 'empty' | 'too_big' | 'unsupported' | 'failed' };

type Reason = Exclude<AttachOutcome, { ok: true }>['reason'];
type OneImage = { ok: true; image: PendingImage } | { ok: false; reason: Reason };

const one = (result: OneImage): AttachOutcome =>
  result.ok ? { ok: true, images: [result.image] } : result;

/** The camera roll. Permission is asked for at the moment he taps + — the one
 * time the ask makes sense — and a denial is reported rather than swallowed.
 *
 * `limit` is how many more pictures the message has room for: the gallery stays
 * open with an Add button up to that many, instead of closing on the first tap
 * (the user, 2026-10-02). */
export async function pickImage(threadId: string, limit: number): Promise<AttachOutcome> {
  try {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return { ok: false, reason: 'denied' };
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: QUALITY,
      base64: true,
      exif: false,
      allowsMultipleSelection: true,
      selectionLimit: Math.max(1, limit),
    });
    if (picked.canceled || picked.assets.length === 0) return { ok: false, reason: 'cancelled' };
    return uploadAll(threadId, picked.assets.slice(0, Math.max(1, limit)));
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Every picture he took, in the order he took them. One that cannot be used is
 * skipped rather than costing him the rest of the selection, so this is only a
 * failure when none of them got through. */
async function uploadAll(threadId: string, assets: ImagePicker.ImagePickerAsset[]): Promise<AttachOutcome> {
  const images: PendingImage[] = [];
  let reason: Reason = 'failed';
  for (const asset of assets) {
    if (!asset.base64) {
      reason = 'empty';
      continue;
    }
    const result = await upload(threadId, asset.base64, mimeOf(asset), asset.uri, asset.width, asset.height);
    if (result.ok) images.push(result.image);
    else reason = result.reason;
  }
  return images.length > 0 ? { ok: true, images } : { ok: false, reason };
}

/** A picture kept in the Files app. No permission to ask for: the system picker
 * hands over only what he chose, and it offers only the types the server
 * stores, so a PDF is greyed out rather than refused after the upload. The size
 * and type are checked from what the picker reports BEFORE the file is read,
 * so a 400 MB video is refused without being loaded into memory. */
export async function pickFile(threadId: string): Promise<AttachOutcome> {
  try {
    const picked = await DocumentPicker.getDocumentAsync({ type: ACCEPTED, copyToCacheDirectory: true, multiple: false });
    if (picked.canceled || picked.assets.length === 0) return { ok: false, reason: 'cancelled' };
    const asset = picked.assets[0];
    if (asset.size != null && tooBig(asset.size)) return { ok: false, reason: 'too_big' };
    const mime = fileMimeOf(asset);
    if (!isImageMime(mime)) return { ok: false, reason: 'unsupported' };
    const base64 = await new File(asset.uri).base64();
    return one(await upload(threadId, base64, mime, asset.uri));
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Whatever is on the clipboard, when it is a picture. Returns `empty` when it
 * is not, so the composer can fall back to pasting text. */
export async function pasteImage(threadId: string): Promise<AttachOutcome> {
  try {
    if (!(await Clipboard.hasImageAsync())) return { ok: false, reason: 'empty' };
    const image = await Clipboard.getImageAsync({ format: 'jpeg', jpegQuality: QUALITY });
    if (!image?.data) return { ok: false, reason: 'empty' };
    // getImageAsync hands back a data URL; the server wants the payload alone.
    const base64 = image.data.includes(',') ? image.data.split(',')[1] : image.data;
    return one(await upload(threadId, base64, 'image/jpeg', image.data, image.size?.width, image.size?.height));
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** An image the system paste button handed over (modules/paste-control). It
 * arrives already decoded as JPEG bytes, so it skips the clipboard read that
 * would otherwise make iOS ask permission, and joins the same upload path as
 * the picker's images. */
export async function attachPastedImage(
  threadId: string,
  image: { base64: string; mime: string; width: number; height: number },
): Promise<AttachOutcome> {
  return one(await upload(threadId, image.base64, image.mime, `data:${image.mime};base64,${image.base64}`, image.width, image.height));
}

/** A file the system paste button handed over. Same route as a picked file, and
 * for the same reason as the image: the tap on that button is the consent, so
 * the app never reads the pasteboard and iOS never asks. A file that is not a
 * picture stops in upload(), before the server sees it. */
export async function attachPastedFile(
  threadId: string,
  file: { base64: string; mime: string; name: string },
): Promise<AttachOutcome> {
  const mime = fileMimeOf({ mimeType: file.mime });
  return one(await upload(threadId, file.base64, mime, `data:${mime};base64,${file.base64}`));
}

/** The one door to the media route, so nothing reaches it that the route
 * refuses: a type outside ACCEPTED, no bytes, or too many. */
async function upload(
  threadId: string,
  base64: string,
  mime: string,
  uri: string,
  width?: number,
  height?: number,
): Promise<OneImage> {
  if (!isImageMime(mime)) return { ok: false, reason: 'unsupported' };
  const bytes = decodedBytes(base64);
  if (bytes === 0) return { ok: false, reason: 'empty' };
  if (tooBig(bytes)) return { ok: false, reason: 'too_big' };
  try {
    const { media_id } = await api.chatUploadMedia(threadId, {
      mime,
      data_b64: base64,
      width: width ?? null,
      height: height ?? null,
    });
    return { ok: true, image: { id: media_id, uri, mime, bytes } };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export const ATTACH_MESSAGE: Record<Exclude<AttachOutcome, { ok: true }>['reason'], string> = {
  cancelled: '',
  denied: 'Hub needs access to your photos — turn it on in Settings › Hub.',
  empty: 'Nothing to attach — the clipboard has no picture or file in it.',
  too_big: 'That is over 7 MB. Send a smaller one.',
  unsupported: 'Only pictures can be attached — JPEG, PNG, GIF or WebP.',
  failed: "Couldn't attach that one.",
};
