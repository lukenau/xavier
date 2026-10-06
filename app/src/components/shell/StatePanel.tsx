// 1:1 port of apps/hub/src/components/shell/StatePanel.tsx — the loading /
// error / empty panel every data section renders instead of popping in, plus
// the two page-furniture pieces that live beside it in the same PWA file.
import type { ReactNode } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { TokenName } from '../../theme/tokens.gen';
import { useSpinRotation } from './motion';
import { TickRule, useMoment, XavierPose, type MomentId } from '../../whimsy';

export type StatePanelTone = 'neutral' | 'pending' | 'error';

interface ToneTokens {
  color: TokenName;
  border: TokenName;
  bg: TokenName;
}

const TONES: Record<StatePanelTone, ToneTokens> = {
  pending: { color: 'fg-3', border: 'border', bg: 'bg-1' },
  error: { color: 'status-down', border: 'status-down-border', bg: 'status-down-wash' },
  neutral: { color: 'fg-3', border: 'border', bg: 'bg-1' },
};

// Native-only (whimsy layer, not in the PWA): Xavier stands beside the panel.
const TONE_MOMENT: Record<StatePanelTone, MomentId> = {
  pending: 'loading',
  error: 'error',
  neutral: 'empty',
};

export interface StatePanelProps {
  tone?: StatePanelTone;
  title: string;
  detail?: string;
  /** Which Xavier moment to show; defaults by tone, `false` for none. */
  moment?: MomentId | false;
}

export function StatePanel({ tone = 'neutral', title, detail, moment }: StatePanelProps) {
  const { t } = useTheme();
  const tokens = TONES[tone];
  const rotate = useSpinRotation();
  const resolved = useMoment(moment === false ? undefined : (moment ?? TONE_MOMENT[tone]));
  // Panels mount and remount with every refetch; a buzz on each would nag.
  const xavier = resolved && moment === undefined ? { ...resolved, haptic: undefined } : resolved;
  return (
    <View
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      style={[
        styles.panel,
        { backgroundColor: t(tokens.bg), borderColor: t(tokens.border) },
        xavier && styles.panelWithXavier,
      ]}
    >
      {xavier ? <XavierPose moment={xavier} size="inline" /> : null}
      <View style={xavier ? styles.body : undefined}>
        <View style={styles.titleRow}>
          {/* Xavier's scan band is the loading animation when it runs;
              the ring stays for Off, and for Reduce Motion (no scan). */}
          {tone === 'pending' && xavier?.motion !== 'scan' && (
            <Animated.View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[
                styles.spinner,
                { borderColor: t('border-strong'), borderTopColor: t('fg-2') },
                { transform: [{ rotate }] },
              ]}
            />
          )}
          <Text
            style={[
              styles.title,
              { color: tone === 'error' ? t(tokens.color) : t('fg-1') },
            ]}
          >
            {title}
          </Text>
        </View>
        {detail ? <Text style={[styles.detail, { color: t('fg-3') }]}>{detail}</Text> : null}
      </View>
    </View>
  );
}

/** Section divider within a page: 5px accent dot + mono uppercase eyebrow. */
export function ScreenLabel({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <View style={styles.screenLabelRow}>
      <View style={[styles.screenLabelDot, { backgroundColor: t('accent') }]} />
      <Text style={[styles.screenLabel, { color: t('fg-4') }]}>{children}</Text>
    </View>
  );
}

/** Page heading with an optional right-aligned control (RefreshControl, badge). */
export function PageTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const { t } = useTheme();
  return (
    <>
      <View style={styles.pageTitleRow}>
        <Text
          accessibilityRole="header"
          style={[styles.pageTitle, { color: t('fg-0') }]}
        >
          {children}
        </Text>
        {right ? <View style={styles.pageTitleRight}>{right}</View> : null}
      </View>
      <TickRule />
    </>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 10,
    borderWidth: 1,
  },
  panelWithXavier: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 10 },
  body: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  spinner: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5 },
  title: { fontFamily: fonts.sans(550), fontSize: 13.5, flexShrink: 1 },
  detail: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 4 },
  screenLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 18,
    marginBottom: 8,
  },
  screenLabelDot: { width: 5, height: 5, borderRadius: 2.5 },
  screenLabel: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  pageTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingBottom: 18,
  },
  pageTitle: { fontFamily: fonts.sans(620), fontSize: 26, letterSpacing: -0.78, flexShrink: 1 },
  pageTitleRight: { flexShrink: 0 },
});
