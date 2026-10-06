import { api, ApiError, ApplyError, GateNotWiredError, newClientMsgId } from './api';

const BASE = 'https://hub.example.com/api';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function mockFetchOnce(res: Response) {
  (global.fetch as jest.Mock).mockResolvedValueOnce(res);
}

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.resetAllMocks();
});

describe('GET reads: exact path + query', () => {
  const cases: [string, () => Promise<unknown>, string][] = [
    ['health', () => api.health(), '/health'],
    ['backups', () => api.backups(), '/backups'],
    ['myPages', () => api.myPages(), '/my-pages'],
    ['feed', () => api.feed(), '/feed'],
    ['vitals', () => api.vitals(), '/vitals'],
    ['cron', () => api.cron(), '/cron'],
    ['cronCosts', () => api.cronCosts(), '/cron/costs'],
    ['kanban', () => api.kanban(), '/kanban'],
    ['skills', () => api.skills(), '/skills'],
    ['plugins', () => api.plugins(), '/plugins'],
    ['mcp', () => api.mcp(), '/mcp'],
    ['memory', () => api.memory(), '/memory'],
    ['doctor', () => api.doctor(), '/doctor'],
    ['pairing', () => api.pairing(), '/pairing'],
    ['configFull', () => api.configFull(), '/config/full'],
    ['advisor', () => api.advisor(), '/advisor'],
    ['connectors', () => api.connectors(), '/connectors'],
    ['passkeyStatus', () => api.passkeyStatus(), '/passkey/status'],
    ['tmuxSessions', () => api.tmuxSessions(), '/tmux/sessions'],
    ['tmuxHistory', () => api.tmuxHistory(), '/tmux/history'],
    ['topicsConfig', () => api.topicsConfig(), '/config/topics'],
    ['decisions', () => api.decisions(), '/decisions'],
    ['fsRoots', () => api.fsRoots(), '/files/roots'],
    ['sessions', () => api.sessions(), '/sessions'],
    ['chatModels', () => api.chatModels(), '/chat/models'],
    ['browserSessions', () => api.browserSessions(), '/browser/sessions'],
    ['openrouterCredits', () => api.openrouterCredits(), '/cost/openrouter'],
    ['finance', () => api.finance(), '/finance'],
  ];

  it.each(cases)('%s hits GET %s', async (_name, call, path) => {
    // sessions/chatModels unwrap `{data}` — an empty object would throw on
    // `.data` access, so give every case a body shaped enough not to crash;
    // this block asserts the URL only, response-shape handling is covered
    // separately below.
    mockFetchOnce(jsonResponse({ data: [] }));
    await call();
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}${path}`, { credentials: 'include' });
  });

  it('cronLogs defaults to limit=30', async () => {
    mockFetchOnce(jsonResponse({ runs: [] }));
    await api.cronLogs();
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/cron/logs?limit=30`, { credentials: 'include' });
  });

  it('cronLogs(15) matches the Home call site exactly', async () => {
    mockFetchOnce(jsonResponse({ runs: [] }));
    await api.cronLogs(15);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/cron/logs?limit=15`, { credentials: 'include' });
  });

  it('cronLogs(10) matches the Ops call site exactly', async () => {
    mockFetchOnce(jsonResponse({ runs: [] }));
    await api.cronLogs(10);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/cron/logs?limit=10`, { credentials: 'include' });
  });

  it('spendSummary defaults to window=mtd', async () => {
    mockFetchOnce(jsonResponse({}));
    await api.spendSummary();
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/spend/summary?window=mtd`, { credentials: 'include' });
  });

  it('spendSummary(window) passes the window through verbatim', async () => {
    mockFetchOnce(jsonResponse({}));
    await api.spendSummary('today');
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/spend/summary?window=today`, { credentials: 'include' });
  });

  it('spendTimeseries defaults to window=7d', async () => {
    mockFetchOnce(jsonResponse({}));
    await api.spendTimeseries();
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/spend/timeseries?window=7d`, { credentials: 'include' });
  });

  it('sessionMessages encodes the session id into the path', async () => {
    mockFetchOnce(jsonResponse({ data: [] }));
    await api.sessionMessages('a/b c');
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/sessions/a%2Fb%20c/messages`, { credentials: 'include' });
  });

  it('connectorOauthStatus encodes the provider into the path and posts the poll token', async () => {
    mockFetchOnce(jsonResponse({}));
    await api.connectorOauthStatus('nous ai', 'tok');
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/connectors/nous%20ai/oauth-status`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poll_token: 'tok' }),
    });
  });

  it('fsBrowse encodes root and path as query params', async () => {
    mockFetchOnce(jsonResponse({}));
    await api.fsBrowse('code', '/some dir/x');
    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE}/files/browse?root=code&path=%2Fsome%20dir%2Fx`,
      { credentials: 'include' },
    );
  });

  it('fsRead encodes root and path as query params', async () => {
    mockFetchOnce(jsonResponse({}));
    await api.fsRead('hub', '/a&b');
    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE}/files/read?root=hub&path=%2Fa%26b`,
      { credentials: 'include' },
    );
  });
});

describe('response unwrapping', () => {
  it('sessions() unwraps { data }', async () => {
    const data = [{ id: '1' }];
    mockFetchOnce(jsonResponse({ data }));
    await expect(api.sessions()).resolves.toBe(data as never);
  });

  it('cronLogs() unwraps { runs }', async () => {
    const runs = [{ job_id: '1' }];
    mockFetchOnce(jsonResponse({ runs }));
    await expect(api.cronLogs(5)).resolves.toBe(runs as never);
  });

  it('chatModels() unwraps { data }', async () => {
    const data = [{ id: 'x', label: 'X' }];
    mockFetchOnce(jsonResponse({ data }));
    await expect(api.chatModels()).resolves.toBe(data as never);
  });
});

describe('null-on-error normalization', () => {
  it('browserSessions(): any ApiError hides the card', async () => {
    mockFetchOnce(jsonResponse({ detail: 'gone' }, { status: 502 }));
    await expect(api.browserSessions()).resolves.toBeNull();
  });

  it('browserSessions(): fills deploy-skew defaults on success', async () => {
    mockFetchOnce(
      jsonResponse({
        running: [{ id: 'r1', started_at: null, region: null, live_url: null }],
        recent: [{ id: 'r2', status: null, started_at: null, ended_at: null }],
        updated_at: '',
      }),
    );
    const result = await api.browserSessions();
    expect(result?.running[0]).toMatchObject({ pages: [], current_url: null });
    expect(result?.recent[0]).toMatchObject({ pages: [], duration_s: null });
  });

  it('openrouterCredits(): 404 hides the card', async () => {
    mockFetchOnce(jsonResponse({ detail: 'not plumbed' }, { status: 404 }));
    await expect(api.openrouterCredits()).resolves.toBeNull();
  });

  it('openrouterCredits(): 405 also hides the card', async () => {
    mockFetchOnce(jsonResponse({ detail: 'nope' }, { status: 405 }));
    await expect(api.openrouterCredits()).resolves.toBeNull();
  });

  it('openrouterCredits(): any other status rethrows', async () => {
    mockFetchOnce(jsonResponse({ detail: 'boom' }, { status: 500 }));
    await expect(api.openrouterCredits()).rejects.toBeInstanceOf(ApiError);
  });

  it('finance(): 404 means "not connected yet"', async () => {
    mockFetchOnce(jsonResponse({ detail: 'no snapshot' }, { status: 404 }));
    await expect(api.finance()).resolves.toBeNull();
  });

  it('finance(): any other error rethrows', async () => {
    mockFetchOnce(jsonResponse({ detail: 'boom' }, { status: 500 }));
    await expect(api.finance()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('write requests post canonical JSON', () => {
  it('connectorConnect asks for a challenge first and never starts a login without a proof', async () => {
    mockFetchOnce(jsonResponse({ challenge: 'c', rp_id: 'r', user_verification: 'required', allowed_credentials: [], timeout_ms: 60000 }));
    await expect(api.connectorConnect('nous')).rejects.toBeInstanceOf(GateNotWiredError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/connectors/nous/challenge`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('applyWrite POSTs the full WriteRequest, unmodified, to /action/challenge', async () => {
    mockFetchOnce(jsonResponse({ detail: 'boom' }, { status: 400 }));
    const request = { action: 'cron.pause' as const, job_id: 'j1' };
    await expect(api.applyWrite(request)).rejects.toBeInstanceOf(ApplyError);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/action/challenge`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request }),
    });
  });

  it('applyAdvisorPreset builds the canonical advisor.preset WriteRequest', async () => {
    mockFetchOnce(jsonResponse({ detail: 'boom' }, { status: 400 }));
    await expect(api.applyAdvisorPreset('cost')).rejects.toBeInstanceOf(ApplyError);
    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE}/action/challenge`,
      expect.objectContaining({ body: JSON.stringify({ request: { action: 'advisor.preset', preset: 'cost' } }) }),
    );
  });

  it('saveTopicRouting POSTs only {chat_id, topics, routes} to the challenge (drops pending_sync/updated_at)', async () => {
    mockFetchOnce(jsonResponse({ detail: 'boom' }, { status: 400 }));
    const config = {
      chat_id: '123',
      topics: { ops: 1 },
      routes: { 'cron-watch': 'ops' },
      pending_sync: true,
      updated_at: 'ignored',
    };
    await expect(api.saveTopicRouting(config)).rejects.toBeInstanceOf(ApplyError);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/config/topics/challenge`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { chat_id: '123', topics: { ops: 1 }, routes: { 'cron-watch': 'ops' } } }),
    });
  });

  it('answerDecision POSTs {option_key, note} to the challenge, trimming note and encoding the id', async () => {
    mockFetchOnce(jsonResponse({ detail: 'boom' }, { status: 400 }));
    await expect(api.answerDecision('dec 1', 'dismiss', '  ')).rejects.toBeInstanceOf(ApplyError);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/decisions/dec%201/challenge`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ option_key: 'dismiss', note: null }),
    });
  });

  it('answerDecision keeps a non-blank trimmed note', async () => {
    mockFetchOnce(jsonResponse({ detail: 'boom' }, { status: 400 }));
    await expect(api.answerDecision('dec1', null, '  looks fine  ')).rejects.toBeInstanceOf(ApplyError);
    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE}/decisions/dec1/challenge`,
      expect.objectContaining({ body: JSON.stringify({ option_key: null, note: 'looks fine' }) }),
    );
  });

  it('terminalUnlock POSTs an empty body to /terminal/challenge', async () => {
    mockFetchOnce(jsonResponse({ detail: 'boom' }, { status: 400 }));
    await expect(api.terminalUnlock()).rejects.toBeInstanceOf(ApplyError);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/terminal/challenge`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('terminalLogout POSTs an empty body and resolves void', async () => {
    mockFetchOnce(jsonResponse({}));
    await expect(api.terminalLogout()).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/terminal/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('chatSend POSTs {text, client_msg_id} to the encoded thread path', async () => {
    const message = { id: 'msg_1', client_msg_id: 'cid1' };
    mockFetchOnce(jsonResponse({ message, deduped: false }));
    await expect(api.chatSend('thr 1', 'hello', 'cid1')).resolves.toEqual({ message, deduped: false });
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/chat/threads/thr%201/send`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', client_msg_id: 'cid1' }),
    });
  });

  it('chatPatchThread POSTs only the fields it was given to /patch', async () => {
    const thread = { id: 'thr_1', pinned: true };
    mockFetchOnce(jsonResponse({ thread }));
    await expect(api.chatPatchThread('thr 1', { pinned: true })).resolves.toEqual({ thread });
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/chat/threads/thr%201/patch`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
  });

  it('chatStopThread POSTs to the thread it was given and escapes its id', async () => {
    mockFetchOnce(jsonResponse({ status: 'ok', thread_id: 'thr 1' }));
    await expect(api.chatStopThread('thr 1')).resolves.toEqual({ status: 'ok', thread_id: 'thr 1' });
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/chat/threads/thr%201/stop`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  });

  it('session unwraps one gateway session record', async () => {
    const session = { id: 'sess-1', model: 'claude-opus-4-6' };
    mockFetchOnce(jsonResponse({ session }));
    await expect(api.session('sess 1')).resolves.toEqual(session);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/sessions/sess%201`, { credentials: 'include' });
  });

  it('newClientMsgId: matches chat/routes.py\'s pattern and is not reused across calls', () => {
    const a = newClientMsgId();
    const b = newClientMsgId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(a).not.toBe(b);
  });

  it('enrollPasskey POSTs register/options then hits the not-wired gate seam before verify', async () => {
    mockFetchOnce(jsonResponse({ rp: {} }));
    await expect(api.enrollPasskey('Face ID')).rejects.toBeInstanceOf(GateNotWiredError);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/passkey/register/options`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Only the options call fired — createPasskey threw before /verify.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('the gate seam (requestActionAssertion has no native implementation yet)', () => {
  it('applyWrite: a successful challenge still fails past the assertion step', async () => {
    mockFetchOnce(jsonResponse({ challenge: 'c', rp_id: 'r', user_verification: 'required', allowed_credentials: [], timeout_ms: 60000 }));
    await expect(api.applyWrite({ action: 'gateway.drain' })).rejects.toBeInstanceOf(GateNotWiredError);
    // Only the challenge call fired — no /action/apply without an assertion.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('applyWrite: a challenge-step ApiError still maps through toApplyCode, never reaching the gate', async () => {
    mockFetchOnce(jsonResponse({ detail: { detail: 'no key enrolled', code: 'no_passkey' } }, { status: 400 }));
    await expect(api.applyWrite({ action: 'gateway.drain' })).rejects.toMatchObject({
      code: 'no_passkey',
      message: 'no key enrolled',
    });
  });

  it('applyWrite: a 412 challenge status maps to challenge_expired', async () => {
    mockFetchOnce(jsonResponse({ detail: 'gone' }, { status: 412 }));
    await expect(api.applyWrite({ action: 'gateway.drain' })).rejects.toMatchObject({ code: 'challenge_expired' });
  });

  it('applyWrite: a 403 challenge status maps to assertion_invalid', async () => {
    mockFetchOnce(jsonResponse({ detail: 'gone' }, { status: 403 }));
    await expect(api.applyWrite({ action: 'gateway.drain' })).rejects.toMatchObject({ code: 'assertion_invalid' });
  });

  it('applyWrite: a 502 challenge status maps to bridge_error', async () => {
    mockFetchOnce(jsonResponse({ detail: 'gone' }, { status: 502 }));
    await expect(api.applyWrite({ action: 'gateway.drain' })).rejects.toMatchObject({ code: 'bridge_error' });
  });

  it('applyWrite: a 405 challenge status maps to phase_2_pending', async () => {
    mockFetchOnce(jsonResponse({ detail: 'gone' }, { status: 405 }));
    await expect(api.applyWrite({ action: 'gateway.drain' })).rejects.toMatchObject({ code: 'phase_2_pending' });
  });

  it('applyWrite: an unrecognized challenge status maps to unknown', async () => {
    mockFetchOnce(jsonResponse({ detail: 'gone' }, { status: 418 }));
    await expect(api.applyWrite({ action: 'gateway.drain' })).rejects.toMatchObject({ code: 'unknown' });
  });

  it('applyWrite: a plain 400 with no server code maps to bad_request', async () => {
    mockFetchOnce(jsonResponse({ detail: 'validation failed' }, { status: 400 }));
    await expect(api.applyWrite({ action: 'gateway.drain' })).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('ApplyError / GateNotWiredError shape (parity with PWA webauthn.ts)', () => {
  it('ApplyError exposes both code and detail, and falls back to code for the message when detail is omitted', () => {
    const withDetail = new ApplyError('bridge_error', 'trader unreachable');
    expect(withDetail).toMatchObject({ code: 'bridge_error', detail: 'trader unreachable', message: 'trader unreachable' });

    const withoutDetail = new ApplyError('cancelled');
    expect(withoutDetail).toMatchObject({ code: 'cancelled', detail: undefined, message: 'cancelled' });
  });

  it('GateNotWiredError carries a code (default unknown) so err.code branching ports unchanged', () => {
    expect(new GateNotWiredError().code).toBe('unknown');
    expect(new GateNotWiredError('cancelled').code).toBe('cancelled');
  });
});

describe('ApiError.parseError message extraction', () => {
  it('nested object detail: message + code come from detail.detail / detail.code', async () => {
    mockFetchOnce(jsonResponse({ detail: { detail: 'bad key', code: 'no_passkey' } }, { status: 400 }));
    await expect(api.health()).rejects.toMatchObject({ status: 400, message: 'bad key', code: 'no_passkey' });
  });

  it('string detail: message is the string, no code', async () => {
    mockFetchOnce(jsonResponse({ detail: 'plain message' }, { status: 500 }));
    await expect(api.health()).rejects.toMatchObject({ status: 500, message: 'plain message', code: undefined });
  });

  it('no parseable body: message falls back to "<verb> <path> → <status>"', async () => {
    mockFetchOnce({ ok: false, status: 503, json: async () => { throw new Error('not json'); } } as unknown as Response);
    await expect(api.health()).rejects.toMatchObject({ status: 503, message: 'GET /health → 503' });
  });
});

describe('the daily brief: reads, writes, and the two failure codes', () => {
  it('brief() reads /brief, and a date is a query param not a path segment', async () => {
    mockFetchOnce(jsonResponse({ date: '2026-09-16' }));
    await api.brief();
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/brief`, { credentials: 'include' });

    mockFetchOnce(jsonResponse({ date: '2026-09-14' }));
    await api.brief('2026-09-14');
    expect(global.fetch).toHaveBeenLastCalledWith(`${BASE}/brief?date=2026-09-14`, {
      credentials: 'include',
    });
  });

  it('dismissBriefItem POSTs the exact four-field body the server model requires', async () => {
    mockFetchOnce(jsonResponse({ ok: true, item_id: 'abc123abc123', action: 'dismiss' }));
    await api.dismissBriefItem('abc123abc123', 'dismiss', 'f'.repeat(24), '2026-09-16');
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/briefing/dismiss.json`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      // BriefDismissBody is item_id/action/token/date — all four required.
      body: JSON.stringify({
        item_id: 'abc123abc123',
        action: 'dismiss',
        token: 'f'.repeat(24),
        date: '2026-09-16',
      }),
    });
  });

  it('a snooze carries its span in the action and gets `until` back', async () => {
    mockFetchOnce(
      jsonResponse({ ok: true, item_id: 'abc123abc123', action: 'snooze:3d', until: '2026-09-19T12:00:00+00:00' }),
    );
    const result = await api.dismissBriefItem('abc123abc123', 'snooze:3d', 't'.repeat(24), '2026-09-16');
    expect(result.until).toBe('2026-09-19T12:00:00+00:00');
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body).action).toBe('snooze:3d');
  });

  it('markBriefItemUseful POSTs three fields and surfaces the idempotent second tap', async () => {
    mockFetchOnce(jsonResponse({ ok: true, item_id: 'abc123abc123', signal: 'useful', already: true }));
    const result = await api.markBriefItemUseful('abc123abc123', 'u'.repeat(24), '2026-09-16');
    expect(result.already).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(`${BASE}/briefing/useful.json`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: 'abc123abc123', token: 'u'.repeat(24), date: '2026-09-16' }),
    });
  });

  it('403 (bad token) and 503 (key unprovisioned) stay DISTINCT, with their codes intact', async () => {
    // The screen restores the row with different copy for each — "this brief
    // expired" vs "dismissals are offline" — so collapsing them into one
    // generic failure would tell the user the wrong thing to do about it.
    mockFetchOnce(jsonResponse({ detail: { code: 'bad_item_token', detail: 'bad item token' } }, { status: 403 }));
    await expect(
      api.dismissBriefItem('abc123abc123', 'dismiss', 'wrong', '2026-09-16'),
    ).rejects.toMatchObject({ status: 403, code: 'bad_item_token' });

    mockFetchOnce(
      jsonResponse(
        { detail: { code: 'dismiss_key_unprovisioned', detail: 'brief dismiss key not provisioned' } },
        { status: 503 },
      ),
    );
    await expect(
      api.markBriefItemUseful('abc123abc123', 'f'.repeat(24), '2026-09-16'),
    ).rejects.toMatchObject({ status: 503, code: 'dismiss_key_unprovisioned' });
  });

  it('a brief write is NOT routed through the Face-ID gate (Ruling 57)', async () => {
    // No signer is registered in this suite, so anything going through
    // requestActionAssertion throws GateNotWiredError before it posts. These
    // reach the network instead — the per-item HMAC is the proof.
    mockFetchOnce(jsonResponse({ ok: true, item_id: 'abc123abc123', action: 'undo' }));
    await expect(
      api.dismissBriefItem('abc123abc123', 'undo', 'f'.repeat(24), '2026-09-16'),
    ).resolves.toMatchObject({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
