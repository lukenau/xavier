// 1:1 port of apps/hub/src/routes/config/AdvisorPage.tsx.
//
// The advisor pairs a cheaper "executor" model with a stronger "advisor" that
// reviews its work. Three honest presets — each is a canonical config state
// (model.default + advisor.{enabled,model}) applied via the SAME Face-ID-gated
// config.set path, THEN a gateway restart (advisor_config is read ONCE at agent
// init, so the restart is what makes a change take effect). Quality is the
// recommended default; Cost is labelled honestly and is never the default.
import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import {
  PageTitle,
  PRESSED_OPACITY,
  RefreshControl,
  Screen,
  SectionHead,
  StatePanel,
  Toast,
  useHideTabBar,
  useSpinRotation,
  type ToastKind,
} from '../shell';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import type { AdvisorPreset, AdvisorState } from '../../lib/types';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import {
  ActionBar,
  BackLink,
  BarCancel,
  ConfigCard,
  GateButton,
  useActionBarClearance,
} from './parts';
import {
  GATEWAY_WAIT,
  isAdvisorBlocked,
  isGatewayHealthy,
  nextSelection,
  notHealthyYetMessage,
  PRESETS,
  presetLabel,
  providerLabel,
  restartFailedMessage,
  shortModel,
  switchedMessage,
  type PresetMeta,
} from './advisor';
import { advisorErrorMessage } from './writeErrors';

const INTRO =
  'The advisor pairs the working model with a stronger reviewer that critiques its moves. Switching a preset rewrites the config and restarts the gateway to load it.';
const FOOTER =
  'A restart briefly interrupts in-flight turns. The advisor only re-reads its config at agent init, so the restart is required — not optional.';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * After the preset is written + the gateway restart is dispatched, wait for the
 * gateway to come back healthy. The restart drops the container for ~15s, so we
 * give it a short head-start then poll hub-api /health until the gateway service
 * reports `up` again. Returns false on timeout so the caller can show an honest
 * "didn't recover" state.
 */
async function waitForGatewayHealthy(isCancelled: () => boolean): Promise<boolean> {
  const deadline = Date.now() + GATEWAY_WAIT.deadlineMs;
  await sleep(GATEWAY_WAIT.headStartMs); // let the old container drop so we don't read a stale "up"
  while (Date.now() < deadline) {
    if (isCancelled()) return false;
    try {
      if (isGatewayHealthy(await api.health())) return true;
    } catch {
      // hub-api itself may blip during the restart — keep polling until the deadline.
    }
    await sleep(GATEWAY_WAIT.pollMs);
  }
  return false;
}

function RadioDot({ on }: { on: boolean }) {
  const { t } = useTheme();
  return (
    <View
      style={[
        styles.radio,
        { borderColor: on ? t('accent') : t('border-strong'), backgroundColor: on ? t('accent-soft') : 'transparent' },
      ]}
    >
      {on ? <View style={[styles.radioFill, { backgroundColor: t('accent') }]} /> : null}
    </View>
  );
}

function Badge({ text, tone }: { text: string; tone: 'good' | 'warn' }) {
  const { t } = useTheme();
  const color = tone === 'good' ? t('status-up') : t('status-warn');
  const soft = tone === 'good' ? t('status-up-soft') : t('status-warn-soft');
  return (
    <View style={[styles.badge, { backgroundColor: soft, borderColor: soft }]}>
      <Text style={[styles.badgeLabel, { color }]}>{text}</Text>
    </View>
  );
}

