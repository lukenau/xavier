// Tests for the Face ID write gate.
//
// Two things are being held here, and the second is the one that matters.
//
//   1. The bytes. The signature must cover EXACTLY `base64url_decode(challenge)`
//      — the 32 canonical bytes hub-api's `_ChallengeCache` minted and a
//      WebAuthn authenticator would have embedded in clientDataJSON. The
//      fixtures below are copied from Task 20's report
//      (server/test_devicekeys.py::dk_assertion), not re-derived here.
//
//   2. The CALLER. A vulnerability already shipped on this project because a
//      guard was correct and its caller never called it, while a unit test of
//      the guard passed happily. So most of this file drives `api.applyWrite`,
//      `api.terminalUnlock`, `api.saveTopicRouting` and `api.answerDecision` —
//      the four gated call sites — and asserts what actually reaches the wire,
//      including that NOTHING reaches /apply when signing fails.
import AsyncStorage from '@react-native-async-storage/async-storage';

// The native module, mocked. Not `virtual`: the package IS a dependency, so a
// jest failure to resolve it is a real signal and should not be papered over.
// The enum values are the ones the module actually ships (lib/typescript
// types.d.ts) — 'strong' is what iOS maps to `.biometryCurrentSet`, and
// 'base64' is what routes the challenge through Data(base64Encoded:).
jest.mock('@sbaiahmed1/react-native-biometrics', () => ({
  BiometricStrength: { Strong: 'strong', Weak: 'weak' },
  InputEncoding: { UTF8: 'utf8', Base64: 'base64' },
  createKeys: jest.fn(),
  deleteKeys: jest.fn(),
  signWithOptions: jest.fn(),
}));

import { createKeys, deleteKeys, signWithOptions } from '@sbaiahmed1/react-native-biometrics';
import { api, ApplyError, GateNotWiredError, GATE_NOT_WIRED_MESSAGE } from './api';
import { challengeToSignedBytesB64, enrol, GateError, installGateSigner, readPairing, signChallenge } from './gate';
import { gateErrorCode, isCancelledGateError, writeErrorMessage } from '../components/config/writeErrors';

const BASE = 'https://hub.example.com/api';

// ── Task 20's deterministic vector (task-20-report.md §2) ───────────────────
// Private scalar 0x0102…1F20 on P-256. Copied, not re-derived.
const VECTOR = {
  spkiDerB64:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUVw9brnjlrkE0/7Kf1T9zQzB6Ze/N13K' +
    'UVrQpsO0A19FNr46UPMY+/mlR1kCoiFQK+8NV+CMU7LMClbxfZ+TVA==',
  keyId: 'f1d59449b727165de732bf283338122b99628a615918fedc67d878fffcf47da7',
  challengeB64: 'S3RvUGE1TnJEcXpXeGJZY0hqTG1RdjhlOWZUdTJnNkE',
  signedBytesHex: '4b746f5061354e7244717a5778625963486a4c6d517638653966547532673641',
};

// A second challenge whose base64url spelling uses BOTH substituted characters,
// which the vector above happens not to. Without it the `-`/`_` translation
// could be deleted and every test would still pass.
const ALPHABET_CHALLENGE = {
  b64u: 'X-zrZv_IbzjZUnhsbWlsecLbwjndTpG0ZynXOif7V-k',
  standard: 'X+zrZv/IbzjZUnhsbWlsecLbwjndTpG0ZynXOif7V+k=',
  hex: '5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9',
};

