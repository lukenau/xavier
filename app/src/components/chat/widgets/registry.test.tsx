// Skia has no native module under jest (TurboModuleRegistry.getEnforcing throws
// at import time) and this file imports the whole registry, so the chart pulls
// it in. Same stand-in as chartTable.test.tsx.
jest.mock('@shopify/react-native-skia', () => {
  const React = require('react');
  const { View } = require('react-native');
  const node =
    (name: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (props: any) =>
      React.createElement(View, { testID: name, ...props }, props.children);
  return {
    Canvas: node('sk-canvas'),
    Group: node('sk-group'),
    Line: node('sk-line'),
    Path: node('sk-path'),
    Rect: node('sk-rect'),
    RoundedRect: node('sk-rrect'),
    Circle: node('sk-circle'),
    Text: node('sk-text'),
    vec: (x: number, y: number) => ({ x, y }),
    useFont: () => ({
      measureText: (text: string) => ({ x: 0, y: 0, width: text.length * 6, height: 10 }),
    }),
  };
});

import { create, act } from 'react-test-renderer';
import { Text } from 'react-native';
import { WidgetPartView } from './index';
import type { WidgetPart } from '../../../chat/types';

function texts(part: WidgetPart): string[] {
  let tree: ReturnType<typeof create> | undefined;
  act(() => {
    tree = create(<WidgetPartView part={part} threadId="thr_1" />);
  });
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
  };
  tree!.root.findAllByType(Text).forEach((n) => walk(n.props.children));
  act(() => tree!.unmount());
  return out;
}

describe('WidgetPartView — every catalog kind reaches a renderer', () => {
  it('draws a card', () => {
    expect(texts({ type: 'widget', kind: 'card', props: { title: 'Budget' } })).toContain('Budget');
  });
  it('draws a metric', () => {
    expect(texts({ type: 'widget', kind: 'metric', props: { label: 'Spend', value: '14' } })).toContain('14');
  });
  it('draws a table', () => {
    expect(texts({ type: 'widget', kind: 'table', props: { columns: ['Day'], rows: [['Mon']] } })).toContain('Mon');
  });
  it('draws a progress bar', () => {
    expect(texts({ type: 'widget', kind: 'progress', props: { label: 'Backfill', value: 25 } })).toContain('Backfill');
  });
  it('draws a link', () => {
    expect(texts({ type: 'widget', kind: 'link', props: { url: 'https://x.test', title: 'Docs' } })).toContain('Docs');
  });
  it('draws a button row', () => {
    expect(texts({ type: 'widget', kind: 'button_row', props: { buttons: ['Go'] } })).toContain('Go');
  });
  it('draws a poll', () => {
    expect(texts({ type: 'widget', kind: 'poll', props: { question: 'Which?', options: ['a', 'b'] } })).toContain('Which?');
  });
  it('draws a checklist', () => {
    expect(texts({ type: 'widget', kind: 'checklist', props: { items: ['ship it'] } })).toContain('ship it');
  });
  it('draws a timeline', () => {
    const part: WidgetPart = {
      type: 'widget',
      kind: 'timeline',
      props: { title: 'Order 114-77', items: [{ time: 'Mon 9:04 AM', label: 'Placed' }, { label: 'Shipped' }] },
    };
    expect(texts(part)).toEqual(expect.arrayContaining(['Order 114-77', 'Mon 9:04 AM', 'Placed', 'Shipped']));
  });
  it('draws a calendar', () => {
    const part: WidgetPart = {
      type: 'widget',
      kind: 'calendar',
      props: { days: [{ date: '2026-09-22', events: [{ title: 'Standup', start: '09:30' }] }] },
    };
    expect(texts(part)).toContain('Standup');
  });
  it('draws a form', () => {
    expect(texts({ type: 'widget', kind: 'form', props: { fields: [{ label: 'Name' }] } })).toContain('Name');
  });
  it('draws a chart without crashing', () => {
    const part: WidgetPart = {
      type: 'widget',
      kind: 'chart',
      props: { title: 'Spend', series: [{ id: 'a', label: 'A' }], buckets: [{ key: 'Mon', value: 3 }] },
    };
    expect(texts(part)).toContain('Spend');
  });

  it('draws a clarify question', () => {
    const part: WidgetPart = {
      type: 'widget',
      kind: 'clarify',
      widget_id: 'clr_1',
      question: 'Which env?',
      choices: ['staging', 'prod'],
    };
    expect(texts(part)).toEqual(expect.arrayContaining(['Which env?', 'staging', 'prod']));
  });

  it('says so rather than leaving a hole when it cannot draw the payload', () => {
    expect(texts({ type: 'widget', kind: 'teapot', props: {} }).join(' ')).toMatch(/could not draw/i);
    expect(texts({ type: 'widget', kind: 'card', props: {} }).join(' ')).toMatch(/could not draw/i);
  });
});
