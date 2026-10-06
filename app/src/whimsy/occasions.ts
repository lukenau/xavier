// Occasions dress Xavier for the time and date. Rules are plain data so they
// could later be served from hub-api; first match wins.
import type { MomentId } from './moments';
import type { PoseId } from './poses';

export interface Occasion {
  id: string;
  active: (now: Date) => boolean;
  /** Moments whose pose this occasion replaces. */
  moments: MomentId[] | 'all';
  pose: PoseId;
}

const md = (now: Date) => (now.getMonth() + 1) * 100 + now.getDate();

// Poses that are "Xavier idling"; an occasion shouldn't turn an error into a party.
const RESTING: MomentId[] = ['empty', 'all-clear', 'welcome', 'chat.empty', 'offline', 'loading'];

export const OCCASIONS: Occasion[] = [
  {
    id: 'new-year',
    active: (now) => md(now) === 1231 || md(now) === 101,
    moments: [...RESTING, 'success'],
    pose: 'party',
  },
  {
    id: 'christmas',
    active: (now) => md(now) >= 1224 && md(now) <= 1226,
    moments: RESTING,
    pose: 'party',
  },
  {
    id: 'late-night',
    active: (now) => now.getHours() >= 0 && now.getHours() < 5,
    moments: RESTING,
    pose: 'pyjamas',
  },
];

export function activeOccasion(moment: MomentId, now: Date): Occasion | undefined {
  return OCCASIONS.find(
    (o) => o.active(now) && (o.moments === 'all' || o.moments.includes(moment)),
  );
}
