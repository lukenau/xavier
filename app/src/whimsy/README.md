# Whimsy — Xavier and the app's character

Native-only layer (not in the PWA; recorded as a parity deviation). Xavier is a
Dalmatian butler rendered as **dot-matrix LED art with blueprint hints**: he
lives on a small dark screen (the tile) that stays dark in both themes, with
gold scan/sheen/glitch/pulse effects over it. Never painterly or cartoon —
the user rejected that as "pet food branding". Data screens stay calm.

Screens import only from `src/whimsy`.

## Moments

A screen names what is happening; `moments.ts` decides pose, motion and haptic.

```tsx
<XavierMoment id="chat.empty" size="hero" />        // a pose, or nothing
<StatePanel tone="neutral" title="No jobs" />       // default moment by tone
<StatePanel tone="neutral" title="…" moment="all-clear" />
<StatePanel … moment={false} />                     // opt out
```

Resolution: base moment → occasion (time/date) → level + reduce-motion clamp.

Tile effects (`motion` in `moments.ts`): `scan` (working/loading), `sheen`
(success, welcome), `glitch` (error), `pulse` (needs you), `still`.
Below `spot` size the tile is a round crop on his face (`POSE_FACES`).
`XavierAvatar` is the portrait tile for liveness spots; `DotScanner` is the
five-dot working glyph where a tile would be too big.

## Adding things

| To add | Do |
|---|---|
| A moment | one line in `moments.ts` |
| A pose | see `scripts/xavier/README.md`, then one line in `poses.ts` + its `POSE_FACES` entry |
| An occasion | one entry in `occasions.ts` |
| An easter egg | one entry in `eggs.ts`, `useEgg(id)` on the target |
| A haptic | a name in `haptics.ts` and the level it needs |

`whimsy.test.tsx` fails if a moment or occasion points at a missing pose.

## Levels

Settings → Xavier: **Off** (the app as it was), **Calm** (empty, error,
success, needs-you), **Full** (default: loading tiles, dot scanner in chat,
card press give, tap haptics). iOS Reduce Motion stops decorative motion at
any level.

## Where it's wired

StatePanel (round tile by tone) · PageTitle (tick rule) · Card (press give +
tap haptic) · Toast (X seal, success/error haptic) · XavierCard (portrait
avatar) · chat TurnIndicator (dot scanner) · chat empty states (hero tile).

Everything is JS + JPEGs + already-installed native modules (expo-haptics), so
it ships over the air — no new build.
