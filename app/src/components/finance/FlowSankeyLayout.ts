// The FlowSankey's layout, lifted out of the PWA component's `useMemo` body
// (apps/hub/src/components/finance/FlowSankey.tsx:231-734) plus every
// render-time decision that is arithmetic rather than drawing
// (`:736-1075`). Pure: no React, no Skia, no DOM — so the numbers can be
// pinned by tests on a host that cannot render.
//
// The block above that body — constants, packSlots, chartNames, fitLabel,
// assignRows, wrapParts, ribbonPath — is the byte-locked verbatim copy in
// src/shared/sankeyLayout.ts and is imported, never re-derived.
//
// One transform, the same one src/shared applies: `var(--x)` colour strings
// become bare token names for src/theme's resolveToken().
import type { AccountFlow, FlowGraph } from '../../shared/financeModel';
import { fmtUsd } from '../../shared/seriesColors';
import {
  ACCT_VALUE_MIN_W,
  BAND_H,
  GAP,
  IN_LABELS,
  MIN_W,
  MX,
  OUT_META,
  VW,
  Y,
  assignRows,
  chartNames,
  fitLabel,
  outLabelFor,
  packSlots,
  ribbonPath,
  wrapParts,
  type OutId,
  type Ribbon,
  type Slot,
} from '../../shared/sankeyLayout';

export { ribbonPath, type OutId, type Ribbon, type Slot };

export interface SankeyBands {
  in: number;
  conduit: number;
  cash: number;
  card: number;
  out: number;
  h: number;
}

export interface SankeyBuild {
  bandTotals: { name: string; total: number }[];
  BAND: SankeyBands;
  VH: number;
  logos: Map<string, string>;
  selfSourceIds: string[];
  parkedIds: Set<string>;
  inSlots: Slot[];
  conduitSlots: Slot[];
  cashSlots: Slot[];
  cardSlots: Slot[];
  outSlots: Slot[];
  ribbons: Ribbon[];
  inParts: string[];
  totalIn: number;
  totalOut: number;
  nAccounts: number;
}

