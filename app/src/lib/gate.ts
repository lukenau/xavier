// The Face ID write gate — the native replacement for the PWA's WebAuthn
// ceremony, and the thing that makes every write in this app work.
//
// WHY A DEVICE KEY AND NOT A PASSKEY. A native passkey for this RP is
// impossible in a TestFlight build: Apple's CDN must fetch an association file
// from `hub.example.com` and cannot reach the tailnet. Verified,
// with sources, in docs/research/passkeys.md. So the app proves possession of a
// P-256 key in the Secure Enclave, created with `BiometricStrength.Strong`,
// which on iOS is `.biometryCurrentSet`: the private key cannot be used without
// a live Face ID match, and re-enrolling a face invalidates it.
//
// WHAT THIS FILE OWNS, AND WHAT IT DOES NOT. It owns exactly two things: the
// one-time pairing ceremony (`enrol`) and the signing step (`signChallenge`).
// It does NOT own the challenge -> sign -> apply sequence — api.ts does, for
// every write, exactly as the PWA's client does. `installGateSigner()` hands
// api.ts the signer; app/_layout.tsx calls it once at startup.
//
// THE HONEST LIMIT (mirrors server/devicekeys.py). User verification
// is enforced on the device by the Enclave's access control, not attested in
// the signature the way WebAuthn's UV flag is. A valid signature proves
// possession of the Enclave key, not that a biometric matched. An attacker
// holding a jailbroken, unlocked handset is inside this gate. The WebAuthn path
// remains available in the PWA, is strictly stronger, and the two verifiers are
// independent.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BiometricStrength,
  InputEncoding,
  createKeys,
  deleteKeys,
  signWithOptions,
} from '@sbaiahmed1/react-native-biometrics';
import { ApiError, ApplyError, api, registerGateSigner, type AssertionChallenge, type GateProof } from './api';
import type { ApplyErrorCode } from './types';

/**
 * A gate failure. Extends ApplyError on purpose rather than standing alongside
 * it: `src/components/config/writeErrors.ts` decides cancelled-silent vs toast
 * with `err instanceof ApplyError || err instanceof GateNotWiredError`, so a
 * sibling class would have every Face ID cancellation leak out as a toast
 * through the `default:` arm. Subclassing keeps the PWA's error matrix working
 * unchanged — which is the property gate.test.ts asserts, at the caller.
 */
export class GateError extends ApplyError {
  constructor(code: ApplyErrorCode, detail: string) {
    super(code, detail);
  }
}

/**
 * Two aliases, ping-ponged. Pairing generates a fresh key, and `createKeys`
 * REPLACES whatever lives under the alias it is given — so pairing into the
 * live alias would destroy a working pairing the moment the enrol code was
 * mistyped. The new key goes into the other alias and only becomes live once
 * the server has accepted it; the old one is deleted after that, never before.
 */
const ALIAS_A = 'hub.devicekey.a';
const ALIAS_B = 'hub.devicekey.b';

/**
 * The pairing self-test payload: standard base64 of the 22 ASCII bytes
 * "hub-devicekey-selftest".
 *
 * Deliberately NOT 32 bytes. Every hub-api challenge is exactly 32
 * (`secrets.token_urlsafe(32)`), so a signature over this message can never be
 * mistaken for — or replayed as — a proof for any real challenge, whatever else
 * goes wrong. The signature itself is discarded; only the ceremony matters.
 */
const SELF_TEST_DATA = 'aHViLWRldmljZWtleS1zZWxmdGVzdA==';

/** Local pairing record. Public data only — the private key never leaves the
 * Enclave, and `key_id` is a sha256 of the public key. It lives here because
 * GET /api/devicekey/status deliberately discloses no key ids, so the register
 * response is the only place the app can ever learn its own. */
export interface Pairing {
  key_id: string;
  alias: string;
  label: string;
  paired_at: string;
}

const PAIRING_KEY = 'hub-devicekey-pairing';

export async function readPairing(): Promise<Pairing | null> {
  const raw = await AsyncStorage.getItem(PAIRING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Pairing>;
    if (typeof parsed?.key_id !== 'string' || typeof parsed?.alias !== 'string') return null;
    return {
      key_id: parsed.key_id,
      alias: parsed.alias,
      label: typeof parsed.label === 'string' ? parsed.label : 'iPhone',
      paired_at: typeof parsed.paired_at === 'string' ? parsed.paired_at : '',
    };
  } catch {
    // A record we cannot parse is a record we cannot sign with. Unpaired.
    return null;
  }
}

