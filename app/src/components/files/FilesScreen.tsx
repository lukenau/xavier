// 1:1 port of apps/hub/src/routes/Files.tsx — roots / browse / read, per
// docs/inventory/terminal.md §7. Read-only; no WebView involved (kept in
// Task 19 alongside the brief/trusted-page work because the task brief
// grouped it with the other route(s) Task 8 stubbed out).
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import type { FsEntry } from '../../lib/types';
import { PageTitle, PRESSED_OPACITY, Screen, StatePanel, useHideTabBar } from '../shell';
import { useTheme } from '../../theme/useTheme';
import { fonts } from '../../theme/fonts';
import {
  breadcrumbSegments,
  DEFAULT_ROOT_ID,
  filePreviewErrorCopy,
  formatMtime,
  formatSize,
  joinPath,
  parentPath,
} from './filesPath';

interface Selection {
  root: string;
  path: string;
}

function BackToOps() {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => router.back()}
      accessibilityRole="button"
      style={({ pressed }) => [styles.backToOps, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <Text style={[styles.backToOpsLabel, { color: t('accent') }]}>‹ Ops</Text>
    </Pressable>
  );
}

function FilePreview({ selection, onBack }: { selection: Selection; onBack: () => void }) {
  const { t } = useTheme();
  const { data, error, isLoading } = usePoll(
    ['fs-read', selection.root, selection.path],
    () => api.fsRead(selection.root, selection.path),
    QUERY_TUNING['fs-read'],
  );
  const name = selection.path.split('/').pop() ?? selection.path;

  return (
    <>
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        style={({ pressed }) => [styles.backRow, pressed && { opacity: PRESSED_OPACITY }]}
      >
        <Text style={[styles.backRowLabel, { color: t('fg-2') }]}>‹ Back to listing</Text>
      </Pressable>
      <View style={[styles.previewCard, { backgroundColor: t('bg-1'), borderColor: t('border') }]}>
        <View style={styles.previewHeader}>
          <Text numberOfLines={1} style={[styles.previewName, { color: t('fg-0') }]}>
            {name}
          </Text>
          <Text style={[styles.previewSize, { color: t('fg-3') }]}>
            {data ? formatSize(data.size) : ''}
          </Text>
        </View>
        {isLoading && <Text style={[styles.previewMeta, { color: t('fg-3') }]}>Loading…</Text>}
        {error && (
          <Text style={[styles.previewMeta, { color: t('status-down') }]}>
            {filePreviewErrorCopy((error as Error).message)}
          </Text>
        )}
        {data && <Text style={[styles.previewText, { color: t('fg-1') }]}>{data.text}</Text>}
      </View>
    </>
  );
}

