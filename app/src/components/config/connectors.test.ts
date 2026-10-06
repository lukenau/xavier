// Connector row formatting + the device-code helpers.
import type { ConnectorProvider } from '../../lib/types';
import { connectedCount, hostnameOf, isMcpBroken, mcpStatusLabel, providerSub, usesDeviceCode } from './connectors';
import { fmtWhen, pageHref, pageSub } from './pages';

function provider(over: Partial<ConnectorProvider> = {}): ConnectorProvider {
  return {
    id: 'nous',
    name: 'Nous Portal',
    flow: 'device-code',
    connect: 'native',
    connected: false,
    credentials: [],
    connect_cmd: 'hermes auth add nous',
    ...over,
  };
}

describe('hostnameOf', () => {
  test('pulls the host out of a real verification URL', () => {
    expect(hostnameOf('https://portal.nousresearch.com/device?code=ABCD')).toBe('portal.nousresearch.com');
    expect(hostnameOf('http://localhost:8642/oauth')).toBe('localhost');
    expect(hostnameOf('https://user:pw@example.com/x')).toBe('example.com');
  });

  test('anything unparseable reads "link", never an empty label or a throw', () => {
    // RN's own URL would return '' here and can throw on some of these — the
    // PWA's browser URL throws and falls back to 'link', which is what the
    // button must say ("Open link").
    expect(hostnameOf('not a url')).toBe('link');
    expect(hostnameOf('')).toBe('link');
    expect(hostnameOf('foo#bar')).toBe('link');
    expect(hostnameOf('/relative/path')).toBe('link');
  });
});

describe('provider rows', () => {
  test('the sub-line counts credentials, singular and plural', () => {
    expect(providerSub(provider({ flow: 'api-key', credentials: [] }))).toBe('api-key · not connected');
    expect(
      providerSub(provider({ flow: 'oauth', credentials: [{ index: '0', label: null, type: 'oauth', active: true }] })),
    ).toBe('oauth · 1 credential');
    expect(
      providerSub(
        provider({
          flow: 'oauth',
          credentials: [
            { index: '0', label: null, type: 'oauth', active: true },
            { index: '1', label: null, type: 'oauth', active: false },
          ],
        }),
      ),
    ).toBe('oauth · 2 credentials');
  });

  test('QUIRK (inventory §13.7): the row branches on `flow`, never on the server\'s `connect` hint', () => {
    // OpenRouter is flow 'api-key' / connect 'api-key', and still gets the
    // read-only "via terminal" sheet — there is no key-entry form in the PWA
    // and none here. Reproduced, not fixed.
    expect(usesDeviceCode(provider({ flow: 'device-code', connect: 'terminal' }))).toBe(true);
    expect(usesDeviceCode(provider({ id: 'openrouter', flow: 'api-key', connect: 'api-key' }))).toBe(false);
    expect(usesDeviceCode(provider({ flow: 'oauth-loopback', connect: 'native' }))).toBe(false);
  });

  test('the header count is blank until the query resolves', () => {
    expect(connectedCount(undefined)).toBe('');
    expect(connectedCount([])).toBe('0/0');
    expect(connectedCount([provider({ connected: true }), provider({ id: 'x' })])).toBe('1/2');
  });
});

describe('MCP rows', () => {
  test('a broken status is the one that gets the reauth line', () => {
    for (const s of ['failed', 'auth error', 'token expired', 'EXPIRED']) expect(isMcpBroken(s)).toBe(true);
    for (const s of ['ok', 'connected', null]) expect(isMcpBroken(s)).toBe(false);
  });

  test('a null status reads "configured", not blank', () => {
    expect(mcpStatusLabel(null)).toBe('configured');
    expect(mcpStatusLabel('ok')).toBe('ok');
  });
});

describe('hosted pages', () => {
  test('the sub-line marks briefs and drops the date when there is no mtime', () => {
    const page = { slug: 'briefing-2026-09-08', title: 'Daily briefing', mtime: null, kind: 'brief' as const };
    expect(pageSub(page)).toBe('daily brief ·  · /my-pages/briefing-2026-09-08');
    expect(pageSub({ ...page, kind: 'page' })).toBe(' · /my-pages/briefing-2026-09-08');
    expect(fmtWhen(null)).toBe('');
    expect(fmtWhen(0)).toBe('');
  });

  test('mtime is SECONDS since the epoch, not milliseconds', () => {
    // The server sends os.stat().st_mtime; reading it as ms would date every
    // page to 1970.
    expect(fmtWhen(1757289600)).toBe(
      new Date(1757289600 * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' }),
    );
    expect(new Date(1757289600 * 1000).getUTCFullYear()).toBe(2025);
  });

  test('the href is the slug directory, trailing slash and all', () => {
    // Without the trailing slash the server redirects, and a redirect is one
    // more navigation for BriefWebView's policy to allow.
    expect(pageHref('briefing-2026-09-08')).toBe('/my-pages/briefing-2026-09-08/');
  });
});
