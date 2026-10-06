import { Stack } from 'expo-router';
import { STACK_SCREEN_OPTIONS } from '../../src/components/shell/stack';

// Pin the stack's entry screen — see app/chat/_layout.tsx for the build-5 bug
// this guards against. Bare <Stack/>: nothing here is a sheet.
export const unstable_settings = { initialRouteName: 'index' };

export default function AutomationsStackLayout() {
  return <Stack screenOptions={STACK_SCREEN_OPTIONS} />;
}
