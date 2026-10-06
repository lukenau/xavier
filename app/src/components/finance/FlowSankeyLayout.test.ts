// The Sankey's arithmetic, pinned. Every expected number here was derived from
// the PWA's own formulas (apps/hub/src/components/finance/FlowSankey.tsx) by
// hand or from docs/inventory/money.md §7 — not read back out of this port's
// output — so a transcription slip fails rather than records itself.
import type { AccountFlow, FlowGraph, MatchedEdge } from '../../shared/financeModel';
import { fitLabel, packSlots, type Slot } from '../../shared/sankeyLayout';
import {
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
  selfLogoLayout,
  spacedGlyphs,
  summaryLine,
  type SankeyBuild,
} from './FlowSankeyLayout';

const acct = (over: Partial<AccountFlow> & { last4: string }): AccountFlow => ({
  label: `Account ${over.last4}`,
  institution: 'Bank',
  accountName: 'Checking',
  cls: 'cash',
  color: 'series-1',
  balance: null,
  inflow: 0,
  inflowByType: { income: 0, refund: 0, interest: 0 },
  spend: 0,
  transferOut: 0,
  transferIn: 0,
  paymentOut: 0,
  paymentIn: 0,
  total: 0,
  ...over,
});

const graph = (
  accounts: AccountFlow[],
  edges: MatchedEdge[] = [],
  institutions: Record<string, { logo: string | null; color: string | null }> = {},
): FlowGraph => ({
  accounts,
  byLast4: new Map(accounts.map((a) => [a.last4, a])),
  edges,
  inflowByType: [],
  out: { spent: 0, savings: 0, card: 0, invest: 0, moved: 0 },
  institutions,
  windowDays: 30,
});

// One checking account funding everything the chart knows how to draw: a card
// it pays off, a wallet it tops up, savings and a brokerage it parks money in,
// an unmatched payment out (debt), and spending of its own.
const CHECKING = acct({
  last4: '1111',
  label: 'Example Bank Checking ••1111',
  institution: 'Example Bank',
  accountName: 'Example Bank Checking',
  balance: 3000,
  inflow: 5000,
  inflowByType: { income: 5000, refund: 0, interest: 0 },
  spend: 1200,
  transferOut: 2000,
  paymentOut: 1800,
  total: 8000,
});
// The issuer calls it "CREDIT CARD", so only the user's nickname tells it apart.
const CARD = acct({
  last4: '2222',
  label: 'Example Bank Miles ••2222',
  institution: 'Example Bank',
  accountName: 'CREDIT CARD',
  nickname: 'Example Bank Miles',
  cls: 'credit',
  color: 'series-2',
  balance: -200,
  inflow: 100,
  inflowByType: { income: 0, refund: 100, interest: 0 },
  spend: 900,
  paymentIn: 1500,
  total: 2500,
});
const VENMO = acct({
  last4: '9999',
  label: 'Venmo ••9999',
  institution: 'Venmo',
  accountName: 'Venmo',
  color: 'series-3',
  balance: 1,
  spend: 50,
  transferIn: 300,
  total: 350,
});
const SAVINGS = acct({
  last4: '5555',
  label: 'Acme Savings ••5555',
  institution: 'Acme',
  accountName: 'Savings',
  color: 'series-4',
  balance: 4000,
  transferIn: 1000,
  total: 1000,
});
const BROKERAGE = acct({
  last4: '7777',
  label: 'Sample Fund ••7777',
  institution: 'Sample Fund',
  accountName: 'Individual Cash Account',
  cls: 'investment',
  color: 'series-5',
  balance: 9000,
  transferIn: 800,
  total: 800,
});

const EDGES: MatchedEdge[] = [
  { from: '1111', to: '2222', amount: 1500, type: 'payment' },
  { from: '1111', to: '5555', amount: 1000, type: 'transfer' },
  { from: '1111', to: '7777', amount: 800, type: 'transfer' },
  { from: '1111', to: '9999', amount: 200, type: 'transfer' },
];

const ESTATE = graph([CHECKING, CARD, VENMO, SAVINGS, BROKERAGE], EDGES);

const built = (): SankeyBuild => {
  const b = buildSankey(ESTATE);
  if (!b) throw new Error('fixture built nothing');
  return b;
};

