// The `/` picker — VERDICT-V2 §4.6.3, modelled on Claude Code per the user's own
// brief ("i want skills to be invokable the same way i can call / in the
// middle of a claude code message").
//
// It docks directly above the composer and filters as you type. The first cut
// used the terminal's modal Sheet, which dismissed the keyboard and covered
// the screen: "i want the slash commands to open a tab above the keyboard to
// select... it should be tied to what's being typed more" (the user, 2026-09-22).
// A modal is the wrong shape for an autocomplete that opens and shuts on every
// keystroke — this is a plain View inside the composer, so the keyboard never
// goes down and the list never covers the conversation.
import { useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { PRESSED_OPACITY } from '../shell';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { filterCommands, type CommandCatalogEntry, type CommandCategory } from '../../chat/commands';

const CATEGORY_LABEL: Record<CommandCategory, string> = {
  skill: 'skill',
  builtin: 'builtin',
  plugin: 'plugin',
  alias: 'alias',
};

export interface CommandSheetProps {
  open: boolean;
  onClose: () => void;
  /** Text typed after the `/` so far — filters the catalog live, no round trip. */
  query: string;
  commands: CommandCatalogEntry[];
  /** Whether the thread has a turn in flight — gates `reject`-policy rows and
   * puts `interrupt_then_dispatch` ones behind a confirm (VERDICT-V2 §4.6.3). */
  running: boolean;
  onSelect: (entry: CommandCatalogEntry) => void;
}

/** One row's interaction state, derived from `busy_policy` + `running` alone
 * (VERDICT-V2 §4.6.3: `reject` disabled, `dispatch` always enabled,
 * `interrupt_then_dispatch` enabled behind a confirm) — a pure function so the
 * gating rule is checkable without mounting the sheet. */
export function rowState(
  entry: CommandCatalogEntry,
  running: boolean,
): 'enabled' | 'disabled' | 'confirm' {
  if (!running) return 'enabled';
  if (entry.busy_policy === 'reject') return 'disabled';
  if (entry.busy_policy === 'interrupt_then_dispatch') return 'confirm';
  return 'enabled';
}

function Badge({ category }: { category: CommandCategory }) {
  const { t } = useTheme();
  // `skill` gets `accent` — the same token the user's own name for it in the
  // brief ("skills to be invokable") makes the category worth calling out;
  // everything else is a quieter, structurally-distinct color per category so
  // the eye doesn't have to read the label to tell them apart at a glance.
  const color = t(
    category === 'skill'
      ? 'accent'
      : category === 'builtin'
        ? 'petrol'
        : category === 'plugin'
          ? 'series-4'
          : 'fg-3',
  );
  const soft = t(
    category === 'skill'
      ? 'accent-soft'
      : category === 'builtin'
        ? 'petrol-soft'
        : 'bg-2',
  );
  return (
    <View style={[styles.badge, { backgroundColor: soft }]}>
      <Text style={[styles.badgeLabel, { color }]}>{CATEGORY_LABEL[category]}</Text>
    </View>
  );
}

function CommandRow({
  entry,
  running,
  onSelect,
}: {
  entry: CommandCatalogEntry;
  running: boolean;
  onSelect: (entry: CommandCatalogEntry) => void;
}) {
  const { t } = useTheme();
  const state = rowState(entry, running);
  const disabled = state === 'disabled';

  const press = () => {
    if (disabled) return;
    if (state === 'confirm') {
      Alert.alert(
        `Interrupt the running turn?`,
        `${entry.name} stops what's running now and starts a new one.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Continue', style: 'destructive', onPress: () => onSelect(entry) },
        ],
      );
      return;
    }
    onSelect(entry);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry.name}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={press}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: t('border') },
        pressed && !disabled && { opacity: PRESSED_OPACITY },
        disabled && styles.rowDisabled,
      ]}
    >
      <View style={styles.rowMain}>
        <View style={styles.rowTitleLine}>
          <Text style={[styles.rowName, { color: disabled ? t('fg-3') : t('fg-0') }]}>{entry.name}</Text>
          {entry.arg_hint ? (
            <Text style={[styles.rowArgHint, { color: t('fg-2') }]} numberOfLines={1}>
              {entry.arg_hint}
            </Text>
          ) : null}
        </View>
        {entry.description ? (
          <Text
            style={[styles.rowDescription, { color: t('fg-2') }]}
            numberOfLines={1}
          >
            {entry.description}
          </Text>
        ) : null}
      </View>
      <Badge category={entry.category} />
    </Pressable>
  );
}

export function CommandSheet({ open, onClose, query, commands, running, onSelect }: CommandSheetProps) {
  const { t } = useTheme();
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  if (!open) return null;

  return (
    <View style={[styles.dock, { backgroundColor: t('bg-1'), borderColor: t('border') }]}>
      <View style={[styles.dockHead, { borderBottomColor: t('border') }]}>
        <Text style={[styles.dockQuery, { color: t('accent') }]} numberOfLines={1}>
          /{query}
        </Text>
        <Text style={[styles.dockCount, { color: t('fg-2') }]}>
          {filtered.length} {filtered.length === 1 ? 'match' : 'matches'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close commands"
          onPress={onClose}
          style={({ pressed }) => [styles.dockClose, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.dockCloseGlyph, { color: t('fg-3') }]}>✕</Text>
        </Pressable>
      </View>
      {filtered.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: t('fg-3') }]}>
            {commands.length === 0 ? 'Loading commands…' : 'No matching command or skill.'}
          </Text>
        </View>
      ) : (
        // keyboardShouldPersistTaps="always": a tap on a row must select it
        // WITHOUT the keyboard going down first — that dismissal is the whole
        // reason the modal version felt wrong.
        <ScrollView
          style={styles.dockList}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="none"
          showsVerticalScrollIndicator={false}
        >
          {filtered.map((entry) => (
            <CommandRow key={entry.name} entry={entry} running={running} onSelect={onSelect} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Three rows and no more: head ~31 (7+7 padding, 13pt query, hairline) +
  // 3 × ~58 per two-line row (11+11 padding, 13.5pt name, 2 gap, 12pt
  // description, hairline) + 2 border ≈ 207. On an iPhone 15 Pro with the
  // portrait keyboard up, the old 248 left ~58pt of transcript (two lines);
  // 208 leaves ~98. More rows scroll.
  dock: { maxHeight: 208, borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  dockHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dockQuery: { flex: 1, minWidth: 0, fontFamily: fonts.mono(600), fontSize: 13 },
  dockCount: { fontFamily: fonts.mono(400), fontSize: 10 },
  dockClose: { minWidth: 28, minHeight: 24, alignItems: 'flex-end', justifyContent: 'center' },
  dockCloseGlyph: { fontFamily: fonts.sans(400), fontSize: 13 },
  dockList: { paddingHorizontal: 11 },
  empty: { paddingVertical: 20, alignItems: 'center' },
  emptyText: { fontFamily: fonts.sans(500), fontSize: 13 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowDisabled: { opacity: 0.45 },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  rowName: { fontFamily: fonts.mono(600), fontSize: 13.5 },
  rowArgHint: { flexShrink: 1, fontFamily: fonts.mono(400), fontSize: 11.5 },
  rowDescription: { fontFamily: fonts.sans(400), fontSize: 12 },
  badge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  badgeLabel: { fontFamily: fonts.mono(600), fontSize: 9.5, letterSpacing: 0.6, textTransform: 'uppercase' },
});
