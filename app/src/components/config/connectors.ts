// Pure logic behind /config/connectors (ConnectorsPage.tsx:33-39, 199-302).
import type { ConnectorProvider } from '../../lib/types';

/**
 * ConnectorsPage.tsx:33-39's `hostnameOf`, hand-rolled rather than
 * `new URL(url).hostname`: RN's URL is a partial implementation
 * (react-native/Libraries/Blob/URL.js) whose `hostname` getter is this same
 * regex, and whose CONSTRUCTOR throws on some non-URL strings — so the PWA's
 * try/catch → 'link' fallback would fire in a different set of cases than in
 * a browser. This is the browser's behaviour for both halves: a real host, or
 * 'link'.
 */
export function hostnameOf(url: string): string {
  const match = /^[a-zA-Z][\w+.-]*:\/\/(?:[^@/]*@)?([^:/?#]+)/.exec(url);
  return match ? match[1] : 'link';
}

/** A `{connected}/{total}` count, blank until the query resolves. */
export function connectedCount<T extends { connected: boolean }>(rows: T[] | undefined): string {
  return rows ? `${rows.filter((r) => r.connected).length}/${rows.length}` : '';
}

/** `{flow} · 2 credentials` / `{flow} · not connected` (ConnectorsPage.tsx:224-228). */
export function providerSub(provider: ConnectorProvider): string {
  const n = provider.credentials.length;
  return `${provider.flow} · ${n ? `${n} credential${n === 1 ? '' : 's'}` : 'not connected'}`;
}

/**
 * QUIRK (inventory §13.7): the UI branches on `flow === 'device-code'` and
 * IGNORES the server's own per-provider `connect` hint (`native | terminal |
 * api-key`). So an api-key provider like OpenRouter gets the read-only "via
 * terminal" sheet even though the server marks it `connect: 'api-key'`, and
 * there is no key-entry form anywhere. Reproduced, not fixed.
 */
export function usesDeviceCode(provider: ConnectorProvider): boolean {
  return provider.flow === 'device-code';
}

/** An MCP row whose status reads as broken gets the reauth line
 * (ConnectorsPage.tsx:274). */
export function isMcpBroken(status: string | null): boolean {
  return /fail|error|expired/i.test(status ?? '');
}

/** `{status ?? 'configured'}` — the right-hand label on an MCP row. */
export function mcpStatusLabel(status: string | null): string {
  return status ?? 'configured';
}

/** Device-code polling interval (ConnectorsPage.tsx:84). No client-side cap:
 * expiry is the server's call, reported after ~16 min of log staleness
 * (inventory §13.9). */
export const OAUTH_POLL_MS = 3000;
/** How long the "copied" caption stays up (ConnectorsPage.tsx:98). */
export const COPIED_MS = 1400;
