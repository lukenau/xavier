// Pair this iPhone's Secure-Enclave key with the hub (docs/research/passkeys.md).
// Internal-only: it is not a PWA route, it has no link to keep working, and it
// is the app's credential-enrolment surface — an external `hub://…` deep link
// has no business opening it (src/lib/deepLinks.ts INTERNAL_ONLY_ROUTES).
//
// The demo never touches the Enclave key or the pairing flow; it says what
// pairing is for instead.
import { PairSheet } from '../../../src/components/config/PairSheet';
import { inDemo, PairDemo } from '../../../src/demo/ServerOnly';

export default inDemo(PairSheet, PairDemo);