/**
 * The bytes the signature covers, as the native module wants them.
 *
 * hub-api mints `challenge` as `secrets.token_urlsafe(32)` — 43 chars of
 * UNPADDED base64url over 32 random bytes — and the device key signs exactly
 * `base64url_decode(challenge)`: the same 32 bytes a WebAuthn authenticator
 * embeds in clientDataJSON. No prefix, no wrapper, no re-encoding.
 *
 * The conversion below is load-bearing and not cosmetic. `signWithOptions`
 * with `InputEncoding.Base64` reaches Foundation's `Data(base64Encoded:)`
 * (ios/ReactNativeBiometrics.swift), which is STANDARD base64 with no
 * `ignoreUnknownCharacters`: `-` and `_` are rejected outright and missing
 * padding is rejected too, so handing it the raw base64url string either fails
 * the call or, on some inputs, would sign different bytes. Translate the
 * alphabet and restore the padding, exactly as the PWA's webauthn.ts does
 * before `navigator.credentials.get()`.
 */
export function challengeToSignedBytesB64(challengeB64u: string): string {
  // Fail before the native module sees it rather than after. A challenge is
  // server-minted and always base64url; anything else means the contract moved
  // or the value was tampered with in transit, and signing it blind is the one
  // thing this function must not do.
  if (!/^[A-Za-z0-9_-]+$/.test(challengeB64u)) {
    throw new GateError('unknown', 'The hub sent a challenge this app cannot read.');
  }
  const standard = challengeB64u.replace(/-/g, '+').replace(/_/g, '/');
  return standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
}

/**
 * Native error code -> the PWA's ApplyErrorCode, which is what decides whether
 * a failure is swallowed or toasted (writeErrors.ts `gateMessage`).
 *
 * Only the `default:` arm of that switch shows our message, so the codes that
 * already have PWA copy keep their code, and the natively-specific failures use
 * `unknown` to carry a sentence that is actually true on a phone ("pair this
 * iPhone again" — there is no native passkey enrolment to send anyone to).
 */
function toGateError(errorCode: string | undefined, detail: string | undefined): GateError {
  switch (errorCode) {
    // The user said no. Silent where the PWA is silent (ConfigHome, Routing),
    // "Face ID cancelled." where the PWA toasts (ConfigSectionPage, Advisor).
    case 'USER_CANCEL':
    case 'SYSTEM_CANCEL':
    case 'USER_FALLBACK':
      return new GateError('cancelled', 'Face ID cancelled.');

    // A face was presented and did not match, or the Enclave refused the key.
    case 'AUTHENTICATION_FAILED':
    case 'KEY_REQUIRES_AUTHENTICATION':
    case 'KEY_ACCESS_FAILED':
    case 'SIGNATURE_CREATION_FAILED':
      return new GateError('assertion_invalid', 'Face ID did not verify.');

    // The key is gone. Both of these mean the same thing to the user: pair again.
    case 'KEY_NOT_FOUND':
      return new GateError('unknown', 'This iPhone is no longer paired. Mint a new code on the Hub’s Security page.');
    case 'BIOMETRY_CURRENT_SET_CHANGED':
      return new GateError(
        'unknown',
        'Face ID enrolment changed, so the paired key was invalidated. Pair this iPhone again.',
      );

    case 'BIOMETRY_LOCKOUT':
    case 'BIOMETRY_LOCKOUT_PERMANENT':
      return new GateError('unknown', 'Face ID is locked out. Unlock this iPhone with its passcode, then try again.');

    case 'BIOMETRY_NOT_AVAILABLE':
    case 'BIOMETRY_NOT_ENROLLED':
    case 'PASSCODE_NOT_SET':
      return new GateError('unknown', 'Face ID is not set up on this iPhone, so writes cannot be authorized.');

    default:
      return new GateError('unknown', detail || 'Face ID signing failed.');
  }
}

/** The native module resolves most failures as `{success:false, errorCode}` but
 * rejects on a few (e.g. DATA_ENCODING_FAILED), so both shapes are mapped. */
