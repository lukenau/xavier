// The newest Discord thread, when there is one (Home.tsx:74-101). Taps
// through to Ops, where the sessions list lives.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import type { AgentSession } from '../../lib/types';
import { relTime } from '../../shared/time';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { discordSession } from './homeState';

export function DiscordRow({ sessions }: { sessions: AgentSession[] | undefined }) {
  const { t } = useTheme();
  const session = discordSession(sessions);
  if (!session) return null;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={session.title ?? 'Discord thread'}
      onPress={() => router.push('/ops')}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: t('bg-1'), borderColor: t('border') },
        pressed && { opacity: PRESSED_OPACITY },
      ]}
    >
      <SymbolView name="paperplane" size={16} tintColor={t('fg-3')} weight="regular" />
      <View style={styles.text}>
        <Text style={[styles.title, { color: t('fg-1') }]} numberOfLines={1} ellipsizeMode="tail">
          {session.title ?? 'Discord thread'}
        </Text>
        {session.preview ? (
          <Text
            style={[styles.preview, { color: t('fg-3') }]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {session.preview}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.when, { color: t('fg-4') }]}>{relTime(session.last_active)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 11,
    marginBottom: 12,
  },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: fonts.sans(540), fontSize: 13.5 },
  preview: { fontFamily: fonts.sans(400), fontSize: 11.5, marginTop: 1 },
  when: { fontFamily: fonts.mono(400), fontSize: 10 },
});
