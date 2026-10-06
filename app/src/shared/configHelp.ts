// VERBATIM COPY of apps/hub/src/lib/configHelp.ts (PWA). Do not edit by hand:
// scripts/check-shared-parity.mjs compares this file to the source and
// fails on any difference beyond the two allowed transforms — import
// paths, and `var(--token)` rewritten to the bare token name for
// src/theme's resolveToken(). Change the PWA first, then re-copy.
// --- end copy header; everything below is verbatim ---
// Curated help copy for the Config settings surface. Key = the full dotted
// config key (matches ConfigFullLeaf.key verbatim — TELEGRAM_HOME_CHANNEL is
// case-sensitive in the live tree). `domain` feeds the enum-pill picker;
// `tier` marks consequence weight (caution = status-warn dot, danger =
// status-down dot) and swaps the generic edit copy for `desc`.

export interface ConfigHelp {
  desc: string;
  default?: string;
  unit?: string;
  domain?: string[];
  tier?: 'caution' | 'danger';
}

export const CONFIG_HELP: Record<string, ConfigHelp> = {
  'model.default': {
    desc: "The model Xavier runs everything on. Provider-qualified when routing via OpenRouter (anthropic/claude-opus-4.8).",
    tier: 'caution',
  },
  'model.provider': {
    desc: "Which provider plugin carries chat traffic — must match model.default's id format. A typo here takes Xavier offline.",
    tier: 'danger',
  },
  'agent.max_turns': {
    desc: 'Max tool-calling iterations per conversation. 20–30 focused, 50–100 open exploration; higher = more tokens.',
    default: '30',
  },
  'agent.reasoning_effort': {
    desc: 'Pre-response thinking depth. Higher = smarter, slower, pricier.',
    domain: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  },
  'agent.verify_on_stop': {
    desc: 'Nudge to verify code edits before finishing. auto = on for coding surfaces, off for chat.',
    domain: ['auto', 'true', 'false'],
  },
  'compression.enabled': {
    desc: 'Auto-summarise the middle of long conversations near the context limit. Off = overflow errors possible.',
  },
  'compression.threshold': {
    desc: 'Trigger at this fraction of the context window (0.5 = 50%). Sub-512K models floor at 0.75.',
    unit: 'fraction',
  },
  'compression.protect_last_n': {
    desc: 'Most-recent messages never summarised (20 ≈ 10 turns).',
  },
  'prompt_caching.cache_ttl': {
    desc: 'Anthropic cache lifetime: 5m or 1h only — anything else silently means 5m.',
    domain: ['5m', '1h'],
  },
  'memory.memory_enabled': {
    desc: "Xavier's persistent notes, injected every session.",
  },
  'memory.write_approval': {
    desc: 'Require your OK before Xavier saves a memory. Off = silent saves.',
    tier: 'caution',
  },
  'memory.flush_min_turns': {
    desc: 'Sessions shorter than this skip the save-memories turn on reset/exit.',
  },
  'advisor.enabled': {
    desc: 'Pairs the executor with a stronger Opus reviewer. Anthropic direct API only — not OpenRouter. Needs a gateway restart.',
    tier: 'caution',
  },
  'advisor.max_uses': {
    desc: 'Advisor consultations per request. 0 = unlimited; 2–3 for cost control.',
  },
  'approvals.mode': {
    desc: "'manual' holds risky agent actions for your approval. Relaxing this removes the human gate. Note: 'ask' is not a valid value — hermes ignores it.",
    tier: 'danger',
  },
  'terminal.backend': {
    desc: "Where Xavier's shell runs: local = inside the gateway container. Governs blast radius of agent commands.",
    tier: 'danger',
  },
  'terminal.timeout': {
    desc: 'Seconds before a shell command is killed.',
    unit: 's',
    default: '180',
  },
  'session_reset.mode': {
    desc: 'When platform chats auto-clear (both = idle or daily 4am). Memories are saved first.',
  },
  'session_reset.idle_minutes': {
    desc: 'Minutes of inactivity before a chat session resets (1440 = 24h).',
    unit: 'min',
  },
  TELEGRAM_HOME_CHANNEL: {
    desc: 'Chat ID Xavier calls home for proactive messages — wrong ID sends them elsewhere.',
    tier: 'danger',
  },
  'tool_loop_guardrails.hard_stop_enabled': {
    desc: 'The runaway-loop brake: stops the agent when a tool call keeps failing. Leave on.',
    tier: 'caution',
  },
  'stt.enabled': {
    desc: 'Transcribe voice notes into turns.',
  },
};
