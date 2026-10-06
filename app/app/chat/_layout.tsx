import { Stack } from 'expo-router';
import { STACK_SCREEN_OPTIONS } from '../../src/components/shell/stack';

// Pin the stack's entry screen. Without this, a stack that declares
// <Stack.Screen> children can take the FIRST DECLARED child as its initial
// route rather than index — which shipped in build 5 as: tapping Config
// landed straight on the gateway confirm sheet, and dismissing it emptied
// the stack and fell back to tab 0 (Home). Device-only; no test sees it.
export const unstable_settings = { initialRouteName: 'index' };


export default function ChatStackLayout() {
  return <Stack screenOptions={STACK_SCREEN_OPTIONS} />;
}
