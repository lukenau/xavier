// Where the money went: four bands (money in → wallets → cash → cards → out),
// ribbons in the source account's colour, every chip carrying its own mark,
// name and balance. Port of apps/hub/src/components/finance/FlowSankey.tsx.
//
// The layout is not re-derived here — `FlowSankeyLayout.ts` holds the PWA's
// `useMemo` body and every render-time number, and the block it builds on is
// the byte-locked `src/shared/sankeyLayout.ts`. This file only draws.
//
// Skia rather than react-native-svg because six labels need a halo painted
// UNDER the glyph (`paint-order: stroke`), which rn-svg has never supported
// (issue 1862) and whose text-stroke fallback is itself an open bug (issue
// 2151). Skia gets there by drawing each label twice: stroke pass, then fill.
// The SVG `viewBox="0 0 380 VH"` is reproduced by scaling a 380-wide Group to
// the measured width, so every coordinate below is still a viewBox coordinate.
//
// The PWA's `<title>` tooltips on ribbons and chips are hover-only and
// unreachable on touch, so — as Task 15 did for the equity chart — they are
// not ported. The visible text is unchanged.
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  Canvas,
  Group,
  Image as SkiaImage,
  Path,
  Rect,
  RoundedRect,
  Skia,
  Text as SkiaText,
  useFont,
  type SkFont,
  type SkImage,
} from '@shopify/react-native-skia';
import type { FlowGraph } from '../../shared/financeModel';
import { fmtUsd } from '../../shared/seriesColors';
import { VW, type Slot } from '../../shared/sankeyLayout';
import { fonts, MONO_FEATURES } from '../../theme/fonts';
import { useTheme } from '../../theme/useTheme';
import { seriesPaint } from '../charts/geometry';
import {
  CHART_LABEL,
  CHIP_INK,
  LOGO_SIZE,
  bandLabels,
  bandTotalCells,
  buildSankey,
  chipPlan,
  inSlotPlan,
  legendRows,
  memberLogoLayout,
  memberStripeLayout,
  outChipPlan,
  outLabelRows,
  ribbonPath,
  selfLogoLayout,
  spacedGlyphs,
  summaryLine,
  type SankeyBuild,
} from './FlowSankeyLayout';

const MONO_400 = require('../../../assets/fonts/HubMono-400.ttf');
const MONO_600 = require('../../../assets/fonts/HubMono-600.ttf');
const MONO_700 = require('../../../assets/fonts/HubMono-700.ttf');
const MONO_800 = require('../../../assets/fonts/HubMono-800.ttf');

const RIBBON_OPACITY = 0.45;
const CHIP_RADIUS = 4;
/** `letter-spacing: 0.2em` at 10px. */
const BAND_LABEL_TRACKING = 2;

export interface FlowSankeyProps {
  flows: FlowGraph;
}

