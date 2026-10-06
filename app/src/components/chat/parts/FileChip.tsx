// A file in the transcript, in either direction. Tap it and it opens in the
// preview sheet — the file itself, in place — with the share sheet still one
// tap away inside that sheet.
//
// A file the agent could not upload (too big for the Hub, unreadable) arrives
// as the same chip with no bytes behind it. It says so rather than pretending
// to be tappable.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatBytes } from '../../../chat/attachments';
import type { FilePart } from '../../../chat/types';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import { FilePreviewSheet } from './FilePreviewSheet';

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
  return /^[A-Z0-9]{1,4}$/.test(ext) ? ext : 'FILE';
}

export function FileChip({ part }: { part: FilePart }) {
  const { t } = useTheme();
  const [previewing, setPreviewing] = useState(false);
  const openable = Boolean(part.media_id);
  const name = part.name?.trim() || 'File';
  const detail = [
    part.size_bytes != null ? formatBytes(part.size_bytes) : null,
    openable ? null : 'not stored in the Hub',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <Pressable
        accessibilityRole={openable ? 'button' : undefined}
        accessibilityLabel={openable ? `Open ${name}` : name}
        disabled={!openable}
        onPress={() => {
          // A chip with no bytes behind it is not tappable, and the press is
          // ignored rather than opening a preview that can only fail.
          if (openable) setPreviewing(true);
        }}
        style={[styles.chip, { backgroundColor: t('bg-2'), borderColor: t('border-strong'), opacity: openable ? 1 : 0.7 }]}
      >
        <View style={[styles.badge, { borderColor: t('border-strong') }]}>
          <Text style={[styles.badgeText, { color: t('fg-2') }]}>{extensionOf(name)}</Text>
        </View>
        <View style={styles.body}>
          <Text numberOfLines={1} style={[styles.name, { color: t('fg-1') }]}>
            {name}
          </Text>
          {detail ? (
            <Text numberOfLines={1} style={[styles.detail, { color: t('fg-3') }]}>
              {detail}
            </Text>
          ) : null}
        </View>
      </Pressable>
      <FilePreviewSheet part={previewing ? part : null} onClose={() => setPreviewing(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 11, padding: 9, maxWidth: 280 },
  badge: { minWidth: 38, height: 38, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { fontFamily: fonts.mono(550), fontSize: 10, letterSpacing: 0.4 },
  body: { flexShrink: 1, gap: 2 },
  name: { fontFamily: fonts.sans(550), fontSize: 13.5 },
  detail: { fontFamily: fonts.mono(400), fontSize: 10.5 },
});
