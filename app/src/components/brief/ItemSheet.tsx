// One item, in the app's own detail sheet.
//
// The sheet is the PRIMARY target for every row — tapping a row opens this,
// and "Open in source" is a secondary action that is simply absent when nothing
// resolves (spec §7). That is the native replacement for the old page's
// "item links to a web sub-page" (spec §11.4).
//
// Useful lives here rather than on a leading swipe, which is unavailable
// (spec §12.2). Tapping a row opens the sheet, so Useful is always two taps.
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { HUB_ORIGIN } from '../../lib/api';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { DetailSheet, statusToneColor } from '../system/DetailSheet';
import { openBrief, resolveBriefUri } from '../briefs';
import {
  chipsFor,
  isStale,
  linkTarget,
  metaLine,
  originSymbol,
  resolveRelated,
  type Brief,
  type BriefItem,
  type LinkTarget,
} from './briefModel';
import { ChipRow } from './Chips';
import type { UseBriefActions } from './useBriefActions';

/** Run a resolved link target. Returns false when the target could not be
 * opened, so the caller can say so rather than doing nothing visible. */
export function followTarget(target: NonNullable<LinkTarget>): boolean {
  if (target.kind === 'route') {
    router.push(target.href);
    return true;
  }
  if (target.kind === 'page') {
    const uri = resolveBriefUri(`${HUB_ORIGIN}${target.path}`);
    if (!uri) return false;
    openBrief(uri, 'Brief page');
    return true;
  }
  void Linking.openURL(target.url);
  return true;
}

