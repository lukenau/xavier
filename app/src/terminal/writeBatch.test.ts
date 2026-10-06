// The ack ledger is the one way to break ttyd's flow control from outside the
// transport (task-22-report.md §10.2): one `ack()` per chunk the client
// flagged, never one for an unflagged chunk. Everything below exists to hold
// that count exactly.
import { WriteBatcher } from './writeBatch';
import { bytesToBase64 } from './base64';

const bytes = (...values: number[]) => new Uint8Array(values);

function harness() {
  const injected: string[] = [];
  const acks = { count: 0 };
  let pending: (() => void) | null = null;
  const batcher = new WriteBatcher({
    inject: (js) => injected.push(js),
    onAck: () => {
      acks.count += 1;
    },
    schedule: (fn) => {
      pending = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => {
      pending = null;
    },
  });
  return {
    batcher,
    injected,
    acks,
    tick: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
    scheduled: () => pending !== null,
  };
}

test('a frame of chunks becomes ONE injected write', () => {
  const h = harness();
  h.batcher.push(bytes(1, 2), false);
  h.batcher.push(bytes(3), false);
  h.batcher.push(bytes(4, 5), false);
  expect(h.injected).toHaveLength(0);

  h.tick();

  expect(h.injected).toHaveLength(1);
  expect(h.injected[0]).toBe(`window.__w("${bytesToBase64(bytes(1, 2, 3, 4, 5))}",0);true;`);
});

test('the batch carries the COUNT of flagged chunks, not a boolean', () => {
  const h = harness();
  h.batcher.push(bytes(1), true);
  h.batcher.push(bytes(2), false);
  h.batcher.push(bytes(3), true);
  h.tick();

  expect(h.injected[0]).toContain(',2);');
});

test('the page reporting a batch replays exactly one ack per flagged chunk', () => {
  const h = harness();
  h.batcher.push(bytes(1), true);
  h.batcher.push(bytes(2), false);
  h.batcher.push(bytes(3), true);
  h.tick();
  expect(h.acks.count).toBe(0);

  h.batcher.pageAcked(2);

  expect(h.acks.count).toBe(2);
});

test('unflagged chunks never produce an ack', () => {
  const h = harness();
  h.batcher.push(bytes(1), false);
  h.batcher.push(bytes(2), false);
  h.tick();
  h.batcher.pageAcked(0);

  expect(h.acks.count).toBe(0);
});

test('a page that acks more than it was owed cannot drive the window negative', () => {
  // pending < 0 in the FlowController permanently suppresses the pause.
  const h = harness();
  h.batcher.push(bytes(1), true);
  h.tick();

  h.batcher.pageAcked(9);

  expect(h.acks.count).toBe(1);
});

test('settle() pays every owed ack — injected-but-unrendered AND still queued', () => {
  // The content process died: those bytes will never render, so their acks
  // would be lost and ttyd would stay paused for the rest of the session.
  const h = harness();
  h.batcher.push(bytes(1), true);
  h.tick();
  h.batcher.push(bytes(2), true);
  h.batcher.push(bytes(3), true);

  expect(h.batcher.settle()).toBe(3);
  expect(h.acks.count).toBe(3);
});

test('settle() cancels the pending flush and drops the queue', () => {
  const h = harness();
  h.batcher.push(bytes(1), false);
  h.batcher.settle();

  expect(h.scheduled()).toBe(false);
  h.tick();
  expect(h.injected).toHaveLength(0);
});

test('settle() then more output starts a clean ledger', () => {
  const h = harness();
  h.batcher.push(bytes(1), true);
  h.tick();
  h.batcher.settle();
  expect(h.acks.count).toBe(1);

  h.batcher.push(bytes(2), true);
  h.tick();
  h.batcher.pageAcked(1);

  expect(h.acks.count).toBe(2);
});

describe('while the page is reloading', () => {
  test('bytes are dropped but their acks are still paid', () => {
    // FLOW_HIGH is 10: eleven stranded flagged chunks leave the pty paused
    // for the rest of the session.
    const h = harness();
    h.batcher.suspend();

    for (let i = 0; i < 11; i += 1) h.batcher.push(bytes(i), true);
    h.tick();

    expect(h.injected).toHaveLength(0);
    expect(h.acks.count).toBe(11);
  });

  test('an unflagged chunk dropped mid-reload pays nothing', () => {
    const h = harness();
    h.batcher.suspend();
    h.batcher.push(bytes(1), false);
    expect(h.acks.count).toBe(0);
  });

  test('suspend() settles what was already outstanding', () => {
    const h = harness();
    h.batcher.push(bytes(1), true);
    h.tick();

    expect(h.batcher.suspend()).toBe(1);
    expect(h.acks.count).toBe(1);
  });

  test('resume() lets output flow again', () => {
    const h = harness();
    h.batcher.suspend();
    h.batcher.push(bytes(1), true);
    h.batcher.resume();

    h.batcher.push(bytes(2), true);
    h.tick();
    h.batcher.pageAcked(1);

    expect(h.injected).toHaveLength(1);
    expect(h.acks.count).toBe(2);
  });
});

test('a flush with nothing queued injects nothing', () => {
  const h = harness();
  h.batcher.flush();
  expect(h.injected).toHaveLength(0);
});

test('the next chunk after a flush schedules a new frame', () => {
  const h = harness();
  h.batcher.push(bytes(1), false);
  h.tick();
  expect(h.scheduled()).toBe(false);

  h.batcher.push(bytes(2), false);
  expect(h.scheduled()).toBe(true);
  h.tick();

  expect(h.injected).toHaveLength(2);
});

test('the real scheduler is a timer, not a synchronous call', () => {
  jest.useFakeTimers();
  try {
    const injected: string[] = [];
    const batcher = new WriteBatcher({ inject: (js) => injected.push(js), onAck: () => {} });
    batcher.push(bytes(1), false);
    expect(injected).toHaveLength(0);
    jest.advanceTimersByTime(16);
    expect(injected).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});
