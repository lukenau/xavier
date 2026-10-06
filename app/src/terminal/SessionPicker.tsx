// Claude shells, reachable from inside the terminal.
//
// Same data and the same gated writes as the Ops screen's ShellsSection
// (apps/hub/src/routes/Ops.tsx:524-772): `GET /api/tmux/sessions` and
// `/history` are unauthenticated reads, while spawn / kill / resume go through
// `api.applyWrite` — challenge → Face ID → apply. Nothing here mints anything
// itself; until the signer is registered every write throws at the assertion
// step, after a real challenge POST, and surfaces as an inline message.
//
// Hosts: "vps" is this box, the rest come from hub-tmuxd's tmux-hosts.json
// (e.g. a laptop reached over ssh). An asleep host reports ok=false —
// its rows are simply absent and it gets one warn-toned line, never an error
// panel that would take the VPS list down with it.
//
// ONE string differs from the PWA, deliberately: the post-spawn notice there
// reads "open Terminal and run {attach} (snippet in the key bar)". We ARE the
// terminal, so the attach command is offered as a tap that fills the composer.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../lib/api';
import { QUERY_TUNING, usePoll } from '../lib/query';
import type { TmuxHistory, TmuxInventory, TmuxPastSession, WriteResult } from '../lib/types';
import { StatePanel } from '../components/shell';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';
import { TerminalSheet } from './Sheet';
import { attachSnippet, pastSessionMeta, shellMeta, unreachableHostLine, writeErrorMessage } from './shells';

/** Ops.tsx:827 — hub-tmuxd's spawn body rides along on the WriteResult. */
type WriteResultWithName = WriteResult & { name?: string; host?: string; attach?: string };

interface Spawned {
  name: string;
  host: string;
  attach: string;
}

export interface SessionPickerProps {
  open: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  /** Hands over an attach command — the screen fills the composer with it once
   * the sheet is gone, and nothing ever sends it. */
  onAttach: (cmd: string) => void;
}

