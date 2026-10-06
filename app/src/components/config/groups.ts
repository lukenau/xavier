// 1:1 port of apps/hub/src/routes/Config.tsx — the section→group map behind
// the whole Config IA. Not a src/shared/ verbatim copy: the PWA file lives
// under routes/ (not lib/), so it is outside check-shared-parity's PAIRS
// list. Keep it in step with the PWA by hand.
//
// Explicit section→group assignment by name — no prefix guessing — and any
// section a future hermes upgrade adds falls into 'misc' (Everything else),
// never an orphan row. TELEGRAM_HOME_CHANNEL is case-sensitive in the live tree.

export interface ConfigGroup {
  id: string;
  label: string;
  sub: string;
  sections: string[];
}

export const CONFIG_GROUPS: ConfigGroup[] = [
  {
    id: 'model',
    label: 'Model & routing',
    sub: 'Which brain Xavier runs — default, fallbacks, aux models, advisor',
    sections: ['model', 'fallback_providers', 'auxiliary', 'advisor', 'delegation', 'prompt_caching'],
  },
  {
    id: 'behavior',
    label: 'Behavior',
    sub: 'Turn limits, reasoning effort, guardrails, compression',
    sections: ['agent', 'tool_loop_guardrails', 'compression', 'code_execution', 'streaming'],
  },
  {
    id: 'memory',
    label: 'Memory & sessions',
    sub: 'What Xavier remembers and when chats reset',
    sections: ['memory', 'curator', 'session_reset', 'sessions', 'group_sessions_per_user'],
  },
  {
    id: 'channels',
    label: 'Channels',
    sub: 'Telegram and how messages render',
    sections: ['telegram', 'TELEGRAM_HOME_CHANNEL', 'display', 'platform_toolsets'],
  },
  {
    id: 'tools',
    label: 'Tools',
    sub: 'Shell, browser, voice, MCP servers, skills, plugins',
    sections: ['terminal', 'browser', 'stt', 'mcp_servers', 'skills', 'plugins'],
  },
  {
    id: 'security',
    label: 'Security & approvals',
    sub: 'Approval gates and the command allowlist',
    sections: ['approvals', 'command_allowlist'],
  },
  {
    id: 'gateway',
    label: 'Gateway & housekeeping',
    sub: 'Dashboard, cron engine, updates, timezone',
    sections: ['gateway', 'dashboard', 'cron', 'updates', 'timezone'],
  },
  {
    id: 'misc',
    label: 'Everything else',
    sub: 'Internals and shipped defaults — rarely touched',
    sections: ['onboarding', '_config_version', 'known_plugin_toolsets'],
  },
];

const SECTION_TO_GROUP = new Map<string, string>();
for (const g of CONFIG_GROUPS) for (const s of g.sections) SECTION_TO_GROUP.set(s, g.id);

export function configGroupOf(sectionId: string): string {
  return SECTION_TO_GROUP.get(sectionId) ?? 'misc';
}

export function configGroupLabel(groupId: string): string {
  return CONFIG_GROUPS.find((g) => g.id === groupId)?.label ?? groupId;
}

/** The live special pages, nested under the group each one serves
 * (ConfigHome.tsx:18-28). Labelled by what they DO so they never collide with
 * the group's own settings row. */
export const PAGE_ROWS: Record<string, { href: string; label: string; sub: string }[]> = {
  model: [{ href: '/config/advisor', label: 'Advisor presets', sub: 'executor + reviewer pairing · applies live' }],
  memory: [{ href: '/config/memory', label: 'Memory status (live)', sub: 'provider · what Xavier holds right now' }],
  channels: [{ href: '/config/routing', label: 'Telegram routing', sub: 'where cron + alert deliveries land · topics' }],
  security: [{ href: '/config/security', label: 'Passkeys & Face ID', sub: 'device credentials for the write gate' }],
  gateway: [
    { href: '/config/system', label: 'System status (live)', sub: 'skills · plugins · mcp · doctor' },
    { href: '/config/connectors', label: 'Connectors', sub: 'providers · oauth · mcp auth' },
    { href: '/config/pages', label: 'Hosted pages', sub: 'html under /my-pages' },
  ],
};
