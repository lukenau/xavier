// Unit tests for the runtime server-URL setting's pure logic:
// validateServerUrl (the Save button's gate) and testServerConnection (the
// Test button's /api/healthz probe). Following the plain-logic test style of
// connectors.test.ts / routing.test.ts — no RN, no component mounting.
import { SERVER_TEST_TIMEOUT_MS, testServerConnection, validateServerUrl } from './serverUrl';

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.resetAllMocks();
  jest.useRealTimers();
});

describe('validateServerUrl: what Save accepts', () => {
  it('accepts a plain https URL and strips the trailing slash', () => {
    expect(validateServerUrl('https://hub.example.com/')).toEqual({
      ok: true,
      url: 'https://hub.example.com',
    });
  });

  it('accepts https with a port and a path, preserving both', () => {
    expect(validateServerUrl('https://hub.example.com:8443/hub')).toEqual({
      ok: true,
      url: 'https://hub.example.com:8443/hub',
    });
  });

  it('trims surrounding whitespace before anything else', () => {
    expect(validateServerUrl('  https://hub.example.com  ')).toEqual({
      ok: true,
      url: 'https://hub.example.com',
    });
  });

  it('is case-insensitive on the scheme but leaves the host as typed', () => {
    expect(validateServerUrl('HTTPS://Hub.Example.com')).toEqual({
      ok: true,
      url: 'https://Hub.Example.com',
    });
  });

  it('accepts http:// for localhost — with a port', () => {
    expect(validateServerUrl('http://localhost:8080')).toEqual({
      ok: true,
      url: 'http://localhost:8080',
    });
  });

  it('accepts http:// for 127.0.0.1', () => {
    expect(validateServerUrl('http://127.0.0.1:3000/')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:3000',
    });
  });

  it('accepts http:// for localhost in any case', () => {
    expect(validateServerUrl('http://LOCALHOST')).toEqual({ ok: true, url: 'http://LOCALHOST' });
  });
});

describe('validateServerUrl: what Save rejects', () => {
  it('rejects http:// to any non-loopback host, with the rule in the message', () => {
    const check = validateServerUrl('http://hub.example.com');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(/localhost or 127\.0\.0\.1/);
  });

  it('rejects http:// to a LAN IP the same way', () => {
    expect(validateServerUrl('http://192.168.1.10').ok).toBe(false);
  });

  it('rejects a lookalike host that merely contains localhost', () => {
    expect(validateServerUrl('http://localhost.evil.com').ok).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    const check = validateServerUrl('ftp://hub.example.com');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(/https/);
  });

  it('rejects javascript: URLs (no // shape at all)', () => {
    expect(validateServerUrl('javascript:alert(1)').ok).toBe(false);
  });

  it('rejects a bare hostname with no scheme', () => {
    expect(validateServerUrl('hub.example.com').ok).toBe(false);
  });

  it('rejects the empty string and whitespace', () => {
    expect(validateServerUrl('').ok).toBe(false);
    expect(validateServerUrl('   ').ok).toBe(false);
  });

  it('rejects a scheme with no host', () => {
    expect(validateServerUrl('https://').ok).toBe(false);
  });

  it('rejects an embedded space in the host', () => {
    expect(validateServerUrl('https://hub example.com').ok).toBe(false);
  });
});

describe('testServerConnection (the Test button)', () => {
  function jsonResponse(status: number): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as Response;
  }

  it('GETs /api/healthz on the given base and reports success with the status', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200));
    await expect(testServerConnection('https://hub.example.com')).resolves.toEqual({
      ok: true,
      status: 200,
    });
    expect(global.fetch).toHaveBeenCalledWith('https://hub.example.com/api/healthz', {
      signal: expect.any(AbortSignal),
    });
  });

  it('reports a non-2xx as its reason rather than throwing', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(502));
    await expect(testServerConnection('https://hub.example.com')).resolves.toEqual({
      ok: false,
      reason: 'the server answered HTTP 502',
    });
  });

  it('reports a network failure via the error message, never a throw', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network request failed'));
    await expect(testServerConnection('https://hub.example.com')).resolves.toEqual({
      ok: false,
      reason: 'Network request failed',
    });
  });

  it('survives a non-Error rejection (string throw)', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce('boom');
    await expect(testServerConnection('https://hub.example.com')).resolves.toEqual({
      ok: false,
      reason: 'the request could not be made',
    });
  });

  it('reports a timeout as its own reason, not a raw abort error', async () => {
    jest.useFakeTimers();
    // The real fetch rejects with an AbortError when its signal aborts, and
    // that rejection is what drives testServerConnection's timeout branch. A
    // mock that rejects on its own separate timer instead (ignoring the
    // signal) never settles once fake timers stop at the abort, so the whole
    // point of the test hangs. Reject on the signal, like fetch does.
    (global.fetch as jest.Mock).mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    );
    const pending = testServerConnection('https://hub.example.com', SERVER_TEST_TIMEOUT_MS);
    jest.advanceTimersByTime(SERVER_TEST_TIMEOUT_MS + 1);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'no response within 8s' });
  });
});