export function buildSankey(flows: FlowGraph): SankeyBuild | null {
  // Half a cent was enough to earn a full chip: a card with exactly one $0.03
  // interest charge in the window rendered as a node with no IN or OUT to show,
  // because there was no flow to label. A dollar of movement is the floor for taking
  // up space; anything quieter stays in the transaction list below.
  const edgeTouched = new Set<string>();
  for (const e of flows.edges) {
    if (e.amount < 1) continue;
    edgeTouched.add(e.from);
    edgeTouched.add(e.to);
  }
  const active = flows.accounts.filter((f) => f.total >= 1 || edgeTouched.has(f.last4));
  if (active.length === 0) return null;

  // Band 2 holds accounts money ARRIVES in from outside; band 3 holds accounts your
  // own money moves INTO — cards to pay off, savings and brokerage to park. A savings
  // account with $5,000 in from checking and nothing external, as a band-2 node, had its
  // whole life cancel against the matching outflow and shrank to nothing. It is
  // a destination, not a source.
  // A wallet like Venmo is neither a source nor a destination — money from people
  // lands there and moves on to a bank. Give it its own row ahead of the cash accounts
  // so the hop is visible instead of appearing twice at both ends.
  const CONDUIT_RE = /venmo|paypal|cash app/i;
  const isConduit = (f: AccountFlow) => CONDUIT_RE.test(f.institution);
  const conduitAccts = active.filter(isConduit).slice(0, 3);
  const receivesInternal = new Set(flows.edges.map((e) => e.to));
  // A trickle of interest is not what makes an account a source. Require the external
  // money to be a real share of what moved through, or a savings account earning $13
  // reads as somewhere your paycheck lands.
  const hasExternal = (f: AccountFlow) => {
    const ext = f.inflowByType.income + f.inflowByType.interest + f.inflowByType.refund;
    // A share-of-throughput test alone was too blunt: a checking account's $2,000 of
    // salary was only 17% of what passed through it, so it got demoted to a destination
    // and left the cash row. An absolute floor keeps a real paycheck a source while
    // still ignoring a savings account earning $13 of interest.
    return ext >= Math.max(50, f.total * 0.05);
  };
  // A card is a place money passes THROUGH on its way to a merchant, so it earns a
  // band. Savings and brokerage are where money stops — the last row, beside Spent.
  const isParked = (f: AccountFlow) =>
    !isConduit(f) && f.cls !== 'credit' && receivesInternal.has(f.last4) && !hasExternal(f);
  const isDest = (f: AccountFlow) => !isConduit(f) && f.cls === 'credit';
  const isCardOrDest = (last4: string) => {
    const f = flows.byLast4.get(last4);
    return f ? isDest(f) : false;
  };
  const parkedSet = new Set(active.filter(isParked).map((f) => f.last4));
  const parkedAccts = active.filter(isParked).slice(0, 2);
  const cashAccts = active.filter((f) => !isDest(f) && !isConduit(f) && !isParked(f)).slice(0, 6);
  const cardAccts = active.filter((f) => isDest(f)).slice(0, 6);

  // Matched edges tell us where an internal move actually went.
  const payToCard = new Map<string, Map<string, number>>(); // cash last4 -> card last4 -> amt
  const investFrom = new Map<string, number>();
  const matchedInto = new Map<string, number>();
  // Payments matched into an account, tracked apart from transfers: netting an inbound
  // TRANSFER off the PAYMENT inflow understated unclassified money by the $500 that
  // savings sent back to checking.
  const matchedPayInto = new Map<string, number>();
  const matchedPayOut = new Map<string, number>();
  for (const e of flows.edges) {
    matchedInto.set(e.to, (matchedInto.get(e.to) ?? 0) + e.amount);
    if (e.type === 'payment') matchedPayInto.set(e.to, (matchedPayInto.get(e.to) ?? 0) + e.amount);
    const toF = flows.byLast4.get(e.to);
    const toCls = toF?.cls;
    if (toF && isDest(toF)) {
      const m = payToCard.get(e.from) ?? new Map<string, number>();
      m.set(e.to, (m.get(e.to) ?? 0) + e.amount);
      payToCard.set(e.from, m);
      matchedPayOut.set(e.from, (matchedPayOut.get(e.from) ?? 0) + e.amount);
    } else if (toCls === 'investment') {
      investFrom.set(e.from, (investFrom.get(e.from) ?? 0) + e.amount);
    }
  }

  // Refunds stay visible as money in rather than being netted against spend. Netting
  // is the purer economics, but this chart is about ROUTING: the money genuinely did
  // arrive in the account, and the inflow box names its parts (Income · Refunds ·
  // Transfers) so nothing reads as salary that isn't.
  const netSpend = (f: AccountFlow) => f.spend;
  const externalIn = (f: AccountFlow) => ({
    income: f.inflowByType.income,
    refund: f.inflowByType.refund,
    interest: f.inflowByType.interest,
    // A payment arriving at a CARD is the far side of an outflow — never new money.
    // But an unmatched payment-typed inflow to a CASH account is money genuinely
    // arriving from outside: a $2,000 credit into checking named after a card issuer has
    // no corresponding outflow anywhere, so it is not a reversal, and dropping it hid
    // real money. The server calls it external_in; match that.
    transfer: Math.max(0, f.transferIn - (matchedInto.get(f.last4) ?? 0)),
    // Kept apart from the classified money in: a $2,000 credit labelled with a card's name
    // is real money arriving, but we do not know what it was, and averaging it into
    // income would state something we cannot support.
    unclassified: f.cls === 'credit' ? 0 : Math.max(0, f.paymentIn - (matchedPayInto.get(f.last4) ?? 0)),
  });

  // Wallets were left out of the inflow total even though their ribbons are drawn from
  // it — money arriving at Venmo from a friend is external money entering the picture,
  // so the box read $5,000 while actually feeding $5,300.
  const inTotals: Record<string, number> = { income: 0, refund: 0, interest: 0, transfer: 0, unclassified: 0 };
  for (const f of [...cashAccts, ...cardAccts, ...conduitAccts]) {
    const e = externalIn(f);
    for (const k of Object.keys(inTotals)) inTotals[k] += e[k as keyof typeof e];
  }

  // NET, not gross: savings takes $5,000 + $2,000 from checking and sends $2,500 back,
  // so $4,500 was parked. Counting only the inbound legs overstated it by the return trip.
  const parkedFrom = new Map<string, number>(); // source last4 -> amount left parked
  for (const e of flows.edges) {
    if (parkedSet.has(e.to)) parkedFrom.set(e.from, (parkedFrom.get(e.from) ?? 0) + e.amount);
    else if (parkedSet.has(e.from)) parkedFrom.set(e.to, (parkedFrom.get(e.to) ?? 0) - e.amount);
  }
  for (const [k, v] of parkedFrom) if (v <= 0.005) parkedFrom.delete(k);
  const outTotals: Record<OutId, number> = { spent: 0, invest: 0, debt: 0 };
  for (const f of cashAccts) {
    outTotals.spent += netSpend(f);
    outTotals.invest += Math.min(investFrom.get(f.last4) ?? 0, f.transferOut);
    outTotals.debt += Math.max(0, f.paymentOut - (matchedPayOut.get(f.last4) ?? 0));
  }
  for (const f of cardAccts) outTotals.spent += netSpend(f);
  for (const f of conduitAccts) outTotals.spent += netSpend(f);

  // A node is as wide as the money passing THROUGH it — max(in, out) — not in+out.
  // Summing both directions double-counts every dollar that lands and leaves, which
  // read as $20,000 through a checking account that only ever received $5,000,
  // and detached node width from the ribbons actually attached to it.
  const paidToCards = (last4: string) => [...(payToCard.get(last4) ?? []).values()].reduce((s, v) => s + v, 0);
  const paidFromCash = (card: string) =>
    cashAccts.reduce((s, f) => s + (payToCard.get(f.last4)?.get(card) ?? 0), 0);
  const throughput = (f: AccountFlow): number => {
    const ext = externalIn(f);
    const inSum = ext.income + ext.refund + ext.interest + ext.transfer;
    if (f.cls === 'credit') return Math.max(inSum + paidFromCash(f.last4), netSpend(f), 1);
    const inv = Math.min(investFrom.get(f.last4) ?? 0, f.transferOut);
    const debt = Math.max(0, f.paymentOut - (matchedPayOut.get(f.last4) ?? 0));
    return Math.max(inSum, netSpend(f) + paidToCards(f.last4) + inv + debt, 1);
  };

  // A slot narrower than its own name renders as an unidentifiable sliver — readable
  // only from the legend. Fold those into one "Other" block instead.
  // (The PWA's splitSmall computes a `sum` it discards with `void sum`; everything
  // always lands in `keep`, and the fold below is what actually moves chips out.)
  const splitSmall = (list: AccountFlow[]) => {
    const withVal = list.map((f) => ({ f, v: throughput(f) }));
    return { keep: withVal, rest: [] as typeof withVal };
  };

  const hasConduit = conduitAccts.length > 0;
  const BAND: SankeyBands = {
    in: Y.in,
    conduit: Y.conduit,
    cash: hasConduit ? Y.cashWith : Y.cashWithout,
    card: (hasConduit ? Y.cashWith : Y.cashWithout) + 180,
    out: (hasConduit ? Y.cashWith : Y.cashWithout) + 350,
    h: BAND_H,
  };
  const VH = BAND.out + 100;
  const shown = [...cashAccts, ...cardAccts, ...conduitAccts, ...parkedAccts];
  // Identity by mark, not by hue: a colour-only legend fails anyone who cannot separate
  // those colours. Plaid ships the real institution logo; a bank with none keeps
  // its brand colour and text.
  const logos = new Map<string, string>();
  for (const f of shown) {
    const logo = flows.institutions?.[f.institution]?.logo;
    if (logo) logos.set(f.last4, logo);
  }
  const names = chartNames(shown);
  const nameOf = (f: AccountFlow) => names.get(f.last4)?.full ?? f.label;
  const altOf = (f: AccountFlow) => names.get(f.last4)?.alt ?? f.label;

  // One box for everything arriving from outside. Splitting it produced 24px bars
  // for Refunds and Transfers — too narrow to label, so they read as anonymous grey
  // squares. The breakdown lives in the caption above, where it always fits.
  const classified = inTotals.income + inTotals.refund + inTotals.interest + inTotals.transfer;
  const unknown = inTotals.unclassified;
  const inTotal = classified + unknown;
  const inParts = Object.entries(inTotals)
    .filter(([id, v]) => v > 0.005 && id !== 'unclassified')
    .sort((a, b) => b[1] - a[1])
    .map(([id, v]) => `${IN_LABELS[id]} ${fmtUsd(v)}`);
  // Money you moved INTO a wallet to pay someone is yours already, so it must not sit
  // in "Money in" — but it was invisible: the wallet row is above the cash row, so a
  // Checking -> Venmo flow would have to run upward, which a layered chart cannot draw.
  // Its own box says the money is real without claiming it arrived from outside.
  const selfSourceIds = [
    ...new Set(
      flows.edges
        .filter((e) => conduitAccts.some((c) => c.last4 === e.to) && cashAccts.some((c) => c.last4 === e.from))
        .map((e) => e.from),
    ),
  ];
  const selfFunded = flows.edges
    .filter((e) => conduitAccts.some((c) => c.last4 === e.to) && cashAccts.some((c) => c.last4 === e.from))
    .reduce((a, e) => a + e.amount, 0);
  const inSlots = packSlots(
    [
      { id: 'in', label: 'Money in', alt: 'In', value: Math.max(classified, 1), color: 'series-other' },
      ...(selfFunded > 0.005 ? [{ id: 'self', label: 'Internal', alt: 'Internal', value: selfFunded, color: 'flow-internal' }] : []),
      ...(unknown > 0.005
        ? [{ id: 'unknown', label: 'Unclassified', alt: 'Unknown', value: unknown, color: 'flow-unknown' }]
        : []),
    ],
    inTotal,
  );
  const mkSlots = (list: AccountFlow[], scaleTotal?: number, alignRight = false) => {
    let { keep, rest } = splitSmall(list);
    // Width is finite: if every chip cannot hold its own name AND amount, fold the
    // smallest away rather than shrink them all below the point of being readable.
    const W = VW - 2 * MX;
    // A chip needs room for its mark, its shortest name and its amount. Measuring that
    // honestly is what decides how many fit — five cards at once overflowed and every
    // label shrank past legibility instead of the smallest folding away.
    // Measure the chip the code will actually DRAW when space is tight — a logo and an
    // amount — not the roomy one with its name. Sizing against name+balance demanded
    // 739px in a 356px row and stripped five cards down to two, when the same five fit
    // comfortably once the name is allowed to drop.
    const need = (k: typeof keep) =>
      k.reduce((sum, x) => sum + Math.max(MIN_W, fmtUsd(x.f.balance ?? x.v).length * 6 + 32), 0) +
      GAP * Math.max(0, k.length - 1);
    while (keep.length > 1 && need(keep) > W) {
      const smallest = keep.reduce((a, b) => (a.v <= b.v ? a : b));
      keep = keep.filter((x) => x !== smallest);
      rest = [...rest, smallest];
    }
    if (rest.length === 1 && keep.length > 1) {
      const next = keep.reduce((a, b) => (a.v <= b.v ? a : b));
      keep = keep.filter((x) => x !== next);
      rest = [...rest, next];
    }
    type Item = { id: string; label: string; alt: string; members?: string[]; memberColors?: string[]; memberIds?: string[]; value: number; amount?: number; flow?: number; gin?: number; gout?: number; color: string };
    // For an account money stops in, the number that means something is the balance —
    // "Savings $4,500" beside an account holding $6,000 reads as wrong even though the
    // flow figure is correct. Flow still drives the WIDTH; only the label changes.
    // Balance inside the chip for every account: it is the number the user recognises, and
    // the arrows above/below carry what moved. One number per question.
    const shownAmt = (f: AccountFlow, v: number) => (f.balance != null ? f.balance : v);
    // Net across ALL its edges, not just the ones looping back to a source — $200 went
    // on to the brokerage, so the true net parked is $4,300, not $4,500.
    // A conduit's other half is recorded on the BANK, never on the wallet: the wallet's own
    // ledger shows $600 in from friends and $200 out to friends, but the $600 it pushed
    // to a brokerage and the $200 Checking funded it with are transactions on those
    // accounts. Counting only the wallet's own rows made OUT read $200 against a $1
    // balance — money that plainly did not stay. Add the edges for conduits, where the
    // legs cannot double-count because they come from the counterpart's rows.
    // The wallet's own ledger used to be half the story, so its edges were added in.
    // Since the merger stopped discarding INTERNAL_TRANSFER, Copilot reports the wallet's
    // own withdrawals AND the bank reports the matching deposits — adding edges on top
    // counted every leg twice and pushed the wallet's OUT to $1,600 against a $1 balance.
    const grossIn = (f: AccountFlow) => f.inflow + f.transferIn + f.paymentIn;
    const grossOut = (f: AccountFlow) => f.spend + f.transferOut + f.paymentOut;
    const netFlow = (f: AccountFlow) =>
      flows.edges.reduce(
        (n, e) => n + (e.to === f.last4 ? e.amount : 0) - (e.from === f.last4 ? e.amount : 0),
        0,
      );
    const items: Item[] = keep.map((x) => ({
      id: x.f.last4,
      label: nameOf(x.f),
      alt: altOf(x.f),
      value: x.v,
      amount: shownAmt(x.f, x.v),
      flow: netFlow(x.f),
      gin: grossIn(x.f),
      gout: grossOut(x.f),
      color: x.f.color,
    }));
    if (rest.length === 1)
      items.push({
        id: rest[0].f.last4,
        label: nameOf(rest[0].f),
        alt: altOf(rest[0].f),
        value: rest[0].v,
        amount: shownAmt(rest[0].f, rest[0].v),
        color: rest[0].f.color,
      });
    else if (rest.length > 1)
      items.push({
        id: '__other',
        label: `+${rest.length} accounts`,
        alt: `+${rest.length}`,
        members: rest.map((x) => nameOf(x.f)),
        memberColors: rest.map((x) => x.f.color),
        memberIds: rest.map((x) => x.f.last4),
        // The tile stands in for its members, so its IN/OUT is theirs added up —
        // otherwise the one chip on the row with no figures is the one hiding two
        // accounts.
        gin: rest.reduce((a, x) => a + grossIn(x.f), 0),
        gout: rest.reduce((a, x) => a + grossOut(x.f), 0),
        value: rest.reduce((s, x) => s + x.v, 0),
        color: 'series-other',
      });
    return packSlots(items, scaleTotal, alignRight);
  };
  const bandScale = Math.max(
    cashAccts.reduce((a, f) => a + throughput(f), 0),
    cardAccts.reduce((a, f) => a + throughput(f), 0),
    1,
  );
  const cashSlots = mkSlots(cashAccts, bandScale);
  const conduitSlots = mkSlots(conduitAccts, bandScale, true);
  const cardSlots = mkSlots(cardAccts, bandScale);
  // Savings is where money stops, so it belongs on the final row — but as an account
  // chip with its logo and balance, not an anonymous "-> Savings" bucket. It shares the
  // row with the terminals rather than sitting a band above them.
  const parkedNet = (f: AccountFlow) =>
    flows.edges.reduce((n, e) => n + (e.to === f.last4 ? e.amount : 0) - (e.from === f.last4 ? e.amount : 0), 0);
  const outSlots = packSlots([
    ...(Object.keys(OUT_META) as OutId[])
      .filter((id) => outTotals[id] > 0.005)
      .map((id) => ({ id, label: OUT_META[id].label, alt: OUT_META[id].short, value: outTotals[id], color: OUT_META[id].color })),
    ...parkedAccts
      .filter((f) => parkedNet(f) > 0.005)
      .map((f) => ({
        id: f.last4,
        label: nameOf(f),
        alt: altOf(f),
        value: parkedNet(f),
        amount: f.balance ?? undefined,
        flow: parkedNet(f),
        gin: f.inflow + f.transferIn + f.paymentIn,
        gout: f.spend + f.transferOut + f.paymentOut,
        color: f.color,
      })),
  ]);
  const parkedIds = new Set(parkedAccts.map((f) => f.last4));
  if (inSlots.length === 0 && outSlots.length === 0) return null;

  const bySlot = (slots: Slot[]) => new Map(slots.map((s) => [s.id, s]));
  const inMap = bySlot(inSlots);
  const cashMap = bySlot(cashSlots);
  const conduitMap = bySlot(conduitSlots);
  const cardMap = bySlot(cardSlots);
  const outMap = bySlot(outSlots);

  // Size each band's cursors before drawing so ribbons pack without overlap.
  // An account folded into "Other" still has ribbons; send them to that block.
  const slotOf = (m: Map<string, Slot>, id: string): Slot | undefined => m.get(id) ?? m.get('__other');
  // A ribbon into or out of a folded account keeps that account's own colour, so the
  // fold stays traceable — otherwise every flow through it turned flat grey.
  const ribbonColor = (id: string, fallback: string) => flows.byLast4.get(id)?.color ?? fallback;
  const bump = (m: Map<string, Slot>, id: string, side: 'in' | 'out', v: number) => {
    const s = slotOf(m, id);
    if (s) s[side === 'in' ? 'inTotal' : 'outTotal'] += v;
  };
  for (const f of [...cashAccts, ...cardAccts, ...conduitAccts]) {
    const target = isConduit(f) ? conduitMap : isCardOrDest(f.last4) ? cardMap : cashMap;
    for (const [k, v] of Object.entries(externalIn(f))) {
      if (v <= 0.005) continue;
      bump(inMap, k === 'unclassified' ? 'unknown' : 'in', 'out', v);
      bump(target, f.last4, 'in', v);
    }
  }
  for (const f of cashAccts) {
    for (const [card, v] of payToCard.get(f.last4) ?? []) {
      // slotOf, not cardMap.has: link() resolves through the folded slot, so bump must
      // too. Skipping here while link still drew produced a ribbon against an unmeasured
      // slot (total 1), which rendered as a slab across the whole chart.
      if (!slotOf(cardMap, card)) continue;
      bump(cashMap, f.last4, 'out', v);
      bump(cardMap, card, 'in', v);
    }
    const inv = Math.min(investFrom.get(f.last4) ?? 0, f.transferOut);
    const debt = Math.max(0, f.paymentOut - (matchedPayOut.get(f.last4) ?? 0));
    for (const p of parkedAccts) {
      const v = flows.edges.filter((e) => e.from === f.last4 && e.to === p.last4).reduce((a, e) => a + e.amount, 0);
      if (v <= 0.005 || !outMap.has(p.last4)) continue;
      bump(cashMap, f.last4, 'out', v);
      bump(outMap, p.last4, 'in', v);
    }
    for (const [id, v] of [['spent', netSpend(f)], ['invest', inv], ['debt', debt]] as [OutId, number][]) {
      if (v <= 0.005 || !outMap.has(id)) continue;
      bump(cashMap, f.last4, 'out', v);
      bump(outMap, id, 'in', v);
    }
  }
  for (const f of cardAccts) {
    if (netSpend(f) <= 0.005 || !outMap.has('spent')) continue;
    bump(cardMap, f.last4, 'out', netSpend(f));
    bump(outMap, 'spent', 'in', netSpend(f));
  }

  const ribbons: Ribbon[] = [];
  // Ribbons used to fill a node's width as a FRACTION of that node's own total. Node
  // widths are no longer strictly proportional — each chip gets a floor wide enough to
  // name itself — so the same dollar rendered wide at one end and narrow at the other,
  // and a node whose flow was mostly one ribbon had it stretch edge to edge.
  // One pixels-per-dollar scale for every ribbon instead: a value is the same width
  // wherever it appears, and a node simply carries slack when it is wider than its flow.
  // Each END is scaled to its OWN node: everything leaving a card spans the card's full
  // width, and lands at Spent taking exactly its share of Spent. A ribbon therefore
  // tapers when the two nodes differ in width, which is what a Sankey should do — one
  // global pixels-per-dollar scale instead left slack in every chip and made a card's
  // entire outflow start from a fraction of it.
  const take = (slot: Slot, side: 'in' | 'out', value: number): [number, number] => {
    const totalKey = side === 'in' ? 'inTotal' : 'outTotal';
    const cursorKey = side === 'in' ? 'inCursor' : 'outCursor';
    const total = slot[totalKey] || 1;
    const x0 = slot.x + (slot[cursorKey] / total) * slot.w;
    slot[cursorKey] += value;
    const x1 = slot.x + (slot[cursorKey] / total) * slot.w;
    return [x0, x1];
  };
  const link = (from: Slot, to: Slot, v: number, y0: number, y1: number, color: string, title: string) => {
    const [f0, f1] = take(from, 'out', v);
    const [t0, t1] = take(to, 'in', v);
    ribbons.push({ fromX0: f0, fromX1: f1, toX0: t0, toX1: t1, y0, y1, color, title });
  };

  for (const f of [...cashAccts, ...cardAccts, ...conduitAccts]) {
    const cond = isConduit(f);
    const card = !cond && isCardOrDest(f.last4);
    const target = slotOf(cond ? conduitMap : card ? cardMap : cashMap, f.last4);
    if (!target) continue;
    const yTo = cond ? BAND.conduit : card ? BAND.card : BAND.cash;
    for (const [k, v] of Object.entries(externalIn(f))) {
      if (v <= 0.005) continue;
      const src = inMap.get(k === 'unclassified' ? 'unknown' : 'in');
      if (!src) continue;
      link(src, target, v, BAND.in + BAND.h, yTo, ribbonColor(f.last4, target.color), `${IN_LABELS[k]} → ${nameOf(f)}  ${fmtUsd(v)}`);
    }
  }
  for (const f of cashAccts) {
    const s = slotOf(cashMap, f.last4);
    if (!s) continue;
    for (const [card, v] of payToCard.get(f.last4) ?? []) {
      const c = slotOf(cardMap, card);
      if (!c) continue;
      link(s, c, v, BAND.cash + BAND.h, BAND.card, s.color, `${f.label} → ${c.label}  ${fmtUsd(v)} · paying the bill`);
    }
    const inv = Math.min(investFrom.get(f.last4) ?? 0, f.transferOut);
    const debt = Math.max(0, f.paymentOut - (matchedPayOut.get(f.last4) ?? 0));
    for (const p of parkedAccts) {
      const v = flows.edges.filter((e) => e.from === f.last4 && e.to === p.last4).reduce((a, e) => a + e.amount, 0);
      const po = outMap.get(p.last4);
      if (v <= 0.005 || !po) continue;
      link(s, po, v, BAND.cash + BAND.h, BAND.out, s.color, `${nameOf(f)} → ${nameOf(p)}  ${fmtUsd(v)} · parked`);
    }
    for (const [id, v] of [['spent', netSpend(f)], ['invest', inv], ['debt', debt]] as [OutId, number][]) {
      const o = outMap.get(id);
      if (v <= 0.005 || !o) continue;
      link(s, o, v, BAND.cash + BAND.h, BAND.out, s.color, `${f.label} → ${OUT_META[id].label}  ${fmtUsd(v)}`);
    }
  }
  for (const f of conduitAccts) {
    const s = slotOf(conduitMap, f.last4);
    if (!s) continue;
    const selfIn = flows.edges
      .filter((e) => e.to === f.last4 && cashAccts.some((c) => c.last4 === e.from))
      .reduce((a, e) => a + e.amount, 0);
    const selfSrc = inMap.get('self');
    if (selfIn > 0.005 && selfSrc) {
      selfSrc.outTotal += selfIn;
      s.inTotal += selfIn;
      link(selfSrc, s, selfIn, BAND.in + BAND.h, BAND.conduit, s.color,
        `Your accounts → ${nameOf(f)}  ${fmtUsd(selfIn)} · funded to pay someone`);
    }
    for (const e of flows.edges.filter((x) => x.from === f.last4)) {
      const to = slotOf(cashMap, e.to) ?? slotOf(cardMap, e.to);
      if (!to) continue;
      bump(conduitMap, f.last4, 'out', e.amount);
      to.inTotal += e.amount;
      link(s, to, e.amount, BAND.conduit + BAND.h, cashMap.has(e.to) ? BAND.cash : BAND.card, s.color,
        `${nameOf(f)} → ${to.label}  ${fmtUsd(e.amount)} · passed through`);
    }
    const o = outMap.get('spent');
    if (netSpend(f) > 0.005 && o) {
      bump(conduitMap, f.last4, 'out', netSpend(f));
      o.inTotal += netSpend(f);
      link(s, o, netSpend(f), BAND.conduit + BAND.h, BAND.out, s.color, `${nameOf(f)} → Spent  ${fmtUsd(netSpend(f))}`);
    }
  }
  for (const f of cardAccts) {
    const s = slotOf(cardMap, f.last4);
    const o = outMap.get('spent');
    if (!s) continue;
    if (netSpend(f) <= 0.005 || !o) continue;
    link(s, o, netSpend(f), BAND.card + BAND.h, BAND.out, ribbonColor(f.last4, s.color), `${nameOf(f)} → Spent  ${fmtUsd(netSpend(f))} · net of refunds`);
  }

  return {
    bandTotals: [
      { name: 'In', total: inSlots.reduce((a, x) => a + x.value, 0) },
      ...(conduitSlots.length ? [{ name: 'Wallets', total: conduitSlots.reduce((a, x) => a + x.value, 0) }] : []),
      { name: 'Cash', total: cashSlots.reduce((a, x) => a + x.value, 0) },
      ...(cardSlots.length ? [{ name: 'Cards', total: cardSlots.reduce((a, x) => a + x.value, 0) }] : []),
      { name: 'Out', total: outSlots.reduce((a, x) => a + x.value, 0) },
    ],
    BAND,
    VH,
    logos,
    selfSourceIds,
    parkedIds,
    inSlots,
    conduitSlots,
    cashSlots,
    cardSlots,
    outSlots,
    ribbons,
    inParts,
    totalIn: inTotal,
    totalOut: outSlots.reduce((s, x) => s + x.value, 0),
    nAccounts: cashAccts.length + cardAccts.length,
  };
}

