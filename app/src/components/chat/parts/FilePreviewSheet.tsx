// A file in the transcript, opened in place instead of handed to the share
// sheet. Tapping a chip now shows the file; the share sheet is still there, one
// tap away in the header of this sheet.
//
// Why nothing here is fetched or framed by URL: hub-api serves every non-image
// file as an opaque `application/octet-stream` attachment with `nosniff` and a
// sandbox CSP — by design, so that an uploaded page can never run as the Hub.
// Nothing a viewer can load by URL, then. The bytes the app already downloaded
// are the only thing to draw from.
//
// So: markdown is decoded and laid out as the document it is, by the
// transcript's own parser and renderer — no dependency, and nothing an
// uploaded file contains is ever executed. Every other word-like file is drawn
// as its source, so an uploaded .html appears as its source rather than as a
// page. PDFs and SVGs go to a WebView, with
// JavaScript OFF and navigation locked to that one local file, which is what
// keeps the property the old share-only flow protected. A raster picture is an
// <Image>. Anything with no viewer says so, and points at Share.
import { useEffect, useState, type ComponentType, type ReactElement } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { fetchFilePart, shareFile, type FetchedFile } from '../../../chat/files';
import { previewKindOf } from '../../../chat/filePreview';
import type { FilePart } from '../../../chat/types';
import { utf8Decode } from '../../../terminal/ttydProtocol';
import { PRESSED_OPACITY } from '../../shell';
import { DetailSheet } from '../../system/DetailSheet';
import { TextPart } from './TextPart';
import { fonts } from '../../../theme/fonts';
import { useTheme } from '../../../theme/useTheme';

/** Drawn characters, before the sheet says it is showing only the start. */
const TEXT_CHAR_LIMIT = 200_000;
/** Rendered markdown characters. Loud above this, so the sheet says so and
 *  points at Share rather than laying out a whole book on the main thread. */
const MARKDOWN_CHAR_LIMIT = 40_000;

export interface FilePreviewSheetProps {
  /** The file to show, or null when the sheet is closed. */
  part: FilePart | null;
  onClose: () => void;
}

/** The one WebView prop surface this sheet uses. Declared here rather than
 * imported, so that `react-native-webview` never enters the module graph of a
 * message bubble (its native module is touched at import time). */
type DocumentViewer = ComponentType<{
  source: { uri: string };
  originWhitelist: string[];
  javaScriptEnabled: boolean;
  allowFileAccess: boolean;
  allowingReadAccessToURL: string;
  onShouldStartLoadWithRequest: (req: { url: string }) => boolean;
  startInLoadingState: boolean;
  renderLoading: () => ReactElement;
  style: StyleProp<ViewStyle>;
}>;

/** The file as text, or null when there are no bytes to decode (too large, or
 * still loading). */
export function previewTextOf(file: FetchedFile | null): string | null {
  if (!file?.bytes) return null;
  try {
    return utf8Decode(file.bytes);
  } catch {
    return null;
  }
}

