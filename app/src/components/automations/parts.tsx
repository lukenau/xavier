// The rows every Automations screen is built from. A job row and a run row are
// the same card with a different first line, so a job in the inbox and one of
// its runs in its history read as the same object.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import type { TokenName } from '../../theme/tokens.gen';
import { relTime } from '../../shared/time';
import { Card, PRESSED_OPACITY } from '../shell';
import {
  PILL_TOKENS,
  jobDot,
  jobPills,
  quietLine,
  runDot,
  runPills,
  timeOf,
  type Pill,
} from '../../automations/model';
import type { AutomationJob, RunSummary } from '../../automations/types';

export function Pills({ pills }: { pills: Pill[] }) {
  const { t } = useTheme();
  if (pills.length === 0) return null;
  return (
    <View style={styles.pills}>
      {pills.map((pill, i) => {
        const tokens = PILL_TOKENS[pill.tone];
        return (
          <View
            key={i}
            style={[styles.pill, { backgroundColor: t(tokens.bg), borderColor: t(tokens.border) }]}
          >
            <Text style={[styles.pillLabel, { color: t(tokens.fg) }]}>{pill.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

function Row({
  dot,
  title,
  time,
  preview,
  lines,
  more,
  pills,
  alert,
  onPress,
}: {
  dot: TokenName;
  title: string;
  time: string;
  preview: string;
  lines?: string[];
  more?: number;
  pills: Pill[];
  alert: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Card
      onPress={onPress}
      accessibilityLabel={[title, time, preview].filter(Boolean).join(', ')}
      style={[styles.card, alert ? { borderColor: t('status-warn-border') } : null]}
    >
      <View style={styles.row}>
        <View testID="automation-dot" style={[styles.dot, { backgroundColor: t(dot) }]} />
        <View style={styles.body}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: t('fg-0') }]} numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.time, { color: t('fg-2') }]}>{time}</Text>
          </View>
          {lines && lines.length > 0 ? (
            <View style={styles.lines}>
              {lines.map((line, i) => (
                <View key={i} style={styles.lineRow}>
                  {lines.length > 1 ? <View style={[styles.bullet, { backgroundColor: t('fg-4') }]} /> : null}
                  <Text style={[styles.line, { color: t('fg-1') }]} numberOfLines={lines.length > 1 ? 1 : 3}>
                    {line}
                  </Text>
                </View>
              ))}
              {more ? <Text style={[styles.more, { color: t('fg-3') }]}>+{more} more</Text> : null}
            </View>
          ) : preview ? (
            <Text style={[styles.line, { color: t('fg-1') }]} numberOfLines={3}>
              {preview}
            </Text>
          ) : null}
          <Pills pills={pills} />
        </View>
      </View>
    </Card>
  );
}

export function JobRow({ job, onPress }: { job: AutomationJob; onPress: () => void }) {
  const head = job.latest ?? job.last_run;
  return (
    <Row
      dot={jobDot(job)}
      title={job.name}
      time={head ? relTime(head.run_time) : ''}
      preview={quietLine(job)}
      lines={job.latest?.preview_lines}
      more={job.latest?.more_lines}
      pills={jobPills(job)}
      alert={job.needs_you}
      onPress={onPress}
    />
  );
}

/** `named` puts the job's name on the row, for a list that mixes jobs; a job's
 * own history already says whose runs these are and leads with the time. */
export function RunRow({ run, named, onPress }: { run: RunSummary; named: boolean; onPress: () => void }) {
  const attention = !run.read && run.severity !== 'info';
  return (
    <Row
      dot={runDot(run)}
      title={named ? run.job_name : relTime(run.run_time)}
      time={timeOf(run.run_time)}
      preview={run.preview}
      lines={run.preview_lines}
      more={run.more_lines}
      pills={runPills(run)}
      alert={attention}
      onPress={onPress}
    />
  );
}

/** Several jobs failing the same way, as the one problem they are. */
export function ClusterRow({
  count,
  preview,
  open,
  onPress,
}: {
  count: number;
  preview: string;
  open: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  const title = `${count} automations failing the same way`;
  return (
    <Card onPress={onPress} accessibilityLabel={title} style={[styles.card, { borderColor: t('status-down-border') }]}>
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: t('status-down') }]} />
        <View style={styles.body}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: t('fg-0') }]} numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.time, { color: t('fg-2') }]}>{open ? 'hide' : 'show'}</Text>
          </View>
          {preview ? (
            <Text style={[styles.line, { color: t('fg-1') }]} numberOfLines={2}>
              {preview}
            </Text>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

/** A stretch of runs that added nothing, as one line. */
export function FoldRow({ label, detail, onPress }: { label: string; detail?: string; onPress?: () => void }) {
  const { t } = useTheme();
  const body = (
    <>
      <Text style={[styles.foldLabel, { color: t('fg-3') }]} numberOfLines={2}>
        {label}
      </Text>
      {detail ? <Text style={[styles.foldDetail, { color: t('fg-4') }]}>{detail}</Text> : null}
    </>
  );
  if (!onPress) {
    return <View style={[styles.fold, { borderColor: t('border') }]}>{body}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.fold, { borderColor: t('border') }, pressed && { opacity: PRESSED_OPACITY }]}
    >
      {body}
    </Pressable>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  const { t } = useTheme();
  return (
    <View style={[styles.segmented, { backgroundColor: t('bg-2') }]}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.id)}
            style={[
              styles.segment,
              active ? { backgroundColor: t('bg-1'), borderColor: t('border-strong') } : { borderColor: 'transparent' },
            ]}
          >
            <Text style={[styles.segmentLabel, { color: t(active ? 'fg-0' : 'fg-3') }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  const { t } = useTheme();
  return (
    <View style={styles.chips}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.id)}
            style={({ pressed }) => [
              styles.chip,
              {
                backgroundColor: t(active ? 'accent-soft' : 'bg-1'),
                borderColor: t(active ? 'accent-border' : 'border'),
              },
              pressed && { opacity: PRESSED_OPACITY },
            ]}
          >
            <Text style={[styles.chipLabel, { color: t(active ? 'accent' : 'fg-3') }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The header's small outlined action, as Chat's New and Inbox chips are. */
export function HeaderChip({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.headerChip,
        { borderColor: t('border'), backgroundColor: t('bg-1') },
        (pressed || disabled) && { opacity: PRESSED_OPACITY },
      ]}
    >
      <Text style={[styles.headerChipLabel, { color: t('fg-3') }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 15, paddingVertical: 14, marginBottom: 10 },
  row: { flexDirection: 'row', gap: 11 },
  dot: { width: 9, height: 9, borderRadius: 4.5, marginTop: 7 },
  body: { flex: 1, minWidth: 0, gap: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, minWidth: 0, fontFamily: fonts.sans(600), fontSize: 16 },
  time: { flexShrink: 0, fontFamily: fonts.mono(400), fontSize: 11, ...MONO_FEATURES },
  lines: { gap: 3 },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bullet: { width: 4, height: 4, borderRadius: 2 },
  line: { flex: 1, minWidth: 0, fontFamily: fonts.sans(400), fontSize: 14, lineHeight: 20 },
  more: { fontFamily: fonts.sans(400), fontSize: 12.5, marginLeft: 12 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  pill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 3 },
  pillLabel: { fontFamily: fonts.mono(400), fontSize: 10.5, letterSpacing: 0.5, textTransform: 'uppercase' },
  fold: {
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginBottom: 9,
    gap: 2,
  },
  foldLabel: { fontFamily: fonts.mono(400), fontSize: 11, lineHeight: 16 },
  foldDetail: { fontFamily: fonts.mono(400), fontSize: 10.5 },
  segmented: { flexDirection: 'row', borderRadius: 11, padding: 2, marginBottom: 12 },
  segment: { flex: 1, minHeight: 34, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  segmentLabel: { fontFamily: fonts.sans(550), fontSize: 13 },
  chips: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  chip: { flex: 1, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chipLabel: { fontFamily: fonts.mono(400), fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase' },
  headerChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  headerChipLabel: { fontFamily: fonts.mono(400), fontSize: 10.5, letterSpacing: 0.3 },
});