const ids = (slots: Slot[]) => slots.map((s) => s.id);

describe('buildSankey — which band an account lands in', () => {
  test('nothing above the $1 floor renders no chart at all', () => {
    expect(buildSankey(graph([]))).toBeNull();
    expect(buildSankey(graph([acct({ last4: '0001', total: 0.5 })]))).toBeNull();
  });

  test('an account under $1 still counts when an edge of $1+ touches it', () => {
    const b = buildSankey(
      graph(
        [acct({ last4: '0001', total: 0.5, inflowByType: { income: 60, refund: 0, interest: 0 }, spend: 5 }), acct({ last4: '0002', total: 0.5 })],
        [{ from: '0001', to: '0002', amount: 25, type: 'transfer' }],
      ),
    );
    expect(b).not.toBeNull();
    expect(ids(b!.cashSlots)).toEqual(['0001']);
    // 0002 receives an internal edge and earns nothing from outside → parked.
    expect([...b!.parkedIds]).toEqual(['0002']);
  });

  test('cash / card / wallet / parked split', () => {
    const b = built();
    expect(ids(b.cashSlots)).toEqual(['1111']);
    expect(ids(b.cardSlots)).toEqual(['2222']);
    expect(ids(b.conduitSlots)).toEqual(['9999']);
    expect([...b.parkedIds]).toEqual(['5555', '7777']);
    expect(b.nAccounts).toBe(2); // cash + cards only
  });

  test('$13 of interest does not make a savings account a source', () => {
    const trickle = acct({ last4: '5555', institution: 'Acme', transferIn: 1000, total: 1000, inflow: 13, inflowByType: { income: 0, refund: 0, interest: 13 } });
    const b = buildSankey(graph([CHECKING, trickle], [{ from: '1111', to: '5555', amount: 1000, type: 'transfer' }]))!;
    expect([...b.parkedIds]).toEqual(['5555']);
    // …but $60 of real income clears the absolute floor and it becomes cash.
    const earner = { ...trickle, inflow: 60, inflowByType: { income: 60, refund: 0, interest: 0 } };
    const b2 = buildSankey(graph([CHECKING, earner], [{ from: '1111', to: '5555', amount: 1000, type: 'transfer' }]))!;
    expect([...b2.parkedIds]).toEqual([]);
    expect(ids(b2.cashSlots)).toEqual(['1111', '5555']);
  });

  test('the $50 floor decides it, not the 5% share alone', () => {
    // Only $100 moved through, so the share test asks for $5 — without the
    // absolute floor a $13 interest payment would promote this to a source.
    const tiny = acct({
      last4: '6666', institution: 'Example Savings', transferIn: 60, total: 100,
      inflow: 13, inflowByType: { income: 0, refund: 0, interest: 13 },
    });
    const b = buildSankey(graph([CHECKING, tiny], [{ from: '1111', to: '6666', amount: 60, type: 'transfer' }]))!;
    expect([...b.parkedIds]).toEqual(['6666']);
  });
});

describe('buildSankey — band geometry', () => {
  test('the wallet row pushes every band below it down by 106', () => {
    const withWallet = built();
    expect(withWallet.BAND).toEqual({ in: 104, conduit: 236, cash: 368, card: 548, out: 718, h: 26 });
    expect(withWallet.VH).toBe(818);

    const noWallet = buildSankey(graph([CHECKING, CARD], [{ from: '1111', to: '2222', amount: 1500, type: 'payment' }]))!;
    expect(noWallet.BAND).toEqual({ in: 104, conduit: 236, cash: 262, card: 442, out: 612, h: 26 });
    expect(noWallet.VH).toBe(712);
  });

  test('the lone cash chip fills the row: floor 108.2 + all the spare width', () => {
    // floor = (len('Checking') + len('$5,000')) × 6.3 + 20 = 108.2; W = 380 − 24;
    // one item takes the whole of the spare, so it spans MX → VW − MX.
    const cash = built().cashSlots[0];
    expect(cash.x).toBe(12);
    expect(cash.w).toBeCloseTo(356, 6);
    expect(cash.label).toBe('Example Bank Checking');
    expect(cash.alt).toBe('Checking');
  });

  test('the wallet band is right-aligned against VW − MX', () => {
    const wallet = built().conduitSlots[0];
    // floor = (len('Venmo') + len('$100')) × 6.3 + 20 = 76.7; share = 100/5000 × 279.3.
    expect(wallet.w).toBeCloseTo(82.286, 3);
    expect(wallet.x + wallet.w).toBeCloseTo(368, 6);
  });
});

