import TestRenderer, { act } from 'react-test-renderer';
import { ScrollView, View, type ViewStyle } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { SheetScreen } from './sheet';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function flatten(style: ViewStyle | ViewStyle[]): ViewStyle {
  return Object.assign({}, ...(Array.isArray(style) ? style : [style]));
}

test('scroll={false} gives the body flex:1, so full-bleed content (BriefWebView) can fill it', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <SheetScreen title="Brief" scroll={false}>
          <View testID="filler" />
        </SheetScreen>
      </SafeAreaProvider>,
    );
  });
  const root = renderer.root.findAllByType(View)[0];
  expect(flatten(root.props.style).flex).toBe(1);
  expect(renderer.root.findAllByType(ScrollView)).toHaveLength(0);
});

test('scroll={true} (the default) renders a ScrollView, not the flexed non-scroll body', () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <SheetScreen title="Detail">
          <View testID="filler" />
        </SheetScreen>
      </SafeAreaProvider>,
    );
  });
  expect(renderer.root.findAllByType(ScrollView)).toHaveLength(1);
});
