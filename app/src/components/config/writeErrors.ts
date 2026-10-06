// The four write-gate error mappers the config pages carry, ported verbatim
// from their PWA originals:
//
//   writeErrorMessage    ConfigSectionPage.tsx:272-288  ("Update failed.")
//   advisorErrorMessage  AdvisorPage.tsx:84-100         ("Switch failed.")
//   routingErrorMessage  RoutingPage.tsx:49-65          ("Save failed."; its
//                                                        challenge_expired
//                                                        copy says "tap save
//                                                        again")
//
// SecurityPage.tsx:14-21's `enrolMessage` is deliberately NOT ported: native
// enrolment is not the PWA's WebAuthn registration at all but Task 21's
// pairing-code screen, which brings its own error mapping.
//
// The PWA branches on `ApplyError | WebAuthnError`; natively the second half
// of that union is `GateNotWiredError` (api.ts), which carries the same
// `code` field, so the switch ports unchanged. Until Task 21 wires the
// Secure Enclave signer, a real write reaches the `default:` arm with
// GateNotWiredError's own message — the honest surface for "the gate is not
// built yet", not a fabricated success.
import { ApplyError, GateNotWiredError } from '../../lib/api';
import type { ApplyErrorCode } from '../../lib/types';

/** The gate error's code, or null when this is not a gate error at all. */
export function gateErrorCode(err: unknown): ApplyErrorCode | null {
  if (err instanceof ApplyError || err instanceof GateNotWiredError) return err.code;
  return null;
}

/** ConfigHome.tsx:63 and RoutingPage.tsx:277 swallow a cancelled Face ID with
 * no message at all — unlike ConfigSectionPage/Advisor, which toast it (OQ-10). */
export function isCancelledGateError(err: unknown): boolean {
  return gateErrorCode(err) === 'cancelled';
}

function gateMessage(err: unknown, fallback: string, expired: string): string {
  if (err instanceof ApplyError || err instanceof GateNotWiredError) {
    switch (err.code) {
      case 'cancelled':
        return 'Face ID cancelled.';
      case 'no_passkey':
        return 'No passkey enrolled. Enrol Face ID in Security first.';
      case 'challenge_expired':
        return expired;
      case 'assertion_invalid':
        return 'Face ID did not verify.';
      default:
        return err.message || fallback;
    }
  }
  return err instanceof Error ? err.message : fallback;
}

export function writeErrorMessage(err: unknown): string {
  return gateMessage(err, 'Update failed.', 'That took too long — tap to try again.');
}

export function advisorErrorMessage(err: unknown): string {
  return gateMessage(err, 'Switch failed.', 'That took too long — tap to try again.');
}

export function routingErrorMessage(err: unknown): string {
  return gateMessage(err, 'Save failed.', 'That took too long — tap save again.');
}
