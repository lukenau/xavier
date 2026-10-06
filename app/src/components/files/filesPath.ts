// Pure path/format helpers for the Files browser, ported verbatim from
// `apps/hub/src/routes/Files.tsx` (joinPath/parentPath/formatSize/
// formatMtime/Breadcrumb's segment math) so they're unit-testable without a
// query client or any native module.

export function joinPath(path: string, name: string): string {
  return path ? `${path}/${name}` : name;
}

export function parentPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `Files.tsx:29-36` — relative age from an epoch-SECONDS mtime, `now` injectable for tests. */
export function formatMtime(epoch: number | null, now: number = Date.now()): string {
  if (!epoch) return '';
  const delta = now / 1000 - epoch;
  if (delta < 60) return `${Math.round(delta)}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

export interface BreadcrumbSegment {
  /** Cumulative path up to and including this segment — tap target. */
  path: string;
  label: string;
  /** The last segment (== current path) is non-interactive in the PWA. */
  isLast: boolean;
}

/** `Breadcrumb`'s `segments.map` (`Files.tsx:105-125`): root label first (path ''), then one entry per `/`-separated segment. */
export function breadcrumbSegments(path: string): BreadcrumbSegment[] {
  if (!path) return [];
  const parts = path.split('/');
  return parts.map((seg, i) => ({
    path: parts.slice(0, i + 1).join('/'),
    label: seg,
    isLast: i === parts.length - 1,
  }));
}

/**
 * `FilePreview`'s error copy (`Files.tsx:80-85`): branches on the ApiError
 * message CONTAINING the literal substring '415' or '413'. Per
 * docs/inventory/terminal.md §7.3's open question, the server's actual
 * detail strings ("binary file — preview unsupported", "file larger than
 * 262144 bytes") never contain those digits, so this branch is structurally
 * unreachable and the raw server string is what a user sees — reproduced
 * here bug-for-bug rather than silently fixed, per the task brief.
 */
export function filePreviewErrorCopy(message: string): string {
  if (message.includes('415')) return 'Binary file — preview unsupported';
  if (message.includes('413')) return 'File too large to preview (>256 KB)';
  return message;
}

/**
 * `Files.tsx:168` `useState<string>('code')`. `src/lib/api.ts` has no mock
 * mode (it always talks to the live hub-api), so the live root id is the
 * only default that exists — there is no second, mock-server spelling to
 * reconcile it with.
 */
export const DEFAULT_ROOT_ID = 'code';
