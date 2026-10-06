// The Live centrepiece. Drawn with Skia on the UI thread from
// shared values, so a busy JS thread (audio, socket) never stutters it. It
// sits on a dark panel in both themes, like Xavier's other LED tiles.
import { memo, useMemo } from 'react';
import { Canvas, Picture, Skia, createPicture, useClock } from '@shopify/react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { APERTURE_MODE, apertureDots, apertureGeometry, apertureTicks, type ApertureMode } from './aperture';

export interface ApertureColors {
  panel: string;
  dim: string;
  you: string;
  xavier: string;
  warn: string;
}

export const Aperture = memo(function Aperture({
  size,
  level,
  mode,
  progress,
  colors,
  reduceMotion,
}: {
  size: number;
  level: SharedValue<number>;
  mode: SharedValue<ApertureMode>;
  progress: SharedValue<number>;
  colors: ApertureColors;
  reduceMotion: boolean;
}) {
  const clock = useClock();
  const c = useMemo(
    () => ({
      panel: Skia.Color(colors.panel),
      dim: Skia.Color(colors.dim),
      you: Skia.Color(colors.you),
      xavier: Skia.Color(colors.xavier),
      warn: Skia.Color(colors.warn),
    }),
    [colors],
  );
  const picture = useDerivedValue(() => {
    const m = mode.value;
    const tone = m === APERTURE_MODE.listening ? c.you : m === APERTURE_MODE.reconnecting ? c.warn : c.xavier;
    return createPicture((canvas) => {
      const paint = Skia.Paint();
      paint.setAntiAlias(true);
      const { cx, cy, R, pitch } = apertureGeometry(size);
      paint.setColor(c.panel);
      canvas.drawCircle(cx, cy, R + pitch * 1.1, paint);
      const dots = apertureDots({ size, t: clock.value, level: level.value, mode: m, progress: progress.value, reduceMotion });
      for (const d of dots) {
        paint.setColor(d.lit ? tone : c.dim);
        paint.setAlphaf(d.alpha);
        canvas.drawCircle(d.x, d.y, d.r, paint);
      }
      paint.setStrokeWidth(1.2);
      for (const tk of apertureTicks(size, progress.value)) {
        paint.setColor(c.xavier);
        paint.setAlphaf(tk.lit ? 1 : 0.22);
        canvas.drawLine(tk.x1, tk.y1, tk.x2, tk.y2, paint);
      }
    });
  });
  return (
    <Canvas style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Picture picture={picture} />
    </Canvas>
  );
});