describe('buildSankey — the money', () => {
  test('inflow parts, totals and the internal box', () => {
    const b = built();
    expect(ids(b.inSlots)).toEqual(['in', 'self']); // no unclassified money here
    expect(b.inParts).toEqual(['Income $5,000', 'Refunds $100', 'Transfers $100']);
    expect(b.totalIn).toBe(5200);
    expect(b.inSlots[1].value).toBe(200); // the $200 checking sent to Venmo
    expect(b.selfSourceIds).toEqual(['1111']);
  });

  test('an unmatched payment INTO cash is unclassified money in, never income', () => {
    const odd = { ...CHECKING, paymentIn: 2000 };
    const b = buildSankey(graph([odd], []))!;
    expect(ids(b.inSlots)).toEqual(['in', 'unknown']);
    expect(b.inSlots[1].value).toBe(2000);
    expect(b.totalIn).toBe(5000 + 2000);
    // The same credit landing on a CARD is the far side of a payment, not money in.
    const card = { ...CARD, paymentIn: 2000 };
    const b2 = buildSankey(graph([card], []))!;
    expect(ids(b2.inSlots)).toEqual(['in']);
  });

  test('the OUT row: spend from every band, invest capped by transferOut, unmatched payments as debt', () => {
    const b = built();
    // spent = 1200 (cash) + 900 (card) + 50 (wallet); invest = min(800, 2000);
    // debt = 1800 paid out − 1500 matched onto the card.
    expect(ids(b.outSlots)).toEqual(['spent', 'invest', 'debt', '5555', '7777']);
    expect(b.outSlots.map((s) => s.value)).toEqual([2150, 800, 300, 1000, 800]);
    expect(b.totalOut).toBe(5050);
  });

  test('parked amounts are NET of the return trip', () => {
    const b = buildSankey(
      graph([CHECKING, SAVINGS], [
        { from: '1111', to: '5555', amount: 5000, type: 'transfer' },
        { from: '1111', to: '5555', amount: 2000, type: 'transfer' },
        { from: '5555', to: '1111', amount: 2500, type: 'transfer' },
      ]),
    )!;
    const savings = b.outSlots.find((s) => s.id === '5555')!;
    expect(savings.value).toBe(4500);
  });

  test('band totals name the rows that exist', () => {
    expect(built().bandTotals).toEqual([
      { name: 'In', total: 5400 },
      { name: 'Wallets', total: 100 },
      { name: 'Cash', total: 5000 },
      { name: 'Cards', total: 1600 },
      { name: 'Out', total: 5050 },
    ]);
    const bare = buildSankey(graph([CHECKING]))!;
    expect(bare.bandTotals.map((x) => x.name)).toEqual(['In', 'Cash', 'Out']);
  });
});

