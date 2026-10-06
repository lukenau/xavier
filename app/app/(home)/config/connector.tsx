// Read-only connector detail — the PWA renders this as an in-page <Sheet>
// (docs/inventory/config.md §6.3); natively a sheet is a route.
import { useLocalSearchParams } from 'expo-router';
import { ConnectorSheet } from '../../../src/components/config/ConnectorSheet';

export default function ConnectorSheetScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <ConnectorSheet providerId={id ?? ''} />;
}
