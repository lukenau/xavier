// The write-gate error surface. Two things matter here and nothing else does:
// that each page keeps its own PWA copy (they differ), and that the gate's
// "not wired yet" state reaches the user as a message rather than as silence
// or a fake success.
import { ApplyError, GateNotWiredError, GATE_NOT_WIRED_MESSAGE } from '../../lib/api';
import {
  advisorErrorMessage,
  gateErrorCode,
  isCancelledGateError,
  routingErrorMessage,
  writeErrorMessage,
} from './writeErrors';

describe('the shared code map', () => {
  test.each([
    ['no_passkey', 'No passkey enrolled. Enrol Face ID in Security first.'],
    ['assertion_invalid', 'Face ID did not verify.'],
    ['cancelled', 'Face ID cancelled.'],
  ] as const)('%s reads the same on every page', (code, message) => {
    expect(writeErrorMessage(new ApplyError(code))).toBe(message);
    expect(advisorErrorMessage(new ApplyError(code))).toBe(message);
    expect(routingErrorMessage(new ApplyError(code))).toBe(message);
  });
});

describe('the per-page copy that differs', () => {
  test('challenge_expired tells you which control to tap again', () => {
    expect(writeErrorMessage(new ApplyError('challenge_expired'))).toBe('That took too long — tap to try again.');
    expect(advisorErrorMessage(new ApplyError('challenge_expired'))).toBe('That took too long — tap to try again.');
    // RoutingPage.tsx:57 — "save", because its bar's button says Save.
    expect(routingErrorMessage(new ApplyError('challenge_expired'))).toBe('That took too long — tap save again.');
  });

  test('each page has its own fallback verb', () => {
    expect(writeErrorMessage({})).toBe('Update failed.');
    expect(advisorErrorMessage({})).toBe('Switch failed.');
    expect(routingErrorMessage({})).toBe('Save failed.');
  });

  test('a server message wins over the fallback', () => {
    expect(writeErrorMessage(new ApplyError('bridge_error', 'CLI-bridge unreachable'))).toBe(
      'CLI-bridge unreachable',
    );
    expect(writeErrorMessage(new Error('boom'))).toBe('boom');
  });
});

describe('GateNotWiredError — the live path until Task 21', () => {
  test('it is treated as a gate error, and its message is what the user sees', () => {
    // api.applyWrite POSTs a real /action/challenge and then throws this at
    // the assertion step. Surfacing its own message is the honest state; a
    // silent swallow or a fabricated "applied" would not be.
    const err = new GateNotWiredError();
    expect(gateErrorCode(err)).toBe('unknown');
    expect(writeErrorMessage(err)).toBe(GATE_NOT_WIRED_MESSAGE);
    expect(advisorErrorMessage(err)).toBe(GATE_NOT_WIRED_MESSAGE);
  });

  test('it carries a code, so the cancelled-silent paths still work once it is real', () => {
    expect(isCancelledGateError(new GateNotWiredError('cancelled'))).toBe(true);
    expect(isCancelledGateError(new ApplyError('cancelled'))).toBe(true);
    // ConfigHome and RoutingPage swallow ONLY a cancel (OQ-10) — everything
    // else has to reach a toast or an inline message.
    expect(isCancelledGateError(new ApplyError('no_passkey'))).toBe(false);
    expect(isCancelledGateError(new GateNotWiredError())).toBe(false);
    expect(isCancelledGateError(new Error('cancelled'))).toBe(false);
  });

  test('a non-gate error has no code at all', () => {
    expect(gateErrorCode(new Error('network down'))).toBeNull();
    expect(gateErrorCode('nope')).toBeNull();
  });
});
