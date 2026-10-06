// Row copy for the shells picker, lifted from apps/hub/src/routes/Ops.tsx's
// ShellsSection (:668-762) so the strings live somewhere a test can pin them
// without rendering. Ops has its own port of that section; this is the
// terminal's copy of the FORMATTERS only, deliberately not an import — that
// file belongs to another task and is still in flight.
import { ApplyError, GateNotWiredError } from '../lib/api';
import { relTime } from '../shared/time';
import type { TmuxPastSession, TmuxSession } from '../lib/types';

/** `[name · ][host · ]attached|detached · {n}w · {rel}[ · protected]` */
export function shellMeta(
  session: TmuxSession,
  multiHost: boolean,
  hostLabel: (id: string) => string,
  now = Date.now(),
): string {
  const name = session.title ? `${session.name} · ` : '';
  const host = multiHost ? `${hostLabel(session.host)} · ` : '';
  const state = session.attached ? 'attached' : 'detached';
  const guard = session.protected ? ' · protected' : '';
  return `${name}${host}${state} · ${session.windows}w · ${relTime(session.created, now)}${guard}`;
}

/** `{rel}[ · {cwd}][ · running]` */
export function pastSessionMeta(session: TmuxPastSession, now = Date.now()): string {
  const cwd = session.cwd ? ` · ${session.cwd}` : '';
  const live = session.live ? ' · running' : '';
  return `${relTime(session.last_active, now)}${cwd}${live}`;
}

/** A sleeping laptop is a ROW STATE, not an error: hub-tmuxd reports the
 * host `ok:false` and the VPS list renders unchanged beside it. */
export function unreachableHostLine(label: string, error: string | null): string {
  return `${label} unreachable — ${error ?? 'no response'}. Asleep?`;
}

/** hub-tmuxd returns the attach command; the client fallback is the local
 * form (Ops.tsx:553,597). */
export function attachSnippet(attach: string | undefined, name: string): string {
  return attach ?? `tmux switch-client -t ${name}`;
}

/** Inline message for a failed write; null = silent (user cancelled Face ID). */
export function writeErrorMessage(err: unknown): string | null {
  if (err instanceof ApplyError || err instanceof GateNotWiredError) {
    return err.code === 'cancelled' ? null : err.message;
  }
  return err instanceof Error ? err.message : 'Write failed.';
}
