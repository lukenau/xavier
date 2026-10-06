// Ops.tsx:829-849 — the jump-off link rows at the top and bottom of Ops.
// Each row is a wouter <Link> in the PWA; here it is a router.push, so the
// paths stay the PWA's (/ops/cost, /ops/files, /terminal).
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { ChevronRight, OPS_PRESSED } from './parts';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

export interface NavRow {
  href: Href;
  label: string;
  sub: string;
}

export function NavCard({ rows, style }: { rows: NavRow[]; style?: { marginTop?: number; marginBottom?: number } }) {
  const { t } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t('bg-1'), borderColor: t('border') }, style]}>
      {rows.map((r, i) => (
        <Pressable
          key={String(r.href)}
          onPress={() => router.push(r.href)}
          accessibilityRole="link"
          accessibilityLabel={r.label}
          style={({ pressed }) => [
            styles.row,
            i === rows.length - 1 ? null : { borderBottomWidth: 1, borderBottomColor: t('border') },
            pressed && { opacity: OPS_PRESSED },
          ]}
        >
          <View style={styles.rowText}>
            <Text style={[styles.label, { color: t('fg-0') }]}>{r.label}</Text>
            <Text style={[styles.sub, { color: t('fg-3') }]}>{r.sub}</Text>
          </View>
          <ChevronRight />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 44,
  },
  rowText: { flex: 1, minWidth: 0 },
  label: { fontFamily: fonts.sans(520), fontSize: 15 },
  sub: { fontFamily: fonts.mono(400), fontSize: 10.5 },
});
