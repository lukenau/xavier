// The runtime server-address setting (Config › Server address). There is no
// PWA twin: the PWA is compiled against its own origin, while this native
// build can be pointed at ANY self-hoster's hub at runtime — so this screen
// is the native-only control for it (api.ts's user-set override).
//
// Everything on the screen is honest about state: the effective server and
// where it came from (user-set vs built-in) are always rendered, Save
// validates before it persists, and Test probes the address's /api/healthz
// and reports the outcome — success, an HTTP status, or the failure reason —
// without ever throwing into the UI.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SheetScreen, PRESSED_OPACITY } from '../shell';
import {
  clearUserApiBase,
  getUserApiBase,
  loadStoredApiBase,
  resolveApiBase,
  setUserApiBase,
  type ApiBaseSource,
} from '../../lib/api';
import { testServerConnection, validateServerUrl } from '../../lib/serverUrl';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

const SOURCE_LABEL: Record<ApiBaseSource, string> = {
  user: 'user-set',
  build: 'built-in · build',
  default: 'built-in · shipped default',
};

interface EffectiveServer {
  base: string;
  source: ApiBaseSource;
}

export function ServerPage() {
  const { t } = useTheme();
  const [value, setValue] = useState('');
  const [effective, setEffective] = useState<EffectiveServer | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [testLine, setTestLine] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadStoredApiBase().then(() => {
      if (cancelled) return;
      setEffective(resolveApiBase());
      setValue(getUserApiBase() ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function refreshEffective() {
    setEffective(resolveApiBase());
  }

  function clearMessages() {
    setError(null);
    setNote(null);
    setTestLine(null);
  }

  async function onSave() {
    setBusy('save');
    clearMessages();
    try {
      const check = await setUserApiBase(value);
      if (!check.ok) {
        setError(check.error);
        return;
      }
      refreshEffective();
      setNote(`Saved — this build now talks to ${check.url}.`);
    } finally {
      setBusy(null);
    }
  }

  async function onClear() {
    setBusy('clear');
    clearMessages();
    try {
      await clearUserApiBase();
      setValue('');
      refreshEffective();
      setNote('Cleared — falling back to the built-in server.');
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    setBusy('test');
    clearMessages();
    try {
      // The address in the field, if it validates; otherwise what the app is
      // actually using right now. Either way the line names what was probed.
      const input = value.trim();
      let target = resolveApiBase().base;
      if (input) {
        const check = validateServerUrl(input);
        if (!check.ok) {
          setError(check.error);
          return;
        }
        target = check.url;
      }
      const result = await testServerConnection(target);
      setTestLine({
        ok: result.ok,
        text: result.ok ? `${target} responded (HTTP ${result.status}).` : `${target}: ${result.reason}.`,
      });
    } finally {
      setBusy(null);
    }
  }

  const hasOverride = effective?.source === 'user';

  return (
    <SheetScreen eyebrow="Server" title="Server address">
      {/* (3): the effective server and its provenance, always visible so the
          state is never ambiguous. */}
      {effective ? (
        <View style={styles.effective}>
          <Text style={[styles.effectiveLabel, { color: t('fg-4') }]}>Effective server</Text>
          <Text style={[styles.effectiveBase, { color: t('fg-0') }]}>{effective.base}</Text>
          <Text
            style={[
              styles.effectiveSource,
              { color: effective.source === 'user' ? t('status-up') : t('fg-3') },
            ]}
          >
            {SOURCE_LABEL[effective.source]}
          </Text>
        </View>
      ) : null}

      <Text style={[styles.note, { color: t('fg-3') }]}>
        Point this build at any hub. https:// for any server; http:// only for localhost or 127.0.0.1.
        Clear to use the built-in address.
      </Text>

      <TextInput
        value={value}
        onChangeText={(v) => {
          setValue(v);
          clearMessages();
        }}
        placeholder="https://hub.example.com"
        placeholderTextColor={t('fg-4')}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        keyboardType="url"
        style={[styles.input, { backgroundColor: t('bg-2'), borderColor: t('border'), color: t('fg-0') }]}
      />

      <View style={styles.buttonRow}>
        <Pressable
          onPress={() => void onSave()}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel="Save server address"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: t('accent-soft'), borderColor: t('accent-border') },
            busy !== null && { opacity: 0.5 },
            pressed && busy === null && { opacity: PRESSED_OPACITY },
          ]}
        >
          <Text style={[styles.buttonLabel, { color: t('accent') }]}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => void onTest()}
          disabled={busy !== null}
          accessibilityRole="button"
          accessibilityLabel="Test server connection"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: t('bg-1'), borderColor: t('border-strong') },
            busy !== null && { opacity: 0.5 },
            pressed && busy === null && { opacity: PRESSED_OPACITY },
          ]}
        >
          <Text style={[styles.buttonLabel, { color: t('fg-1') }]}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => void onClear()}
          disabled={busy !== null || !hasOverride}
          accessibilityRole="button"
          accessibilityLabel="Clear server address"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: t('bg-1'), borderColor: t('border-strong') },
            (busy !== null || !hasOverride) && { opacity: 0.5 },
            pressed && busy === null && hasOverride && { opacity: PRESSED_OPACITY },
          ]}
        >
          <Text style={[styles.buttonLabel, { color: t('fg-1') }]}>
            {busy === 'clear' ? 'Clearing…' : 'Clear'}
          </Text>
        </Pressable>
      </View>

      {error ? <Text style={[styles.error, { color: t('status-down') }]}>{error}</Text> : null}
      {note ? <Text style={[styles.note, { color: t('status-up') }]}>{note}</Text> : null}
      {testLine ? (
        <Text style={[styles.note, { color: testLine.ok ? t('status-up') : t('status-down') }]}>
          {testLine.text}
        </Text>
      ) : null}
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  effective: { marginBottom: 14 },
  effectiveLabel: { fontFamily: fonts.sans(550), fontSize: 11, marginBottom: 3 },
  effectiveBase: { fontFamily: fonts.mono(500), fontSize: 14, marginBottom: 2 },
  effectiveSource: { fontFamily: fonts.sans(500), fontSize: 12 },
  note: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 18, paddingHorizontal: 4, marginBottom: 12 },
  input: {
    width: '100%',
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontFamily: fonts.mono(500),
    fontSize: 15,
    marginBottom: 12,
  },
  buttonRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  button: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontFamily: fonts.sans(550), fontSize: 13 },
  error: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 18, paddingHorizontal: 4, marginBottom: 12 },
});