// ------------------------------------------------------- render-time geometry
//
// Everything below is `:736-1075` with the JSX removed: the same conditionals,
// the same x/y arithmetic, the same strings — just returned as data so a test
// can read them without a GPU.

export const CHIP_INK = 'on-series';
export const LOGO_SIZE = 16;

/** `in $x · through N accounts · out $y` — the caption above the canvas. */
export function summaryLine(totalIn: number, nAccounts: number, totalOut: number): string {
  return `in ${fmtUsd(totalIn)} · through ${nAccounts} account${nAccounts === 1 ? '' : 's'} · out ${fmtUsd(totalOut)}`;
}

export const CHART_LABEL =
  'Money flow: income lands in cash accounts, pays off cards, and leaves as spending, investing, or debt';

export interface ChipPlan {
  folded: boolean;
  /** '' for a folded tile, which shows marks instead of figures. */
  amt: string;
  name: string;
  bothFit: boolean;
  logoAndAmt: boolean;
  /** The centred fallback label; '' when folded. */
  only: string;
  logoX: number;
  nameX: number;
  /** Right edge for the end-anchored amount. */
  amtX: number;
  onlyX: number;
  /** Centre x shared by the IN/OUT halo labels and the under-chip amount. */
  midX: number;
}

/**
 * The chip decision tree (`:766-776`). `logo` is the base64 PNG or undefined —
 * only its presence matters to the arithmetic.
 */
