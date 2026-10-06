// VERBATIM COPY of apps/hub/src/components/finance/FlowSankey.tsx#L2-L229 (PWA). Do not edit by hand:
// scripts/check-shared-parity.mjs compares this file to the source and
// fails on any difference beyond the two allowed transforms — import
// paths, and `var(--token)` rewritten to the bare token name for
// src/theme's resolveToken(). Change the PWA first, then re-copy.
//
// The copied block is module-private in the PWA (nothing there is exported —
// the component sits in the same file), so without this list the file is
// unreachable and the whole point of copying it is lost. The list lives ABOVE
// the sentinel, which is exactly the region check-shared-parity.mjs strips
// before comparing, so parity still holds byte for byte: re-copying the PWA
// block never touches these lines, and editing them can never mask drift.
// Export clauses are hoisted bindings, not uses, so naming a `const` declared
// further down is legal and stays legal when the block is re-copied.
export {
  VW,
  MX,
  GAP,
  MIN_W,
  BAND_H,
  Y,
  OUT_META,
  ACCT_VALUE_MIN_W,
  IN_LABELS,
  outLabelFor,
  packSlots,
  chartNames,
  fitLabel,
  assignRows,
  wrapParts,
  ribbonPath,
};
export type { OutId, Slot, Ribbon };
// --- end copy header; everything below is verbatim ---
import { fmtUsd } from './seriesColors';

// Four bands, in the order money actually travels:
//
//   IN     income / refunds / outside transfers
//   CASH   the accounts money lands in
//   CARDS  the cards that cash pays off
//   OUT    where money finally leaves: spent, invested, or to a creditor we can't see
//
// The previous three-band version put cards in the SAME band as cash, so "paying the
// bill" had nowhere to go but a terminal bucket — the card was drawn twice (once as an
// account receiving money, once as a destination), and every internal hop was counted
// as an outflow. That made out ($3,000) 2.5x in ($1,200): a dollar of salary counted
// once arriving, again moving to the card, and again as card spend.
//
// Now a bill payment is a ribbon cash -> card, and only money that genuinely leaves
// reaches OUT. Internal cash->cash shuffling cancels and is drawn nowhere, so the two
// ends are comparable: in ≈ out + whatever stayed put.

const VW = 380;
const MX = 12;
const GAP = 10;
const MIN_W = 46;
// Income gets its own line: it is the only truly-earned money in. Refunds are
// paybacks and transfers are shuffling, so they sit on a lower, secondary row.
// Bands are positioned at build time: the conduit row only exists when a pass-through
// wallet is actually in play, so a chart without one keeps its old height
// instead of leaving an empty gap.
const BAND_H = 26;
const Y = { in: 104, conduit: 236, cashWith: 368, cashWithout: 262, card: 0, out: 0 };

const OUT_META = {
  spent: { label: 'Spent', short: 'Spent', color: 'cat-spend', text: 'fg-2' },
  invest: { label: '→ Invest', short: 'Inv', color: 'flow-invest', text: 'flow-invest' },
  debt: { label: '→ Debt', short: 'Debt', color: 'flow-debt', text: 'flow-debt' },
} as const;
type OutId = keyof typeof OUT_META;

const ACCT_VALUE_MIN_W = 36;
const outLabelFor = (id: OutId, w: number): string => {
  const budget = Math.floor((w + GAP) / 6.3);
  const meta = OUT_META[id];
  if (!meta) return '';
  const { label, short } = meta;
  if (label.length <= budget) return label;
  if (short.length <= budget) return short;
  return short.slice(0, Math.max(2, budget));
};

const IN_LABELS: Record<string, string> = {
  income: 'Income',
  refund: 'Refunds',
  interest: 'Interest',
  transfer: 'Transfers',
  unclassified: 'Unclassified',
};

interface Slot {
  id: string;
  label: string;
  alt: string;
  members?: string[];
  memberColors?: string[];
  memberIds?: string[];
  amount?: number;
  flow?: number;
  gin?: number;
  gout?: number;
  value: number;
  color: string;
  x: number;
  w: number;
  inCursor: number;
  outCursor: number;
  inTotal: number;
  outTotal: number;
}

interface Ribbon {
  fromX0: number;
  fromX1: number;
  toX0: number;
  toX1: number;
  y0: number;
  y1: number;
  color: string;
  title: string;
}

// Width was purely proportional, so a small account got a bar too narrow to name and
// the label had to be dropped or ellipsized. Every chip already prints its own amount,
// so width is partly redundant encoding: give each one enough room to identify itself
// first, then share the LEFTOVER width proportionally, which still shows magnitude.
function packSlots(
  items: { id: string; label: string; alt?: string; members?: string[]; memberColors?: string[]; memberIds?: string[]; value: number; amount?: number; flow?: number; gin?: number; gout?: number; color: string }[],
  scaleTotal?: number,
  alignRight = false,
): Slot[] {
  // Each band used to normalise to the FULL width independently, so a lone Venmo row
  // stretched edge to edge and swamped the flows beneath it. Passing the chart-wide
  // total keeps every band on one value->width scale.
  const total = scaleTotal ?? (items.reduce((s, i) => s + i.value, 0) || 1);
  const W = VW - 2 * MX - GAP * Math.max(0, items.length - 1);
  const floors = items.map((i) =>
    // A folded tile shows two marks and no text, so it wants an ordinary chip's width —
    // not the width of the two accounts it replaces, which squeezed it to a sliver.
    i.memberIds?.length ? 72 : Math.max(MIN_W, ((i.alt ?? i.label).length + fmtUsd(i.value).length) * 6.3 + 20),
  );
  const fixed = floors.reduce((s, w) => s + w, 0);
  const spare = Math.max(0, W - fixed);
  let widths = items.map((i, n) => floors[n] + (i.value / total) * spare);
  const sum = widths.reduce((s, w) => s + w, 0);
  if (sum > W) widths = widths.map((w) => (w / sum) * W);
  let x = alignRight ? VW - MX - widths.reduce((a, b) => a + b, 0) - GAP * Math.max(0, items.length - 1) : MX;
  return items.map((it, i) => {
    const slot: Slot = { alt: it.label, ...it, x, w: widths[i], inCursor: 0, outCursor: 0, inTotal: 0, outTotal: 0 };
    x += widths[i] + GAP;
    return slot;
  });
}

