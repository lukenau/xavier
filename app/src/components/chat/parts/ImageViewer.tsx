// A picture from the transcript, opened full screen. Tapping it in the message
// only gets you the thumbnail the bubble has room for; this is the one you can
// actually look at.
//
// Deliberately plain: the image at `contain`, a Close, and a tap anywhere to go
// back. Nothing here fetches or writes — it draws the same authenticated URL the
// transcript already loaded.
import { Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PRESSED_OPACITY } from '../../shell';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';

export interface ImageViewerProps {
  /** The image to show, or null when the viewer is closed. */
  uri: string | null;
  /** Shown small in the header, e.g. the file name. */
  label?: string;
  onClose: () => void;
}

export function ImageViewer({ uri, label, onClose }: ImageViewerProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={Boolean(uri)}
      onRequestClose={onClose}
      animationType="fade"
      presentationStyle="fullScreen"
      backdropColor={t('bg-0')}
    >
      <View
        style={[styles.ground, { backgroundColor: t('bg-0'), paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]}
      >
        <View style={styles.bar}>
          <Text numberOfLines={1} style={[styles.label, { color: t('fg-3') }]}>
            {label ?? ''}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close image"
            onPress={onClose}
            style={({ pressed }) => [styles.close, pressed && { opacity: PRESSED_OPACITY }]}
          >
            <Text style={[styles.closeLabel, { color: t('accent') }]}>Close</Text>
          </Pressable>
        </View>
        {uri ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Full size image" onPress={onClose} style={styles.fill}>
            <Image
              accessibilityIgnoresInvertColors
              source={{ uri }}
              resizeMode="contain"
              style={styles.fill}
            />
          </Pressable>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 16 },
  label: { flexShrink: 1, fontFamily: fonts.mono(400), fontSize: 11 },
  close: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },
  closeLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
  fill: { flex: 1, width: '100%' },
});
