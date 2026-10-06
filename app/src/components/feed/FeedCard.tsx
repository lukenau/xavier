// One row of the Feed inbox (Feed.tsx:64-114). The whole card is the tap
// target; a card with nothing to show is disabled rather than hidden.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { FeedItem } from '../../lib/types';
import { relTime } from '../../shared/time';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { isOpenable, KIND_SYMBOL, kindToneToken, secondLine } from './feedModel';

export function FeedCard({
  item,
  isNew,
  onOpen,
}: {
  item: FeedItem;
  isNew: boolean;
  onOpen: (item: FeedItem) => void;
}) {
  const { t } = useTheme();
  const openable = isOpenable(item);
  const alert = item.kind === 'alert';
  const line = secondLine(item);
  const symbol = KIND_SYMBOL[item.kind];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.title}
      accessibilityState={{ disabled: !openable }}
      disabled={!openable}
      onPress={() => onOpen(item)}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: t('bg-1'),
          borderColor: t(item.priority === 'high' ? 'status-warn-border' : 'border'),
        },
        pressed && openable && { opacity: PRESSED_OPACITY },
      ]}
    >
      <View style={styles.headerRow}>
        {/* An unknown kind off the wire has no glyph in the PWA either
            (KIND_GLYPH[kind] is undefined there) — same hole, explicit. */}
        {symbol ? (
          <SymbolView
            name={symbol}
            size={16}
            tintColor={t(kindToneToken(item))}
            weight="regular"
          />
        ) : (
          <View style={styles.glyphGap} />
        )}
        <Text numberOfLines={1} style={[styles.title, { color: t('fg-0') }]}>
          {item.title}
        </Text>
        <Text
          style={[
            styles.badge,
            {
              color: t(alert ? 'status-warn' : 'fg-3'),
              borderColor: t(alert ? 'status-warn-border' : 'border'),
              backgroundColor: t('bg-2'),
            },
          ]}
        >
          {item.kind}
        </Text>
        {isNew ? (
          <View accessibilityLabel="new" style={[styles.newDot, { backgroundColor: t('accent') }]} />
        ) : null}
        <Text style={[styles.age, { color: t('fg-4') }]}>{relTime(item.ts)}</Text>
      </View>
      {line ? (
        <Text numberOfLines={1} style={[styles.second, { color: t(line.tone) }]}>
          {line.text}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  glyphGap: { width: 16, height: 16 },
  title: { flex: 1, minWidth: 0, fontFamily: fonts.sans(560), fontSize: 14 },
  badge: {
    flexShrink: 0,
    fontFamily: fonts.mono(400),
    fontSize: 9,
    letterSpacing: 0.72,
    textTransform: 'uppercase',
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  newDot: { flexShrink: 0, width: 6, height: 6, borderRadius: 3 },
  age: { flexShrink: 0, fontFamily: fonts.mono(400), fontSize: 10, ...MONO_FEATURES },
  second: { marginTop: 5, paddingLeft: 26, fontFamily: fonts.sans(400), fontSize: 12 },
});
