// Terminal font size, persisted exactly as the PWA persists it
// (XtermView.tsx:45,178): same key, same 13px default, same 10-20 clamp.
// AsyncStorage instead of localStorage, so the read is async — the screen
// renders at the default for one frame and then settles, which is invisible
// because the WebView's own first paint is later than that either way.
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const FONT_KEY = 'hub-term-font';
export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 20;

export function clampFontSize(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

/** `Number(localStorage.getItem(...)) || 13` — a missing or corrupt value is
 * 0 or NaN, both falsy, both the default. */
export async function readFontSize(): Promise<number> {
  const raw = await AsyncStorage.getItem(FONT_KEY);
  return clampFontSize(Number(raw) || DEFAULT_FONT_SIZE);
}

export async function writeFontSize(size: number): Promise<void> {
  await AsyncStorage.setItem(FONT_KEY, String(size));
}

export function useTerminalFontSize() {
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);

  useEffect(() => {
    let live = true;
    void readFontSize().then((size) => {
      if (live) setFontSize(size);
    });
    return () => {
      live = false;
    };
  }, []);

  const step = useCallback((delta: number) => {
    setFontSize((current) => {
      const next = clampFontSize(current + delta);
      if (next !== current) void writeFontSize(next);
      return next;
    });
  }, []);

  return {
    fontSize,
    smaller: useCallback(() => step(-1), [step]),
    larger: useCallback(() => step(1), [step]),
  };
}
