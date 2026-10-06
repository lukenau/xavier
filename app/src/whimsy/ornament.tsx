// Blueprint furniture: the tick rule and the X seal. Accent tokens only.
import { StyleSheet, Text, View } from 'react-native';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';
import { useWhimsy } from './level';

/** A blueprint rule: a gold hairline that fades out, with measurement ticks. */
export function TickRule() {
  const { t } = useTheme();
  const { level } = useWhimsy();
  if (level === 'off') return null;
  return (
    <View style={styles.rule} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="tick-rule">
      <View
        style={[
          styles.line,
          { experimental_backgroundImage: `linear-gradient(to right, ${t('accent-border')}, transparent)` },
        ]}
      />
      {TICKS.map((major, i) => (
        <View
          key={i}
          style={[
            styles.tick,
            { left: i * TICK_STEP, height: major ? 6 : 3, backgroundColor: t('accent-border'), opacity: 1 - i / TICKS.length },
          ]}
        />
      ))}
    </View>
  );
}

const TICK_STEP = 12;
const TICKS = [true, false, false, false, true, false, false, false, true, false, false, false];

/** The wax-seal monogram — the brand mark, sized for toasts and badges. */
export function Monogram({ size = 18 }: { size?: number }) {
  const { t } = useTheme();
  return (
    <View
      style={[
        styles.seal,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: t('accent-soft'),
          borderColor: t('accent-border'),
        },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={{ color: t('accent'), fontFamily: fonts.sans(600), fontSize: size * 0.56, lineHeight: size * 0.7 }}>
        X
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  rule: { height: 7, marginTop: -8, marginBottom: 16 },
  line: { height: StyleSheet.hairlineWidth * 2, maxWidth: 180 },
  tick: { position: 'absolute', top: 0, width: StyleSheet.hairlineWidth * 2 },
  seal: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
});