export function chipPlan(s: Slot, logo: string | undefined): ChipPlan {
  const folded = (s.memberIds?.length ?? 0) > 0;
  const amt = folded ? '' : fmtUsd(s.amount ?? s.value);
  const name = fitLabel(s.label, s.w * 0.62 - (logo ? 18 : 0), s.alt);
  const bothFit = !folded && s.w >= (name.length + amt.length) * 6.2 + 14 + (logo ? 18 : 0);
  // A logo identifies the bank on its own. If the name and amount cannot both fit
  // beside it, drop the NAME — the mark already carries identity and the number
  // is what cannot be recovered from anywhere else on the chip.
  const logoAndAmt = !folded && !bothFit && logo != null && s.w >= amt.length * 6.2 + 30;
  const only = folded ? '' : fitLabel(s.label, s.w - (logo ? 18 : 0), s.alt) || s.alt;
  return {
    folded,
    amt,
    name,
    bothFit,
    logoAndAmt,
    only,
    logoX: s.x + (bothFit ? 6 : 5),
    nameX: s.x + (logo ? 25 : 7),
    amtX: s.x + s.w - 7,
    onlyX: s.x + (logo ? 24 : 0) + (s.w - (logo ? 24 : 0)) / 2,
    midX: s.x + s.w / 2,
  };
}

