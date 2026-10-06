import { create, act, type ReactTestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import { ClarifyWidget, answerText } from './ClarifyWidget';
import type { ClarifyWidget as ClarifyWidgetT } from '../../../chat/widget';

const ask = (over: Partial<ClarifyWidgetT> = {}): ClarifyWidgetT => ({
  kind: 'clarify',
  clarifyId: 'clr_1',
  question: 'Which env?',
  choices: ['staging', 'prod'],
  multiSelect: false,
  ...over,
});

describe('answerText — the contract with the gateway', () => {
  it('sends 1-based indices, never the labels', () => {
    // `_coerce_multi_select_text` takes "numbers and/or exact labels separated
    // by commas"; an index cannot be broken by a label containing a comma.
    expect(answerText(['a', 'b', 'c'], [0], '')).toBe('1');
    expect(answerText(['a', 'b', 'c'], [2, 0], '')).toBe('1,3');
  });

  it('sorts the indices so the answer does not depend on tap order', () => {
    expect(answerText(['a', 'b', 'c'], [2, 0, 1], '')).toBe('1,2,3');
  });

  it('free text wins over a selection', () => {
    expect(answerText(['a', 'b'], [0], 'neither, actually')).toBe('neither, actually');
  });

  it('is nothing to send when nothing is chosen', () => {
    expect(answerText(['a', 'b'], [], '')).toBeNull();
    expect(answerText(['a', 'b'], [], '   ')).toBeNull();
  });
});

function render(widget: ClarifyWidgetT, onAnswer?: (t: string) => void) {
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(<ClarifyWidget widget={widget} onAnswer={onAnswer && (async (t) => onAnswer(t))} />);
  });
  return tree!;
}

function textUnder(node: ReactTestInstance): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (typeof n === 'string') out.push(n);
    else if (Array.isArray(n)) n.forEach(walk);
  };
  node.findAllByType(Text).forEach((n) => walk(n.props.children));
  return out.join(' ');
}

/** `findAllByType(Pressable)` matches nothing under jest-expo; the sibling
 *  suites find controls by their accessibility role, so this does too. */
function buttons(tree: ReturnType<typeof create>) {
  return tree.root.findAll(
    (n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function',
    { deep: false },
  );
}

function press(tree: ReturnType<typeof create>, label: string) {
  const target = buttons(tree).find((b) => textUnder(b).includes(label));
  if (!target) throw new Error(`no control labelled ${label}`);
  act(() => {
    target.props.onPress();
  });
}

function allText(tree: ReturnType<typeof create>): string {
  return textUnder(tree.root);
}

describe('ClarifyWidget', () => {
  it('a single-select answers on one tap', () => {
    const answers: string[] = [];
    const tree = render(ask(), (t) => answers.push(t));
    press(tree, 'prod');
    expect(answers).toEqual(['2']);
    act(() => tree.unmount());
  });

  it('a multi-select waits for the Answer button', () => {
    const answers: string[] = [];
    const tree = render(ask({ multiSelect: true }), (t) => answers.push(t));
    press(tree, 'staging');
    expect(answers).toEqual([]);
    press(tree, 'prod');
    press(tree, 'Answer');
    expect(answers).toEqual(['1,2']);
    act(() => tree.unmount());
  });

  it('shows the words back, not the indices it sent', () => {
    const tree = render(ask(), () => {});
    press(tree, 'prod');
    expect(allText(tree)).toContain('prod');
    expect(allText(tree)).not.toContain('Answered: 2');
    act(() => tree.unmount());
  });

  it('a question with no choices is a free-text box', () => {
    const answers: string[] = [];
    const tree = render(ask({ choices: [], question: 'Why?' }), (t) => answers.push(t));
    expect(allText(tree)).toContain('Why?');
    act(() => tree.unmount());
  });

  it('renders an already-answered question without controls', () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<ClarifyWidget widget={ask()} answered="1" />);
    });
    expect(allText(tree!)).toContain('staging');
    expect(buttons(tree!)).toHaveLength(0);
    act(() => tree!.unmount());
  });
});
