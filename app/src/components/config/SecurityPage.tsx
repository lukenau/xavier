// Port of apps/hub/src/routes/config/SecurityPage.tsx — the Face-ID credential
// that gates the Terminal and every write (config.set, cron.*, gateway.*).
//
// The passkey card is READ-ONLY, and deliberately so. The PWA's card carries an
// "Enrol" button wired to `navigator.credentials.create` (api.enrollPasskey),
// which has no native twin at all: no passkey can exist for this RP in a
// TestFlight build (docs/research/passkeys.md). Wiring that button here would
// POST /passkey/register/options and then fail at a step that is never going to
// work, so it is the one piece of this page Task 18 did NOT port; everything
// else — status, copy, the refresh control — is verbatim.
//
// The SECOND card is the native replacement for that button: a Secure-Enclave
// device key, paired with a one-time code the PWA's own Security page mints
// behind a real passkey ceremony (src/lib/gate.ts, app/(home)/config/pair.tsx). It is
// the only entry point to that sheet — /config/pair is internal-only.
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useFocusEffect } from 'expo-router';
import {
  openSheet,
  PageTitle,
  PRESSED_OPACITY,
  RefreshControl,
  Screen,
  SectionHead,
  useHideTabBar,
} from '../shell';
import { api } from '../../lib/api';
import { readPairing, type Pairing } from '../../lib/gate';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { BackLink, ChevronRight, ConfigCard } from './parts';

export function SecurityPage() {
  useHideTabBar();
  const { t } = useTheme();
  const status = usePoll(['passkey-status'], api.passkeyStatus, QUERY_TUNING['passkey-status']);
  const [pairing, setPairing] = useState<Pairing | null>(null);

  // Re-read on focus, not just on mount: the pairing sheet is pushed on top of
  // this page and popped back onto it, so a mount-only read would leave the row
  // saying "Not paired" straight after a successful pairing.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void readPairing().then((p) => {
        if (!cancelled) setPairing(p);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  // The PWA renders "Not enrolled" while the query is still loading or has
  // failed — there is no pending/error panel on this page (inventory §13.5).
  // Reproduced: the flash is the PWA's behaviour.
  const registered = status.data?.registered ?? false;

  return (
    <Screen
      header={
        <>
          <BackLink />
          <PageTitle right={<RefreshControl queries={status} />}>Security</PageTitle>
        </>
      }
    >
      <SectionHead label="Passkey" count={registered ? 'enrolled' : 'not enrolled'} />
      <ConfigCard style={styles.card}>
        <View style={styles.row}>
          <View
            style={[styles.badge, { backgroundColor: t('accent-soft'), borderColor: t('accent-border') }]}
          >
            <SymbolView name="lock" size={18} tintColor={t('accent')} weight="regular" />
          </View>
          <View style={styles.text}>
            <Text style={[styles.title, { color: t('fg-0') }]}>Face ID passkey</Text>
            <Text style={[styles.sub, { color: t('fg-3') }]}>
              {registered
                ? 'Enrolled · gates Terminal + writes'
                : 'Not enrolled · required to unlock Terminal and edit config'}
            </Text>
          </View>
        </View>
      </ConfigCard>

      <SectionHead label="This iPhone" count={pairing ? 'paired' : 'not paired'} />
      <Pressable
        onPress={() => openSheet('/config/pair')}
        accessibilityRole="button"
        accessibilityLabel="Pair this iPhone"
        style={({ pressed }) => (pressed ? { opacity: PRESSED_OPACITY } : null)}
      >
        <ConfigCard style={styles.card}>
          <View style={styles.row}>
            <View
              style={[styles.badge, { backgroundColor: t('accent-soft'), borderColor: t('accent-border') }]}
            >
              <SymbolView name="iphone" size={18} tintColor={t('accent')} weight="regular" />
            </View>
            <View style={styles.text}>
              <Text style={[styles.title, { color: t('fg-0') }]}>Face ID device key</Text>
              <Text style={[styles.sub, { color: t('fg-3') }]}>
                {pairing
                  ? 'Paired · Face ID authorizes writes and Terminal'
                  : 'Not paired · writes and Terminal stay locked'}
              </Text>
            </View>
            <ChevronRight />
          </View>
        </ConfigCard>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 15, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  badge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.sans(550), fontSize: 14 },
  sub: { fontFamily: fonts.sans(400), fontSize: 12 },
});
