// ConnectorsPage.tsx:327-349's read-only provider detail sheet, as a route.
// No action of its own: connecting a non-device-code provider is a terminal
// job, and `connect_cmd` is what to run.
import { StyleSheet, Text } from 'react-native';
import { SheetBody, SheetFields, SheetScreen, StatePanel } from '../shell';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { fonts } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';

export function ConnectorSheet({ providerId }: { providerId: string }) {
  const { t } = useTheme();
  // Cache-shared with ConnectorsPage — the sheet is only ever pushed from it.
  const connectors = usePoll(['connectors'], api.connectors, QUERY_TUNING.connectors);
  const provider = connectors.data?.providers.find((p) => p.id === providerId);

  if (!provider) {
    return (
      <SheetScreen eyebrow="Connector" title={providerId}>
        <StatePanel
          tone={connectors.isError ? 'error' : 'pending'}
          title={connectors.isError ? 'Connectors unavailable' : 'Reading connectors…'}
          detail={connectors.isError ? (connectors.error?.message ?? '') : 'GET /api/connectors'}
        />
      </SheetScreen>
    );
  }

  return (
    <SheetScreen
      eyebrow="Connector"
      title={provider.name}
      status={{
        label: provider.connected ? 'connected' : 'not connected',
        color: provider.connected ? t('status-up') : t('fg-4'),
      }}
    >
      <SheetFields
        fields={[
          { label: 'Flow', value: provider.flow, mono: true },
          { label: 'Connected', value: provider.connected ? 'yes' : 'no' },
          { label: 'Credentials', value: String(provider.credentials.length), mono: true },
        ]}
      />
      {provider.connect_cmd ? (
        <SheetBody label="Connect command">
          <Text style={[styles.command, { color: t('fg-1') }]}>{provider.connect_cmd}</Text>
        </SheetBody>
      ) : null}
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  command: { fontFamily: fonts.mono(400), fontSize: 12, lineHeight: 18 },
});