export function FilePreviewSheet({ part, onClose }: FilePreviewSheetProps) {
  const { t } = useTheme();
  const [file, setFile] = useState<FetchedFile | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [Viewer, setViewer] = useState<DocumentViewer | null>(null);
  const mediaId = part?.media_id ?? null;
  const name = part?.name?.trim() || 'File';
  const kind = previewKindOf(part?.name, part?.mime);

  // The frame is loaded only when a PDF or SVG is actually being shown.
  // react-native-webview touches its native module the moment it is imported,
  // so a static import would put that on every message bubble in the transcript
  // — and on every test that renders one. It is required rather than
  // import()ed because import() also drags the module's large type graph into
  // the type-check of everything downstream of the transcript.
  useEffect(() => {
    if (kind !== 'frame') return;
    const loaded = require('react-native-webview') as { default?: DocumentViewer } | undefined;
    if (!loaded) return;
    const frame = loaded.default ?? (loaded as unknown as DocumentViewer);
    setViewer(() => frame);
  }, [kind]);

  useEffect(() => {
    if (!part || !mediaId) return;
    let live = true;
    setFile(null);
    setState('loading');
    void (async () => {
      const fetched = await fetchFilePart(part);
      if (!live) return;
      setFile(fetched);
      setState(fetched ? 'ready' : 'failed');
    })();
    return () => {
      live = false;
    };
    // part is a fresh object on every render of the bubble; the media id is
    // what actually identifies the bytes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId]);

  const shareable = state === 'ready' && file ? file : null;
  const decoded = kind === 'text' || kind === 'markdown' ? previewTextOf(file) : null;
  // Markdown gets a tighter ceiling than source: a text view this large stops
  // being readable and starts being slow, and Share is one tap away.
  const limit = kind === 'markdown' ? MARKDOWN_CHAR_LIMIT : TEXT_CHAR_LIMIT;
  const shown = decoded === null ? null : decoded.slice(0, limit);
  const truncated = decoded !== null && decoded.length > limit;

  return (
    <DetailSheet visible={Boolean(part)} onClose={onClose} eyebrow="File" title={name} scroll={false}>
      <View style={styles.fill}>
        <View style={styles.bar}>
          <Text numberOfLines={1} style={[styles.note, { color: t('fg-3') }]}>
            {state === 'loading'
              ? 'Opening…'
              : state === 'failed'
                ? "Couldn't open that one"
                : kind === 'none'
                  ? 'No viewer for this kind of file'
                  : part?.mime || kind}
          </Text>
          {shareable ? (
            <ShareAction
              label={`Share ${name}`}
              onPress={() => {
                if (part) void shareFile(part, shareable.uri);
              }}
            />
          ) : null}
        </View>
        {state === 'ready' && file ? (
          kind === 'text' || kind === 'markdown' ? (
            shown === null ? (
              <Text style={[styles.help, { color: t('fg-2') }]}>
                This file is too large to show here. Use Share to open it on your phone.
              </Text>
            ) : shown.trim() === '' ? (
              <Text style={[styles.help, { color: t('fg-2') }]}>This file is empty.</Text>
            ) : (
              <ScrollView style={styles.fill} contentContainerStyle={styles.textBody}>
                {kind === 'markdown' ? (
                  <>
                    <TextPart text={shown} />
                    {truncated ? (
                      <Text style={[styles.note, styles.cut, { color: t('fg-3') }]}>
                        Showing the start of {name} — Share opens the whole file.
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <Text selectable style={[styles.mono, { color: t('fg-1') }]}>
                    {shown}
                    {truncated ? '\n\n… truncated — open it with Share to see the rest.' : ''}
                  </Text>
                )}
              </ScrollView>
            )
          ) : kind === 'image' ? (
            <Image
              accessibilityIgnoresInvertColors
              accessibilityLabel={`Preview of ${name}`}
              source={{ uri: file.uri }}
              resizeMode="contain"
              style={styles.fill}
            />
          ) : kind === 'frame' ? (
            Viewer ? (
              <Viewer
                source={{ uri: file.uri }}
                originWhitelist={['*']}
                javaScriptEnabled={false}
                allowFileAccess
                allowingReadAccessToURL={file.dir}
                onShouldStartLoadWithRequest={(req: { url: string }) => req.url === file.uri}
                startInLoadingState
                renderLoading={() => <Text style={[styles.note, { color: t('fg-3') }]}>Opening…</Text>}
                style={styles.fill}
              />
            ) : (
              <Text style={[styles.note, { color: t('fg-3') }]}>Opening…</Text>
            )
          ) : (
            <Text style={[styles.help, { color: t('fg-2') }]}>
              The Hub can show pictures, PDFs and text here. Use Share to open this one on your phone.
            </Text>
          )
        ) : null}
      </View>
    </DetailSheet>
  );
}

function ShareAction({ label, onPress }: { label: string; onPress: () => void }) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.share, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <Text style={[styles.shareLabel, { color: t('accent') }]}>Share</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, gap: 10 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 4 },
  note: { flexShrink: 1, fontFamily: fonts.mono(400), fontSize: 11 },
  help: { fontFamily: fonts.sans(400), fontSize: 14, lineHeight: 20, paddingHorizontal: 4 },
  textBody: { paddingBottom: 24 },
  cut: { marginTop: 12 },
  mono: { fontFamily: fonts.mono(400), fontSize: 12, lineHeight: 18 },
  share: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },
  shareLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
});