describe('buildSankey — ribbons', () => {
  test('every flow, in draw order, with the sentence the PWA writes', () => {
    expect(built().ribbons.map((r) => r.title)).toEqual([
      'Income → Example Bank Checking  $5,000',
      'Refunds → Example Bank Miles  $100',
      'Transfers → Venmo  $100',
      'Example Bank Checking ••1111 → Example Bank Miles  $1,500 · paying the bill',
      'Example Bank Checking → Acme  $1,000 · parked',
      'Example Bank Checking → Sample Fund  $800 · parked',
      'Example Bank Checking ••1111 → Spent  $1,200',
      'Example Bank Checking ••1111 → → Invest  $800',
      'Example Bank Checking ••1111 → → Debt  $300',
      'Your accounts → Venmo  $200 · funded to pay someone',
      'Venmo → Spent  $50.00',
      'Example Bank Miles → Spent  $900 · net of refunds',
    ]);
  });

  test('a ribbon spans the share of each end it actually carries', () => {
    const b = built();
    const toCard = b.ribbons.find((r) => r.title.includes('paying the bill'))!;
    const cash = b.cashSlots[0];
    const card = b.cardSlots[0];
    // Cash sends 1200 + 1500 + 1000 + 800 + 800 + 300 = 5600 in total; the card
    // payment is the second ribbon out of it, after 1200 of spend… except the
    // card leg is allocated FIRST (payToCard precedes the OUT buckets).
    expect(toCard.fromX0).toBeCloseTo(cash.x, 6);
    expect(toCard.fromX1).toBeCloseTo(cash.x + (1500 / cash.outTotal) * cash.w, 6);
    // At the card end it lands after the $100 refund already taken.
    expect(toCard.toX0).toBeCloseTo(card.x + (100 / card.inTotal) * card.w, 6);
    expect(toCard.y0).toBe(394); // BAND.cash + h
    expect(toCard.y1).toBe(548); // BAND.card
  });

  test('an account folded into +N accounts keeps its own colour on its ribbons', () => {
    const cards = [1, 2, 3, 4, 5, 6].map((n) =>
      acct({
        last4: `200${n}`,
        institution: `Bank${n}`,
        accountName: 'CREDIT CARD',
        cls: 'credit',
        color: `series-${n}`,
        spend: 1000 + n,
        paymentIn: 1000,
        total: 2000,
      }),
    );
    const b = buildSankey(
      graph(
        [CHECKING, ...cards],
        cards.map((c) => ({ from: '1111', to: c.last4, amount: 1000, type: 'payment' as const })),
      ),
    )!;
    // need = 6 × max(46, len('$1,000')×6 + 32) + 5 gaps = 458 > 356, so the two
    // smallest fold away rather than every chip shrinking below legibility.
    expect(ids(b.cardSlots)).toEqual(['2003', '2004', '2005', '2006', '__other']);
    const folded = b.cardSlots[4];
    expect(folded.label).toBe('+2 accounts');
    expect(folded.members).toEqual(['Bank1', 'Bank2']);
    expect(folded.memberIds).toEqual(['2001', '2002']);
    expect(b.ribbons.some((r) => r.title.includes('Bank1') && r.color === 'series-1')).toBe(true);
  });
});

describe('chip layout — the fits-inside decision tree', () => {
  const slot = (over: Partial<Slot>): Slot => ({
    id: 'x', label: 'Sample Fund', alt: 'Sample Fund', value: 1000, amount: 1000,
    color: 'series-1', x: 12, w: 200, inCursor: 0, outCursor: 0, inTotal: 0, outTotal: 0, ...over,
  });

  test('a wide chip carries its name AND its balance', () => {
    const plan = chipPlan(slot({ w: 200 }), undefined);
    // (11 + 6) × 6.2 + 14 = 119.4 ≤ 200.
    expect(plan.bothFit).toBe(true);
    expect(plan.name).toBe('Sample Fund');
    expect(plan.amt).toBe('$1,000');
    expect(plan.nameX).toBe(19); // x + 7, no logo
    expect(plan.amtX).toBe(205); // x + w − 7
  });

  test('with a mark but no room for both, the NAME is what goes', () => {
    // w = 80: bothFit needs (len(fitLabel(80×0.62−18=31.6)) + 6) × 6.2 + 14 + 18.
    // fitLabel at 31.6 → floor(31.6/6.6) = 4 chars → 'Sam…'; (4+6)×6.2+32 = 94 > 80.
    // logoAndAmt needs 6 × 6.2 + 30 = 67.2 ≤ 80 → mark + number.
    const plan = chipPlan(slot({ w: 80 }), 'BASE64');
    expect(plan.bothFit).toBe(false);
    expect(plan.logoAndAmt).toBe(true);
    expect(plan.logoX).toBe(17); // x + 5 (the tighter inset)
  });

  test('with no mark and no room, one centred label and the amount below', () => {
    const plan = chipPlan(slot({ w: 60 }), undefined);
    expect(plan.bothFit).toBe(false);
    expect(plan.logoAndAmt).toBe(false);
    // fitLabel(label, 60) → floor(60/6.6) = 9 chars → 'Sample F…'
    expect(plan.only).toBe('Sample F…');
    expect(plan.onlyX).toBe(42); // x + w/2
  });

  test('a folded tile shows marks, never figures', () => {
    const plan = chipPlan(slot({ memberIds: ['a', 'b'], memberColors: ['series-2', 'series-3'], label: '+2 accounts' }), undefined);
    expect(plan.folded).toBe(true);
    expect(plan.amt).toBe('');
    expect(plan.only).toBe('');
    expect(plan.bothFit).toBe(false);
    expect(plan.logoAndAmt).toBe(false);
  });

  test('the alt name is preferred over a broken one', () => {
    // 'Example Bank Checking' at 60px: max = 9 chars, alt 'Checking' fits whole.
    expect(fitLabel('Example Bank Checking', 60, 'Checking')).toBe('Checking');
    expect(chipPlan(slot({ label: 'Example Bank Checking', alt: 'Checking', w: 60 }), undefined).only).toBe('Checking');
  });

  test('member stripes round only the two ends; marks cap at three', () => {
    const s = slot({ w: 120, memberColors: ['a', 'b', 'c', 'd'], memberIds: ['1', '2', '3', '4'] });
    expect(memberStripeLayout(s)).toEqual([
      { color: 'a', x: 12, w: 30, rounded: true },
      { color: 'b', x: 42, w: 30, rounded: false },
      { color: 'c', x: 72, w: 30, rounded: false },
      { color: 'd', x: 102, w: 30, rounded: true },
    ]);
    const logos = new Map([['1', 'AA'], ['3', 'CC'], ['4', 'DD']]);
    expect(memberLogoLayout(s, logos)).toEqual([
      { id: '1', x: 12 + 20 - 8 },
      { id: '3', x: 12 + 60 - 8 },
      { id: '4', x: 12 + 100 - 8 },
    ]);
  });
});

