// Health entry (Home.tsx:147-171). In the PWA this is a plain anchor to
// `/oura/` — a static page regenerated after each ring sync, outside the SPA.
// Natively it pushes the trusted-page screen (Task 19's `app/(home)/oura.tsx`,
// TrustedPageView), which keeps a back affordance the PWA's standalone mode
// never had. The sync button rides alongside, outside the tap target.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { OuraSyncButton } from './OuraSyncButton';

export function OuraRow({ onGateError }: { onGateError?: (message: string) => void }) {
  const { t } = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: t('bg-1'), borderColor: t('border') }]}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Health — Oura cockpit"
        onPress={() => router.push('/oura')}
        style={({ pressed }) => [styles.link, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <SymbolView name="circle.circle" size={16} tintColor={t('fg-3')} weight="regular" />
        <View style={styles.text}>
          <Text style={[styles.title, { color: t('fg-1') }]} numberOfLines={1} ellipsizeMode="tail">
            Health — Oura cockpit
          </Text>
          <Text style={[styles.subline, { color: t('fg-4') }]}>sleep · readiness · illness radar →</Text>
        </View>
      </Pressable>
      <OuraSyncButton onGateError={onGateError} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 14,
    borderWidth: 1,
    paddingLeft: 14,
    paddingRight: 8,
    marginBottom: 12,
  },
  link: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.sans(580), fontSize: 13.5 },
  subline: { fontFamily: fonts.mono(400), fontSize: 10, marginTop: 1 },
});
