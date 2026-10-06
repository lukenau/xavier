// One event's details. Read-only: the source exposes no RSVP status, so there
// is nothing here to answer and nothing claiming you did.
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { WireEvent } from '../../lib/calendarTypes';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY, SheetFields } from '../shell';
import { DetailSheet } from '../system/DetailSheet';
import { whenLabel } from './calendarModel';

const ACCOUNT_LABEL: Record<WireEvent['account'], string> = { work: 'Work', personal: 'Personal' };
export const UNCONFIRMED_NOTE = 'Not returned by the latest sync — it may have been cancelled, or the source may have blinked.';

const HTTPS_URL = /https:\/\/[^\s,"'<>]+\.[^\s,"'<>]+/i;

/** Everything on an event came out of someone's calendar invite by way of a
 * language model. A link is offered only when it is plainly an https one; the
 * location is searched too, because that is where Meet links often land. */
export function joinUrl(event: WireEvent): string | null {
  const own = event.conference_url?.trim() ?? '';
  if (/^https:\/\/[^\s/]+\.[^\s]+$/i.test(own)) return own;
  const inLocation = event.location?.match(HTTPS_URL);
  return inLocation ? inLocation[0] : null;
}

export function hostOf(url: string): string {
  return url.replace(/^https:\/\//i, '').split('/')[0].split('?')[0];
}

function people(count: number | null): string | null {
  if (count === null || count < 1) return null;
  return count === 1 ? '1 person' : `${count} people`;
}

export function EventSheet({ event, onClose }: { event: WireEvent | null; onClose: () => void }) {
  const { t } = useTheme();

  // Rendered closed rather than not at all, so the dismissal is the system's.
  if (!event) {
    return (
      <DetailSheet visible={false} onClose={onClose}>
        <View />
      </DetailSheet>
    );
  }

  const join = joinUrl(event);
  return (
    <DetailSheet visible onClose={onClose} title={event.title} eyebrow={ACCOUNT_LABEL[event.account]}>
      {event.unconfirmed ? (
        <Text accessibilityRole="alert" style={[styles.note, { color: t('status-warn') }]}>
          {UNCONFIRMED_NOTE}
        </Text>
      ) : null}
      <SheetFields
        fields={[
          { label: 'When', value: whenLabel(event) },
          { label: 'Where', value: event.location },
          { label: 'Organizer', value: event.organizer },
          { label: 'Invited', value: people(event.attendee_count) },
        ]}
      />
      {join ? (
        <Pressable
          onPress={() => {
            Linking.openURL(join).catch(() => undefined);
          }}
          accessibilityRole="link"
          accessibilityLabel="Join"
          style={({ pressed }) => [
            styles.join,
            { backgroundColor: t('petrol-soft'), borderColor: t('petrol-border') },
            pressed && { opacity: PRESSED_OPACITY },
          ]}
        >
          <SymbolView name="video" size={16} tintColor={t('petrol')} weight="regular" />
          <View style={styles.joinText}>
            <Text style={[styles.joinLabel, { color: t('petrol') }]}>Join meeting</Text>
            <Text style={[styles.joinHost, { color: t('fg-3') }, MONO_FEATURES]} numberOfLines={1}>
              {hostOf(join)}
            </Text>
          </View>
        </Pressable>
      ) : null}
    </DetailSheet>
  );
}

const styles = StyleSheet.create({
  note: { fontFamily: fonts.sans(500), fontSize: 13, lineHeight: 18, paddingHorizontal: 4, paddingBottom: 12 },
  join: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 52,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 14,
    paddingHorizontal: 16,
  },
  joinText: { alignItems: 'center' },
  joinLabel: { fontFamily: fonts.sans(580), fontSize: 15 },
  joinHost: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 1 },
});
