import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { Runbooks, RUNBOOKS } from './Runbooks';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <SafeAreaProvider initialMetrics={METRICS}>{node}</SafeAreaProvider>,
    );
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

let tree: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

test('the shipped runbooks are generic examples, pinned as data', () => {
  // These are shell commands run against a live box: a mistyped one is a wrong
  // command in the user's composer, so they are pinned here.
  expect(RUNBOOKS.map((g) => g.section)).toEqual(['Host', 'Docker', 'Logs']);
  expect(RUNBOOKS.flatMap((g) => g.items.map((i) => i.cmd))).toEqual([
    'uname -a',
    'df -h',
    'free -h && uptime',
    'ss -lntup',
    'docker ps',
    'docker compose ps',
    'docker logs -f ',
    'docker exec -it ',
    'tail -f ',
    'grep -i error ',
    'journalctl -u ',
  ]);
});

test("no runbook leaks the owner's own estate", () => {
  // The list ships in a public repo; every entry must be honest to a stranger.
  const all = RUNBOOKS.flatMap((g) => g.items.map((i) => `${i.label} ${i.cmd}`)).join('\n');
  for (const leak of [
    'agent-data',
    'tailscale',
    'mac.internal.example',
    'hub-term',
    'example-gateway',
    'hub-api',
    'hermes cron',
    'ssh mac',
  ]) {
    expect(all).not.toContain(leak);
  }
});

test('the trailing-space commands keep it — they are completions, not commands', () => {
  const trailing = RUNBOOKS.flatMap((g) => g.items).filter((i) => i.cmd.endsWith(' '));
  expect(trailing.map((i) => i.label)).toEqual([
    'Follow a container log',
    'Shell into a container',
    'Tail a file',
    'Search a log for errors',
    'Journal for a unit',
  ]);
  expect(RUNBOOKS[1].items.find((i) => i.label === 'Shell into a container')?.cmd).toBe(
    'docker exec -it ',
  );
});

test('an open sheet lists every section, every item and the footer rule', () => {
  tree = render(<Runbooks open onClose={jest.fn()} onSnippet={jest.fn()} />);
  const rendered = texts(tree);

  expect(rendered).toContain('Runbooks');
  expect(rendered).toContain('TERMINAL');
  for (const group of RUNBOOKS) {
    expect(rendered).toContain(group.section.toUpperCase());
    for (const item of group.items) {
      expect(rendered).toContain(item.label);
      expect(rendered).toContain(item.cmd);
    }
  }
  expect(rendered).toContain('runbooks fill the composer — review, edit, then send');
});

test('a closed sheet renders nothing', () => {
  tree = render(<Runbooks open={false} onClose={jest.fn()} onSnippet={jest.fn()} />);
  expect(texts(tree)).toEqual([]);
});

test('tapping a runbook fills the composer and closes — it never executes', () => {
  const onSnippet = jest.fn();
  const onClose = jest.fn();
  tree = render(<Runbooks open onClose={onClose} onSnippet={onSnippet} />);

  const row = tree.root
    .findAll((n) => typeof n.props.onPress === 'function')
    .find((n) =>
      n.findAllByType(Text).some((inner) => inner.props.children === 'Disk space'),
    );
  act(() => row?.props.onPress());

  expect(onSnippet.mock.calls).toEqual([['df -h']]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Close dismisses without filling anything', () => {
  const onSnippet = jest.fn();
  const onClose = jest.fn();
  tree = render(<Runbooks open onClose={onClose} onSnippet={onSnippet} />);

  const close = tree.root
    .findAll((n) => typeof n.props.onPress === 'function')
    .find((n) =>
      n.findAllByType(Text).some((inner) => inner.props.children === 'Close'),
    );
  act(() => close?.props.onPress());

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSnippet).not.toHaveBeenCalled();
});
