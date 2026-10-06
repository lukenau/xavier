// The sky, drawn rather than typed.
//
// Emoji were the obvious shortcut and are wrong here: they carry their own
// palette, ignore the theme, and render at a size the system picks. An icon
// font or SVG library would be a new dependency, and a native one moves the
// OTA fingerprint. So each condition is a handful of views — a circle, a
// couple of rounded rects — which cost nothing, take their colour from the
// theme, and scale off one number.
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../../theme/useTheme';
import { sunColor, waterColor, type Condition } from '../../../chat/weatherLayout';

export function WeatherGlyph({ condition, size = 18 }: { condition: Condition; size?: number }) {
  const { t, scheme } = useTheme();
  // A brown sun is what `accent` gives in light mode; these are picked to be
  // seen rather than read (the user, 2026-09-23).
  const sun = sunColor(scheme);
  const cloud = t('fg-2');
  const water = waterColor(scheme);
  const u = size / 18; // every measurement below is in 18pt units

  const Sun = ({ x, y, r }: { x: number; y: number; r: number }) => (
    <View
      style={[styles.piece, { left: x * u, top: y * u, width: r * 2 * u, height: r * 2 * u, borderRadius: r * u, backgroundColor: sun }]}
    />
  );
  const Moon = () => (
    <>
      <View style={[styles.piece, { left: 4 * u, top: 3 * u, width: 11 * u, height: 11 * u, borderRadius: 5.5 * u, backgroundColor: sun }]} />
      {/* The crescent is a bite out of the disc, taken in the card's own ground. */}
      <View style={[styles.piece, { left: 1 * u, top: 1.5 * u, width: 11 * u, height: 11 * u, borderRadius: 5.5 * u, backgroundColor: t('bg-1') }]} />
    </>
  );
  const Cloud = ({ y = 6, color = cloud }: { y?: number; color?: string }) => (
    <>
      <View style={[styles.piece, { left: 2 * u, top: (y + 3) * u, width: 14 * u, height: 5 * u, borderRadius: 2.5 * u, backgroundColor: color }]} />
      <View style={[styles.piece, { left: 4 * u, top: y * u, width: 7 * u, height: 7 * u, borderRadius: 3.5 * u, backgroundColor: color }]} />
      <View style={[styles.piece, { left: 9 * u, top: (y + 1.5) * u, width: 5.5 * u, height: 5.5 * u, borderRadius: 2.75 * u, backgroundColor: color }]} />
    </>
  );
  const Drops = ({ color = water, tall = false }: { color?: string; tall?: boolean }) =>
    [3, 7.5, 12].map((x, i) => (
      <View
        key={i}
        style={[
          styles.piece,
          {
            left: x * u,
            top: (15 + (i === 1 ? 0.5 : 0)) * u,
            width: 1.6 * u,
            height: (tall ? 3.5 : 2.5) * u,
            borderRadius: 1 * u,
            backgroundColor: color,
            transform: [{ rotate: '12deg' }],
          },
        ]}
      />
    ));

  return (
    <View style={{ width: size, height: size }}>
      {condition === 'clear' ? <Sun x={4} y={4} r={5} /> : null}
      {condition === 'clear_night' ? <Moon /> : null}
      {condition === 'partly_cloudy' ? (
        <>
          <Sun x={8} y={1} r={4} />
          <Cloud y={6} />
        </>
      ) : null}
      {condition === 'partly_cloudy_night' ? (
        <>
          <View style={[styles.piece, { left: 9 * u, top: 1 * u, width: 7 * u, height: 7 * u, borderRadius: 3.5 * u, backgroundColor: sun }]} />
          <View style={[styles.piece, { left: 7 * u, top: 0 * u, width: 7 * u, height: 7 * u, borderRadius: 3.5 * u, backgroundColor: t('bg-1') }]} />
          <Cloud y={6} />
        </>
      ) : null}
      {condition === 'cloudy' ? <Cloud y={5} /> : null}
      {condition === 'fog' ? (
        <>
          <Cloud y={3} />
          {[0, 1].map((i) => (
            <View
              key={i}
              style={[styles.piece, { left: (2 + i) * u, top: (13 + i * 3) * u, width: (14 - i * 3) * u, height: 1.6 * u, borderRadius: 1 * u, backgroundColor: cloud }]}
            />
          ))}
        </>
      ) : null}
      {condition === 'rain' ? (
        <>
          <Cloud y={3} />
          <Drops />
        </>
      ) : null}
      {condition === 'snow' ? (
        <>
          <Cloud y={3} />
          {[3.5, 8, 12.5].map((x, i) => (
            <View
              key={i}
              style={[styles.piece, { left: x * u, top: (15 + (i === 1 ? 1 : 0)) * u, width: 2.2 * u, height: 2.2 * u, borderRadius: 1.1 * u, backgroundColor: water }]}
            />
          ))}
        </>
      ) : null}
      {condition === 'storm' ? (
        <>
          <Cloud y={3} />
          <View style={[styles.piece, { left: 7 * u, top: 12.5 * u, width: 2.2 * u, height: 4 * u, backgroundColor: sun, transform: [{ rotate: '20deg' }] }]} />
          <View style={[styles.piece, { left: 8.5 * u, top: 14 * u, width: 2.2 * u, height: 4 * u, backgroundColor: sun, transform: [{ rotate: '20deg' }] }]} />
        </>
      ) : null}
      {condition === 'wind' ? (
        [0, 1, 2].map((i) => (
          <View
            key={i}
            style={[
              styles.piece,
              {
                left: (2 + (i === 1 ? 0 : 2)) * u,
                top: (4 + i * 4.5) * u,
                width: (i === 1 ? 14 : 10) * u,
                height: 1.8 * u,
                borderRadius: 1 * u,
                backgroundColor: cloud,
              },
            ]}
          />
        ))
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  piece: { position: 'absolute' },
});
