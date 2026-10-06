// The wash has to survive a theme switch and a token edit, so what is pinned
// here is the DERIVATION — corner, colour and the ring alpha that composites
// back to `--wash`'s own peak — not four hand-copied numbers.
import TestRenderer, { act } from 'react-test-renderer';
import { View } from 'react-native';
import { dark, light } from '../../theme/tokens.gen';
import { Ground, WASH_RINGS, parseWash, ringAlpha } from './Ground';

const composite = (a: number, n: number) => 1 - (1 - a) ** n;

test('ringAlpha inverts the stacking, so N rings land back on the gradient peak', () => {
  for (const peak of [0.075, 0.16, 0.13, 0.1]) {
    expect(composite(ringAlpha(peak), WASH_RINGS.length)).toBeCloseTo(peak, 12);
  }
});

test('parseWash reads both corners out of the dark token', () => {
  const [ochre, petrol] = parseWash(dark.wash);
  expect(ochre).toMatchObject({ rgb: '240,171,94', x: 100, y: 0 });
  expect(petrol).toMatchObject({ rgb: '38,110,130', x: 0, y: 100 });
  expect(ochre.alpha).toBeCloseTo(0.0193, 4);
  expect(petrol.alpha).toBeCloseTo(0.0427, 4);
});

test('parseWash reads the light theme’s different colour pair, not the dark one', () => {
  const [ochre, petrol] = parseWash(light.wash);
  expect(ochre.rgb).toBe('131,75,0');
  expect(petrol.rgb).toBe('0,96,124');
  expect(ochre.alpha).toBeCloseTo(0.0342, 4);
  expect(petrol.alpha).toBeCloseTo(0.026, 4);
});

test('rings are centred on their corner: half the diameter off each edge', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Ground />);
  });
  const rings = renderer.root.findByProps({ testID: 'ground' }).findAllByType(View);
  // Two washes × four rings, plus the container View itself.
  expect(rings).toHaveLength(WASH_RINGS.length * 2 + 1);

  const widest = WASH_RINGS[0];
  const topRight = rings.find(
    (r) => r.props.style?.width === widest && r.props.style?.right !== undefined,
  );
  expect(topRight?.props.style).toMatchObject({ right: -widest / 2, top: -widest / 2 });

  const bottomLeft = rings.find(
    (r) => r.props.style?.width === widest && r.props.style?.left !== undefined,
  );
  expect(bottomLeft?.props.style).toMatchObject({ left: -widest / 2, bottom: -widest / 2 });

  act(() => renderer.unmount());
});
