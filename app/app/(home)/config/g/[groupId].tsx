// The full-settings editor, one config GROUP per page — the PWA's
// `/config/g/:groupId` (docs/inventory/config.md §3).
//
// The ONLY dynamic segment in the route tree. `KNOWN_ROUTES` carries it as
// the literal expo-router pattern `/config/g/[groupId]`, and
// `resolveDeepLink` matches a concrete path against it segment by segment —
// see the comment on `routeMatches` in src/lib/deepLinks.ts. An unknown
// groupId is not a 404: the page renders the PWA's "Nothing here" panel,
// exactly as the hash route did.
import { useLocalSearchParams } from 'expo-router';
import { ConfigSectionPage } from '../../../../src/components/config/ConfigSectionPage';

export default function ConfigGroupScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  return <ConfigSectionPage groupId={groupId ?? ''} />;
}