/** Up to 3 member marks, evenly spaced across a folded tile (`:784-799`). */
export function memberLogoLayout(s: Slot, logos: Map<string, string>): { id: string; x: number }[] {
  const marks = (s.memberIds ?? []).filter((id) => logos.has(id)).slice(0, 3);
  return marks.map((id, i) => ({ id, x: s.x + (s.w / marks.length) * (i + 0.5) - 8 }));
}

/** Member colour stripes; only the two ends are drawn rounded (`:773-783`). */
export function memberStripeLayout(s: Slot): { color: string; x: number; w: number; rounded: boolean }[] {
  const all = s.memberColors ?? [];
  return all.map((color, i) => ({
    color,
    x: s.x + (s.w / all.length) * i,
    w: s.w / all.length,
    rounded: i === 0 || i === all.length - 1,
  }));
}

export interface InSlotPlan {
  caption: string[];
  captionY: number[];
  labelText: string;
  labelY: number;
  amountText: string;
  amountY: number;
  midX: number;
  logoY: number;
}

/** The IN band's stacked label / amount / caption (`:919-976`). */
export function inSlotPlan(s: Slot, inParts: string[], bandIn: number): InSlotPlan {
  // Three headlines centred on boxes far narrower than the text ran into each
  // other ("Money in $5,3From your accounts $200classified"). Label and amount
  // now stack, each fitted to its own box, so a box only ever owns its width.
  const parts = s.id === 'in' ? wrapParts(inParts, s.w) : s.id === 'self' ? [['']] : [['source unknown']];
  const top = bandIn - 6 - parts.length * 10;
  return {
    caption: parts.map((line) => line.join('  ·  ')),
    captionY: parts.map((_, li) => bandIn - 6 - (parts.length - 1 - li) * 10),
    labelText: fitLabel(s.label, s.w + GAP, s.alt),
    labelY: top - 12,
    amountText: fmtUsd(s.value),
    amountY: top - 1,
    midX: s.x + s.w / 2,
    logoY: bandIn - 15,
  };
}