function PresetCard({
  meta,
  currentExecutor,
  isCurrent,
  isSelected,
  disabled,
  onSelect,
}: {
  meta: PresetMeta;
  currentExecutor: string | null;
  isCurrent: boolean;
  isSelected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useTheme();
  const highlighted = isSelected || (isCurrent && !disabled);
  return (
    <Pressable
      onPress={onSelect}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ checked: isSelected || isCurrent, disabled }}
      style={({ pressed }) => [
        styles.presetCard,
        {
          backgroundColor: highlighted ? t('accent-soft') : t('bg-1'),
          borderColor: highlighted ? t('accent-border') : t('border'),
          opacity: disabled ? 0.6 : 1,
        },
        pressed && !disabled && { opacity: PRESSED_OPACITY },
      ]}
    >
      <View style={styles.radioSlot}>
        <RadioDot on={isSelected || isCurrent} />
      </View>
      <View style={styles.presetBody}>
        <View style={styles.presetHead}>
          <Text style={[styles.presetLabel, { color: t('fg-0') }]}>{meta.label}</Text>
          {meta.badge ? <Badge text={meta.badge.text} tone={meta.badge.tone} /> : null}
          {isCurrent ? <Text style={[styles.liveLabel, { color: t('accent') }]}>· Live</Text> : null}
        </View>
        <Text style={[styles.presetBlurb, { color: t('fg-2') }]}>{meta.blurb}</Text>
        <Text style={[styles.presetModels, { color: t('fg-3') }]}>
          sets executor to {shortModel(meta.executor)} (currently {shortModel(currentExecutor)}) + advisor{' '}
          {meta.advisor ? shortModel(meta.advisor) : 'off'}
        </Text>
      </View>
    </Pressable>
  );
}

function CurrentSummary({ state }: { state: AdvisorState }) {
  const { t } = useTheme();
  const custom = state.preset === 'custom';
  return (
    <ConfigCard style={styles.summaryCard}>
      <View style={styles.summaryHead}>
        <Text style={[styles.summaryLive, { color: t('fg-3') }]}>Live now</Text>
        <Text style={[styles.summaryPreset, { color: custom ? t('status-warn') : t('accent') }]}>
          {presetLabel(state.preset)}
        </Text>
      </View>
      <Text style={[styles.summaryModels, { color: t('fg-3') }]}>
        exec {shortModel(state.executor)}
        {state.advisor_enabled ? ` · advisor ${shortModel(state.advisor_model)}` : ' · advisor off'}
      </Text>
      {custom ? (
        <Text style={[styles.summaryCustom, { color: t('fg-2') }]}>
          The live config matches none of the presets. Pick one below to normalise it.
        </Text>
      ) : null}
    </ConfigCard>
  );
}

/** Bottom Face-ID confirm bar — mirrors the ConfigSectionPage ReviewBar. Notes
 * the gateway restart the switch triggers so it's never a surprise. */