describe('the IN band caption', () => {
  const s: Slot = { id: 'in', label: 'Money in', alt: 'In', value: 5200, color: 'series-other', x: 12, w: 200, inCursor: 0, outCursor: 0, inTotal: 0, outTotal: 0 };

  test('parts wrap to the box and the stack rises above it', () => {
    const plan = inSlotPlan(s, ['Income $5,000', 'Refunds $100', 'Transfers $100'], 104);
    // max chars = max(10, floor(200/5.4)) = 37; 'Income $5,000  ·  Refunds $100' is 30,
    // adding Transfers takes it past 37, so it wraps to two lines.
    expect(plan.caption).toEqual(['Income $5,000  ·  Refunds $100', 'Transfers $100']);
    expect(plan.captionY).toEqual([88, 98]); // 104 − 6 − 10, then 104 − 6
    expect(plan.labelY).toBe(104 - 6 - 20 - 12);
    expect(plan.amountY).toBe(104 - 6 - 20 - 1);
    expect(plan.labelText).toBe('Money in');
    expect(plan.amountText).toBe('$5,200');
  });

  test('the internal box says nothing; unknown money says where it came from', () => {
    expect(inSlotPlan({ ...s, id: 'self' }, [], 104).caption).toEqual(['']);
    expect(inSlotPlan({ ...s, id: 'unknown' }, [], 104).caption).toEqual(['source unknown']);
  });

  test('source marks sit centred as a row above the box', () => {
    const logos = new Map([['1111', 'AA'], ['2222', 'BB']]);
    expect(selfLogoLayout({ ...s, id: 'self' }, ['1111', '3333', '2222'], logos)).toEqual([
      { id: '1111', x: 112 - 18 },
      { id: '2222', x: 112 },
    ]);
    expect(inSlotPlan({ ...s, id: 'self' }, [], 104).logoY).toBe(89);
  });
});