/** The `self` slot's source marks, centred as a row (`:947-961`). */
export function selfLogoLayout(s: Slot, selfSourceIds: string[], logos: Map<string, string>): { id: string; x: number }[] {
  const marks = selfSourceIds.filter((id) => logos.has(id)).slice(0, 3);
  return marks.map((id, i) => ({ id, x: s.x + s.w / 2 - (marks.length * 18) / 2 + i * 18 }));
}

export interface OutChipPlan {
  label: string;
  labelY: number;
  labelColor: string;
  amount: string;
  amountY: number;
  midX: number;
}

/**
 * The terminal chips under the OUT row (`:986-1008`). `rows` comes from
 * assignRows over the same slots, so a label only steps up when it would
 * collide with its left neighbour.
 */
export function outChipPlan(s: Slot, bandOut: number, bandH: number, rows: Map<string, number>): OutChipPlan {
  const row = rows.get(s.id) ?? 0;
  const meta = OUT_META[s.id as OutId];
  return {
    label: outLabelFor(s.id as OutId, s.w),
    labelY: bandOut + bandH + 15 + row * 24,
    labelColor: meta?.text ?? 'fg-2',
    amount: fmtUsd(s.value),
    amountY: bandOut + bandH + 26 + row * 24,
    midX: s.x + s.w / 2,
  };
}

