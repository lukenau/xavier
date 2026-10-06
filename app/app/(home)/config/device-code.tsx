// The device-code OAuth flow (docs/inventory/config.md §6.4). Internal-only:
// mounting it POSTs /api/connectors/{id}/connect, so it must never be
// reachable from an external deep link (src/lib/deepLinks.ts).
import { useLocalSearchParams } from 'expo-router';
import { DeviceCodeSheet } from '../../../src/components/config/DeviceCodeSheet';

export default function DeviceCodeSheetScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <DeviceCodeSheet providerId={id ?? ''} />;
}
