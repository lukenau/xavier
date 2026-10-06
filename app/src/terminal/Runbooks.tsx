// Runbooks, not a snippet pile: grouped one-tappers for the ops the user
// actually runs from a phone (Warp-workflow pattern). They FILL the composer
// for review — nothing executes on tap.
//
// The list below ships in a public repo, so it holds GENERIC examples a
// stranger can read and run on any host, never the owner's own estate. Self-
// hosters are expected to edit these (or wire a server-provided list) to match
// their own box.
import { Fragment } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts } from '../theme/fonts';
import { useTheme } from '../theme/useTheme';
import { TerminalSheet } from './Sheet';

export interface Snippet {
  label: string;
  cmd: string;
}

export const RUNBOOKS: readonly { section: string; items: readonly Snippet[] }[] = [
  {
    section: 'Host',
    items: [
      { label: 'System info', cmd: 'uname -a' },
      { label: 'Disk space', cmd: 'df -h' },
      { label: 'Memory + load', cmd: 'free -h && uptime' },
      { label: 'Listening ports', cmd: 'ss -lntup' },
    ],
  },
  {
    section: 'Docker',
    items: [
      { label: 'List containers', cmd: 'docker ps' },
      { label: 'Compose services', cmd: 'docker compose ps' },
      { label: 'Follow a container log', cmd: 'docker logs -f ' },
      { label: 'Shell into a container', cmd: 'docker exec -it ' },
    ],
  },
  {
    section: 'Logs',
    items: [
      { label: 'Tail a file', cmd: 'tail -f ' },
      { label: 'Search a log for errors', cmd: 'grep -i error ' },
      { label: 'Journal for a unit', cmd: 'journalctl -u ' },
    ],
  },
];

export interface RunbooksProps {
  open: boolean;
  onClose: () => void;
  onDismissed?: () => void;
  /** Hands the command over; the screen applies it once the sheet is gone. */
  onSnippet: (cmd: string) => void;
}

export function Runbooks({ open, onClose, onDismissed, onSnippet }: RunbooksProps) {
  const { t } = useTheme();

  return (
    <TerminalSheet
      open={open}
      onClose={onClose}
      onDismissed={onDismissed}
      eyebrow="Terminal"
      title="Runbooks"
    >
      <View style={styles.body}>
        {RUNBOOKS.map((group) => (
          <Fragment key={group.section}>
            <Text style={[styles.section, { color: t('fg-4') }]}>{group.section.toUpperCase()}</Text>
            {group.items.map((snippet, i) => (
              <Pressable
                key={snippet.label}
                accessibilityRole="button"
                onPress={() => {
                  onSnippet(snippet.cmd);
                  onClose();
                }}
                style={({ pressed }) => [
                  styles.item,
                  i < group.items.length - 1 && { borderBottomWidth: 1, borderBottomColor: t('border') },
                  // `active:opacity-70` — the runbook rows' own press state,
                  // not the shell's 0.8 PRESSED_OPACITY.
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={[styles.itemLabel, { color: t('fg-0') }]}>{snippet.label}</Text>
                <Text numberOfLines={1} style={[styles.itemCmd, { color: t('fg-3') }]}>
                  {snippet.cmd}
                </Text>
              </Pressable>
            ))}
          </Fragment>
        ))}
        <Text style={[styles.footer, { color: t('fg-4') }]}>
          runbooks fill the composer — review, edit, then send
        </Text>
      </View>
    </TerminalSheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: 6 },
  section: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    letterSpacing: 1.4,
    paddingTop: 8,
    paddingBottom: 4,
    marginTop: 6,
  },
  item: { minHeight: 48, paddingVertical: 11, justifyContent: 'center' },
  itemLabel: { fontFamily: fonts.sans(540), fontSize: 14 },
  itemCmd: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 2 },
  footer: { fontFamily: fonts.mono(400), fontSize: 10, paddingTop: 8 },
});