function Breadcrumb({
  rootLabel,
  path,
  onNavigate,
}: {
  rootLabel: string;
  path: string;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTheme();
  const segments = breadcrumbSegments(path);
  return (
    <View style={styles.breadcrumb}>
      <Pressable onPress={() => onNavigate('')} hitSlop={10}>
        <Text style={[styles.breadcrumbSeg, { color: t('fg-2') }]}>{rootLabel}</Text>
      </Pressable>
      {segments.map((seg) => (
        <View key={seg.path} style={styles.breadcrumbSegRow}>
          <Text style={[styles.breadcrumbSlash, { color: t('fg-4') }]}>/</Text>
          <Pressable onPress={() => onNavigate(seg.path)} disabled={seg.isLast} hitSlop={10}>
            <Text style={[styles.breadcrumbSeg, { color: t(seg.isLast ? 'fg-1' : 'fg-2') }]}>
              {seg.label}
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function EntryRow({ entry, onOpen }: { entry: FsEntry; onOpen: () => void }) {
  const { t } = useTheme();
  const isDir = entry.kind === 'dir';
  return (
    <Pressable onPress={onOpen} style={[styles.entryRow, { borderColor: t('border') }]}>
      <View style={[styles.entryDot, { backgroundColor: isDir ? t('accent') : t('fg-4') }]} />
      <View style={styles.entryBody}>
        <Text numberOfLines={1} style={[styles.entryName, { color: t('fg-0') }]}>
          {entry.name}
        </Text>
        <Text style={[styles.entryMeta, { color: t('fg-3') }]}>
          {isDir ? 'Directory' : formatSize(entry.size)}
          {entry.modified ? ` · ${formatMtime(entry.modified)}` : ''}
        </Text>
      </View>
      {isDir && <Text style={[styles.entryChevron, { color: t('fg-3') }]}>›</Text>}
    </Pressable>
  );
}

export default function FilesScreen() {
  useHideTabBar();
  const { t } = useTheme();
  const [rootId, setRootId] = useState<string>(DEFAULT_ROOT_ID);
  const [path, setPath] = useState<string>('');
  const [fileSelection, setFileSelection] = useState<Selection | null>(null);

  const { data: roots } = usePoll(['fs-roots'], api.fsRoots, QUERY_TUNING['fs-roots']);
  const activeRoot = useMemo(() => roots?.find((r) => r.id === rootId), [roots, rootId]);

  const { data: listing, error } = usePoll(
    ['fs-browse', rootId, path],
    () => api.fsBrowse(rootId, path),
    { ...QUERY_TUNING['fs-browse'], enabled: !fileSelection },
  );

  const selectRoot = (id: string) => {
    setRootId(id);
    setPath('');
    setFileSelection(null);
  };

  const openEntry = (entry: FsEntry) => {
    if (entry.kind === 'dir') {
      setPath(joinPath(path, entry.name));
    } else if (entry.kind === 'file') {
      setFileSelection({ root: rootId, path: joinPath(path, entry.name) });
    }
  };

  return (
    <Screen
      header={
        <>
          <BackToOps />
          <PageTitle>Files</PageTitle>
        </>
      }
    >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.rootRow}>
        {roots?.map((r) => {
          const active = r.id === rootId;
          return (
            <Pressable
              key={r.id}
              onPress={() => selectRoot(r.id)}
              style={[
                styles.rootChip,
                {
                  backgroundColor: active ? t('accent-soft') : t('bg-1'),
                  borderColor: active ? t('accent-border') : t('border'),
                },
              ]}
            >
              <Text
                style={[
                  styles.rootChipLabel,
                  {
                    color: active ? t('accent') : t('fg-2'),
                    fontFamily: fonts.sans(active ? 600 : 500),
                  },
                ]}
              >
                {r.label}
                {!r.exists && (
                  <Text style={[styles.rootChipMissing, { color: t('fg-4') }]}> missing</Text>
                )}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {fileSelection ? (
        <FilePreview selection={fileSelection} onBack={() => setFileSelection(null)} />
      ) : (
        <>
          <Breadcrumb rootLabel={activeRoot?.label ?? rootId} path={path} onNavigate={setPath} />
          {error && (
            <Text style={[styles.browseError, { color: t('status-down') }]}>
              {(error as Error).message}
            </Text>
          )}
          {listing && (
            <View>
              {path !== '' && (
                <Pressable
                  onPress={() => setPath(parentPath(path))}
                  style={[styles.entryRow, { borderColor: t('border') }]}
                >
                  <View style={styles.entryBody}>
                    <Text style={[styles.entryName, { color: t('fg-2') }]}>..</Text>
                    <Text style={[styles.entryMeta, { color: t('fg-3') }]}>Up one level</Text>
                  </View>
                </Pressable>
              )}
              {/* entries/truncated are typed required; a truncated listing must
                  not crash Files — degrade to an empty list. */}
              {(listing.entries ?? []).length === 0 ? (
                <StatePanel tone="neutral" title="Empty directory" />
              ) : (
                (listing.entries ?? []).map((e) => (
                  <EntryRow key={e.name} entry={e} onOpen={() => openEntry(e)} />
                ))
              )}
              {listing.truncated && (
                <Text style={[styles.truncatedNote, { color: t('fg-4') }]}>
                  listing truncated at 500 entries
                </Text>
              )}
            </View>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  backToOps: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  backToOpsLabel: { fontFamily: fonts.sans(520), fontSize: 13 },
  rootRow: { marginBottom: 14 },
  rootChip: {
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
    marginRight: 6,
    justifyContent: 'center',
  },
  rootChipLabel: { fontFamily: fonts.sans(500), fontSize: 12 },
  rootChipMissing: { fontFamily: fonts.mono(400), fontSize: 9 },
  breadcrumb: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', paddingBottom: 14, gap: 2 },
  breadcrumbSegRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  breadcrumbSeg: { fontFamily: fonts.mono(400), fontSize: 11, minHeight: 22 },
  breadcrumbSlash: { fontFamily: fonts.mono(400), fontSize: 11 },
  browseError: { fontFamily: fonts.mono(400), fontSize: 12, paddingBottom: 12 },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  entryDot: { width: 8, height: 8, borderRadius: 4 },
  entryBody: { flex: 1, minWidth: 0 },
  entryName: { fontFamily: fonts.sans(520), fontSize: 14 },
  entryMeta: { fontFamily: fonts.mono(400), fontSize: 10.5, marginTop: 2 },
  entryChevron: { fontSize: 16 },
  truncatedNote: {
    fontFamily: fonts.mono(400),
    fontSize: 10.5,
    textAlign: 'center',
    paddingVertical: 12,
  },
  backRow: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  backRowLabel: { fontFamily: fonts.sans(400), fontSize: 13 },
  previewCard: { borderRadius: 14, padding: 14, borderWidth: 1 },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
    paddingBottom: 10,
  },
  previewName: { fontFamily: fonts.sans(600), fontSize: 14, flexShrink: 1 },
  previewSize: { fontFamily: fonts.mono(400), fontSize: 10 },
  previewMeta: { fontFamily: fonts.sans(400), fontSize: 12 },
  previewText: { fontFamily: fonts.mono(400), fontSize: 11, lineHeight: 17 },
});