export function FlowSankey({ flows }: FlowSankeyProps) {
  const { t } = useTheme();
  const [width, setWidth] = useState(0);
  const built = useMemo(() => buildSankey(flows), [flows]);
  const images = useMemo(() => decodeLogos(built), [built]);

  const chipName = useFont(MONO_700, 10.5);
  const chipAmount = useFont(MONO_600, 9.5);
  const chipAmountAlone = useFont(MONO_700, 10);
  const flowAmount = useFont(MONO_700, 9);
  const outLabel = useFont(MONO_600, 10.5);
  const outAmount = useFont(MONO_400, 9);
  const caption = useFont(MONO_400, 8.5);
  const bandLabel = useFont(MONO_800, 10);

  if (!built) return null;
  const { BAND, VH, logos, selfSourceIds, parkedIds, inSlots, inParts, conduitSlots, cashSlots, cardSlots, outSlots, ribbons, totalIn, totalOut, nAccounts } =
    built;
  const scale = width > 0 ? width / VW : 0;
  const paint = (color: string) => seriesPaint(color, t);
  const ink = t(CHIP_INK);
  const halo = t('bg-1');
  const outRows = outLabelRows(outSlots);
  const parked = outSlots.filter((s) => parkedIds.has(s.id));

  const chip = (s: Slot, y: number) => {
    const logo = logos.get(s.id);
    const plan = chipPlan(s, logo);
    return (
      // Keyed by row too: a folded tile is `__other` on whichever bands have one.
      <Group key={`${y}:${s.id}`}>
        <RoundedRect x={s.x} y={y} width={s.w} height={BAND.h} r={CHIP_RADIUS} color={paint(s.color)} />
        {memberStripeLayout(s).map((stripe, i) =>
          stripe.rounded ? (
            <RoundedRect key={i} x={stripe.x} y={y} width={stripe.w} height={BAND.h} r={CHIP_RADIUS} color={paint(stripe.color)} />
          ) : (
            <Rect key={i} x={stripe.x} y={y} width={stripe.w} height={BAND.h} color={paint(stripe.color)} />
          ),
        )}
        {!logo &&
          memberLogoLayout(s, logos).map((mark) => (
            <Logo key={mark.id} image={images.get(mark.id)} x={mark.x} y={y + 5} />
          ))}
        {logo && <Logo image={images.get(s.id)} x={plan.logoX} y={y + 5} />}

        {plan.logoAndAmt ? (
          <Label text={plan.amt} x={plan.amtX} y={y + 17} anchor="end" font={chipAmountAlone} color={ink} />
        ) : plan.bothFit ? (
          <Group>
            <Label text={plan.name} x={plan.nameX} y={y + 17} anchor="start" font={chipName} color={ink} />
            <Label text={plan.amt} x={plan.amtX} y={y + 17} anchor="end" font={chipAmount} color={ink} />
          </Group>
        ) : (
          <Label text={plan.only} x={plan.onlyX} y={y + 17} anchor="middle" font={chipName} color={ink} />
        )}

        {/* IN above and OUT below sit OUTSIDE the fits-inside branch: a narrow card
            chip took the other path and lost both figures entirely. */}
        {s.gin != null && s.gin > 0.005 && (
          <Label
            text={`IN ${fmtUsd(s.gin)}`}
            x={plan.midX}
            y={y - 6}
            anchor="middle"
            font={flowAmount}
            color={t('fg-2')}
            halo={halo}
            haloWidth={3.5}
          />
        )}
        {s.gout != null && s.gout > 0.005 && (
          <Label
            text={`OUT ${fmtUsd(s.gout)}`}
            x={plan.midX}
            y={y + BAND.h + 12}
            anchor="middle"
            font={flowAmount}
            color={t('fg-2')}
            halo={halo}
            haloWidth={3.5}
          />
        )}
        {!plan.bothFit && !plan.logoAndAmt && !plan.folded && (
          <Label
            text={plan.amt}
            x={plan.midX}
            y={y + BAND.h + 23}
            anchor="middle"
            font={caption}
            color={t('fg-3')}
            halo={halo}
            haloWidth={3}
          />
        )}
      </Group>
    );
  };

  return (
    <View style={[styles.card, { backgroundColor: t('bg-1'), borderColor: t('border') }]}>
      <Text style={[styles.summary, { color: t('fg-4') }]}>{summaryLine(totalIn, nAccounts, totalOut)}</Text>

      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        accessible
        accessibilityRole="image"
        accessibilityLabel={CHART_LABEL}
      >
        {width > 0 && (
          <Canvas style={{ width, height: VH * scale }}>
            <Group transform={[{ scale }]}>
              {ribbons.map((r, i) => (
                <Path key={i} path={ribbonPath(r)} color={paint(r.color)} opacity={RIBBON_OPACITY} />
              ))}

              {inSlots.map((s) => {
                const plan = inSlotPlan(s, inParts, BAND.in);
                return (
                  <Group key={s.id}>
                    <RoundedRect x={s.x} y={BAND.in} width={s.w} height={BAND.h} r={CHIP_RADIUS} color={paint(s.color)} />
                    <Label text={plan.labelText} x={plan.midX} y={plan.labelY} anchor="middle" font={chipName} color={t('fg-1')} />
                    <Label text={plan.amountText} x={plan.midX} y={plan.amountY} anchor="middle" font={chipName} color={t('fg-1')} />
                    {s.id === 'self' &&
                      selfLogoLayout(s, selfSourceIds, logos).map((mark) => (
                        <Logo key={mark.id} image={images.get(mark.id)} x={mark.x} y={plan.logoY} />
                      ))}
                    {plan.caption.map((line, li) => (
                      <Label key={li} text={line} x={plan.midX} y={plan.captionY[li]} anchor="middle" font={caption} color={t('fg-3')} />
                    ))}
                  </Group>
                );
              })}

              {conduitSlots.map((s) => chip(s, BAND.conduit))}
              {cashSlots.map((s) => chip(s, BAND.cash))}
              {cardSlots.map((s) => chip(s, BAND.card))}
              {parked.map((s) => chip(s, BAND.out))}

              {outSlots
                .filter((s) => !parkedIds.has(s.id))
                .map((s) => {
                  const plan = outChipPlan(s, BAND.out, BAND.h, outRows);
                  return (
                    <Group key={s.id}>
                      <RoundedRect x={s.x} y={BAND.out} width={s.w} height={BAND.h} r={CHIP_RADIUS} color={paint(s.color)} />
                      <Label text={plan.label} x={plan.midX} y={plan.labelY} anchor="middle" font={outLabel} color={paint(plan.labelColor)} />
                      <Label text={plan.amount} x={plan.midX} y={plan.amountY} anchor="middle" font={outAmount} color={t('fg-3')} />
                    </Group>
                  );
                })}

              {bandLabels(built).map((label) => (
                <TrackedLabel
                  key={label.text}
                  text={label.text}
                  x={label.x}
                  y={label.y}
                  font={bandLabel}
                  color={t('fg-1')}
                  halo={halo}
                  haloWidth={4}
                />
              ))}
            </Group>
          </Canvas>
        )}
      </View>

      {/* What each level actually carries. The ribbons show proportion; these show the
          amounts, so a band can be read without measuring it against another. */}
      <View style={[styles.totals, { borderTopColor: t('border') }]}>
        {bandTotalCells(built.bandTotals).map((b) => (
          <View key={b.name} style={styles.totalCell}>
            {b.arrow && <Text style={[styles.arrow, { color: t('fg-4') }]}>→</Text>}
            <Text style={[styles.totalName, { color: t('fg-4') }]}>{b.name}</Text>
            <Text style={[styles.totalValue, { color: t('fg-2') }]}>{b.total}</Text>
          </View>
        ))}
      </View>

      {/* A folded tile is one chip but two accounts — the legend is where there IS room
          to name them, so expand it into a row per member in that member's own colour. */}
      <View style={[styles.legend, { borderTopColor: t('border') }]}>
        {legendRows(built).map((row) => (
          <View key={row.id} style={styles.legendRow}>
            <View style={[styles.swatch, { backgroundColor: paint(row.color) }]} />
            <Text style={[styles.legendText, { color: t('fg-2') }]}>{row.text}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Advance width, which is what SVG's `textAnchor` measures — not the ink bounds. */
function advance(font: SkFont, text: string): number {
  return font.getGlyphWidths(font.getGlyphIDs(text)).reduce((a, b) => a + b, 0);
}

/**
 * One SVG `<text>`: anchored, and — when `halo` is set — drawn twice so the
 * stroke lands under the glyph, which is `paint-order: stroke`.
 */
function Label({
  text,
  x,
  y,
  anchor,
  font,
  color,
  halo,
  haloWidth,
}: {
  text: string;
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  font: SkFont | null;
  color: string;
  halo?: string;
  haloWidth?: number;
}) {
  if (!font || !text) return null;
  const w = anchor === 'start' ? 0 : advance(font, text);
  const px = anchor === 'start' ? x : anchor === 'middle' ? x - w / 2 : x - w;
  return (
    <Group>
      {halo && <SkiaText x={px} y={y} text={text} font={font} color={halo} style="stroke" strokeWidth={haloWidth} />}
      <SkiaText x={px} y={y} text={text} font={font} color={color} />
    </Group>
  );
}

/**
 * A band label. Skia draws a run at a single x, so `letter-spacing` becomes
 * per-glyph placement; every stroke is laid down before any fill, or the next
 * glyph's halo would cut into the previous glyph.
 */
function TrackedLabel({
  text,
  x,
  y,
  font,
  color,
  halo,
  haloWidth,
}: {
  text: string;
  x: number;
  y: number;
  font: SkFont | null;
  color: string;
  halo: string;
  haloWidth: number;
}) {
  if (!font) return null;
  const glyphs = spacedGlyphs(text, x, BAND_LABEL_TRACKING, (ch) => advance(font, ch));
  return (
    <Group>
      {glyphs.map((g, i) => (
        <SkiaText key={`halo-${i}`} x={g.x} y={y} text={g.ch} font={font} color={halo} style="stroke" strokeWidth={haloWidth} />
      ))}
      {glyphs.map((g, i) => (
        <SkiaText key={i} x={g.x} y={y} text={g.ch} font={font} color={color} />
      ))}
    </Group>
  );
}

function Logo({ image, x, y }: { image: SkImage | undefined; x: number; y: number }) {
  if (!image) return null;
  return <SkiaImage image={image} x={x} y={y} width={LOGO_SIZE} height={LOGO_SIZE} fit="contain" />;
}

/** `<image href="data:image/png;base64,…">` — decoded once per build. */
function decodeLogos(built: SankeyBuild | null): Map<string, SkImage> {
  const out = new Map<string, SkImage>();
  if (!built) return out;
  for (const [id, b64] of built.logos) {
    const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBase64(b64));
    if (image) out.set(id, image);
  }
  return out;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 14,
    paddingBottom: 12,
    marginBottom: 8,
  },
  summary: {
    fontFamily: fonts.mono(400),
    fontSize: 10,
    marginBottom: 2,
    ...MONO_FEATURES,
  },
  totals: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: 12,
    rowGap: 4,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
  },
  totalCell: { flexDirection: 'row', alignItems: 'baseline', columnGap: 5 },
  arrow: { fontFamily: fonts.mono(400), fontSize: 10 },
  totalName: { fontFamily: fonts.mono(400), fontSize: 10, letterSpacing: 0.6 },
  totalValue: { fontFamily: fonts.mono(600), fontSize: 10, ...MONO_FEATURES },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 14,
    rowGap: 9,
    marginTop: 10,
    paddingTop: 11,
    borderTopWidth: 1,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', columnGap: 6 },
  swatch: { width: 9, height: 9, borderRadius: 2 },
  legendText: { fontFamily: fonts.mono(400), fontSize: 10 },
});
