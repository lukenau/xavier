// 1:1 port of apps/hub/src/routes/config/MemoryPage.tsx: the active built-in
// store + provider and the installed memory plugins, read via
// `hermes memory status` (CLI-bridge). READ-ONLY.
//
// MemorySection is Task 11's (src/components/system/), split out of the System
// panel for exactly this page. The ['memory'] observer here is cache-shared
// with it — no extra fetch, it just drives the header refresh + freshness
// stamp (MemoryPage.tsx:11-14).
import { PageTitle, RefreshControl, Screen, useHideTabBar } from '../shell';
import { MemorySection } from '../system/MemorySection';
import { api } from '../../lib/api';
import { QUERY_TUNING, usePoll } from '../../lib/query';
import { BackLink } from './parts';

export function MemoryPage() {
  useHideTabBar();
  const memory = usePoll(['memory'], api.memory, QUERY_TUNING.memory);
  return (
    <Screen
      header={
        <>
          <BackLink />
          <PageTitle right={<RefreshControl queries={memory} />}>Memory</PageTitle>
        </>
      }
    >
      <MemorySection />
    </Screen>
  );
}
