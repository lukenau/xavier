// 1:1 port of apps/hub/src/components/shell/RefreshControl.tsx: refetch every
// query on the page, spin while any is fetching, and stamp the age of the
// OLDEST dataUpdatedAt so the label never overstates freshness. 44px hit area
// around a 28px visible control.
//
// Six page-local copies of this existed while the screen tasks ran in parallel
// (none of them could write to shell/**). They are gone; this is the one.
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { PRESSED_OPACITY } from './Card';
import { useSpinRotation } from './motion';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

/**
 * What the control needs off a query. Structural rather than
 * `Pick<UseQueryResult…>` so any `UseQueryResult<T, E>` passes without the
 * caller naming its generics, and so a heterogeneous array of them (Ops
 * passes eight) is still one array type.
 */
export interface RefreshableQuery {
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => unknown;
}

/** RefreshControl.tsx:6-13 — '' at zero, then now / {n}s / {n}m / {n}h.
 * Computed at render time only — no timer, so the label refreshes when
 * something else re-renders the header, exactly as in the PWA. */
export function ageLabel(oldest: number, now: number = Date.now()): string {
  if (!oldest) return '';
  const s = Math.max(0, (now - oldest) / 1000);
  if (s < 10) return 'now';
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

export function RefreshControl({ queries }: { queries: RefreshableQuery | RefreshableQuery[] }) {
  const { t } = useTheme();
  const rotate = useSpinRotation();
  const list = Array.isArray(queries) ? queries : [queries];
  const fetching = list.some((q) => q.isFetching);
  const oldest = Math.min(...list.map((q) => q.dataUpdatedAt || Date.now()));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh"
      onPress={() => list.forEach((q) => q.refetch())}
      style={({ pressed }) => [styles.hit, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <Text style={[styles.age, { color: t('fg-4') }]}>{ageLabel(oldest)}</Text>
      <Animated.View
        style={[
          styles.icon,
          { backgroundColor: t('bg-1'), borderColor: t('border') },
          fetching ? { transform: [{ rotate }] } : null,
        ]}
      >
        <SymbolView name="arrow.clockwise" size={13} tintColor={t('fg-2')} weight="regular" />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'flex-end',
  },
  age: { fontFamily: fonts.mono(400), fontSize: 10, ...MONO_FEATURES },
  icon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
