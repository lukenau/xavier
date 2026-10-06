// One source of truth for the Live voice settings, shared by the running Live
// screen and the settings sheet route.
//
// The sheet (`app/(home)/live-settings.tsx`) is not a child of the screen: it
// is a sibling screen pushed over it, so both sides subscribe here. The sheet
// writes through `update`, and the running screen sees the new object without
// a remount. `update` takes the next WHOLE settings object (never a mutation)
// and persists it through voices.ts's `saveVoiceSettings`.
import { create } from 'zustand';
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '../lib/live/settings';
import { loadVoiceSettings, saveVoiceSettings } from '../components/chat/voices';

interface VoiceSettingsState {
  /** Always defined: the defaults stand in until the stored blob lands, so no
   * caller ever has to branch on `null`. */
  settings: VoiceSettings;
  hydrated: boolean;
  hydrating: boolean;
  /** Reads the persisted blob once (idempotent; concurrent calls collapse). */
  hydrate: () => Promise<void>;
  /** The next whole object; persists in the background. */
  update: (next: VoiceSettings) => void;
}

export const useVoiceSettings = create<VoiceSettingsState>((set, get) => ({
  settings: DEFAULT_VOICE_SETTINGS,
  hydrated: false,
  hydrating: false,

  hydrate: async () => {
    if (get().hydrated || get().hydrating) return;
    set({ hydrating: true });
    const settings = await loadVoiceSettings();
    set({ settings, hydrated: true, hydrating: false });
  },

  update: (next) => {
    set({ settings: next });
    // saveVoiceSettings swallows its own storage failures: the in-memory value
    // is what the session uses, persistence is best-effort (voices.ts).
    void saveVoiceSettings(next);
  },
}));
