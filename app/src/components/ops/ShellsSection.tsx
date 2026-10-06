// Ops.tsx:524-772 — persistent host tmux sessions running the `claude` CLI.
// "Shells", not "Sessions": SessionsSection above is Hermes AGENT sessions.
//
// Sessions span hosts: "vps" is this box, the rest come from hub-tmuxd's
// tmux-hosts.json (e.g. a laptop reached over ssh). A remote host that
// is asleep reports ok=false and its rows are simply absent — the VPS list
// never degrades with it, and the host gets one warn-toned line at the bottom
// of the card rather than an error panel.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { UseQueryResult } from '@tanstack/react-query';
import { SectionHead, StatePanel } from '../shell';
import { OpsCard, OPS_PRESSED, Pill } from './parts';
import { attachSnippet, isTmuxLocked, isTmuxUnavailable, pastSessionMeta, shellMeta, unreachableHostLine, writeErrorMessage } from './opsFormat';
import { api, ApiError } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { TmuxHistory, TmuxInventory, TmuxPastSession, WriteResult } from '../../lib/types';

/** Ops.tsx:827 — hub-tmuxd's spawn body rides along on the WriteResult. */
type WriteResultWithName = WriteResult & { name?: string; host?: string; attach?: string };

interface Spawned {
  name: string;
  host: string;
  attach: string;
}

