// RN core's Clipboard is a native module; the button's behaviour (append on
// success, "long-press ↓" flash on failure) is what is under test.
jest.mock('react-native/Libraries/Components/Clipboard/Clipboard', () => ({
  __esModule: true,
  default: { getString: jest.fn(), setString: jest.fn() },
}));

import { createRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { Composer, PASTE_FLASH_MS, type ComposerHandle } from './Composer';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const clipboard = require('react-native/Libraries/Components/Clipboard/Clipboard')
  .default as { getString: jest.Mock };

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

function texts(tree: TestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(tree.toJSON());
  return out;
}

const field = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(TextInput)[0];

const sendButton = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAll((n) => n.props.accessibilityLabel === 'Send')[0];

const pasteButton = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAll((n) => n.props.accessibilityLabel === 'Paste from clipboard')[0];

let tree: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  clipboard.getString.mockReset();
});

test('Enter sends the line with a trailing CR and clears the field', () => {
  const onSend = jest.fn();
  tree = render(<Composer onSend={onSend} />);

  act(() => field(tree!).props.onChangeText('hermes doctor'));
  act(() => field(tree!).props.onSubmitEditing());

  expect(onSend.mock.calls).toEqual([['hermes doctor\r']]);
  expect(field(tree).props.value).toBe('');
});

test('the return key SUBMITS without blurring — the composer keeps the keyboard', () => {
  // RN 0.86 defaults a multiline TextInput to submitBehavior 'newline', where
  // onSubmitEditing never fires and blurOnSubmit is ignored. This prop is the
  // whole send-on-Enter + keep-focus contract, and nothing it does is visible
  // as text.
  tree = render(<Composer onSend={jest.fn()} />);
  expect(field(tree).props.submitBehavior).toBe('submit');
  expect(field(tree).props.multiline).toBe(true);
  expect(field(tree).props.autoCapitalize).toBe('none');
  expect(field(tree).props.autoCorrect).toBe(false);
  expect(field(tree).props.enterKeyHint).toBe('send');
});

test('an empty or whitespace-only line never ships a bare CR', () => {
  // The ⏎ chip is the deliberate way to send one.
  const onSend = jest.fn();
  tree = render(<Composer onSend={onSend} />);

  act(() => field(tree!).props.onSubmitEditing());
  act(() => field(tree!).props.onChangeText('   '));
  act(() => field(tree!).props.onSubmitEditing());
  act(() => sendButton(tree!).props.onPress());

  expect(onSend).not.toHaveBeenCalled();
});

test('leading and trailing whitespace is sent verbatim — only the guard trims', () => {
  const onSend = jest.fn();
  tree = render(<Composer onSend={onSend} />);

  act(() => field(tree!).props.onChangeText('  ls -la  '));
  act(() => field(tree!).props.onSubmitEditing());

  expect(onSend.mock.calls).toEqual([['  ls -la  \r']]);
});

test('a multi-line paste ships its newlines and ONE trailing CR', () => {
  const onSend = jest.fn();
  tree = render(<Composer onSend={onSend} />);

  act(() => field(tree!).props.onChangeText('for f in a b\ndo echo $f\ndone'));
  act(() => field(tree!).props.onSubmitEditing());

  expect(onSend.mock.calls).toEqual([['for f in a b\ndo echo $f\ndone\r']]);
});

test('while disconnected the field says so and refuses to send', () => {
  const onSend = jest.fn();
  tree = render(<Composer onSend={onSend} disabled />);
  expect(field(tree).props.placeholder).toBe('reconnecting…');

  act(() => field(tree!).props.onChangeText('docker ps'));
  act(() => field(tree!).props.onSubmitEditing());

  expect(onSend).not.toHaveBeenCalled();

  act(() => tree!.update(<Composer onSend={onSend} />));
  expect(field(tree).props.placeholder).toBe('command…');
  act(() => field(tree!).props.onSubmitEditing());
  expect(onSend.mock.calls).toEqual([['docker ps\r']]);
});

test('fill() REPLACES the draft — a runbook is not appended to what was typed', () => {
  const ref = createRef<ComposerHandle>();
  tree = render(<Composer ref={ref} onSend={jest.fn()} />);

  act(() => field(tree!).props.onChangeText('half-typed'));
  act(() => ref.current?.fill('hermes cron list'));

  expect(field(tree).props.value).toBe('hermes cron list');
});

describe('the paste button', () => {
  test('appends the clipboard to the draft', async () => {
    clipboard.getString.mockResolvedValue('/srv/hub-data');
    tree = render(<Composer onSend={jest.fn()} />);

    act(() => field(tree!).props.onChangeText('ls '));
    await act(async () => {
      await pasteButton(tree!).props.onPress();
    });

    expect(field(tree).props.value).toBe('ls /srv/hub-data');
  });

  test('an empty read flashes the hint — RN resolves \'\' where the web rejects', async () => {
    // `navigator.clipboard.readText()` rejects when permission is refused;
    // RN's Clipboard just resolves an empty string, so this branch IS the
    // refusal path on device and the hint would be dead code without it.
    clipboard.getString.mockResolvedValue('');
    tree = render(<Composer onSend={jest.fn()} />);

    act(() => field(tree!).props.onChangeText('ls'));
    await act(async () => {
      await pasteButton(tree!).props.onPress();
    });

    expect(field(tree).props.value).toBe('ls');
    expect(texts(tree)).toContain('long-press ↓');
  });

  test('a refused clipboard flashes the long-press hint, then goes back', async () => {
    jest.useFakeTimers();
    try {
      clipboard.getString.mockRejectedValue(new Error('denied'));
      tree = render(<Composer onSend={jest.fn()} />);

      await act(async () => {
        await pasteButton(tree!).props.onPress();
      });
      expect(texts(tree)).toContain('long-press ↓');

      act(() => jest.advanceTimersByTime(PASTE_FLASH_MS));
      expect(texts(tree)).toContain('paste');
    } finally {
      jest.useRealTimers();
    }
  });
});
