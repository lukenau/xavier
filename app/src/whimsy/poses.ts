// Xavier's dot-matrix poses, each a small LED screen with its own dark
// backdrop. Adding one: a prompt line in scripts/xavier/poses.prompts.mjs,
// `node scripts/xavier/gen-pose.mjs <id>`, export, then one line here.
// JS-required images ship over the air.
import type { ImageSourcePropType } from 'react-native';

export const POSES = {
  portrait: require('../../assets/xavier/portrait.jpg'),
  bow: require('../../assets/xavier/bow.jpg'),
  'tray-empty': require('../../assets/xavier/tray-empty.jpg'),
  'tray-offer': require('../../assets/xavier/tray-offer.jpg'),
  sniffing: require('../../assets/xavier/sniffing.jpg'),
  ledger: require('../../assets/xavier/ledger.jpg'),
  'ears-up': require('../../assets/xavier/ears-up.jpg'),
  tilt: require('../../assets/xavier/tilt.jpg'),
  oops: require('../../assets/xavier/oops.jpg'),
  triumph: require('../../assets/xavier/triumph.jpg'),
  asleep: require('../../assets/xavier/asleep.jpg'),
  pyjamas: require('../../assets/xavier/pyjamas.jpg'),
  party: require('../../assets/xavier/party.jpg'),
} satisfies Record<string, ImageSourcePropType>;

export type PoseId = keyof typeof POSES;

export const POSE_LABELS: Record<PoseId, string> = {
  portrait: 'Xavier',
  bow: 'Xavier bowing',
  'tray-empty': 'Xavier holding an empty silver tray',
  'tray-offer': 'Xavier presenting a sealed letter on a tray',
  sniffing: 'Xavier sniffing about',
  ledger: 'Xavier reading his ledger',
  'ears-up': 'Xavier, ears up',
  tilt: 'Xavier tilting his head',
  oops: 'Xavier catching a falling teacup',
  triumph: 'Xavier ringing a service bell',
  asleep: 'Xavier dozing',
  pyjamas: 'Xavier in his pyjamas',
  party: 'Xavier in a party hat',
};

/** The small round tile's crop: centre (0–1) and zoom, framed on his face AND
 * the prop — the prop is what says which moment this is (the magnifier while
 * checking, the teacup on an error). Tune with a rendered preview, never blind. */
export const POSE_FACES: Record<PoseId, { x: number; y: number; zoom: number }> = {
  portrait: { x: 0.5, y: 0.42, zoom: 1.15 },
  sniffing: { x: 0.68, y: 0.32, zoom: 1.45 },
  oops: { x: 0.6, y: 0.3, zoom: 1.55 },
  'tray-empty': { x: 0.42, y: 0.3, zoom: 1.35 },
  triumph: { x: 0.6, y: 0.45, zoom: 1.2 },
  'ears-up': { x: 0.45, y: 0.3, zoom: 1.5 },
  ledger: { x: 0.52, y: 0.38, zoom: 1.4 },
  bow: { x: 0.5, y: 0.32, zoom: 1.4 },
  tilt: { x: 0.5, y: 0.28, zoom: 1.6 },
  asleep: { x: 0.5, y: 0.4, zoom: 1.35 },
  'tray-offer': { x: 0.5, y: 0.38, zoom: 1.3 },
  pyjamas: { x: 0.45, y: 0.35, zoom: 1.35 },
  party: { x: 0.5, y: 0.28, zoom: 1.45 },
};