// "Example Bank Checking" cut to "Example Bank Chec…" reads as a bug. Drop the institution
// word first (the legend below carries the full name against the same colour), and only
// then ellipsize — a shorter true word beats a longer broken one.
// A chart identifies an account by its BANK first — "Example Bank", not "Individual
// Cash Account". Qualify with the account name only when this chart draws two from the
// same bank (Example Bank Checking vs Savings), and fall back to the mask only when the
// names don't separate them either (three cards from one issuer all called "CREDIT CARD").
function chartNames(
  accounts: { last4: string; institution: string; accountName: string; nickname?: string }[],
): Map<string, { full: string; alt: string }> {
  const perInst = new Map<string, number>();
  for (const a of accounts) perInst.set(a.institution, (perInst.get(a.institution) ?? 0) + 1);
  const out = new Map<string, { full: string; alt: string }>();
  const used = new Map<string, number>();
  for (const a of accounts) {
    // A nickname beats anything derived: an issuer can call every card it issues "CREDIT
    // CARD", so institution+name can only ever fall back to the mask. Its short form drops
    // a leading institution ("Example Bank Travel" → "Travel").
    if (a.nickname) {
      const prefix = `${a.institution} `.toLowerCase();
      const short = a.nickname.toLowerCase().startsWith(prefix) ? a.nickname.slice(prefix.length).trim() : '';
      out.set(a.last4, { full: a.nickname, alt: short || a.nickname });
      continue;
    }
    if ((perInst.get(a.institution) ?? 0) <= 1) {
      out.set(a.last4, { full: a.institution, alt: a.institution });
      continue;
    }
    const qual = (a.accountName || '')
      .replace(new RegExp(`^${a.institution}\\s*`, 'i'), '')
      .split(' ')
      .find((w) => w.length > 2 && !/^credit$|^card$|^account$/i.test(w));
    const name = qual ? `${a.institution} ${qual}` : a.institution;
    const n = (used.get(name) ?? 0) + 1;
    used.set(name, n);
    // When only the mask separates two cards, the MASK is the identifying part —
    // falling back to "Example Bank" would label two different chips identically, and
    // truncating it gave "Exa…".
    // the user would rather see the balance than the mask: "…0000" ate the width the amount
    // needed, and two chips reading "Example Bank" is a trade he accepted. The legend below
    // still carries the mask for anyone who needs to tell them apart.
    const byMask = n > 1 || !qual;
    out.set(a.last4, byMask
      ? { full: a.institution, alt: a.institution }
      : { full: name, alt: qual as string });
  }
  return out;
}

// Falling back to the first word labelled Checking and Savings both "Example" — the
// institution is precisely the ambiguous half when a chart draws two from one bank. The
// alt carries the distinguishing part ("Checking", "…0000"); prefer it over a shorter
// name that identifies nothing.
function fitLabel(label: string, w: number, alt?: string): string {
  const max = Math.floor(w / 6.6);
  if (label.length <= max) return label;
  if (alt && alt.length <= max) return alt;
  const src = alt ?? label;
  return max <= 3 ? '' : `${src.slice(0, max - 1)}…`;
}

// Lay labels out by measuring them, not by alternating every other one. A label only
// gets lifted to a higher row when it would actually overlap the one before it, so
// well-separated labels stay on a single clean line and only genuinely tight
// neighbours (Refunds/Transfers on narrow bars) step up.
function assignRows(slots: Slot[], textOf: (s: Slot) => string): Map<string, number> {
  const CHAR = 5.6;
  const PAD = 6;
  const rowEnds: number[] = [];
  const rows = new Map<string, number>();
  for (const s of [...slots].sort((a, b) => a.x - b.x)) {
    const half = (textOf(s).length * CHAR) / 2;
    const left = s.x + s.w / 2 - half;
    const right = s.x + s.w / 2 + half;
    let row = 0;
    while (row < rowEnds.length && left < rowEnds[row] + PAD) row++;
    rowEnds[row] = right;
    rows.set(s.id, row);
  }
  return rows;
}

// Greedy pack: keep adding parts while the line still fits the box it sits under.
function wrapParts(parts: string[], w: number): string[][] {
  const max = Math.max(10, Math.floor(w / 5.4));
  const lines: string[][] = [];
  let cur: string[] = [];
  for (const p of parts) {
    const trial = [...cur, p].join('  ·  ');
    if (cur.length && trial.length > max) {
      lines.push(cur);
      cur = [p];
    } else {
      cur.push(p);
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

function ribbonPath(r: Ribbon): string {
  const ym = (r.y0 + r.y1) / 2;
  return (
    `M${r.fromX0.toFixed(1)},${r.y0} C${r.fromX0.toFixed(1)},${ym} ${r.toX0.toFixed(1)},${ym} ${r.toX0.toFixed(1)},${r.y1} ` +
    `L${r.toX1.toFixed(1)},${r.y1} C${r.toX1.toFixed(1)},${ym} ${r.fromX1.toFixed(1)},${ym} ${r.fromX1.toFixed(1)},${r.y0} Z`
  );
}

