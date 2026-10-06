// The Live settings BODY: the controls the Live pipeline actually honours,
// Flux voice, speed, expressivity, voice replies.
// Turn-taking, language and reply length are not settings: Flux listens
// continuously, Live is English, and brevity comes from the spoken-style note
// the server sends with every voice turn. The voices are Flux voices because
// the streaming endpoint (/v2/speak) only takes flux-* models.
// Every change calls `onChange` with the next whole settings object; the
// caller is the shared store (src/chat/voiceSettings.ts), which persists it
// (voices.ts's saveVoiceSettings) and feeds it to the running Live screen.
//
// The CONTAINER lives in `app/(home)/live-settings.tsx` as a native route
// sheet (SheetScreen + sheetScreenOptions), not here. As a route it is a
// sibling screen over the Live page, which is why the settings are shared
// state and why the two halves are split: a form sheet is inset by the system
// and cannot collide with the status bar.
//
// Speed and expressivity are CHIP rows, not drag sliders: RN core has no
// Slider, a slider library would be one more native module, and a
// PanResponder drag handle is more gesture surface than a 0.75–1.25 range
// earns. Five chips cover the range and read fine one-handed.
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import type { VoiceSettings } from '../../lib/live/settings';
import { FLUX_VOICES, findVoice, type VoiceEntry } from './voices';
import { PRESSED_OPACITY } from '../shell';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

export const SPEED_STEPS = [0.75, 0.9, 1.0, 1.15, 1.25];
export const EXPRESSIVITY_STEPS = [-2, -1, 0, 1, 2];

export interface VoiceSettingsBodyProps {
  settings: VoiceSettings;
  /** The next whole settings object — the body never mutates in place. */
  onChange: (next: VoiceSettings) => void;
  /** Sample playback for one voice. Optional, and the route does not wire it
   * yet: without it the rows show no sample button rather than a dead one. */
  onSample?: (voiceId: string) => void;
}

/** Chip label helpers, pure and exported for the tests. */
export function speedLabel(v: number): string {
  return v === 1.0 ? '1.0×' : `${v.toFixed(2).replace(/0$/, '')}×`;
}

export function expressivityLabel(v: number): string {
  if (v === 0) return 'tuned';
  return v > 0 ? `+${v}` : String(v);
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionLabel, { color: t('fg-4') }]}>{label}</Text>
      {children}
    </View>
  );
}

function Chips<T extends string | number>({
  value,
  options,
  labelOf,
  onPick,
}: {
  value: T;
  options: readonly T[];
  labelOf: (v: T) => string;
  onPick: (v: T) => void;
}) {
  const { t } = useTheme();
  return (
    <View style={styles.chipRow}>
      {options.map((option) => {
        const chosen = option === value;
        return (
          <Pressable
            key={String(option)}
            accessibilityRole="button"
            accessibilityLabel={labelOf(option)}
            accessibilityState={{ selected: chosen }}
            onPress={() => onPick(option)}
            style={({ pressed }) => [
              styles.chip,
              {
                backgroundColor: chosen ? t('accent-soft') : t('bg-2'),
                borderColor: chosen ? t('accent') : t('border'),
              },
              pressed && { opacity: PRESSED_OPACITY },
            ]}
          >
            <Text style={[styles.chipLabel, { color: chosen ? t('accent') : t('fg-1') }]}>
              {labelOf(option)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function VoiceRow({
  voice,
  chosen,
  onPick,
  onSample,
}: {
  voice: VoiceEntry;
  chosen: boolean;
  onPick: () => void;
  onSample?: (id: string) => void;
}) {
  const { t } = useTheme();
  return (
    <View style={[styles.voiceRow, { borderBottomColor: t('border') }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Voice ${voice.name}`}
        accessibilityState={{ selected: chosen }}
        onPress={onPick}
        style={({ pressed }) => [styles.voiceMain, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <Text style={[styles.voiceName, { color: chosen ? t('accent') : t('fg-0') }]}>
          {voice.name}
          {chosen ? ' ✓' : ''}
        </Text>
        <Text style={[styles.voiceMeta, { color: t('fg-4') }]}>
          {voice.accent} · {voice.gender}
        </Text>
      </Pressable>
      {onSample ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Sample ${voice.name}`}
          accessibilityHint="Plays a short sample of this voice"
          onPress={() => onSample(voice.id)}
          style={({ pressed }) => [styles.sampleButton, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.sampleLabel, { color: t('petrol') }]}>sample</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function VoiceSettingsBody({ settings, onChange, onSample }: VoiceSettingsBodyProps) {
  const { t } = useTheme();
  const pickTts = <K extends keyof VoiceSettings['tts']>(key: K, value: VoiceSettings['tts'][K]) =>
    onChange({ ...settings, tts: { ...settings.tts, [key]: value } });
  const current = findVoice(settings.tts.voice);

  return (
    <View>
      <Section label={`VOICE — ${current ? current.name : settings.tts.voice}`}>
        <View>
          {FLUX_VOICES.map((voice) => (
            <VoiceRow
              key={voice.id}
              voice={voice}
              chosen={voice.id === settings.tts.voice}
              onPick={() => pickTts('voice', voice.id)}
              onSample={onSample}
            />
          ))}
        </View>
      </Section>

      <Section label="SPEED">
        <Chips
          value={settings.tts.speed}
          options={SPEED_STEPS}
          labelOf={speedLabel}
          onPick={(v) => pickTts('speed', v)}
        />
      </Section>

      <Section label="EXPRESSIVITY">
        <Chips
          value={settings.tts.expressivity}
          options={EXPRESSIVITY_STEPS}
          labelOf={expressivityLabel}
          onPick={(v) => pickTts('expressivity', v)}
        />
      </Section>

      <View style={[styles.switchRow, { borderBottomColor: t('border') }]}>
        <Text style={[styles.switchLabel, { color: t('fg-0') }]}>Voice replies</Text>
        <Switch
          accessibilityLabel="Voice replies"
          value={settings.tts.enabled}
          onValueChange={(v) => pickTts('enabled', v)}
          trackColor={{ false: t('bg-2'), true: t('accent-soft') }}
          thumbColor={settings.tts.enabled ? t('accent') : t('fg-3')}
        />
      </View>

      <Text style={[styles.footnote, { color: t('fg-4') }]}>
        Applies on the next Live session — one already running keeps its config.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 20 },
  sectionLabel: { fontFamily: fonts.sans(500), fontSize: 11, letterSpacing: 0.6, marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 7 },
  chipLabel: { fontFamily: fonts.sans(500), fontSize: 13 },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    minHeight: 48,
  },
  voiceMain: { flex: 1, minWidth: 0, paddingVertical: 10 },
  voiceName: { fontFamily: fonts.sans(500), fontSize: 15 },
  voiceMeta: { fontFamily: fonts.sans(400), fontSize: 11, marginTop: 1 },
  sampleButton: { minWidth: 64, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  sampleLabel: { fontFamily: fonts.sans(500), fontSize: 13 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    paddingVertical: 10,
    marginBottom: 20,
  },
  switchLabel: { fontFamily: fonts.sans(500), fontSize: 15 },
  footnote: { fontFamily: fonts.sans(400), fontSize: 11, marginTop: 4 },
});