function fromNativeRejection(err: unknown): GateError {
  if (err instanceof GateError) return err;
  const code = (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : undefined;
  return toGateError(code, message);
}

/**
 * The one place the Enclave key is ever used. `data` is STANDARD base64 of the
 * bytes to sign (see challengeToSignedBytesB64); the module decodes it with
 * Foundation's Data(base64Encoded:) and signs with
 * .ecdsaSignatureMessageX962SHA256 — SHA-256 applied internally, X9.62 DER out.
 *
 * Both native failure shapes land here: most paths resolve `{success:false,
 * errorCode}` and a few reject outright, so every caller gets a GateError.
 */
async function signBytes(
  alias: string,
  data: string,
  promptTitle: string,
  promptSubtitle: string,
): Promise<string> {
  let result;
  try {
    result = await signWithOptions({
      keyAlias: alias,
      data,
      inputEncoding: InputEncoding.Base64,
      promptTitle,
      promptSubtitle,
      cancelButtonText: 'Cancel',
      biometricStrength: BiometricStrength.Strong,
      disableDeviceFallback: true,
    });
  } catch (err) {
    throw fromNativeRejection(err);
  }
  if (!result.success || !result.signature) {
    throw toGateError(result.errorCode, result.error);
  }
  return result.signature;
}

/**
 * The signing step, and nothing else: challenge in, assertion payload out.
 * api.ts calls this between its own challenge POST and its own apply POST.
 */
export async function signChallenge(challenge: AssertionChallenge): Promise<GateProof> {
  const pairing = await readPairing();
  if (!pairing) {
    throw new GateError('unknown', 'This iPhone is not paired yet. Mint a code on the Hub’s Security page.');
  }

  const data = challengeToSignedBytesB64(challenge.challenge);
  const signature = await signBytes(
    pairing.alias,
    data,
    'Authorize this change',
    'Hub needs Face ID before it will write.',
  );

  return {
    devicekey_assertion: {
      key_id: pairing.key_id,
      // Echoed byte-for-byte: this string is the server's challenge-cache key,
      // and the cache is what makes the proof single-use and purpose-bound.
      // Re-encoding it (padding it, or to standard base64) would miss the cache
      // and the write would fail for a reason nobody could see.
      challenge_b64: challenge.challenge,
      signature_b64: signature,
    },
  };
}

/** Arms api.ts's gate seam. Called once from app/_layout.tsx at startup. */
export function installGateSigner(): void {
  registerGateSigner(signChallenge);
}

/** Server-side pairing failures, mapped for the enrol screen. The server makes
 * wrong / expired / already-spent codes deliberately indistinguishable (one
 * string, one status), so this must not invent a distinction it cannot know. */
function toEnrolError(err: unknown): GateError {
  if (err instanceof GateError) return err;
  if (err instanceof ApiError) {
    if (err.code === 'enroll_code_invalid' || err.status === 403) {
      return new GateError('assertion_invalid', 'That code is wrong, expired or already used. Mint a new one.');
    }
    if (err.code === 'bad_devicekey' || err.status === 400) {
      return new GateError('bad_request', 'The hub rejected this iPhone’s key.');
    }
    if (err.code === 'devicekey_store_unreadable') {
      return new GateError('unknown', 'The hub could not read its device-key store. Check hub-api.');
    }
    return new GateError('unknown', err.message);
  }
  return fromNativeRejection(err);
}

/**
 * Pair this iPhone. `code` is the one-time, TTL-bound, attempt-capped code just
 * minted on the server — locally over a unix socket (`./install.sh --pair`, the
 * host shell is already full trust) or, for an optional web UI, behind its
 * WebAuthn gate. Either way a human on the server vouched for the Enclave key
 * the server is about to trust; the app asserts nothing on its own.
 *
 * Ordering is the security-relevant part. The key is generated into the spare
 * alias, the server is asked to accept it, and only a 200 promotes it to live.
 * A rejected code therefore costs nothing: the throwaway key is deleted and the
 * existing pairing is untouched.
 */
export async function enrol(code: string, label = 'iPhone'): Promise<Pairing> {
  const normalized = code.trim().toUpperCase();
  const current = await readPairing();
  const alias = current?.alias === ALIAS_A ? ALIAS_B : ALIAS_A;

  let publicKey: string;
  try {
    // ec256 => Secure Enclave; Strong => .biometryCurrentSet; no device-credential
    // fallback, so a passcode alone can never stand in for a face.
    ({ publicKey } = await createKeys(alias, 'ec256', BiometricStrength.Strong, false, false));
  } catch (err) {
    throw fromNativeRejection(err);
  }

  // Creating a .biometryCurrentSet key does NOT prompt — only USING one does —
  // so no biometric has happened yet. Without this, the first real Face ID
  // ceremony would be the first gated write, and a phone with Face ID off,
  // not enrolled, or locked out would pair "successfully" and then fail every
  // write with a message about a write. Prove the key is usable while the user
  // is still looking at the pairing screen, and BEFORE the one-time code is
  // spent: a failure here costs neither the code nor the existing pairing.
  try {
    await signBytes(alias, SELF_TEST_DATA, 'Pair this iPhone', 'Confirm Face ID before pairing.');
  } catch (err) {
    await deleteKeys(alias).catch(() => undefined);
    throw fromNativeRejection(err);
  }

  let registered: { key_id: string };
  try {
    registered = await api.registerDeviceKey(normalized, publicKey, label);
  } catch (err) {
    // The key the server would not take must not survive: left behind it would
    // sit in the Enclave under the alias the NEXT pairing attempt writes to.
    await deleteKeys(alias).catch(() => undefined);
    throw toEnrolError(err);
  }

  const pairing: Pairing = {
    key_id: registered.key_id,
    alias,
    label,
    paired_at: new Date().toISOString(),
  };
  await AsyncStorage.setItem(PAIRING_KEY, JSON.stringify(pairing));
  // Only now is the previous key unreachable to us. Its RECORD stays on the
  // server until a `devicekey.revoke` from the PWA — harmless (the Enclave key
  // behind it is gone, so nothing can sign for it) but worth knowing.
  if (current && current.alias !== alias) await deleteKeys(current.alias).catch(() => undefined);
  return pairing;
}
