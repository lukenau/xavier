// The runtime server-address setting (Config › Server address). Internal-only
// like /config/pair: it has no PWA route and nothing to link to, and it
// changes where every request and websocket in the app goes — the only way in
// is a deliberate tap inside Config › This device.
export { ServerPage as default } from '../../../src/components/config/ServerPage';
