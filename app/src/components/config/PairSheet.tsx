// Pair this iPhone with the hub — the enrolment half of the Face ID write gate
// (src/lib/gate.ts). There is no PWA twin: the PWA enrols a passkey, which has
// no native equivalent for this RP (docs/research/passkeys.md), so this sheet
// is the native replacement for that ceremony.
//
// The flow, end to end: the user mints a one-time code on the server machine
// (`./install.sh --pair`, or the WebAuthn-gated Security page of an optional
// web UI); he types those 6 characters here; the app generates a Secure-Enclave
// P-256 key and posts the public half with the code to /api/devicekey/register.
// The human ceremony — a host shell or a passkey assertion — is what vouches
// for the key; this screen holds no authority of its own, and the code is
// single-use, TTL-bound and rate-limited server-side (server/devicekeys.py).
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { SheetScreen, PRESSED_OPACITY } from '../shell';
import { enrol, readPairing, type Pairing } from '../../lib/gate';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

/** devicekeys.py `_CODE_LEN` / `_CODE_ALPHABET`: 6 chars, Crockford-style
 * (no I, O, 0 or 1 to mistype). Filtering here is a convenience, not a check —
 * the server is what decides whether a code is real. */
const CODE_LEN = 6;
const CODE_ALPHABET = /[^A-HJ-NP-Z2-9]/g;

function relDay(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function PairSheet() {
  const { t } = useTheme();
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readPairing().then((p) => {
      if (!cancelled) setPairing(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const ready = code.length === CODE_LEN && !busy;

  async function onPair() {
    setBusy(true);
    setError(null);
    try {
      const next = await enrol(code, 'iPhone');
      setPairing(next);
      setDone(true);
      setCode('');
    } catch (err) {
      // Clear it here too, not only on success: the code is single-use and
      // TTL-bound, so a failed attempt leaves a value that is now worthless and
      // worth nothing to keep in memory. Retrying always means a NEW code.
      setCode('');
      setError(err instanceof Error ? err.message : 'Pairing failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SheetScreen eyebrow="Security" title="Pair this iPhone">
      {done ? (
        <View style={styles.okRow}>
          <SymbolView name="checkmark" size={16} tintColor={t('status-up')} weight="semibold" />
          <Text style={[styles.okLabel, { color: t('status-up') }]}>
            Paired. Face ID now authorizes writes from this iPhone.
          </Text>
        </View>
      ) : null}

      <Text style={[styles.note, { color: t('fg-3') }]}>
        On the server, run ./install.sh --pair to mint a one-time code, then type it here before the
        countdown runs out.
      </Text>

      <TextInput
        value={code}
        onChangeText={(v) => setCode(v.toUpperCase().replace(CODE_ALPHABET, '').slice(0, CODE_LEN))}
        placeholder="ABC234"
        placeholderTextColor={t('fg-4')}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        maxLength={CODE_LEN}
        style={[styles.input, { backgroundColor: t('bg-2'), borderColor: t('border'), color: t('fg-0') }]}
      />

      <Pressable
        onPress={onPair}
        disabled={!ready}
        accessibilityRole="button"
        accessibilityLabel="Pair this iPhone"
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: t('accent-soft'), borderColor: t('accent-border') },
          !ready && { opacity: 0.5 },
          pressed && ready && { opacity: PRESSED_OPACITY },
        ]}
      >
        <Text style={[styles.buttonLabel, { color: t('accent') }]}>{busy ? 'Pairing…' : 'Pair'}</Text>
      </Pressable>

      {error ? <Text style={[styles.error, { color: t('status-down') }]}>{error}</Text> : null}

      {pairing && !done ? (
        <Text style={[styles.note, { color: t('fg-4') }]}>
          Already paired as “{pairing.label}”{relDay(pairing.paired_at) ? ` on ${relDay(pairing.paired_at)}` : ''}.
          Pairing again mints a new key and retires this one — the old record stays on the hub until
          it is revoked from the PWA.
        </Text>
      ) : null}
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  okRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 4, paddingBottom: 12 },
  okLabel: { fontFamily: fonts.sans(550), fontSize: 13, flex: 1 },
  note: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 18, paddingHorizontal: 4, marginBottom: 12 },
  input: {
    width: '100%',
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    fontFamily: fonts.mono(600),
    fontSize: 22,
    letterSpacing: 4,
    textAlign: 'center',
    marginBottom: 12,
  },
  button: {
    width: '100%',
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  buttonLabel: { fontFamily: fonts.sans(600), fontSize: 13.5 },
  error: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 18, paddingHorizontal: 4, marginBottom: 12 },
});