function challengeResponse(challenge: string) {
  return {
    challenge,
    rp_id: 'hub.example.com',
    user_verification: 'required' as const,
    allowed_credentials: [],
    timeout_ms: 60000,
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function mockFetchOnce(res: Response) {
  (global.fetch as jest.Mock).mockResolvedValueOnce(res);
}

const PAIRING = { key_id: VECTOR.keyId, alias: 'hub.devicekey.a', label: 'iPhone', paired_at: '2026-09-11T00:00:00.000Z' };

async function seedPairing(pairing: unknown = PAIRING) {
  await AsyncStorage.setItem('hub-devicekey-pairing', JSON.stringify(pairing));
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
}

beforeEach(async () => {
  global.fetch = jest.fn();
  await AsyncStorage.clear();
  (signWithOptions as jest.Mock).mockReset();
  // Pairing now runs a Face ID self-test before it spends the enrol code, so
  // the default is "the ceremony works"; the tests that care override it.
  (signWithOptions as jest.Mock).mockResolvedValue({ success: true, signature: 'SIGDER==' });
  (createKeys as jest.Mock).mockReset();
  (deleteKeys as jest.Mock).mockReset();
  (deleteKeys as jest.Mock).mockResolvedValue({ success: true });
  installGateSigner();
});

afterEach(() => {
  // clearAllMocks, NOT resetAllMocks: the shipped AsyncStorage mock is itself a
  // set of jest.fn()s with implementations, and resetting them turns every
  // later getItem into undefined.
  jest.clearAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
describe('the canonical signed bytes', () => {
  it("are Task 20's vector, byte for byte", () => {
    const data = challengeToSignedBytesB64(VECTOR.challengeB64);
    expect(Buffer.from(data, 'base64').toString('hex')).toBe(VECTOR.signedBytesHex);
    expect(Buffer.from(data, 'base64')).toHaveLength(32);
  });

  it('translate the base64url alphabet and restore the padding', () => {
    // Foundation's Data(base64Encoded:) is STANDARD base64 with no
    // ignoreUnknownCharacters: '-'/'_' are rejected and missing padding is
    // rejected. Handing it the raw challenge string would fail the call.
    const data = challengeToSignedBytesB64(ALPHABET_CHALLENGE.b64u);
    expect(data).toBe(ALPHABET_CHALLENGE.standard);
    expect(Buffer.from(data, 'base64').toString('hex')).toBe(ALPHABET_CHALLENGE.hex);
  });

  it('are the bytes hub-api itself signs: base64url_decode of the challenge', () => {
    // Independent of the vector: decode with a different decoder and compare.
    const viaGate = Buffer.from(challengeToSignedBytesB64(ALPHABET_CHALLENGE.b64u), 'base64');
    const viaNode = Buffer.from(ALPHABET_CHALLENGE.b64u, 'base64url');
    expect(viaGate.equals(viaNode)).toBe(true);
  });

  it('refuse a challenge outside the base64url alphabet instead of signing it blind', () => {
    for (const bad of ['not base64!', 'abc=', 'ab+cd', 'ab/cd', '']) {
      expect(() => challengeToSignedBytesB64(bad)).toThrow(GateError);
    }
  });
});

describe('signChallenge (the signing step, and only that)', () => {
  it('signs the decoded challenge bytes and returns the assertion payload', async () => {
    await seedPairing();
    (signWithOptions as jest.Mock).mockResolvedValue({ success: true, signature: 'SIGDER==' });

    const proof = await signChallenge(challengeResponse(VECTOR.challengeB64));

    expect(signWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        keyAlias: 'hub.devicekey.a',
        data: challengeToSignedBytesB64(VECTOR.challengeB64),
        inputEncoding: 'base64',
        biometricStrength: 'strong',
        disableDeviceFallback: true,
      }),
    );
    expect(proof).toEqual({
      devicekey_assertion: {
        key_id: VECTOR.keyId,
        challenge_b64: VECTOR.challengeB64,
        signature_b64: 'SIGDER==',
      },
    });
  });

  it('echoes challenge_b64 byte for byte — it is the server cache key, not a value to re-encode', async () => {
    await seedPairing();
    (signWithOptions as jest.Mock).mockResolvedValue({ success: true, signature: 's' });
    const proof = await signChallenge(challengeResponse(ALPHABET_CHALLENGE.b64u));
    expect(proof.devicekey_assertion.challenge_b64).toBe(ALPHABET_CHALLENGE.b64u);
    // …and is NOT what was handed to the signer.
    expect(proof.devicekey_assertion.challenge_b64).not.toBe(ALPHABET_CHALLENGE.standard);
  });

  it('refuses to prompt at all when this iPhone is not paired', async () => {
    await expect(signChallenge(challengeResponse(VECTOR.challengeB64))).rejects.toBeInstanceOf(GateError);
    expect(signWithOptions).not.toHaveBeenCalled();
  });

  it('treats an unparseable pairing record as unpaired, never as a key to guess with', async () => {
    await AsyncStorage.setItem('hub-devicekey-pairing', '{not json');
    await expect(signChallenge(challengeResponse(VECTOR.challengeB64))).rejects.toBeInstanceOf(GateError);
    await AsyncStorage.setItem('hub-devicekey-pairing', JSON.stringify({ label: 'x' }));
    expect(await readPairing()).toBeNull();
    expect(signWithOptions).not.toHaveBeenCalled();
  });

  it('rejects a bad challenge before the native module is touched', async () => {
    await seedPairing();
    await expect(signChallenge(challengeResponse('not base64!'))).rejects.toBeInstanceOf(GateError);
    expect(signWithOptions).not.toHaveBeenCalled();
  });

  it('never returns a payload when the native call succeeded but produced no signature', async () => {
    await seedPairing();
    (signWithOptions as jest.Mock).mockResolvedValue({ success: true, signature: undefined });
    await expect(signChallenge(challengeResponse(VECTOR.challengeB64))).rejects.toBeInstanceOf(GateError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('error mapping — the PWA cancelled-silent vs toast matrix', () => {
  const cases: [string, string, boolean][] = [
    // native errorCode            expected ApplyErrorCode   silent?
    ['USER_CANCEL', 'cancelled', true],
    ['SYSTEM_CANCEL', 'cancelled', true],
    ['USER_FALLBACK', 'cancelled', true],
    ['AUTHENTICATION_FAILED', 'assertion_invalid', false],
    ['KEY_REQUIRES_AUTHENTICATION', 'assertion_invalid', false],
    ['KEY_ACCESS_FAILED', 'assertion_invalid', false],
    ['SIGNATURE_CREATION_FAILED', 'assertion_invalid', false],
    ['KEY_NOT_FOUND', 'unknown', false],
    ['BIOMETRY_CURRENT_SET_CHANGED', 'unknown', false],
    ['BIOMETRY_LOCKOUT', 'unknown', false],
    ['BIOMETRY_LOCKOUT_PERMANENT', 'unknown', false],
    ['BIOMETRY_NOT_AVAILABLE', 'unknown', false],
    ['BIOMETRY_NOT_ENROLLED', 'unknown', false],
    ['PASSCODE_NOT_SET', 'unknown', false],
    ['SOMETHING_NEW_IN_0_17', 'unknown', false],
  ];

  it.each(cases)('%s resolves as %s', async (errorCode, expected, silent) => {
    await seedPairing();
    (signWithOptions as jest.Mock).mockResolvedValue({ success: false, errorCode, error: 'native detail' });
    const err = await signChallenge(challengeResponse(VECTOR.challengeB64)).catch((e: unknown) => e);

    // The caller, not the mapper: writeErrors.ts is what the config screens ask.
    expect(gateErrorCode(err)).toBe(expected);
    expect(isCancelledGateError(err)).toBe(silent);
  });

  it('a GateError is an ApplyError, so writeErrors.ts branches on it unchanged', async () => {
    await seedPairing();
    (signWithOptions as jest.Mock).mockResolvedValue({ success: false, errorCode: 'USER_CANCEL' });
    const err = await signChallenge(challengeResponse(VECTOR.challengeB64)).catch((e: unknown) => e);
    // Were GateError a sibling of ApplyError rather than a subclass, every
    // cancelled Face ID would fall through to the default arm and be toasted.
    expect(err).toBeInstanceOf(ApplyError);
    expect(writeErrorMessage(err)).toBe('Face ID cancelled.');
  });

  it('a native rejection (not a {success:false} result) maps the same way', async () => {
    await seedPairing();
    const rejection = Object.assign(new Error('User canceled authentication'), { code: 'USER_CANCEL' });
    (signWithOptions as jest.Mock).mockRejectedValue(rejection);
    const err = await signChallenge(challengeResponse(VECTOR.challengeB64)).catch((e: unknown) => e);
    expect(gateErrorCode(err)).toBe('cancelled');
  });

  it('surfaces a device-key-specific sentence for the failures the PWA has no copy for', async () => {
    await seedPairing();
    (signWithOptions as jest.Mock).mockResolvedValue({ success: false, errorCode: 'BIOMETRY_CURRENT_SET_CHANGED' });
    const err = await signChallenge(challengeResponse(VECTOR.challengeB64)).catch((e: unknown) => e);
    expect(writeErrorMessage(err)).toMatch(/Pair this iPhone again/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE CALLER. api.ts owns the challenge -> sign -> apply sequence; these assert
// what it actually puts on the wire once the signer is registered.
describe('api.applyWrite with the real signer registered', () => {
  it('posts the proof under devicekey_assertion, bound to the challenge it was handed', async () => {
    await seedPairing();
    (signWithOptions as jest.Mock).mockResolvedValue({ success: true, signature: 'SIGDER==' });
    mockFetchOnce(jsonResponse(challengeResponse(VECTOR.challengeB64)));
    mockFetchOnce(jsonResponse({ status: 'applied', applied_at: 'now' }));

    const request = { action: 'cron.pause' as const, job_id: 'j1' };
    await expect(api.applyWrite(request)).resolves.toMatchObject({ status: 'applied' });

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe(`${BASE}/action/challenge`);
    expect(calls[1][0]).toBe(`${BASE}/action/apply`);
    expect(bodyOf(calls[1])).toEqual({
      request,
      devicekey_assertion: {
        key_id: VECTOR.keyId,
        challenge_b64: VECTOR.challengeB64,
        signature_b64: 'SIGDER==',
      },
    });
    // The server takes EXACTLY ONE proof; a stray `assertion` key is a 422.
    expect(bodyOf(calls[1])).not.toHaveProperty('assertion');
  });

  it('signs the challenge the server just minted, not a stale or client-chosen one', async () => {
    await seedPairing();
    (signWithOptions as jest.Mock).mockResolvedValue({ success: true, signature: 's' });
    mockFetchOnce(jsonResponse(challengeResponse(ALPHABET_CHALLENGE.b64u)));
    mockFetchOnce(jsonResponse({ status: 'applied', applied_at: 'now' }));

    await api.applyWrite({ action: 'gateway.drain' });

    expect((signWithOptions as jest.Mock).mock.calls[0][0].data).toBe(ALPHABET_CHALLENGE.standard);
    const applied = bodyOf((global.fetch as jest.Mock).mock.calls[1]);
    expect((applied.devicekey_assertion as { challenge_b64: string }).challenge_b64).toBe(ALPHABET_CHALLENGE.b64u);
  });

  it('never posts /action/apply when Face ID is cancelled', async () => {
    await seedPairing();
    (signWithOptions as jest.Mock).mockResolvedValue({ success: false, errorCode: 'USER_CANCEL' });
    mockFetchOnce(jsonResponse(challengeResponse(VECTOR.challengeB64)));

    const err = await api.applyWrite({ action: 'gateway.restart' }).catch((e: unknown) => e);
    expect(gateErrorCode(err)).toBe('cancelled');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(`${BASE}/action/challenge`);
  });

  it('never posts /action/apply when this iPhone is not paired', async () => {
    mockFetchOnce(jsonResponse(challengeResponse(VECTOR.challengeB64)));
    await expect(api.applyWrite({ action: 'gateway.restart' })).rejects.toBeInstanceOf(GateError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("maps hub-api's 412 no_devicekey to an enrolment message, not to challenge_expired", async () => {
    await seedPairing();
    (signWithOptions as jest.Mock).mockResolvedValue({ success: true, signature: 's' });
    mockFetchOnce(jsonResponse(challengeResponse(VECTOR.challengeB64)));
    mockFetchOnce(jsonResponse({ detail: { code: 'no_devicekey', detail: 'No device key paired.' } }, { status: 412 }));
    await expect(api.applyWrite({ action: 'gateway.drain' })).rejects.toMatchObject({ code: 'no_passkey' });
  });
});

describe('the other three gated call sites carry the same proof', () => {
  beforeEach(async () => {
    await seedPairing();
    (signWithOptions as jest.Mock).mockResolvedValue({ success: true, signature: 'SIGDER==' });
  });

  const expectedProof = {
    key_id: VECTOR.keyId,
    challenge_b64: VECTOR.challengeB64,
    signature_b64: 'SIGDER==',
  };

  it('terminalUnlock posts devicekey_assertion to /terminal/session', async () => {
    mockFetchOnce(jsonResponse(challengeResponse(VECTOR.challengeB64)));
    mockFetchOnce(jsonResponse({ ok: true }));
    await expect(api.terminalUnlock()).resolves.toBe(true);
    expect(bodyOf((global.fetch as jest.Mock).mock.calls[1])).toEqual({ devicekey_assertion: expectedProof });
  });

  it('saveTopicRouting posts the config AND the proof', async () => {
    mockFetchOnce(jsonResponse(challengeResponse(VECTOR.challengeB64)));
    mockFetchOnce(jsonResponse({ status: 'ok', pending_sync: true }));
    await api.saveTopicRouting({ chat_id: '1', topics: {}, routes: {} });
    expect(bodyOf((global.fetch as jest.Mock).mock.calls[1])).toEqual({
      config: { chat_id: '1', topics: {}, routes: {} },
      devicekey_assertion: expectedProof,
    });
  });

  it('answerDecision posts the answer AND the proof', async () => {
    mockFetchOnce(jsonResponse(challengeResponse(VECTOR.challengeB64)));
    mockFetchOnce(jsonResponse({ status: 'answered', answered_at: 'now' }));
    await api.answerDecision('d1', 'yes', null);
    expect(bodyOf((global.fetch as jest.Mock).mock.calls[1])).toEqual({
      option_key: 'yes',
      note: null,
      devicekey_assertion: expectedProof,
    });
  });

  it.each([
    ['terminalUnlock', () => api.terminalUnlock()],
    ['saveTopicRouting', () => api.saveTopicRouting({ chat_id: '1', topics: {}, routes: {} })],
    ['answerDecision', () => api.answerDecision('d1', 'yes', null)],
  ])('%s stops at the challenge when Face ID is cancelled', async (_name, call) => {
    (signWithOptions as jest.Mock).mockResolvedValue({ success: false, errorCode: 'USER_CANCEL' });
    mockFetchOnce(jsonResponse(challengeResponse(VECTOR.challengeB64)));
    await expect(call()).rejects.toBeInstanceOf(GateError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('the gate fails closed when nothing registered a signer', () => {
  it('applyWrite throws GateNotWiredError and posts no apply', async () => {
    // A fresh module registry: this is the state of api.ts before
    // app/_layout.tsx calls installGateSigner().
    jest.resetModules();
    const fresh = require('./api') as typeof import('./api');
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(challengeResponse(VECTOR.challengeB64)));
    await expect(fresh.api.applyWrite({ action: 'gateway.restart' })).rejects.toBeInstanceOf(fresh.GateNotWiredError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('installGateSigner is what arms it', async () => {
    jest.resetModules();
    const fresh = require('./api') as typeof import('./api');
    fresh.registerGateSigner(async () => ({
      devicekey_assertion: { key_id: 'k', challenge_b64: 'c', signature_b64: 's' },
    }));
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(challengeResponse(VECTOR.challengeB64)))
      .mockResolvedValueOnce(jsonResponse({ status: 'applied', applied_at: 'now' }));
    await expect(fresh.api.applyWrite({ action: 'gateway.restart' })).resolves.toMatchObject({ status: 'applied' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('enrolment', () => {
  it('creates a Secure-Enclave key bound to the current biometric set and registers it', async () => {
    (createKeys as jest.Mock).mockResolvedValue({ publicKey: VECTOR.spkiDerB64 });
    mockFetchOnce(jsonResponse({ ok: true, key_id: VECTOR.keyId, count: 1 }));

    const pairing = await enrol('abc234', 'iPhone');

    // ec256 => Secure Enclave; 'strong' => .biometryCurrentSet; no device
    // credential fallback, so a passcode alone can never stand in for a face.
    expect(createKeys).toHaveBeenCalledWith('hub.devicekey.a', 'ec256', 'strong', false, false);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(`${BASE}/devicekey/register`);
    expect(bodyOf((global.fetch as jest.Mock).mock.calls[0])).toEqual({
      code: 'ABC234', // trimmed + upper-cased before it leaves the app
      spki_der_b64: VECTOR.spkiDerB64,
      label: 'iPhone',
    });
    expect(pairing).toMatchObject({ key_id: VECTOR.keyId, alias: 'hub.devicekey.a', label: 'iPhone' });
    expect(await readPairing()).toMatchObject({ key_id: VECTOR.keyId, alias: 'hub.devicekey.a' });
  });

  it('normalizes a code typed with stray whitespace and lower case', async () => {
    (createKeys as jest.Mock).mockResolvedValue({ publicKey: VECTOR.spkiDerB64 });
    mockFetchOnce(jsonResponse({ ok: true, key_id: VECTOR.keyId, count: 1 }));
    await enrol('  k7p2xq ', 'iPhone');
    expect(bodyOf((global.fetch as jest.Mock).mock.calls[0]).code).toBe('K7P2XQ');
  });

  it.each([
    ['an expired code', { detail: { code: 'enroll_code_invalid', detail: 'enrolment failed' } }, 403],
    ['a wrong code', { detail: { code: 'enroll_code_invalid', detail: 'enrolment failed' } }, 403],
    ['a replayed code', { detail: { code: 'enroll_code_invalid', detail: 'enrolment failed' } }, 403],
  ])('%s is rejected with the one sentence the server can honestly say', async (_name, body, status) => {
    (createKeys as jest.Mock).mockResolvedValue({ publicKey: VECTOR.spkiDerB64 });
    mockFetchOnce(jsonResponse(body, { status }));
    const err = await enrol('ZZZZZZ').catch((e: unknown) => e);
    // hub-api deliberately makes wrong / expired / spent indistinguishable
    // (devicekeys.py `_ENROLL_FAILED`); inventing a distinction here would be
    // a lie about what the app can know.
    expect((err as GateError).message).toBe('That code is wrong, expired or already used. Mint a new one.');
    expect(gateErrorCode(err)).toBe('assertion_invalid');
  });

  it('a rejected code costs nothing: the throwaway key is deleted and the live pairing survives', async () => {
    await seedPairing();
    (createKeys as jest.Mock).mockResolvedValue({ publicKey: 'NEWKEY' });
    mockFetchOnce(jsonResponse({ detail: { code: 'enroll_code_invalid' } }, { status: 403 }));

    await expect(enrol('ZZZZZZ')).rejects.toBeInstanceOf(GateError);

    // The new key went to the SPARE alias, so the live one was never replaced…
    expect(createKeys).toHaveBeenCalledWith('hub.devicekey.b', 'ec256', 'strong', false, false);
    // …the rejected key is gone…
    expect(deleteKeys).toHaveBeenCalledWith('hub.devicekey.b');
    expect(deleteKeys).not.toHaveBeenCalledWith('hub.devicekey.a');
    // …and the app can still sign with what it had.
    expect(await readPairing()).toMatchObject({ key_id: VECTOR.keyId, alias: 'hub.devicekey.a' });
  });

  it('re-pairing ping-pongs the alias and retires the old key only after the new one is stored', async () => {
    await seedPairing();
    (createKeys as jest.Mock).mockResolvedValue({ publicKey: 'NEWKEY' });
    mockFetchOnce(jsonResponse({ ok: true, key_id: 'newkeyid', count: 2 }));

    const pairing = await enrol('ABC234');

    expect(createKeys).toHaveBeenCalledWith('hub.devicekey.b', 'ec256', 'strong', false, false);
    expect(pairing.alias).toBe('hub.devicekey.b');
    expect(await readPairing()).toMatchObject({ key_id: 'newkeyid', alias: 'hub.devicekey.b' });
    expect(deleteKeys).toHaveBeenCalledWith('hub.devicekey.a');
  });

  it('surfaces a store fault as a store fault, not as a bad code', async () => {
    (createKeys as jest.Mock).mockResolvedValue({ publicKey: VECTOR.spkiDerB64 });
    mockFetchOnce(jsonResponse({ detail: { code: 'devicekey_store_unreadable', detail: 'bad json' } }, { status: 503 }));
    const err = await enrol('ABC234').catch((e: unknown) => e);
    expect((err as GateError).message).toMatch(/device-key store/);
  });

  it('leaves the app unpaired when the Enclave refuses to make a key', async () => {
    (createKeys as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Secure Enclave not available'), { code: 'SECURE_ENCLAVE_NOT_AVAILABLE' }),
    );
    await expect(enrol('ABC234')).rejects.toBeInstanceOf(GateError);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await readPairing()).toBeNull();
  });

  it('the freshly paired key signs the very next write', async () => {
    (createKeys as jest.Mock).mockResolvedValue({ publicKey: VECTOR.spkiDerB64 });
    mockFetchOnce(jsonResponse({ ok: true, key_id: VECTOR.keyId, count: 1 }));
    await enrol('ABC234');

    (signWithOptions as jest.Mock).mockResolvedValue({ success: true, signature: 'SIGDER==' });
    mockFetchOnce(jsonResponse(challengeResponse(VECTOR.challengeB64)));
    mockFetchOnce(jsonResponse({ status: 'applied', applied_at: 'now' }));
    await api.applyWrite({ action: 'gateway.drain' });

    const applied = bodyOf((global.fetch as jest.Mock).mock.calls[2]);
    expect(applied.devicekey_assertion).toEqual({
      key_id: VECTOR.keyId,
      challenge_b64: VECTOR.challengeB64,
      signature_b64: 'SIGDER==',
    });
  });
});

describe('pairing exercises Face ID before it spends the code', () => {
  const SELF_TEST_DATA = 'aHViLWRldmljZWtleS1zZWxmdGVzdA==';

  it('signs a self-test payload with the new key BEFORE registering it', async () => {
    (createKeys as jest.Mock).mockResolvedValue({ publicKey: VECTOR.spkiDerB64 });
    mockFetchOnce(jsonResponse({ ok: true, key_id: VECTOR.keyId, count: 1 }));

    await enrol('ABC234');

    expect(signWithOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        keyAlias: 'hub.devicekey.a',
        data: SELF_TEST_DATA,
        inputEncoding: 'base64',
        biometricStrength: 'strong',
        disableDeviceFallback: true,
      }),
    );
    // Ordering is the point: the ceremony happens while the user is on the
    // pairing screen, and before the single-use code is spent.
    const signOrder = (signWithOptions as jest.Mock).mock.invocationCallOrder[0];
    const postOrder = (global.fetch as jest.Mock).mock.invocationCallOrder[0];
    expect(signOrder).toBeLessThan(postOrder);
  });

  it('the self-test payload can never be replayed as a proof for a real challenge', () => {
    // hub-api challenges are always exactly 32 bytes; this is 22.
    expect(Buffer.from(SELF_TEST_DATA, 'base64')).toHaveLength(22);
    expect(Buffer.from(SELF_TEST_DATA, 'base64').toString()).toBe('hub-devicekey-selftest');
  });

  it.each([
    ['Face ID is not enrolled', 'BIOMETRY_NOT_ENROLLED'],
    ['Face ID is locked out', 'BIOMETRY_LOCKOUT'],
    ['the user cancels', 'USER_CANCEL'],
  ])('fails the pairing at once when %s — the code is never spent', async (_name, errorCode) => {
    (createKeys as jest.Mock).mockResolvedValue({ publicKey: VECTOR.spkiDerB64 });
    (signWithOptions as jest.Mock).mockResolvedValue({ success: false, errorCode });

    await expect(enrol('ABC234')).rejects.toBeInstanceOf(GateError);

    // Nothing was sent, so the one-time code survives for a real retry…
    expect(global.fetch).not.toHaveBeenCalled();
    // …the unusable key is gone…
    expect(deleteKeys).toHaveBeenCalledWith('hub.devicekey.a');
    // …and the app is still honestly unpaired.
    expect(await readPairing()).toBeNull();
  });

  it('a failed self-test leaves an EXISTING pairing untouched', async () => {
    await seedPairing();
    (createKeys as jest.Mock).mockResolvedValue({ publicKey: 'NEWKEY' });
    (signWithOptions as jest.Mock).mockResolvedValue({ success: false, errorCode: 'BIOMETRY_LOCKOUT' });

    await expect(enrol('ABC234')).rejects.toBeInstanceOf(GateError);

    expect(deleteKeys).toHaveBeenCalledWith('hub.devicekey.b');
    expect(deleteKeys).not.toHaveBeenCalledWith('hub.devicekey.a');
    expect(await readPairing()).toMatchObject({ key_id: VECTOR.keyId, alias: 'hub.devicekey.a' });
  });

  it('reports a self-test cancellation as cancelled, not as a bad code', async () => {
    (createKeys as jest.Mock).mockResolvedValue({ publicKey: VECTOR.spkiDerB64 });
    (signWithOptions as jest.Mock).mockResolvedValue({ success: false, errorCode: 'USER_CANCEL' });
    const err = await enrol('ABC234').catch((e: unknown) => e);
    expect(gateErrorCode(err)).toBe('cancelled');
  });
});

describe('the registration seam is not a hot-swap', () => {
  it('re-registering the SAME signer is a no-op (React re-runs mount effects)', () => {
    expect(() => installGateSigner()).not.toThrow();
    expect(() => installGateSigner()).not.toThrow();
  });

  it('registering a DIFFERENT signer throws instead of silently winning', () => {
    jest.resetModules();
    const fresh = require('./api') as typeof import('./api');
    const first: import('./api').GateSigner = async () => ({
      devicekey_assertion: { key_id: 'k', challenge_b64: 'c', signature_b64: 's' },
    });
    const second: import('./api').GateSigner = async () => ({
      devicekey_assertion: { key_id: 'evil', challenge_b64: 'c', signature_b64: 's' },
    });
    fresh.registerGateSigner(first);
    expect(() => fresh.registerGateSigner(first)).not.toThrow();
    expect(() => fresh.registerGateSigner(second)).toThrow(/already has a different signer/);
  });

  it('the first signer is still the one that signs after a refused swap', async () => {
    jest.resetModules();
    const fresh = require('./api') as typeof import('./api');
    const first: import('./api').GateSigner = async () => ({
      devicekey_assertion: { key_id: 'first', challenge_b64: VECTOR.challengeB64, signature_b64: 's' },
    });
    fresh.registerGateSigner(first);
    expect(() =>
      fresh.registerGateSigner(async () => ({
        devicekey_assertion: { key_id: 'evil', challenge_b64: 'c', signature_b64: 's' },
      })),
    ).toThrow();

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(challengeResponse(VECTOR.challengeB64)))
      .mockResolvedValueOnce(jsonResponse({ status: 'applied', applied_at: 'now' }));
    await fresh.api.applyWrite({ action: 'gateway.drain' });
    const applied = bodyOf((global.fetch as jest.Mock).mock.calls[1]);
    expect((applied.devicekey_assertion as { key_id: string }).key_id).toBe('first');
  });
});

describe('GateNotWiredError carries a per-site message', () => {
  it('defaults to the one sentence every write surface renders', () => {
    // The single place the literal is spelled out. Every other suite asserts
    // GATE_NOT_WIRED_MESSAGE, so a copy edit lands here and nowhere else — this
    // is the gate that makes such an edit deliberate rather than incidental.
    expect(GATE_NOT_WIRED_MESSAGE).toBe(
      'Face ID is unavailable, so nothing was sent. Restart Hub, then pair this iPhone in Config › Security.',
    );
    expect(new GateNotWiredError().message).toBe(GATE_NOT_WIRED_MESSAGE);
    expect(new GateNotWiredError().code).toBe('unknown');
  });

  it('lets a throw site say what it actually means instead', () => {
    expect(new GateNotWiredError('unknown', 'something true').message).toBe('something true');
  });

  it('still carries a code, so err.code branching works on it', () => {
    expect(new GateNotWiredError('cancelled').code).toBe('cancelled');
  });

  it('enrollPasskey explains that passkeys are not an app thing at all', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ rp: {} }));
    const err = await api.enrollPasskey('Face ID').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateNotWiredError);
    expect((err as Error).message).toMatch(/Passkeys cannot be enrolled from the app/);
  });
});