export function ShellsSection({ q }: { q: UseQueryResult<TmuxInventory, Error> }) {
  const { t } = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spawned, setSpawned] = useState<Spawned | null>(null);
  const [host, setHost] = useState('vps');
  const [resumeOpen, setResumeOpen] = useState(false);
  const history = usePoll<TmuxHistory>(['tmux-history'], api.tmuxHistory, {
    ...QUERY_TUNING['tmux-history'],
    enabled: resumeOpen,
  });

  const hosts = q.data?.hosts ?? [];
  const multiHost = hosts.length > 1;
  const hostLabel = (id: string) => hosts.find((h) => h.id === id)?.label ?? id;
  const target = hosts.find((h) => h.id === host);

  async function spawn() {
    if (busy) return;
    setBusy('spawn');
    setError(null);
    try {
      const req = host === 'vps' ? { action: 'tmux.spawn' as const } : { action: 'tmux.spawn' as const, host };
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
        sessionHost === 'vps' ? { action: 'tmux.kill', name } : { action: 'tmux.kill', name, host: sessionHost },
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

  const sessions = q.data?.sessions ?? [];
  const past = (history.data?.sessions ?? []).filter((s) => s.host === host);
  const hostBlocked = target !== undefined && !target.ok;
  // A locked list (no terminal session yet, or nothing enrolled) has no card to
  // show a new or resumed session in, so its controls wait for the unlock.
  const locked = q.isError && isTmuxLocked(q.error as Error | null);
  const unenrolled = locked && q.error instanceof ApiError && q.error.status === 412;

  return (
    <View style={styles.section}>
      <SectionHead
        label="Claude shells"
        count={q.data ? `${sessions.length}` : ''}
        action={
          <View style={styles.pills}>
            {multiHost
              ? hosts.map((h) => (
                  <Pill
                    key={h.id}
                    label={h.label}
                    onPress={() => setHost(h.id)}
                    disabled={busy !== null}
                    selected={h.id === host}
                    background={h.id === host ? t('bg-2') : undefined}
                    borderColor={h.id === host ? t('border-strong') : t('border')}
                    color={h.ok ? t('fg-1') : t('fg-3')}
                  />
                ))
              : null}
            <Pill
              label="Resume"
              onPress={() => setResumeOpen((v) => !v)}
              disabled={busy !== null || hostBlocked || locked}
              selected={resumeOpen}
              background={resumeOpen ? t('bg-2') : undefined}
              borderColor={resumeOpen ? t('border-strong') : t('border')}
              color={t('fg-1')}
            />
            <Pill
              label={busy === 'spawn' ? 'Starting…' : 'New session'}
              onPress={spawn}
              disabled={busy !== null || hostBlocked || locked}
              background={t('bg-2')}
              borderColor={t('border')}
              color={t('fg-1')}
            />
          </View>
        }
      />
      {/* No pending StatePanel: this section renders nothing until data. An
          absent host manager is NOT an error — hub-tmuxd is an optional host
          daemon that most installs (and the demo) never run, and the server
          says so with an honest 503. Painting that red reads as a broken app
          for a feature that was simply never wired up, so it gets a neutral
          panel; only a genuine failure (5xx other than 503, bad payload)
          keeps the error tone. */}
      {q.isError ? (
        isTmuxUnavailable(q.error as Error | null) ? (
          <StatePanel
            tone="neutral"
            title="No host shells"
            detail="The host shell manager (hub-tmuxd) isn't running here, so there are no host sessions to list. Ops, cron and the rest of the Hub are unaffected."
          />
        ) : locked ? (
          <StatePanel
            tone="neutral"
            title="Shells are locked"
            detail={
              unenrolled
                ? 'Pair this iPhone in Config › Security, then unlock the terminal to see shells.'
                : 'Unlock the terminal to see shells — open Terminal and confirm with Face ID.'
            }
          />
        ) : (
          <StatePanel tone="error" title="Shells unavailable" detail={q.error?.message ?? ''} />
        )
      ) : null}
      {q.data ? (
        <OpsCard>
          {sessions.length === 0 ? (
            <Text style={[styles.emptyLine, { color: t('fg-2') }]}>No tmux sessions running.</Text>
          ) : null}
          {sessions.map((s, i) => (
            <View
              key={`${s.host}/${s.name}`}
              style={[
                styles.row,
                i === sessions.length - 1 ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
              ]}
            >
              <View style={styles.rowText}>
                <Text
                  style={[s.title ? styles.title : styles.titleMono, { color: t('fg-0') }]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {s.title ?? s.name}
                </Text>
                <Text style={[styles.meta, { color: t('fg-3') }]}>{shellMeta(s, multiHost, hostLabel)}</Text>
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
              <Text key={h.id} style={[styles.hostWarn, { color: t('status-warn'), borderTopColor: t('border') }]}>
                {unreachableHostLine(h.label, h.error)}
              </Text>
            ))}
          {spawned ? (
            <Text style={[styles.notice, { color: t('fg-2'), borderTopColor: t('border') }]}>
              Started <Text style={styles.noticeMono}>{spawned.name}</Text>
              {multiHost ? ` on ${hostLabel(spawned.host)}` : ''} — open{' '}
              <Text
                style={styles.noticeLink}
                accessibilityRole="link"
                onPress={() => router.push('/ops/terminal')}
              >
                Terminal
              </Text>{' '}
              and run <Text style={styles.noticeMono}>{spawned.attach}</Text> (snippet in the key bar).
            </Text>
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
                isTmuxUnavailable(history.error) ? (
                  <Text style={[styles.resumeState, { color: t('fg-3') }]}>
                    No past sessions — the host shell manager isn't running here.
                  </Text>
                ) : (
                  <Text style={[styles.resumeState, { color: t('danger') }]}>{history.error?.message ?? ''}</Text>
                )
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
                      style={[s.title ? styles.pastTitle : styles.pastTitleMono, { color: s.live ? t('fg-2') : t('fg-0') }]}
                      numberOfLines={1}
                      ellipsizeMode="tail"
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
        </OpsCard>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 14, marginBottom: 10 },
  pills: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  rowText: { flex: 1, minWidth: 0 },
  emptyLine: { fontFamily: fonts.sans(400), fontSize: 13, paddingVertical: 8 },
  title: { fontFamily: fonts.sans(520), fontSize: 15 },
  titleMono: { fontFamily: fonts.mono(520), fontSize: 15 },
  meta: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  hostWarn: { fontFamily: fonts.sans(400), fontSize: 12, paddingTop: 8, borderTopWidth: 1 },
  notice: { fontFamily: fonts.sans(400), fontSize: 12, paddingTop: 8, borderTopWidth: 1 },
  noticeMono: { fontFamily: fonts.mono(400) },
  noticeLink: { textDecorationLine: 'underline' },
  resumePanel: { paddingTop: 10, marginTop: 4, borderTopWidth: 1 },
  resumeLabel: { fontFamily: fonts.sans(400), fontSize: 11, letterSpacing: 0.66, textTransform: 'uppercase', marginBottom: 4 },
  resumeState: { fontFamily: fonts.sans(400), fontSize: 13, paddingVertical: 6 },
  pastRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  pastTitle: { fontFamily: fonts.sans(400), fontSize: 14 },
  pastTitleMono: { fontFamily: fonts.mono(400), fontSize: 14 },
  error: { fontFamily: fonts.sans(400), fontSize: 12, paddingTop: 8 },
});