function ConfirmBar({
  target,
  applying,
  onApply,
  onCancel,
}: {
  target: PresetMeta;
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useTheme();
  return (
    <ActionBar>
      <View style={styles.barHead}>
        <View style={styles.barHeadText}>
          <Text style={[styles.barEyebrow, { color: t('fg-3') }]}>Switch advisor preset</Text>
          <Text numberOfLines={1} style={[styles.barLine, { color: t('fg-0') }]}>
            → <Text style={{ color: t('accent-hi') }}>{target.label}</Text>
            <Text style={[styles.barLineSuffix, { color: t('fg-3') }]}> · restarts the gateway</Text>
          </Text>
        </View>
        <BarCancel onPress={onCancel} disabled={applying} />
      </View>
      <GateButton
        label={applying ? 'Applying + restarting…' : `Switch to ${target.label} · Face ID`}
        busy={applying}
        onPress={onApply}
      />
    </ActionBar>
  );
}

/** Shown while the gateway restarts + we poll health. Not cancellable — the
 * config write already landed, so the switch is in flight regardless. */
function SwitchingBar({ target }: { target: PresetMeta }) {
  const { t } = useTheme();
  const rotate = useSpinRotation();
  return (
    <ActionBar tone="accent">
      <View style={styles.switchingRow}>
        <Animated.View
          style={[
            styles.switchingSpinner,
            { borderColor: t('accent-border'), borderTopColor: t('accent') },
            { transform: [{ rotate }] },
          ]}
        />
        <View style={styles.barHeadText}>
          <Text style={[styles.switchingTitle, { color: t('fg-0') }]}>
            Switching to {target.label}… <Text style={[styles.switchingEta, { color: t('fg-3') }]}>(~15s)</Text>
          </Text>
          <Text style={[styles.switchingSub, { color: t('fg-3') }]}>
            Restarting the gateway so it reloads the advisor config.
          </Text>
        </View>
      </View>
    </ActionBar>
  );
}

export function AdvisorPage() {
  useHideTabBar();
  const { t } = useTheme();
  const qc = useQueryClient();
  const advisor = usePoll(['advisor'], api.advisor, QUERY_TUNING.advisor);
  // The advisor tool only works on the direct Anthropic provider — when chat
  // traffic routes via OpenRouter the presets would write config that can't take
  // effect, so the live tree gates the whole preset surface.
  const cfg = usePoll(['config-full'], api.configFull, QUERY_TUNING['config-full']);
  const [selected, setSelected] = useState<AdvisorPreset | null>(null);
  // idle → applying (Face-ID + config writes + restart dispatch) → switching
  // (polling health while the gateway comes back). Both non-idle phases lock the UI.
  const [phase, setPhase] = useState<'idle' | 'applying' | 'switching'>('idle');
  const [toast, setToast] = useState<{ kind: ToastKind; text: string } | null>(null);
  // Guards the ~30s health poll so it never setState()s after the page unmounts.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const busy = phase !== 'idle';
  const current = advisor.data?.preset ?? null;
  const target = PRESETS.find((p) => p.id === selected) ?? null;
  const barClearance = useActionBarClearance(target !== null);

  const providerValue = cfg.data?.sections
    .find((s) => s.id === 'model')
    ?.leaves.find((l) => l.key === 'model.provider')?.value;
  const provider = typeof providerValue === 'string' ? providerValue : null;
  const blocked = isAdvisorBlocked(provider);

  function pick(id: AdvisorPreset) {
    if (busy || blocked) return;
    setSelected((s) => nextSelection(s, id, current));
  }

  async function apply() {
    if (!target || busy || blocked) return;
    const label = target.label;
    setPhase('applying');
    try {
      const res = await api.applyAdvisorPreset(target.id);
      if (res.status === 'applied') {
        // Config is written + the restart is dispatched; the gateway now re-reads
        // advisor_config on init. Poll health until it's back before confirming.
        setPhase('switching');
        const healthy = await waitForGatewayHealthy(() => cancelledRef.current);
        if (cancelledRef.current) return;
        // The Config tabs read model.default from the same config — refresh them too.
        await qc.invalidateQueries({ queryKey: ['advisor'] });
        await qc.invalidateQueries({ queryKey: ['config-full'] });
        await qc.invalidateQueries({ queryKey: ['vitals'] });
        setSelected(null);
        setToast(
          healthy
            ? { kind: 'ok', text: switchedMessage(label) }
            : { kind: 'err', text: notHealthyYetMessage(label) },
        );
      } else {
        setSelected(null);
        await qc.invalidateQueries({ queryKey: ['advisor'] });
        setToast({ kind: 'err', text: restartFailedMessage(label, res.restart_stderr) });
      }
    } catch (err) {
      if (!cancelledRef.current) setToast({ kind: 'err', text: advisorErrorMessage(err) });
    } finally {
      if (!cancelledRef.current) setPhase('idle');
    }
  }

  return (
    <>
      <Screen
        contentStyle={barClearance}
        header={
          <>
            <BackLink />
            <PageTitle right={<RefreshControl queries={[advisor, cfg]} />}>Advisor</PageTitle>
          </>
        }
      >
        <Text style={[styles.intro, { color: t('fg-2') }]}>{INTRO}</Text>

        {advisor.isLoading ? (
          <StatePanel tone="pending" title="Reading advisor config…" detail="config file" />
        ) : advisor.isError ? (
          <StatePanel
            tone="error"
            title="Advisor config unavailable"
            detail={advisor.error?.message || 'the configuration service is unreachable'}
          />
        ) : advisor.data ? (
          <>
            <CurrentSummary state={advisor.data} />
            {blocked ? (
              <View style={[styles.blockedCard, { backgroundColor: t('status-warn-soft'), borderColor: t('status-warn-soft') }]}>
                <Text style={[styles.blockedTitle, { color: t('status-warn') }]}>
                  Advisor needs the direct Anthropic provider
                </Text>
                <Text style={[styles.blockedBody, { color: t('fg-2') }]}>
                  Xavier currently routes via {providerLabel(provider)}. Switch model.provider first — presets are
                  disabled until then.
                </Text>
              </View>
            ) : null}
            <SectionHead label="Preset" count="" />
            <View accessibilityRole="radiogroup">
              {PRESETS.map((meta) => (
                <PresetCard
                  key={meta.id}
                  meta={meta}
                  currentExecutor={advisor.data.executor}
                  isCurrent={current === meta.id}
                  isSelected={selected === meta.id}
                  disabled={busy || blocked}
                  onSelect={() => pick(meta.id)}
                />
              ))}
            </View>
            <Text style={[styles.footer, { color: t('fg-4') }]}>{FOOTER}</Text>
          </>
        ) : null}
      </Screen>

      {phase === 'switching' && target ? (
        <SwitchingBar target={target} />
      ) : target ? (
        <ConfirmBar
          target={target}
          applying={phase === 'applying'}
          onApply={apply}
          onCancel={() => setSelected(null)}
        />
      ) : null}
      {toast ? <Toast kind={toast.kind} text={toast.text} onDone={() => setToast(null)} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  intro: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 18.75, marginBottom: 14 },
  summaryCard: { paddingHorizontal: 16, marginBottom: 14 },
  summaryHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  summaryLive: { fontFamily: fonts.sans(400), fontSize: 12 },
  summaryPreset: { fontFamily: fonts.sans(600), fontSize: 13 },
  summaryModels: { fontFamily: fonts.mono(400), fontSize: 11.5, marginTop: 6 },
  summaryCustom: { fontFamily: fonts.sans(400), fontSize: 11.5, lineHeight: 16.7, marginTop: 8 },
  blockedCard: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 15, paddingVertical: 13, marginBottom: 14 },
  blockedTitle: { fontFamily: fonts.sans(600), fontSize: 13, marginBottom: 3 },
  blockedBody: { fontFamily: fonts.sans(400), fontSize: 12, lineHeight: 18 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  radioFill: { width: 9, height: 9, borderRadius: 4.5 },
  radioSlot: { paddingTop: 1 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, borderWidth: 1, flexShrink: 0 },
  badgeLabel: { fontFamily: fonts.sans(600), fontSize: 10, letterSpacing: 0.1 },
  presetCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 15,
    paddingVertical: 13,
    marginBottom: 10,
  },
  presetBody: { flex: 1, minWidth: 0 },
  presetHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 },
  presetLabel: { fontFamily: fonts.sans(600), fontSize: 15 },
  liveLabel: { fontFamily: fonts.sans(500), fontSize: 11 },
  presetBlurb: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 18.1 },
  presetModels: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 6 },
  footer: { fontFamily: fonts.sans(400), fontSize: 11, marginTop: 4, paddingHorizontal: 1 },
  barHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 11 },
  barHeadText: { flex: 1, minWidth: 0 },
  barEyebrow: { fontFamily: fonts.sans(400), fontSize: 11 },
  barLine: { fontFamily: fonts.sans(550), fontSize: 13 },
  barLineSuffix: { fontFamily: fonts.sans(400), fontSize: 11 },
  switchingRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchingSpinner: { width: 18, height: 18, borderRadius: 9, borderWidth: 2.4, flexShrink: 0 },
  switchingTitle: { fontFamily: fonts.sans(600), fontSize: 13.5 },
  switchingEta: { fontFamily: fonts.sans(400), fontSize: 13.5 },
  switchingSub: { fontFamily: fonts.sans(400), fontSize: 11.5, marginTop: 2 },
});