export function outLabelRows(outSlots: Slot[]): Map<string, number> {
  return assignRows(outSlots, (s) => OUT_META[s.id as OutId]?.label ?? s.label);
}

export interface BandLabel {
  text: string;
  x: number;
  y: number;
}

/** WALLETS / CASH / MOVED INTO / OUT — MOVED INTO shows even with no cards (`:1010-1028`). */
export function bandLabels(build: Pick<SankeyBuild, 'BAND' | 'VH' | 'conduitSlots'>): BandLabel[] {
  const { BAND, VH, conduitSlots } = build;
  return [
    ...(conduitSlots.length
      ? [{ text: 'WALLETS', x: Math.max(MX, conduitSlots[0].x), y: BAND.conduit - 22 }]
      : []),
    { text: 'CASH', x: MX, y: BAND.cash - 22 },
    { text: 'MOVED INTO', x: MX, y: BAND.card - 22 },
    { text: 'OUT', x: MX, y: VH - 8 },
  ];
}

/**
 * CSS `letter-spacing` adds its em value after every glyph; Skia draws a run at
 * one x, so the band labels are drawn glyph by glyph. `advance` is the font's
 * advance width for a single character.
 */
export function spacedGlyphs(
  text: string,
  x: number,
  spacing: number,
  advance: (ch: string) => number,
): { ch: string; x: number }[] {
  let cursor = x;
  return [...text].map((ch) => {
    const at = cursor;
    cursor += advance(ch) + spacing;
    return { ch, x: at };
  });
}

