// Advisor preset logic. The preset table is a product surface that must stay
// in step with hub-api's ADVISOR_PRESETS (app.py:694-709) — the first test
// pins it to the server's values, which is the only thing standing between a
// copy-edit and a preset that writes a different model than its card claims.
import type { HealthSummary } from '../../lib/types';
import {
  isAdvisorBlocked,
  isGatewayHealthy,
  nextSelection,
  notHealthyYetMessage,
  PRESETS,
  presetLabel,
  providerLabel,
  restartFailedMessage,
  shortModel,
  switchedMessage,
} from './advisor';

describe('the preset table', () => {
  test('matches hub-api ADVISOR_PRESETS, in the PWA order', () => {
    // app.py:694-709: off → sonnet-4-6 + advisor off; quality → sonnet-4-6 +
    // opus-4-8; cost → haiku-4-5 + opus-4-8.
    expect(PRESETS.map((p) => [p.id, p.executor, p.advisor])).toEqual([
      ['quality', 'claude-sonnet-4-6', 'claude-opus-4-8'],
      ['off', 'claude-sonnet-4-6', null],
      ['cost', 'claude-haiku-4-5', 'claude-opus-4-8'],
    ]);
  });

  test('only Quality is recommended, only Cost is cautioned', () => {
    expect(PRESETS.map((p) => p.badge?.text ?? null)).toEqual(['Recommended', null, 'Caution']);
    expect(PRESETS.map((p) => p.badge?.tone ?? null)).toEqual(['good', null, 'warn']);
  });

  test("the executor the presets write is deliberately NOT in the model picker's list", () => {
    // Inventory §4.5 / OQ-27: /api/chat/models serves claude-sonnet-5 while
    // every preset writes claude-sonnet-4-6. Reproduced, not reconciled —
    // ConfigSectionPage's pillOptions() is what keeps the written value
    // visible (see leaves.test.ts).
    expect(PRESETS.map((p) => p.executor)).not.toContain('claude-sonnet-5');
  });
});

describe('shortModel / presetLabel / providerLabel', () => {
  test('the claude- prefix is dropped and null reads as an em dash', () => {
    expect(shortModel('claude-opus-4-8')).toBe('opus-4-8');
    expect(shortModel('openai/gpt-oss-120b')).toBe('openai/gpt-oss-120b');
    expect(shortModel(null)).toBe('—');
  });

  test('preset labels capitalise, custom is its own word', () => {
    expect(presetLabel('quality')).toBe('Quality');
    expect(presetLabel('off')).toBe('Off');
    expect(presetLabel('custom')).toBe('Custom');
  });

  test('the blocked card spells OpenRouter properly', () => {
    expect(providerLabel('openrouter')).toBe('OpenRouter');
    expect(providerLabel('vertex')).toBe('vertex');
    expect(providerLabel(null)).toBe('');
  });
});

describe('isAdvisorBlocked', () => {
  test('only a KNOWN non-anthropic provider blocks the surface', () => {
    expect(isAdvisorBlocked('openrouter')).toBe(true);
    expect(isAdvisorBlocked('anthropic')).toBe(false);
    // An unreadable config tree must not veto: null means "we could not read
    // model.provider", and locking the page on that would make a broken
    // CLI-bridge look like a policy decision.
    expect(isAdvisorBlocked(null)).toBe(false);
  });
});

describe('isGatewayHealthy', () => {
  const health = (services: HealthSummary['services'], overall: HealthSummary['overall']): HealthSummary => ({
    updated_at: null,
    overall,
    services,
  });
  const svc = (id: string, name: string, status: string) =>
    ({ id, name, status }) as HealthSummary['services'][number];

  test('the gateway row wins, matched on id OR name, case-insensitively', () => {
    expect(isGatewayHealthy(health([svc('example-gateway', 'Hermes', 'up')], 'red'))).toBe(true);
    expect(isGatewayHealthy(health([svc('hermes', 'Hermes Gateway', 'up')], 'red'))).toBe(true);
    expect(isGatewayHealthy(health([svc('example-gateway', 'Hermes', 'down')], 'green'))).toBe(false);
  });

  test('with no gateway row at all, overall green stands in', () => {
    expect(isGatewayHealthy(health([svc('hub-api', 'Hub API', 'up')], 'green'))).toBe(true);
    expect(isGatewayHealthy(health([svc('hub-api', 'Hub API', 'up')], 'amber'))).toBe(false);
    expect(isGatewayHealthy(health([], 'green'))).toBe(true);
  });
});

describe('nextSelection', () => {
  test('tapping a preset selects it; tapping it again clears', () => {
    expect(nextSelection(null, 'cost', 'quality')).toBe('cost');
    expect(nextSelection('cost', 'cost', 'quality')).toBeNull();
  });

  test('tapping the already-live preset is a no-op — there is nothing to restart for', () => {
    expect(nextSelection(null, 'quality', 'quality')).toBeNull();
    expect(nextSelection('cost', 'quality', 'quality')).toBeNull();
  });

  test('a custom live state means every preset is selectable', () => {
    expect(nextSelection(null, 'quality', 'custom')).toBe('quality');
  });
});

describe('result messages', () => {
  test('the happy path names the preset', () => {
    expect(switchedMessage('Quality')).toBe('Advisor now Quality — gateway back online.');
  });

  test('a timed-out restart says the write LANDED, so nobody re-applies it', () => {
    expect(notHealthyYetMessage('Cost')).toContain('the preset is written, so it will take once the gateway is up');
  });

  test('restart_failed quotes stderr when there is any, collapsed and capped', () => {
    expect(restartFailedMessage('Off', '  docker: no\n such  container ')).toBe(
      'Off written to config, but the gateway restart failed (docker: no such container). Restart it from Ops to make it live.',
    );
    expect(restartFailedMessage('Off', '')).toBe(
      'Off written to config, but the gateway restart failed. Restart it from Ops to make it live.',
    );
    expect(restartFailedMessage('Off', 'x'.repeat(200))).toContain(`(${'x'.repeat(140)})`);
  });
});
