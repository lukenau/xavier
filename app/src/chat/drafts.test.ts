// chat/drafts.ts — the one place that recognises an iMessage draft approval.
// Each case here pins a wire tolerance the UI relies on: the server's tool
// schema names `to`/`text` but its `args` is untyped `unknown` at the boundary,
// so a missing or odd shape must degrade to "no details", never throw.
import {
  DRAFT_ATTENTION_KIND,
  draftDetailsFromArgs,
  draftDetailsFromPart,
  draftRows,
  isDraftAttentionKind,
  isDraftToolCall,
} from './drafts';
import type { Part, ToolCallPart } from './types';

function tool(over: Partial<ToolCallPart> = {}): ToolCallPart {
  return { type: 'tool_call', tool_name: 'draft_imessage', ...over };
}

describe('recognition', () => {
  test('only the draft kind is a draft kind', () => {
    expect(isDraftAttentionKind(DRAFT_ATTENTION_KIND)).toBe(true);
    expect(isDraftAttentionKind('approval')).toBe(false);
    expect(isDraftAttentionKind(null)).toBe(false);
    expect(isDraftAttentionKind(undefined)).toBe(false);
  });

  test('a tool_call is the draft iff its tool_name is the iMessage MCP tool', () => {
    expect(isDraftToolCall(tool())).toBe(true);
    expect(isDraftToolCall(tool({ tool_name: 'imessage_draft' }))).toBe(true);
    expect(isDraftToolCall(tool({ tool_name: 'terminal' }))).toBe(false);
    expect(isDraftToolCall({ type: 'text', text: 'hi' } as Part)).toBe(false);
  });
});

describe('details', () => {
  test('reads the recipient, body and Mac draft id the tool was called with', () => {
    expect(draftDetailsFromArgs({ to: 'Mom', text: 'running late', draft_id: 42 })).toEqual({
      to: 'Mom',
      text: 'running late',
      draft_id: 42,
    });
  });

  test('tolerates the server spelling the same fields another way', () => {
    expect(draftDetailsFromArgs({ contact: 'Alex', body: 'on my way', id: '7' })).toEqual({
      to: 'Alex',
      text: 'on my way',
      draft_id: 7,
    });
  });

  test('a non-object args is all-null, never a throw', () => {
    expect(draftDetailsFromArgs(undefined)).toEqual({ to: null, text: null, draft_id: null });
    expect(draftDetailsFromArgs('nope')).toEqual({ to: null, text: null, draft_id: null });
    expect(draftDetailsFromArgs(null)).toEqual({ to: null, text: null, draft_id: null });
  });

  test('a part that is not a draft tool call yields no details', () => {
    expect(draftDetailsFromPart(undefined)).toBeNull();
    expect(draftDetailsFromPart(tool({ tool_name: 'terminal' }))).toBeNull();
    expect(draftDetailsFromPart(tool({ args: { to: 'Sam', text: 'yo' } }))).toEqual({
      to: 'Sam',
      text: 'yo',
      draft_id: null,
    });
  });
});

describe('inbox rows', () => {
  test('keeps only the draft kind, in order', () => {
    const rows = [{ kind: 'approval' }, { kind: 'imessage_draft' }, { kind: 'mention' }];
    expect(draftRows(rows)).toEqual([{ kind: 'imessage_draft' }]);
  });
});