export interface LegendRow {
  id: string;
  color: string;
  text: string;
}

/** One row per chip, a folded tile expanded to one row per member (`:1046-1072`). */
export function legendRows(build: Pick<SankeyBuild, 'conduitSlots' | 'cashSlots' | 'cardSlots' | 'outSlots' | 'parkedIds'>): LegendRow[] {
  const { conduitSlots, cashSlots, cardSlots, outSlots, parkedIds } = build;
  return [...conduitSlots, ...cashSlots, ...cardSlots, ...outSlots.filter((o) => parkedIds.has(o.id))]
    .flatMap((s) =>
      s.members?.length
        ? s.members.map((name, i) => ({
            ...s,
            id: `${s.id}:${i}`,
            label: name,
            members: undefined,
            color: s.memberColors?.[i] ?? s.color,
            w: 999, // name only; the tile's own total is not this member's
          }))
        : [s],
    )
    .map((s) => ({
      id: s.id,
      color: s.color,
      text: s.members?.length
        ? `${s.members.join(' + ')} · ${fmtUsd(s.value)} through`
        : s.w < ACCT_VALUE_MIN_W
          ? `${s.label} · ${fmtUsd(s.value)} through`
          : s.label,
    }));
}

/** The band-totals strip under the canvas (`:1032-1045`). */
export function bandTotalCells(bandTotals: { name: string; total: number }[]): { name: string; total: string; arrow: boolean }[] {
  return bandTotals.map((b, i) => ({ name: b.name.toUpperCase(), total: fmtUsd(b.total), arrow: i > 0 }));
}
