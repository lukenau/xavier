import TestRenderer, { act } from 'react-test-renderer';
import { StatePanel } from '../components/shell';
import { hapticAllowed } from './haptics';
import { useWhimsyStore } from './level';
import { MOMENTS, type MomentId } from './moments';
import { OCCASIONS } from './occasions';
import { POSES } from './poses';
import { resolveMoment } from './useMoment';

const NOON = new Date(2026, 8, 30, 12, 0);
const LATE = new Date(2026, 8, 30, 2, 0);
const NEW_YEARS_EVE = new Date(2026, 11, 31, 20, 0);

test('every moment and occasion names a pose that exists', () => {
  for (const spec of Object.values(MOMENTS)) expect(POSES).toHaveProperty(spec.pose);
  for (const o of OCCASIONS) expect(POSES).toHaveProperty(o.pose);
});

test('off shows nothing, calm hides the full-only moments', () => {
  for (const id of Object.keys(MOMENTS) as MomentId[]) {
    expect(resolveMoment(id, 'off', true, NOON)).toBeNull();
    expect(resolveMoment(id, 'full', true, NOON)).not.toBeNull();
  }
  expect(resolveMoment('loading', 'calm', true, NOON)).toBeNull();
  expect(resolveMoment('empty', 'calm', true, NOON)?.pose).toBe('tray-empty');
});

test('reduced motion keeps the pose and drops the motion', () => {
  expect(resolveMoment('success', 'full', false, NOON)).toMatchObject({ pose: 'triumph', motion: 'still' });
});

test('occasions dress resting moments only', () => {
  expect(resolveMoment('empty', 'full', true, LATE)).toMatchObject({ pose: 'pyjamas', occasion: 'late-night' });
  expect(resolveMoment('error', 'full', true, LATE)?.pose).toBe('oops');
  expect(resolveMoment('success', 'full', true, NEW_YEARS_EVE)?.pose).toBe('party');
});

test('calm keeps only the haptics that carry meaning', () => {
  expect(hapticAllowed('success', 'calm')).toBe(true);
  expect(hapticAllowed('tap', 'calm')).toBe(false);
  expect(hapticAllowed('error', 'off')).toBe(false);
  expect(hapticAllowed('flourish', 'full')).toBe(true);
});

describe('StatePanel', () => {
  afterEach(() => act(() => useWhimsyStore.setState({ level: 'full' })));

  const poses = (r: TestRenderer.ReactTestRenderer) =>
    r.root.findAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('xavier-pose-') && typeof n.type === 'string');

  test('brings Xavier by tone, and the level can send him away', () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(<StatePanel tone="error" title="Feed unavailable" />);
    });
    expect(poses(r).map((n) => n.props.testID)).toEqual(['xavier-pose-oops']);
    act(() => useWhimsyStore.setState({ level: 'off' }));
    expect(poses(r)).toHaveLength(0);
    expect(r.root.findByProps({ children: 'Feed unavailable' })).toBeTruthy();
  });

  test('moment={false} opts out', () => {
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
      r = TestRenderer.create(<StatePanel tone="neutral" title="No jobs" moment={false} />);
    });
    expect(poses(r)).toHaveLength(0);
  });
});

test('errors carry a red badge so the state reads even at icon size', () => {
  expect(resolveMoment('error', 'full', true, NOON)?.badge).toBe('status-down');
  expect(resolveMoment('empty', 'full', true, NOON)?.badge).toBeUndefined();
});
