// The line under the Chat title: is Xavier up, is he working, and is this
// screen still hearing from him. Both halves are state the app already holds —
// `/api/vitals` (the same read Home's XavierCard uses) and the chat socket's
// own connection status — so nothing here is a guess about a thread.
//
// Pure, for the same reason home/xavierState.ts is: the rule is worth testing
// without mounting the screen.
import type { ChatConnStatus } from '../../chat/wsClient';
import type { Vitals } from '../../lib/types';
import type { TokenName } from '../../theme/tokens.gen';

export interface AgentStatus {
  label: string;
  tone: TokenName;
}

// A healthy socket is not news, so it says nothing; a broken one names itself
// as the chat connection rather than borrowing the agent's sentence.
const CONNECTION_NOTE: Record<ChatConnStatus, string | null> = {
  connected: null,
  connecting: 'connecting to chat…',
  closed: 'chat offline, not updating',
  error: 'chat offline, not updating',
};

export function agentStatus(vitals: Vitals | undefined, connection: ChatConnStatus): AgentStatus {
  const name = vitals?.agent.name ?? 'Xavier';
  const status = vitals?.agent.status;
  const note = CONNECTION_NOTE[connection];
  const say = (agent: string) => (note ? `${agent} · ${note}` : agent);

  // Gateway down outranks everything: a live socket to hub-api says nothing
  // about whether the agent behind it can answer.
  if (status === 'down') return { label: say(`${name} is unreachable`), tone: 'status-down' };
  if (status === undefined || status === 'unknown') {
    return { label: say(`${name}'s status is unknown`), tone: 'fg-4' };
  }
  const busy = vitals?.agent.busy ?? false;
  return {
    label: say(`${name} ${busy ? 'is working' : 'is idle'}`),
    tone: connection === 'connected' ? (busy ? 'status-up' : 'fg-4') : 'status-warn',
  };
}
