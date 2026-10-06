// Pair this iPhone's Secure-Enclave key with the hub (docs/research/passkeys.md).
// Internal-only: it is not a PWA route, it has no link to keep working, and it
// is the app's credential-enrolment surface — an external `hub://…` deep link
// has no business opening it (src/lib/deepLinks.ts INTERNAL_ONLY_ROUTES).
export { PairSheet as default } from '../../../src/components/config/PairSheet';
