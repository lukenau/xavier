// ConnectorsPage.tsx:41-182's DeviceCodeSheet as a route.
//
// Mount → Face ID → POST /api/connectors/{id}/connect (which runs a detached
// `hermes auth add {id} --no-browser` inside the gateway) → poll
// /oauth-status with the poll token /connect returned, every 3s, for the user
// code + verification URL, then until the
// provider reports connected. Dismissing the sheet stops the polling; the
// detached login keeps running inside the gateway (bridge.py:943-957).
//
// Two web primitives are swapped for their native twins:
//   • `navigator.clipboard.writeText` → RN's Clipboard (deprecated in RN core
//     but present in 0.86, and neither @react-native-clipboard/clipboard nor
//     expo-clipboard is installed — installing one was out of scope for this
//     task). Same silent-failure behaviour: a copy that throws is ignored.
//   • `<a target="_blank">` → expo-web-browser's SFSafariViewController.
import { useEffect, useRef, useState } from 'react';
import { Animated, Clipboard, Pressable, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useQueryClient } from '@tanstack/react-query';
import { SymbolView } from 'expo-symbols';
import { PRESSED_OPACITY, SheetScreen, StatePanel, useSpinRotation } from '../shell';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import type { OauthStatus } from '../../lib/types';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { COPIED_MS, hostnameOf, OAUTH_POLL_MS } from './connectors';

function Spinner() {
  const { t } = useTheme();
  const rotate = useSpinRotation();
  return (
    <Animated.View
      style={[
        styles.spinner,
        { borderColor: t('border-strong'), borderTopColor: t('accent') },
        { transform: [{ rotate }] },
      ]}
    />
  );
}

export function DeviceCodeSheet({ providerId }: { providerId: string }) {
  const { t } = useTheme();
  const qc = useQueryClient();
  // Cache-shared with ConnectorsPage (staleTime 20s), so pushing this sheet
  // does not refetch the connector list just to learn the provider's name.
  const connectors = usePoll(['connectors'], api.connectors, QUERY_TUNING.connectors);
  const provider = connectors.data?.providers.find((p) => p.id === providerId);

  const [status, setStatus] = useState<OauthStatus>({ stage: 'pending', url: null, code: null });
  const [startError, setStartError] = useState<string | null>(null);
  const [pollToken, setPollToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus({ stage: 'pending', url: null, code: null });
    setStartError(null);
    setPollToken(null);
    setCopied(false);
    api
      .connectorConnect(providerId)
      .then((started) => {
        if (!cancelled) setPollToken(started.poll_token);
      })
      .catch((err: unknown) => {
        if (!cancelled) setStartError(err instanceof Error ? err.message : 'Could not start the device-code flow.');
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, attempt]);

  const polling = !startError && pollToken !== null && status.stage === 'pending';

  useEffect(() => {
    if (!polling || pollToken === null) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.connectorOauthStatus(providerId, pollToken);
        if (cancelled) return;
        setStatus(next);
        if (next.stage === 'connected') qc.invalidateQueries({ queryKey: ['connectors'] });
      } catch {
        // transient poll failure — keep the interval running
      }
    };
    void poll();
    const timer = setInterval(poll, OAUTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [providerId, attempt, polling, pollToken, qc]);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  function copyCode() {
    if (!status.code) return;
    try {
      Clipboard.setString(status.code);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // the PWA swallows a failed clipboard write too
    }
  }

  const failed = startError !== null || status.stage === 'failed';

  return (
    <SheetScreen eyebrow="Device code" title={provider?.name ?? providerId}>
      {failed ? (
        <>
          <StatePanel
            tone="error"
            title="Connection failed"
            detail={startError ?? status.error ?? 'The provider rejected the request.'}
          />
          <Pressable
            onPress={() => setAttempt((a) => a + 1)}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.retry,
              { backgroundColor: t('bg-2'), borderColor: t('border-strong') },
              pressed && { opacity: PRESSED_OPACITY },
            ]}
          >
            <Text style={[styles.retryLabel, { color: t('fg-1') }]}>Retry</Text>
          </Pressable>
        </>
      ) : status.stage === 'connected' ? (
        <View style={styles.connectedRow}>
          <SymbolView name="checkmark" size={16} tintColor={t('status-up')} weight="semibold" />
          <Text style={[styles.connectedLabel, { color: t('status-up') }]}>Connected.</Text>
        </View>
      ) : !status.code && !status.url ? (
        <View style={styles.waitingRow}>
          <Spinner />
          <Text style={[styles.waitingLabel, { color: t('fg-3') }]}>Requesting device code…</Text>
        </View>
      ) : (
        <>
          {status.code ? (
            <Pressable
              onPress={copyCode}
              accessibilityRole="button"
              accessibilityLabel={`Copy code ${status.code}`}
              style={({ pressed }) => [
                styles.codeBlock,
                { backgroundColor: t('bg-0'), borderColor: t('border') },
                pressed && { opacity: PRESSED_OPACITY },
              ]}
            >
              <Text style={[styles.code, { color: t('fg-0') }]}>{status.code}</Text>
              <Text style={[styles.codeCaption, { color: copied ? t('status-up') : t('fg-4') }]}>
                {copied ? 'copied' : 'tap to copy'}
              </Text>
            </Pressable>
          ) : null}
          {status.url ? (
            <Pressable
              onPress={() => {
                const url = status.url;
                if (url) void WebBrowser.openBrowserAsync(url);
              }}
              accessibilityRole="link"
              style={({ pressed }) => [
                styles.openButton,
                { backgroundColor: t('accent-soft'), borderColor: t('accent-border') },
                pressed && { opacity: PRESSED_OPACITY },
              ]}
            >
              <Text style={[styles.openLabel, { color: t('accent') }]}>Open {hostnameOf(status.url)}</Text>
            </Pressable>
          ) : null}
          <Text style={[styles.note, { color: t('fg-3') }]}>
            Approve on the provider site — this stays pending up to 15 min.
          </Text>
        </>
      )}
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  spinner: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, flexShrink: 0 },
  retry: {
    width: '100%',
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryLabel: { fontFamily: fonts.sans(550), fontSize: 13 },
  connectedRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 4, paddingBottom: 10 },
  connectedLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4, paddingBottom: 10 },
  waitingLabel: { fontFamily: fonts.sans(400), fontSize: 13 },
  codeBlock: {
    width: '100%',
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  code: { fontFamily: fonts.mono(600), fontSize: 22, letterSpacing: 2.2 },
  codeCaption: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 4 },
  openButton: {
    width: '100%',
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  openLabel: { fontFamily: fonts.sans(600), fontSize: 13.5 },
  note: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 18, paddingHorizontal: 4 },
});