export function ItemSheet({
  item,
  brief,
  onClose,
  onOpenRelated,
  actions,
}: {
  item: BriefItem | null;
  brief: Brief | undefined;
  onClose: () => void;
  onOpenRelated: (item: BriefItem) => void;
  actions: UseBriefActions;
}) {
  const { t } = useTheme();
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // Nothing open. Rendering the sheet closed rather than returning null keeps
  // the Modal mounted so its dismissal animation is the system's.
  if (!item) {
    return (
      <DetailSheet visible={false} onClose={onClose}>
        <View />
      </DetailSheet>
    );
  }

  const stale = isStale(brief, item);
  const related = resolveRelated(brief, item);
  const target = linkTarget(item);

  return (
    <DetailSheet
      visible
      onClose={onClose}
      // DetailSheet already styles the eyebrow mono/tracked/uppercase.
      eyebrow={item.source}
      title={item.title}
      status={
        stale
          ? { label: `${item.origin} is degraded`, color: t(statusToneColor('degraded')) }
          : null
      }
    >
      {item.why ? <Text style={[styles.why, { color: t('fg-1') }]}>{item.why}</Text> : null}
      {/* `detail` is what the generator redacted and capped for exactly this
          spot. A brief minted before it existed simply has none. */}
      {item.detail ? (
        <Text style={[styles.detail, { color: t('fg-2') }]}>{item.detail}</Text>
      ) : null}

      {item.evidence.length > 0 ? (
        <View style={styles.evidence}>
          {item.evidence.map((quote, i) => (
            <View key={i} style={[styles.quote, { borderLeftColor: t('border') }]}>
              <Text style={[styles.quoteText, { color: t('fg-2') }]}>{quote}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <ChipRow chips={chipsFor(item)} />

      <View style={styles.metaRow}>
        <SymbolView name={originSymbol(item.origin)} size={13} tintColor={t('fg-4')} weight="regular" />
        <Text style={[styles.meta, { color: t('fg-4') }]}>
          {metaLine(item)}
          {item.carried_from ? ` · carried from ${item.carried_from}` : ''}
        </Text>
      </View>

      <View style={[styles.actions, { borderTopColor: t('border') }]}>
        <SheetAction
          label="Useful"
          symbol="hand.thumbsup"
          onPress={async () => {
            const ok = await actions.markUseful(item);
            setNote(ok ? 'Noted — tomorrow’s gather will keep this kind.' : 'Couldn’t send that.');
          }}
        />
        <SheetAction
          label="Snooze 3 days"
          symbol="clock.arrow.circlepath"
          onPress={() => {
            actions.snooze(item, '3d');
            onClose();
          }}
        />
        <SheetAction
          label="Done"
          symbol="checkmark"
          onPress={() => {
            actions.dismiss(item);
            onClose();
          }}
        />
        {target ? (
          <SheetAction
            label={target.label}
            symbol="arrow.up.right.square"
            onPress={() => {
              if (!followTarget(target)) setNote('That page isn’t on the hub.');
              else onClose();
            }}
          />
        ) : null}
      </View>

      {/* "Tell the brief about this" (Ruling 146) — a note in the user's own
          words, read back into tomorrow's prompt (THE USER'S NOTES ON PAST
          ITEMS in load_exemplars). Notes are not deduped server-side. */}
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="Tell the brief about this…"
        placeholderTextColor={t('fg-4')}
        returnKeyType="send"
        maxLength={300}
        maxFontSizeMultiplier={1.6}
        style={[styles.noteInput, { color: t('fg-1'), borderTopColor: t('border') }]}
        onSubmitEditing={() => {
          const text = draft.trim();
          if (!text) return;
          setDraft('');
          void (async () => {
            const ok = await actions.noteItem(item, text);
            setNote(ok ? 'Noted — tomorrow’s gather will read that.' : 'Couldn’t send that.');
          })();
        }}
      />

      {note ? (
        <Text accessibilityRole="alert" style={[styles.note, { color: t('fg-3') }]}>
          {note}
        </Text>
      ) : null}

      {related.length > 0 ? (
        <View style={styles.related}>
          <Text style={[styles.relatedLabel, { color: t('fg-4') }]}>RELATED</Text>
          {related.map((other) => (
            <Pressable
              key={other.item_id}
              accessibilityRole="button"
              accessibilityLabel={other.title}
              onPress={() => onOpenRelated(other)}
              style={({ pressed }) => [
                styles.relatedRow,
                { borderTopColor: t('border') },
                pressed && { opacity: PRESSED_OPACITY },
              ]}
            >
              <Text numberOfLines={2} style={[styles.relatedTitle, { color: t('fg-2') }]}>
                {other.title}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </DetailSheet>
  );
}

function SheetAction({
  label,
  symbol,
  onPress,
}: {
  label: string;
  symbol: 'hand.thumbsup' | 'clock.arrow.circlepath' | 'checkmark' | 'arrow.up.right.square';
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <SymbolView name={symbol} size={16} tintColor={t('accent')} weight="regular" />
      <Text maxFontSizeMultiplier={1.6} style={[styles.actionLabel, { color: t('accent') }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  why: { fontFamily: fonts.sans(400), fontSize: 14, lineHeight: 20, paddingHorizontal: 4 },
  detail: {
    fontFamily: fonts.sans(400),
    fontSize: 13,
    lineHeight: 19,
    marginTop: 10,
    paddingHorizontal: 4,
  },
  evidence: { marginTop: 14, gap: 10 },
  quote: { borderLeftWidth: 2, paddingLeft: 10 },
  quoteText: { fontFamily: fonts.sans(400), fontSize: 12.5, lineHeight: 18 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, paddingHorizontal: 4 },
  meta: { flex: 1, minWidth: 0, fontFamily: fonts.mono(400), fontSize: 11 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 8,
  },
  actionLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
  noteInput: {
    fontFamily: fonts.sans(400),
    fontSize: 14,
    minHeight: 44,
    marginTop: 4,
    paddingTop: 12,
    paddingHorizontal: 4,
    borderTopWidth: 1,
  },
  note: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 10, paddingHorizontal: 4 },
  related: { marginTop: 18 },
  relatedLabel: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  relatedRow: { borderTopWidth: 1, paddingVertical: 12, paddingHorizontal: 4, minHeight: 48, justifyContent: 'center' },
  relatedTitle: { fontFamily: fonts.sans(550), fontSize: 13.5 },
});
