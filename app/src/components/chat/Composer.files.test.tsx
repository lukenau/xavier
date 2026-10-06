// The "+" offers a photo or a file (2026-10-01: "he wants files in Hub chat").
// One button, the platform's own sheet, and each choice goes to its own picker;
// a chosen file waits in the composer as a chip until the message is sent.
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, api: { ...actual.api, chatCommands: jest.fn() } };
});
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: jest.fn() }));

const mockPickFile = jest.fn();
const mockPickImage = jest.fn();
jest.mock('../../chat/attachments', () => ({
  ...jest.requireActual('../../chat/attachments'),
  pickFile: (...a: unknown[]) => mockPickFile(...a),
  pickImage: (...a: unknown[]) => mockPickImage(...a),
}));

import TestRenderer, { act } from 'react-test-renderer';
import { ActionSheetIOS, Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer } from './Composer';
import { api } from '../../lib/api';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

let renderer: TestRenderer.ReactTestRenderer | null = null;
let client: QueryClient;
let choose: ((index: number) => void) | null = null;

async function renderComposer(onSend = jest.fn()) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <Composer mode="queue" onModeChange={() => {}} onSend={onSend} running={false} onStop={() => {}} threadId="thr_1" />
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  renderer = r;
  return { r, onSend };
}

/** The labelled Pressable — the first node carrying the label, as the other composer tests find it. A host
 * View under it carries the label too but not the handler. */
const pressable = (r: TestRenderer.ReactTestRenderer, label: string) =>
  r.root.findAll((n) => n.props.accessibilityLabel === label)[0];
/** How many of a label are actually on screen (host nodes only, or each button counts three times). */
const host = (r: TestRenderer.ReactTestRenderer, label: string) =>
  r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLabel === label);
const texts = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAllByType(Text).flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string');

beforeEach(() => {
  jest.clearAllMocks();
  choose = null;
  (api.chatCommands as jest.Mock).mockImplementation(() => new Promise(() => {}));
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(((_: unknown, cb: (i: number) => void) => {
    choose = cb;
  }) as typeof ActionSheetIOS.showActionSheetWithOptions);
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
  client?.clear();
  jest.restoreAllMocks();
});

async function tapPlus(r: TestRenderer.ReactTestRenderer) {
  await act(async () => pressable(r, 'Attach a photo or file').props.onPress());
}

it('offers Photo or File from the one button', async () => {
  const { r } = await renderComposer();
  await tapPlus(r);
  expect(ActionSheetIOS.showActionSheetWithOptions).toHaveBeenCalledWith(
    { options: ['Photo', 'File', 'Cancel'], cancelButtonIndex: 2 },
    expect.any(Function),
  );
});

it('sends Photo to the photo picker and File to the file picker, and Cancel to neither', async () => {
  mockPickImage.mockResolvedValue({ ok: false, reason: 'cancelled' });
  mockPickFile.mockResolvedValue({ ok: false, reason: 'cancelled' });
  const { r } = await renderComposer();

  await tapPlus(r);
  await act(async () => choose!(0));
  expect(mockPickImage).toHaveBeenCalledWith('thr_1', 4); // room for the whole message
  expect(mockPickFile).not.toHaveBeenCalled();

  await tapPlus(r);
  await act(async () => choose!(1));
  expect(mockPickFile).toHaveBeenCalledWith('thr_1');

  mockPickImage.mockClear();
  mockPickFile.mockClear();
  await tapPlus(r);
  await act(async () => choose!(2));
  expect(mockPickImage).not.toHaveBeenCalled();
  expect(mockPickFile).not.toHaveBeenCalled();
});

it('holds a chosen file as a chip with its name and size, removes it on tap, and sends its id', async () => {
  mockPickFile.mockResolvedValue({
    ok: true,
    images: [{ id: 'med_1', uri: '', mime: 'application/pdf', bytes: 1234, name: 'report.pdf' }],
  });
  const { r, onSend } = await renderComposer();
  await tapPlus(r);
  await act(async () => choose!(1));

  expect(host(r, 'Remove report.pdf')).toHaveLength(1);
  expect(texts(r)).toEqual(expect.arrayContaining(['report.pdf', '1 KB']));

  await act(async () => pressable(r, 'Send').props.onPress());
  expect(onSend).toHaveBeenCalledWith('', 'queue', ['med_1']);

  // A sent attachment is gone from the composer.
  expect(host(r, 'Remove report.pdf')).toHaveLength(0);
});

it('lets a chip be taken back out before sending', async () => {
  mockPickFile.mockResolvedValue({ ok: true, images: [{ id: 'med_2', uri: '', mime: 'text/plain', bytes: 5, name: 'a.txt' }] });
  const { r, onSend } = await renderComposer();
  await tapPlus(r);
  await act(async () => choose!(1));
  await act(async () => pressable(r, 'Remove a.txt').props.onPress());
  expect(host(r, 'Remove a.txt')).toHaveLength(0);
  await act(async () => pressable(r, 'Send').props.onPress());
  expect(onSend).not.toHaveBeenCalled(); // nothing left to send
});

// The media route stores pictures only, so the file picker refuses anything
// else before an upload (chat/attachments.ts); the composer says so plainly.
it('says why when the chosen file is not a picture, and attaches nothing', async () => {
  mockPickFile.mockResolvedValue({ ok: false, reason: 'unsupported' });
  const { r, onSend } = await renderComposer();
  await tapPlus(r);
  await act(async () => choose!(1));
  expect(texts(r)).toContain('Only pictures can be attached — JPEG, PNG, GIF or WebP.');
  await act(async () => pressable(r, 'Send').props.onPress());
  expect(onSend).not.toHaveBeenCalled();
});

it('takes several photos from one visit to the gallery, and sends them all', async () => {
  mockPickImage.mockResolvedValue({
    ok: true,
    images: [
      { id: 'med_7', uri: '', mime: 'image/jpeg', bytes: 10 },
      { id: 'med_8', uri: '', mime: 'image/jpeg', bytes: 20 },
    ],
  });
  const { r, onSend } = await renderComposer();
  await tapPlus(r);
  await act(async () => choose!(0));

  expect(host(r, 'Remove this picture')).toHaveLength(2);

  await act(async () => pressable(r, 'Send').props.onPress());
  expect(onSend).toHaveBeenCalledWith('', 'queue', ['med_7', 'med_8']);
});
