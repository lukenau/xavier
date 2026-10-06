// "Teach the brief" (Ruling 146) — the user's own standing rules, read back into
// every morning's gather (brief_triage.load_exemplars, right after the date
// line). Read-only GET is ungated; add/remove go through the same
// device-key/WebAuthn gate as saveTopicRouting (api.ts addBriefingRule /
// removeBriefingRule) — this sheet never signs anything itself.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { PRESSED_OPACITY } from '../shell';
import { DetailSheet } from '../system/DetailSheet';

const RULES_QUERY_KEY = ['briefing-rules'];

export function RulesSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTheme();
  const qc = useQueryClient();
  const rules = usePoll(RULES_QUERY_KEY, () => api.briefingRules(), { enabled: visible });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = rules.data?.rules ?? [];

  async function addRule() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addBriefingRule(text);
      setDraft('');
      await qc.invalidateQueries({ queryKey: RULES_QUERY_KEY });
    } catch {
      setError('Couldn’t save that rule.');
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.removeBriefingRule(id);
      await qc.invalidateQueries({ queryKey: RULES_QUERY_KEY });
    } catch {
      setError('Couldn’t remove that rule.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailSheet visible={visible} onClose={onClose} eyebrow="teach the brief" title="Standing rules">
      <Text style={[styles.intro, { color: t('fg-3') }]}>
        Your own sentences — read back into every morning’s gather. Where one conflicts with a
        gate default, the rule wins.
      </Text>

      {list.length === 0 ? (
        <Text style={[styles.empty, { color: t('fg-4') }]}>No rules yet.</Text>
      ) : (
        list.map((rule) => (
          <View key={rule.id} style={[styles.row, { borderTopColor: t('border') }]}>
            <Text style={[styles.ruleText, { color: t('fg-1') }]}>{rule.text}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove rule: ${rule.text}`}
              onPress={() => void removeRule(rule.id)}
              style={({ pressed }) => [styles.removeHit, pressed && { opacity: PRESSED_OPACITY }]}
            >
              <SymbolView name="minus.circle" size={20} tintColor={t('status-down')} weight="regular" />
            </Pressable>
          </View>
        ))
      )}

      {error ? (
        <Text accessibilityRole="alert" style={[styles.error, { color: t('status-down') }]}>
          {error}
        </Text>
      ) : null}

      <View style={[styles.addRow, { borderTopColor: t('border') }]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="my manager owns OKRs, never me…"
          placeholderTextColor={t('fg-4')}
          returnKeyType="done"
          maxLength={300}
          maxFontSizeMultiplier={1.6}
          style={[styles.input, { color: t('fg-1') }]}
          onSubmitEditing={() => void addRule()}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add rule"
          onPress={() => void addRule()}
          style={({ pressed }) => [styles.addHit, pressed && { opacity: PRESSED_OPACITY }]}
        >
          <Text style={[styles.addLabel, { color: t('accent') }]}>Add</Text>
        </Pressable>
      </View>
    </DetailSheet>
  );
}

const styles = StyleSheet.create({
  intro: { fontFamily: fonts.sans(400), fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
  empty: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 14, paddingHorizontal: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderTopWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 4,
    marginTop: 10,
  },
  ruleText: { flex: 1, minWidth: 0, fontFamily: fonts.sans(400), fontSize: 14, lineHeight: 19 },
  removeHit: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  error: { fontFamily: fonts.mono(400), fontSize: 11, marginTop: 10, paddingHorizontal: 4 },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 18,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  input: { flex: 1, minWidth: 0, fontFamily: fonts.sans(400), fontSize: 14, minHeight: 44, paddingHorizontal: 4 },
  addHit: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  addLabel: { fontFamily: fonts.sans(550), fontSize: 14 },
});
