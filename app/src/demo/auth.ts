// The demo's write gate. A real write is signed by the paired Secure Enclave key
// (lib/gate.ts); the demo has no server to pair with and must never touch that
// key, so it asks the phone's owner to confirm instead: Face ID, Touch ID, or
// the device passcode when biometrics fail or are not set up — the policy iOS
// calls deviceOwnerAuthentication. The change then applies to the demo's own
// in-memory data, so a reviewer sees the same prompt-then-apply rhythm as the
// real app.
import type { ApplyErrorCode } from '../lib/types';

export type DemoAuthOutcome = { ok: true } | { ok: false; code: ApplyErrorCode; message: string };

type Authenticate = (options: {
  title?: string;
  subtitle?: string;
  cancelLabel?: string;
  allowDeviceCredentials?: boolean;
}) => Promise<{ success: boolean; errorCode?: string; error?: string }>;

/** Required lazily: the native module throws on import where it does not exist
 * (jest, web), and api.ts — which reaches this file — is imported everywhere. */
function authenticate(): Authenticate {
  return (require('@sbaiahmed1/react-native-biometrics') as { authenticateWithOptions: Authenticate })
    .authenticateWithOptions;
}

function failure(errorCode: string | undefined, detail: string | undefined): DemoAuthOutcome {
  switch (errorCode) {
    case 'USER_CANCEL':
    case 'SYSTEM_CANCEL':
    case 'APP_CANCEL':
    case 'USER_FALLBACK':
      return { ok: false, code: 'cancelled', message: 'Cancelled.' };
    case 'AUTHENTICATION_FAILED':
      return { ok: false, code: 'assertion_invalid', message: 'That did not verify. Try again.' };
    // No passcode, no Face ID, no Touch ID: this device cannot confirm anyone,
    // and the demo has nothing to protect. Blocking here would only stop a
    // reviewer whose test device has no passcode from seeing the change apply.
    case 'BIOMETRY_NOT_AVAILABLE':
    case 'BIOMETRY_NOT_ENROLLED':
    case 'PASSCODE_NOT_SET':
      return { ok: true };
    default:
      return { ok: false, code: 'unknown', message: detail || 'Could not confirm it was you.' };
  }
}

export async function demoAuthorize(reason = 'Authorize this change'): Promise<DemoAuthOutcome> {
  try {
    const result = await authenticate()({
      title: reason,
      subtitle: 'Demo: the change stays on this iPhone.',
      cancelLabel: 'Cancel',
      allowDeviceCredentials: true,
    });
    return result.success ? { ok: true } : failure(result.errorCode, result.error);
  } catch (err) {
    // The native module rejects with the code on the error itself.
    return failure((err as { code?: string })?.code, err instanceof Error ? err.message : undefined);
  }
}
