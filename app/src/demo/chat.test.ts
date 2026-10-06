// A message sent in the demo gets its canned reply the way a real one arrives:
// over the chat socket (an in-memory one), through the client's queue and the
// reducer, into the same store the transcript renders from.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, newClientMsgId } from '../lib/api';
import { getChatSocket, resetChatSocket } from '../chat/socket';
import { selectMessages, useChatStore } from '../chat/store';
import { sendChatMessage } from '../chat/hooks';
import { turnStateOf } from '../chat/turnState';
import { resetDemoModeForTests, setDemoFlag } from './mode';
import { cannedReply } from './chat';
import { resetDemoWorld } from './server';

const fetchSpy = jest.fn();

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetDemoModeForTests();
  resetDemoWorld();
  resetChatSocket();
  useChatStore.getState().reset();
  await setDemoFlag(true);
  fetchSpy.mockReset();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  resetChatSocket();
  resetDemoWorld();
  resetDemoModeForTests();
});

async function openThread(title: string) {
  const boot = await api.chatBootstrap();
  const thread = boot.threads.find((t) => t.title === title)!;
  const detail = await api.chatThreadDetail(thread.id);
  useChatStore.getState().hydrateSnapshot(detail.thread, detail.messages);
  const socket = getChatSocket();
  socket.connect();
  socket.subscribe(thread.id, detail.thread.last_seq);
  await until(() => socket.connected);
  return detail;
}

function send(threadId: string, text: string) {
  const { upsertLocalMessage, removeLocalMessage } = useChatStore.getState();
  return sendChatMessage({ upsertLocalMessage, removeLocalMessage, chatSend: api.chatSend }, threadId, text, newClientMsgId());
}

test('a sent message streams back a canned reply, with a widget, through the socket and the store', async () => {
  const { thread, messages } = await openThread('Demo hub tour');
  const expected = cannedReply('what can you do?', 0);

  await send(thread.id, 'what can you do?');
  const sent = selectMessages(thread.id)(useChatStore.getState());
  expect(sent).toHaveLength(messages.length + 1);
  expect(sent[sent.length - 1]).toMatchObject({ role: 'user', status: 'complete', forward_status: 'forwarded' });
  // Handed to "the agent": the transcript shows it working straight away.
  expect(turnStateOf(sent)).toBe('working');

  await until(() => {
    const rows = selectMessages(thread.id)(useChatStore.getState());
    return rows.length === messages.length + 2 && rows[rows.length - 1].status === 'streaming';
  });

  await until(() => selectMessages(thread.id)(useChatStore.getState()).at(-1)?.status === 'complete');
  const reply = selectMessages(thread.id)(useChatStore.getState()).at(-1)!;
  expect(reply.role).toBe('assistant');
  expect(reply.parts).toEqual(expected);
  expect(reply.parts.some((p) => p.type === 'widget')).toBe(true);
  expect(useChatStore.getState().chat.threads[thread.id].thread.status).toBe('idle');
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('the reply picks its widget from what was asked', () => {
  expect(cannedReply('will it rain tomorrow?', 0)[1]).toMatchObject({ kind: 'weather' });
  expect(cannedReply('how much did I spend?', 0)[1]).toMatchObject({ kind: 'metric' });
  expect(cannedReply('hello', 1)[0]).toMatchObject({ type: 'text', text: expect.stringContaining('picture') });
});

test('Stop ends the reply where it stands', async () => {
  const { thread } = await openThread('Home projects');
  await send(thread.id, 'tell me everything');
  await until(() => selectMessages(thread.id)(useChatStore.getState()).at(-1)?.status === 'streaming');

  await api.chatStopThread(thread.id);
  await until(() => selectMessages(thread.id)(useChatStore.getState()).at(-1)?.status === 'complete');
  expect(useChatStore.getState().chat.threads[thread.id].thread.status).toBe('idle');
});

test('a new conversation is created, named from its first message, and answered', async () => {
  const { thread } = await api.chatCreateThread();
  const socket = getChatSocket();
  socket.connect();
  socket.subscribe(thread.id, 0);
  await until(() => socket.connected);

  await send(thread.id, 'Plan a quiet weekend for the two of us');
  await until(() => selectMessages(thread.id)(useChatStore.getState()).at(-1)?.status === 'complete');
  const listed = (await api.chatBootstrap()).threads.find((t) => t.id === thread.id);
  expect(listed?.title).toBe('Plan a quiet weekend for the two of us');
  expect(listed?.preview).toBeTruthy();
});
