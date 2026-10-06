import { Stack } from 'expo-router';
import { STACK_SCREEN_OPTIONS } from '../../src/components/shell/stack';
import { sheetScreenOptions } from '../../src/components/shell/sheet';

// `index` MUST be declared first. expo-router emits DECLARED <Stack.Screen>
// children before undeclared filesystem routes, in JSX order
// (useScreens.js:70-118), so declaring a sheet without declaring index puts
// the sheet at position 0 and the tab opens on it. unstable_settings below
// does NOT prevent that — it only sorts the appended remainder — which is why
// pinning it alone did not fix the build-5/6 bug where Config opened on the
// gateway sheet. Guarded by src/lib/stackOrder.test.ts.
export const unstable_settings = { initialRouteName: 'index' };


export default function HomeStackLayout() {
  return (
    <Stack screenOptions={STACK_SCREEN_OPTIONS}>
      <Stack.Screen name="index" />
      <Stack.Screen name="sheet" options={sheetScreenOptions()} />
      {/* Config left the tab bar on 2026-09-29 to make room for Automations and
          opens from the gear in Home's header. Its routes keep their paths
          (/config/…) because a group adds nothing to a URL; its four sheets are
          declared here because this is now the stack that presents them. */}
      <Stack.Screen name="config/gateway" options={sheetScreenOptions()} />
      <Stack.Screen name="config/connector" options={sheetScreenOptions()} />
      <Stack.Screen name="config/device-code" options={sheetScreenOptions()} />
      <Stack.Screen name="config/pair" options={sheetScreenOptions()} />
    </Stack>
  );
}
