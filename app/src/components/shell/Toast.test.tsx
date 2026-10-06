import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { Toast, TOAST_VARIANTS, type ToastKind, type ToastVariant } from './Toast';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function render(kind: ToastKind, variant: ToastVariant, onDone: () => void) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <Toast kind={kind} text="Answered — logged to the response ledger." onDone={onDone} variant={variant} />
      </SafeAreaProvider>,
    );
  });
  return renderer;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('auto-dismiss timing matrix', () => {
  // apps/hub has four Toast copies with two timing pairs (PARITY-INVENTORY
  // OQ-18): DecisionCards/RoutingPage/AdvisorPage use 3600/6000 and
  // ConfigSectionPage uses 3200/5000. Both are reproduced, not normalized.
  const cases: [ToastVariant, ToastKind, number][] = [
    ['decision', 'ok', 3600],
    ['decision', 'err', 6000],
    ['config', 'ok', 3200],
    ['config', 'err', 5000],
  ];

  test.each(cases)('%s/%s dismisses at %ims exactly', (variant, kind, ms) => {
    const onDone = jest.fn();
    render(kind, variant, onDone);
    act(() => {
      jest.advanceTimersByTime(ms - 1);
    });
    expect(onDone).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('the table and the component agree', () => {
    for (const [variant, kind, ms] of cases) {
      expect(TOAST_VARIANTS[variant][kind].durationMs).toBe(ms);
    }
  });
});

test('unmounting clears the timer instead of firing onDone later', () => {
  const onDone = jest.fn();
  const renderer = render('ok', 'decision', onDone);
  act(() => {
    renderer.unmount();
  });
  act(() => {
    jest.advanceTimersByTime(10_000);
  });
  expect(onDone).not.toHaveBeenCalled();
});

test('the two variants disagree on the error colour, as the PWA does', () => {
  expect(TOAST_VARIANTS.decision.err.color).toBe('status-warn');
  expect(TOAST_VARIANTS.decision.err.border).toBe('status-warn-soft');
  expect(TOAST_VARIANTS.config.err.color).toBe('danger');
  expect(TOAST_VARIANTS.config.err.border).toBe('status-down-border-strong');
});
