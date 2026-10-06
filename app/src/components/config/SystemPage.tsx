// 1:1 port of apps/hub/src/routes/config/SystemPage.tsx: the back link, then
// the whole read-only System panel (skills / plugins / MCP / doctor), which
// keeps its own "System · read-only · CLI-bridge" header and refresh control.
//
// SystemPanel itself is Task 11's (src/components/system/), built to be
// mounted here — Memory moved out of it to its own /config/memory page.
import { Screen, useHideTabBar } from '../shell';
import { SystemPanel } from '../system/SystemPanel';
import { BackLink } from './parts';

export function SystemPage() {
  useHideTabBar();
  return (
    <Screen header={<BackLink />}>
      <SystemPanel />
    </Screen>
  );
}