describe('the OUT terminals', () => {
  test('a label steps to the next row only when it would collide', () => {
    const slots = packSlots([
      { id: 'spent', label: 'Spent', alt: 'Spent', value: 2150, color: 'cat-spend' },
      { id: 'invest', label: '→ Invest', alt: 'Inv', value: 800, color: 'flow-invest' },
      { id: 'debt', label: '→ Debt', alt: 'Debt', value: 300, color: 'flow-debt' },
    ]);
    const rows = outLabelRows(slots);
    expect(rows.get('spent')).toBe(0);
    const plan = outChipPlan(slots[1], 718, 26, rows);
    expect(plan.labelY).toBe(718 + 26 + 15 + (rows.get('invest') ?? 0) * 24);
    expect(plan.amountY).toBe(plan.labelY + 11);
    expect(plan.labelColor).toBe('flow-invest');
    expect(plan.amount).toBe('$800');
  });

  test('the label shortens to fit, then truncates', () => {
    const wide = { id: 'invest', label: '→ Invest', alt: 'Inv', value: 800, color: 'flow-invest' };
    // budget = floor((w + 10)/6.3) chars.
    expect(outChipPlan(packSlots([{ ...wide }])[0], 0, 0, new Map()).label).toBe('→ Invest');
    const tight: Slot = { id: 'invest', label: '→ Invest', alt: 'Inv', value: 1, color: 'flow-invest', x: 0, w: 20, inCursor: 0, outCursor: 0, inTotal: 0, outTotal: 0 };
    expect(outChipPlan(tight, 0, 0, new Map()).label).toBe('Inv');
    const sliver: Slot = { ...tight, w: 2 };
    expect(outChipPlan(sliver, 0, 0, new Map()).label).toBe('In');
  });

  test('a parked account keeps its own chip on the OUT row', () => {
    const b = built();
    expect(b.outSlots.filter((s) => b.parkedIds.has(s.id)).map((s) => s.label)).toEqual(['Acme', 'Sample Fund']);
  });
});

describe('chrome around the canvas', () => {
  test('the summary line counts accounts, not chips', () => {
    expect(summaryLine(5200, 2, 5050)).toBe('in $5,200 · through 2 accounts · out $5,050');
    expect(summaryLine(10, 1, 5)).toBe('in $10.00 · through 1 account · out $5.00');
  });

  test('MOVED INTO is drawn even with no cards, and WALLETS tracks its first chip', () => {
    const b = built();
    expect(bandLabels(b)).toEqual([
      { text: 'WALLETS', x: b.conduitSlots[0].x, y: 214 },
      { text: 'CASH', x: 12, y: 346 },
      { text: 'MOVED INTO', x: 12, y: 526 },
      { text: 'OUT', x: 12, y: 810 },
    ]);
    const noCards = buildSankey(graph([CHECKING]))!;
    expect(bandLabels(noCards).map((l) => l.text)).toEqual(['CASH', 'MOVED INTO', 'OUT']);
  });

  test('letter-spacing becomes per-glyph placement', () => {
    expect(spacedGlyphs('OUT', 12, 2, () => 6)).toEqual([
      { ch: 'O', x: 12 },
      { ch: 'U', x: 20 },
      { ch: 'T', x: 28 },
    ]);
  });

  test('band totals are uppercased with an arrow between them', () => {
    expect(bandTotalCells([{ name: 'In', total: 5400 }, { name: 'Cash', total: 5000 }])).toEqual([
      { name: 'IN', total: '$5,400', arrow: false },
      { name: 'CASH', total: '$5,000', arrow: true },
    ]);
  });

  test('the legend names every chip, and expands a folded tile into its members', () => {
    const b = built();
    expect(legendRows(b).map((r) => r.text)).toEqual(['Venmo', 'Example Bank Checking', 'Example Bank Miles', 'Acme', 'Sample Fund']);

    const folded: Slot = {
      id: '__other', label: '+2 accounts', alt: '+2', value: 900, color: 'series-other',
      members: ['Bank1', 'Bank2'], memberColors: ['series-1', 'series-2'], memberIds: ['2001', '2002'],
      x: 12, w: 72, inCursor: 0, outCursor: 0, inTotal: 0, outTotal: 0,
    };
    expect(legendRows({ conduitSlots: [], cashSlots: [], cardSlots: [folded], outSlots: [], parkedIds: new Set() })).toEqual([
      { id: '__other:0', color: 'series-1', text: 'Bank1' },
      { id: '__other:1', color: 'series-2', text: 'Bank2' },
    ]);
  });

  test('a chip too narrow to have shown its amount gets it in the legend', () => {
    const narrow: Slot = { id: '4444', label: 'Acme', alt: 'Acme', value: 120, color: 'series-1', x: 12, w: 30, inCursor: 0, outCursor: 0, inTotal: 0, outTotal: 0 };
    expect(legendRows({ conduitSlots: [], cashSlots: [narrow], cardSlots: [], outSlots: [], parkedIds: new Set() })[0].text).toBe('Acme · $120 through');
  });
});
