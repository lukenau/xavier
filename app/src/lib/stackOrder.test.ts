// A stack layout that declares <Stack.Screen> children must declare `index`
// FIRST, or the tab opens on the wrong screen.
//
// Why this is a real trap rather than a style rule — expo-router's
// getSortedChildren (node_modules/expo-router/build/useScreens.js:63-118):
//
//   const entries = [...children];
//   const ordered = order.map(...)        // DECLARED screens, in declaration order
//   ordered.push(...entries.sort(sortRoutesWithInitial(initialRouteName)))
//
// Declared screens are emitted first, in the order they appear in the JSX, and
// only the *remaining* filesystem routes are sorted with `initialRouteName`.
// So a layout that declares sheets but not `index` puts a sheet at position 0,
// and the stack opens on it. `unstable_settings = { initialRouteName: 'index' }`
// does NOT rescue this: it only reorders the appended remainder.
//
// Shipped in builds 5 and 6: tapping Config landed on the "Restart the gateway?"
// sheet, and dismissing it emptied the stack and fell back to tab 0.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const APP_DIR = resolve(__dirname, '../../app');

function layoutFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return layoutFiles(full);
    return name === '_layout.tsx' ? [full] : [];
  });
}

/** The `name="..."` of each <Stack.Screen>, in source order. */
function declaredScreens(src: string): string[] {
  return [...src.matchAll(/<Stack\.Screen\s+name="([^"]+)"/g)].map((m) => m[1]);
}

describe('stack layouts declare index first', () => {
  const layouts = layoutFiles(APP_DIR)
    .map((file) => ({ file, src: readFileSync(file, 'utf8') }))
    .filter(({ src }) => src.includes('<Stack'));

  test('there are stack layouts to check', () => {
    expect(layouts.length).toBeGreaterThan(0);
  });

  test.each(layouts.map(({ file, src }) => [relative(APP_DIR, file), src] as const))(
    '%s puts index at position 0 when it declares any screen',
    (_name, src) => {
      const declared = declaredScreens(src);
      if (declared.length === 0) return; // bare <Stack/> — filesystem order applies
      expect(declared[0]).toBe('index');
    },
  );
});
