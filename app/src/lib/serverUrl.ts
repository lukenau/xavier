// Pure logic behind the runtime server-URL setting: validation
// (ServerPage.tsx's Save button) and the one-shot /api/healthz probe (its Test
// button). No React Native imports — this file is unit-tested directly, in
// the node environment, the same way connectors.ts and routing.ts are.
//
// The rule set is deliberately narrow because this URL is where the app
// points EVERYTHING — enrolment codes, session cookies, the terminal
// websocket. https:// is accepted for any host; http:// is accepted only for
// localhost / 127.0.0.1, so a self-hoster can still point one build at a hub
// running on his own machine without the app ever shipping credentials in
// the clear to a remote box.

export interface ValidServerUrl {
  ok: true;
  /** Normalized base: trimmed, lowercase scheme, no trailing slash. */
  url: string;
}

export interface InvalidServerUrl {
  ok: false;
  /** The inline message ServerPage renders — a reason, not a restatement. */
  error: string;
}

export type ServerUrlCheck = ValidServerUrl | InvalidServerUrl;

/** scheme://host(/path) with no spaces, no query, no fragment. The host part
 * is hand-rolled rather than `new URL(...)` for the same reason
 * connectors.ts's hostnameOf is: RN's URL polyfill throws on some strings the
 * browser accepts, so validation must not depend on it. */
const URL_SHAPE = /^([a-zA-Z][\w+.-]*):\/\/([^/?#\s]+)([^#\s]*)$/;

/** The two hosts http:// is explicitly allowed for. Exact matches —
 * `localhost.evil.com` is neither. A port rides along (localhost:8080). */
function isLoopbackHost(hostWithPort: string): boolean {
  const host = hostWithPort.split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1';
}

export function validateServerUrl(input: string): ServerUrlCheck {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: 'Enter a server URL, e.g. https://hub.example.com.' };
  }
  const match = URL_SHAPE.exec(trimmed);
  if (!match) {
    return { ok: false, error: 'Enter a full URL starting with https:// (or http:// for localhost).' };
  }
  const scheme = match[1].toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') {
    return { ok: false, error: `“${scheme}://” is not supported — use an https:// URL.` };
  }
  if (scheme === 'http' && !isLoopbackHost(match[2])) {
    return {
      ok: false,
      error: 'http:// is only allowed for localhost or 127.0.0.1 — use https:// for any other server.',
    };
  }
  // A trailing slash would make every call a double-slash path
  // (https://x//api/health) and fail against servers that 404 on it.
  const path = (match[3] ?? '').replace(/\/+$/, '');
  return { ok: true, url: `${scheme}://${match[2]}${path}` };
}

export interface ServerTestOk {
  ok: true;
  status: number;
}

export interface ServerTestFail {
  ok: false;
  /** What went wrong: an HTTP status, the network error's message, or a
   * timeout — never a thrown error crossing back into the UI. */
  reason: string;
}

export type ServerTestResult = ServerTestOk | ServerTestFail;

export const SERVER_TEST_TIMEOUT_MS = 8000;

/** One GET to the server's /api/healthz, resolved (never thrown) so the
 * button can always render an outcome. */
export async function testServerConnection(
  base: string,
  timeoutMs: number = SERVER_TEST_TIMEOUT_MS,
): Promise<ServerTestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/healthz`, { signal: controller.signal });
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, reason: `the server answered HTTP ${res.status}` };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, reason: `no response within ${Math.round(timeoutMs / 1000)}s` };
    }
    return { ok: false, reason: err instanceof Error ? err.message : 'the request could not be made' };
  } finally {
    clearTimeout(timer);
  }
}
