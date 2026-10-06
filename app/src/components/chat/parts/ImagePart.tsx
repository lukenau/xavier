// An image in the transcript. It rendered as the literal string "[image]" with
// a comment saying no media route existed — true when it was written, stale
// since GET /api/chat/media/{id} shipped (2026-09-22).
//
// The bytes are behind the same cookie as every other chat read, and iOS
// shares its cookie jar between fetch and image loading, so a plain <Image>
// with the absolute URL authenticates itself. A failure says so rather than
// leaving a silent gap — an image that did not load is information.
//
// The bubble only has room for a thumbnail, so the picture is drawn to fit a
// box that keeps the sender's proportions and is never cropped, and tapping it
// opens ImageViewer for the full-size look.
import { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { HUB_ORIGIN } from '../../../lib/api';
import { PRESSED_OPACITY } from '../../shell';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';
import type { ImagePart as ImagePartT } from '../../../chat/types';
import { ImageViewer } from './ImageViewer';

/** The box a transcript image is drawn in. Wider than the bubble used to allow
 * (240×300 left a tall picture tiny) and shorter than the screen, so one image
 * cannot push the conversation off it. */
const MAX_WIDTH = 320;
const MAX_HEIGHT = 420;
/** Used when the sender told us nothing about the picture's shape. */
const FALLBACK_RATIO = 4 / 3;

/**
 * Fit an image into the transcript's box, keeping its proportions. A tall
 * picture is limited by the height and a wide one by the width, so neither
 * comes out squashed or cropped.
 */
export function imageBox(width?: number, height?: number): { width: number; height: number } {
  const ratio = width && height ? width / height : FALLBACK_RATIO;
  const fitted = Math.min(MAX_WIDTH, MAX_HEIGHT * ratio);
  return { width: Math.round(fitted), height: Math.round(fitted / ratio) };
}

export function ImagePart({ part }: { part: ImagePartT }) {
  const { t } = useTheme();
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const uri = part.url ?? (part.media_id ? `${HUB_ORIGIN}/api/chat/media/${part.media_id}` : null);
  if (!uri || failed) {
    return (
      <View style={[styles.missing, { borderColor: t('border'), backgroundColor: t('bg-2') }]}>
        <Text style={[styles.missingLabel, { color: t('fg-2') }]}>
          {uri ? 'Image did not load' : 'Image unavailable'}
        </Text>
      </View>
    );
  }

  const box = imageBox(part.width ?? undefined, part.height ?? undefined);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Image in the conversation"
        onPress={() => setExpanded(true)}
        style={({ pressed }) => pressed && { opacity: PRESSED_OPACITY }}
      >
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri }}
          onError={() => setFailed(true)}
          resizeMode="contain"
          style={[styles.image, { width: box.width, height: box.height, borderColor: t('border') }]}
        />
      </Pressable>
      <ImageViewer uri={expanded ? uri : null} onClose={() => setExpanded(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  image: { borderRadius: 11, borderWidth: 1, marginVertical: 2 },
  missing: { borderRadius: 11, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, alignSelf: 'flex-start' },
  missingLabel: { fontFamily: fonts.mono(400), fontSize: 11 },
});
