// The demo's server, driven through api.ts — the seam the app uses — with
// fetch() replaced by a spy that must never be called.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, ApplyError, api } from '../lib/api';
import { resetDemoModeForTests, setDemoFlag } from './mode';
import { demoPage, isDemoThreadId, resetDemoWorld, SERVER_ONLY_DETAIL } from './server';
import { localDay } from './time';

const mockAuthenticate = jest.fn();
jest.mock('@sbaiahmed1/react-native-biometrics', () => ({
  authenticateWithOptions: (...args: unknown[]) => mockAuthenticate(...args),
}));

const fetchSpy = jest.fn();

beforeEach(async () => {
  await AsyncStorage.clear();
  resetDemoModeForTests();
  resetDemoWorld();
  await setDemoFlag(true);
  fetchSpy.mockReset();
  global.fetch = fetchSpy as unknown as typeof fetch;
  mockAuthenticate.mockReset().mockResolvedValue({ success: true });
});

afterEach(() => {
  resetDemoWorld();
  resetDemoModeForTests();
});

test('reads answer from the bundled fixtures, and nothing reaches the network', async () => {
  const health = await api.health();
  const feed = await api.feed();
  const sessions = await api.sessions();
  const cron = await api.cron();
  const finance = await api.finance();
  const calendar = await api.calendar('2026-01-01', '2026-12-31');
  const boot = await api.chatBootstrap();

  expect(health).toBeTruthy();
  expect(feed.items.length).toBeGreaterThan(0);
  expect(sessions.length).toBeGreaterThan(0);
  expect(cron.jobs.length).toBeGreaterThan(0);
  expect(finance).not.toBeNull();
  expect(calendar.stale_slices).toBe(0);
  expect(boot.threads.map((t) => t.title)).toEqual(
    expect.arrayContaining(['Trip planning with Xavier', 'Widget gallery']),
  );
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('the shopping thread with its single-use card is not in the demo', async () => {
  const boot = await api.chatBootstrap();
  expect(boot.threads.some((t) => /pitcher|order/i.test(t.title ?? ''))).toBe(false);
  const all = await Promise.all(boot.threads.map((t) => api.chatThreadDetail(t.id)));
  expect(JSON.stringify(all)).not.toMatch(/single-use|pitcher/i);
});

test('dates are moved to the present: the brief is for today on this phone', async () => {
  const brief = await api.brief();
  expect(brief.date).toBe(localDay(new Date()));
  const runs = await api.cronLogs(5);
  expect(runs.length).toBeLessThanOrEqual(5);
  for (const run of runs) {
    const at = Date.parse(String(run.run_time).replace(' ', 'T') + 'Z');
    expect(at).toBeLessThanOrEqual(Date.now());
  }
});

test('a dismissed brief item stays gone on the next read, and undo brings it back', async () => {
  const before = await api.brief();
  const item = before.buckets.now[0];
  expect(item.token).toBeTruthy();

  await api.dismissBriefItem(item.item_id, 'dismiss', item.token as string, before.date);
  const after = await api.brief();
  expect(after.buckets.now.map((i) => i.item_id)).not.toContain(item.item_id);
  expect(after.hidden_count).toBe((before.hidden_count ?? 0) + 1);

  await api.dismissBriefItem(item.item_id, 'undo', item.token as string, before.date);
  const undone = await api.brief();
  expect(undone.buckets.now.map((i) => i.item_id)).toContain(item.item_id);
});

test('answering a decision asks the owner, then moves the card to answered', async () => {
  const before = await api.decisions();
  const card = before.open[0];
  await api.answerDecision(card.id, card.options[0].key, null);

  expect(mockAuthenticate).toHaveBeenCalledWith(expect.objectContaining({ allowDeviceCredentials: true }));
  const after = await api.decisions();
  expect(after.open.map((d) => d.id)).not.toContain(card.id);
  expect(after.answered.find((d) => d.id === card.id)?.answer?.option_key).toBe(card.options[0].key);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('a cancelled prompt applies nothing', async () => {
  mockAuthenticate.mockResolvedValue({ success: false, errorCode: 'USER_CANCEL' });
  const before = await api.decisions();
  await expect(api.answerDecision(before.open[0].id, 'dismiss', null)).rejects.toMatchObject({ code: 'cancelled' });
  expect((await api.decisions()).open).toHaveLength(before.open.length);
});

test('a device with no passcode and no biometrics still applies the change', async () => {
  mockAuthenticate.mockRejectedValue(Object.assign(new Error('no passcode'), { code: 'PASSCODE_NOT_SET' }));
  const before = await api.decisions();
  await api.answerDecision(before.open[0].id, before.open[0].options[0].key, null);
  expect((await api.decisions()).open).toHaveLength(before.open.length - 1);
});

test('marking an automation read clears what it was waiting on', async () => {
  const before = await api.automations();
  const waiting = before.jobs.find((j) => j.needs_you);
  expect(waiting).toBeTruthy();
  expect((await api.automationsBadge()).needs_you).toBe(before.counts.needs_you);

  await api.automationMarkRead(waiting!.id);
  const after = await api.automations();
  expect(after.jobs.find((j) => j.id === waiting!.id)?.needs_you).toBe(false);
  expect(after.counts.needs_you).toBe(before.counts.needs_you - 1);
  expect((await api.automationsBadge()).needs_you).toBe(after.counts.needs_you);

  await api.automationsReadAll();
  expect((await api.automations()).counts.unread).toBe(0);
});

test('opening a run marks it read and hands back the thread under it', async () => {
  const job = (await api.automations()).jobs.find((j) => j.latest)!;
  const opened = await api.automationOpenRun(job.latest!.run_id);
  expect(opened.run.read).toBe(true);
  const thread = await api.chatThreadDetail(opened.thread.id);
  expect(thread.thread.id).toBe(opened.thread.id);
});

test('config and routing saves are visible on the next read', async () => {
  const cfg = await api.configFull();
  const leaf = cfg.sections.flatMap((s) => s.leaves).find((l) => l.writable && l.type === 'str')!;
  await api.applyWrite({ action: 'config.set', key: leaf.key, value: 'demo-value' });
  const after = await api.configFull();
  expect(after.sections.flatMap((s) => s.leaves).find((l) => l.key === leaf.key)?.value).toBe('demo-value');

  const rules = await api.addBriefingRule('Never show me newsletters');
  expect(rules.rules.map((r) => r.text)).toContain('Never show me newsletters');
  expect((await api.briefingRules()).rules).toHaveLength(rules.rules.length);
});

test('approving a pairing request moves it out of pending', async () => {
  const before = await api.pairing();
  const request = before.pending[0];
  await api.applyWrite({ action: 'pairing.approve', platform: request.platform, code: request.code });
  const after = await api.pairing();
  expect(after.pending.map((p) => p.code)).not.toContain(request.code);
  expect(after.approved.map((a) => a.user_id)).toContain(request.user_id);
  expect(after.pending_count).toBe(before.pending_count - 1);
});

test('server-only features answer an honest 503 before any prompt', async () => {
  await expect(api.tmuxSessions()).rejects.toMatchObject({ status: 503 });
  await expect(api.terminalUnlock()).rejects.toBeInstanceOf(ApplyError);
  await expect(api.connectorConnect('demo')).rejects.toMatchObject({ detail: SERVER_ONLY_DETAIL });
  await expect(api.applyWrite({ action: 'tmux.spawn' })).rejects.toBeInstanceOf(ApplyError);
  expect(mockAuthenticate).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('a read the demo does not have is a 404, as a server would say', async () => {
  await expect(api.chatSubagentTranscript('nope', 'child')).rejects.toBeInstanceOf(ApiError);
  expect(await api.openrouterCredits()).toBeNull();
});

test('pages the seed published are served from memory', async () => {
  const pages = await api.myPages();
  const html = demoPage(`https://demo.invalid/my-pages/${pages.pages[0].slug}/`);
  expect(html).toMatch(/<html/i);
  expect(demoPage('https://demo.invalid/my-pages/not-a-page/')).toBeNull();
});

test('demo thread ids are recognisable, real ones are not', async () => {
  const boot = await api.chatBootstrap();
  expect(boot.threads.every((t) => isDemoThreadId(t.id))).toBe(true);
  expect(isDemoThreadId('thr_8f2a91c0d3')).toBe(false);
});
