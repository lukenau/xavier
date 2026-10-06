// "Restart / Drain the gateway?" — ConfigHome's confirm sheet
// (docs/inventory/config.md §2.3), presented as a native form sheet.
import { useLocalSearchParams } from 'expo-router';
import { GatewaySheet, type GatewayAction } from '../../../src/components/config/GatewaySheet';

export default function GatewaySheetScreen() {
  const { action } = useLocalSearchParams<{ action?: string }>();
  return <GatewaySheet action={action === 'drain' ? 'drain' : ('restart' as GatewayAction)} />;
}