function Pill({
  label,
  accessibilityLabel,
  onPress,
  disabled,
  color,
  background,
  borderColor,
}: {
  label: string;
  /** Rows repeat "Kill" and "Resume"; VoiceOver needs to know which one. */
  accessibilityLabel?: string;
  onPress: () => void;
  disabled: boolean;
  color: string;
  background?: string;
  borderColor: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.pill,
        { borderColor, backgroundColor: background },
        // `active:opacity-70`; a disabled pill is not dimmed in the PWA either.
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.pillLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

export function SessionPicker({ open, onClose, onDismissed, onAttach }: SessionPickerProps) {
  const { t } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spawned, setSpawned] = useState<Spawned | null>(null);
  const [host, setHost] = useState('vps');
  const [resumeOpen, setResumeOpen] = useState(false);
  const q = usePoll<TmuxInventory>(['tmux-sessions'], api.tmuxSessions, {
    ...QUERY_TUNING['tmux-sessions'],
    enabled: open,
  });
  const history = usePoll<TmuxHistory>(['tmux-history'], api.tmuxHistory, {
    ...QUERY_TUNING['tmux-history'],
    enabled: open && resumeOpen,
  });

  const hosts = q.data?.hosts ?? [];
  const multiHost = hosts.length > 1;
  const hostLabel = (id: string) => hosts.find((h) => h.id === id)?.label ?? id;
  const target = hosts.find((h) => h.id === host);
  const hostBlocked = target !== undefined && !target.ok;
  const sessions = q.data?.sessions ?? [];
  const past = (history.data?.sessions ?? []).filter((s) => s.host === host);

  async function spawn() {
    if (busy) return;
    setBusy('spawn');
    setError(null);
    try {
      const req =
        host === 'vps' ? { action: 'tmux.spawn' as const } : { action: 'tmux.spawn' as const, host };
      const res = (await api.applyWrite(req)) as WriteResultWithName;
      if (res.name) {
        setSpawned({ name: res.name, host: res.host ?? host, attach: attachSnippet(res.attach, res.name) });
      }
      await q.refetch();
    } catch (err) {
      const msg = writeErrorMessage(err);
      if (msg) setError(msg);
    } finally {
      setBusy(null);
    }
  }

  async function kill(name: string, sessionHost: string) {
    if (busy) return;
    setBusy(`${sessionHost}/${name}`);
    setError(null);
    try {
      await api.applyWrite(
        sessionHost === 'vps'
          ? { action: 'tmux.kill', name }
          : { action: 'tmux.kill', name, host: sessionHost },
      );
      if (spawned?.name === name && spawned.host === sessionHost) setSpawned(null);
      await q.refetch();
    } catch (err) {
      const msg = writeErrorMessage(err);
      if (msg) setError(msg);
    } finally {
      setBusy(null);
    }
  }

  async function resume(s: TmuxPastSession) {
    if (busy) return;
    setBusy(`resume/${s.session_id}`);
    setError(null);
    try {
      const res = (await api.applyWrite({
        action: 'tmux.spawn',
        resume: s.session_id,
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(s.host !== 'vps' ? { host: s.host } : {}),
      })) as WriteResultWithName;
      if (res.name) {
        setSpawned({ name: res.name, host: res.host ?? s.host, attach: attachSnippet(res.attach, res.name) });
      }
      setResumeOpen(false);
      await q.refetch();
    } catch (err) {
      const msg = writeErrorMessage(err);
      if (msg) setError(msg);
    } finally {
      setBusy(null);
    }
  }

  return (
    <TerminalSheet
      open={open}
      onClose={onClose}
      onDismissed={onDismissed}
      eyebrow="Terminal"
      title="Claude shells"
    >
      <View style={styles.pills}>
        {multiHost
          ? hosts.map((h) => (
              <Pill
                key={h.id}
                label={h.label}
                onPress={() => setHost(h.id)}
                disabled={busy !== null}
                background={h.id === host ? t('bg-2') : undefined}
                borderColor={h.id === host ? t('border-strong') : t('border')}
                color={h.ok ? t('fg-1') : t('fg-3')}
              />
            ))
          : null}
        <Pill
          label="Resume"
          onPress={() => setResumeOpen((v) => !v)}
          disabled={busy !== null || hostBlocked}
          background={resumeOpen ? t('bg-2') : undefined}
          borderColor={resumeOpen ? t('border-strong') : t('border')}
          color={t('fg-1')}
        />
        <Pill
          label={busy === 'spawn' ? 'Starting…' : 'New session'}
          onPress={spawn}
          disabled={busy !== null || hostBlocked}
          background={t('bg-2')}
          borderColor={t('border')}
          color={t('fg-1')}
        />
      </View>

      {q.isError ? (
        <StatePanel tone="error" title="Shells unavailable" detail={q.error?.message ?? ''} />
      ) : null}

      {q.data ? (
        <View>
          {sessions.length === 0 ? (
            <Text style={[styles.empty, { color: t('fg-2') }]}>No tmux sessions running.</Text>
          ) : null}
          {sessions.map((s, i) => (
            <View
              key={`${s.host}/${s.name}`}
              style={[
                styles.row,
                i === sessions.length - 1
                  ? null
                  : { borderBottomWidth: 1, borderBottomColor: t('border') },
              ]}
            >
              <View style={styles.rowText}>
                <Text
                  numberOfLines={1}
                  style={[s.title ? styles.title : styles.titleMono, { color: t('fg-0') }]}
                >
                  {s.title ?? s.name}
                </Text>
                <Text style={[styles.meta, { color: t('fg-3') }]}>
                  {shellMeta(s, multiHost, hostLabel)}
                </Text>
              </View>
              {!s.protected && !s.attached ? (
                <Pill
                  label={busy === `${s.host}/${s.name}` ? '…' : 'Kill'}
                  accessibilityLabel={`Kill ${s.name}`}
                  onPress={() => kill(s.name, s.host)}
                  disabled={busy !== null}
                  borderColor={t('border')}
                  color={t('danger')}
                />
              ) : null}
            </View>
          ))}
          {hosts
            .filter((h) => !h.ok)
            .map((h) => (
              <Text
                key={h.id}
                style={[styles.hostWarn, { color: t('status-warn'), borderTopColor: t('border') }]}
              >
                {unreachableHostLine(h.label, h.error)}
              </Text>
            ))}
          {spawned ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Fill the composer with the attach command"
              onPress={() => {
                onAttach(spawned.attach);
                onClose();
              }}
              style={({ pressed }) => [pressed && { opacity: 0.7 }]}
            >
              <Text style={[styles.notice, { color: t('fg-2'), borderTopColor: t('border') }]}>
                Started <Text style={styles.noticeMono}>{spawned.name}</Text>
                {multiHost ? ` on ${hostLabel(spawned.host)}` : ''} — run{' '}
                <Text style={styles.noticeMono}>{spawned.attach}</Text> (tap to fill the composer).
              </Text>
            </Pressable>
          ) : null}
          {resumeOpen ? (
            <View style={[styles.resumePanel, { borderTopColor: t('border') }]}>
              <Text style={[styles.resumeLabel, { color: t('fg-3') }]}>
                Resume a past session{multiHost ? ` · ${hostLabel(host)}` : ''}
              </Text>
              {history.isLoading ? (
                <Text style={[styles.resumeState, { color: t('fg-2') }]}>Reading transcripts…</Text>
              ) : null}
              {history.isError ? (
                <Text style={[styles.resumeState, { color: t('danger') }]}>
                  {history.error?.message ?? ''}
                </Text>
              ) : null}
              {history.data && past.length === 0 ? (
                <Text style={[styles.resumeState, { color: t('fg-2') }]}>
                  No past sessions on {hostLabel(host)}.
                </Text>
              ) : null}
              {past.map((s) => (
                <View key={`${s.host}/${s.session_id}`} style={styles.pastRow}>
                  <View style={styles.rowText}>
                    <Text
                      numberOfLines={1}
                      style={[
                        s.title ? styles.pastTitle : styles.pastTitleMono,
                        { color: s.live ? t('fg-2') : t('fg-0') },
                      ]}
                    >
                      {s.title ?? s.session_id.slice(0, 8)}
                    </Text>
                    <Text style={[styles.meta, { color: t('fg-3') }]}>{pastSessionMeta(s)}</Text>
                  </View>
                  {!s.live ? (
                    <Pill
                      label={busy === `resume/${s.session_id}` ? '…' : 'Resume'}
                      accessibilityLabel={`Resume ${s.title ?? s.session_id.slice(0, 8)}`}
                      onPress={() => resume(s)}
                      disabled={busy !== null}
                      borderColor={t('border')}
                      color={t('fg-1')}
                    />
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
          {error ? <Text style={[styles.error, { color: t('danger') }]}>{error}</Text> : null}
        </View>
      ) : null}
    </TerminalSheet>
  );
}

const styles = StyleSheet.create({
  pills: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 10, flexWrap: 'wrap' },
  pill: {
    minHeight: 30,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    justifyContent: 'center',
  },
  pillLabel: { fontFamily: fonts.sans(400), fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  rowText: { flex: 1, minWidth: 0 },
  empty: { fontFamily: fonts.sans(400), fontSize: 13, paddingVertical: 8 },
  title: { fontFamily: fonts.sans(520), fontSize: 15 },
  titleMono: { fontFamily: fonts.mono(520), fontSize: 15 },
  meta: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  hostWarn: { fontFamily: fonts.sans(400), fontSize: 12, paddingTop: 8, borderTopWidth: 1 },
  notice: { fontFamily: fonts.sans(400), fontSize: 12, paddingTop: 8, borderTopWidth: 1 },
  noticeMono: { fontFamily: fonts.mono(400) },
  resumePanel: { paddingTop: 10, marginTop: 4, borderTopWidth: 1 },
  resumeLabel: {
    fontFamily: fonts.sans(400),
    fontSize: 11,
    letterSpacing: 0.66,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  resumeState: { fontFamily: fonts.sans(400), fontSize: 13, paddingVertical: 6 },
  pastRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  pastTitle: { fontFamily: fonts.sans(400), fontSize: 14 },
  pastTitleMono: { fontFamily: fonts.mono(400), fontSize: 14 },
  error: { fontFamily: fonts.sans(400), fontSize: 12, paddingTop: 8 },
});
