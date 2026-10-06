// VERBATIM COPY of apps/hub/src/components/finance/model.ts (PWA). Do not edit by hand:
// scripts/check-shared-parity.mjs compares this file to the source and
// fails on any difference beyond the two allowed transforms — import
// paths, and `var(--token)` rewritten to the bare token name for
// src/theme's resolveToken(). Change the PWA first, then re-copy.
// --- end copy header; everything below is verbatim ---
import type { FinanceSnapshot, FinanceTxn } from '../lib/types';
import { ACCOUNT_DISPLAY, lookup, type AccountDisplay } from './accountDisplay';

// Pure derivation layer for the Finance surface. Everything here is a plain
// function over snapshot data — no React, no DOM — so the txn-type mapping and
// flow aggregation stay unit-testable. The wire contract says amount > 0 =
// outflow (spend); negative = money in.

// --- accounts (present in live snapshot v2; types.ts lags the wire) ----------
export interface FinanceAccount {
  name: string;
  institution: string;
  last4: string;
  type: string;
  balance: number;
  currency: string;
  source: string;
  id: string;
  asof: string;
}

export type FinanceSnapshotFull = FinanceSnapshot & { accounts?: FinanceAccount[] };

// types.ts lags the wire: snapshot txns may carry kind="income" (merger sets it
// only for Copilot type=INCOME rows).
export type FinanceTxnFull = FinanceTxn & { kind?: 'income' | null };

// --- transaction type tags ----------------------------------------------------
export type TxnType = 'spend' | 'income' | 'transfer' | 'payment' | 'refund' | 'fee' | 'interest';

// Chip + edge colours. These are var() references, not literals: every surface
// that consumes them is SVG or DOM, both of which resolve custom properties, so
// the finance tab themes with everything else.
// Refund stays distinct from income — byte-identical values made an inflow ribbon
// of refunds read as a paycheck in the flow chart.
export const TXN_COLORS: Record<TxnType, { fg: string; bg: string }> = {
  spend: { fg: 'cat-spend', bg: 'cat-spend-soft' },
  income: { fg: 'cat-income', bg: 'cat-income-soft' },
  transfer: { fg: 'cat-transfer', bg: 'cat-transfer-soft' },
  payment: { fg: 'cat-payment', bg: 'cat-payment-soft' },
  refund: { fg: 'cat-refund', bg: 'cat-refund-soft' },
  fee: { fg: 'cat-fee', bg: 'cat-fee-soft' },
  interest: { fg: 'cat-interest', bg: 'cat-interest-soft' },
};

export function isInflowType(t: TxnType): boolean {
  return t === 'income' || t === 'refund' || t === 'interest';
}

/**
 * CLASSIFICATION PARITY SPEC — mirrored in the merger
 * (the finance-snapshot merger). Both implementations MUST
 * agree; edit them together. Plaid enum categories compare with underscores as
 * spaces (BANK_FEES → "bank fees"). Order matters:
 *   1. kind == "income" OR category ~ income|paycheck|payroll|salary|dividend|direct deposit → income
 *   1b. merchant ~ klarna|affirm|afterpay|sezzle|quadpay|pay in 4|spaff -> spend (BNPL buys
 *       goods; Plaid files it under LOAN_PAYMENTS alongside real debt service)
 *   2. merchant OR category ~ returned payment|payment thank you|automatic payment|autopay|
 *      epay|card pmt|loan payments|credit card payment → payment (NEVER spend, NEVER fee, either sign)
 *   3. category ~ interest → interest
 *   4. category ~ refund|reimburse|chargeback → refund
 *   5. category ~ \bfees?\b|service charge|overdraft → fee (after the payment rule,
 *      so 'Returned Payment' never lands here)
 *   6. merchant OR category ~ transfer|zelle → transfer
 *   7. remaining negative (inflow) → refund for source=copilot (p2p money back),
 *      income for source=plaid (unlabeled bank inflow)
 *   8. remaining positive → spend
 */
const PAYMENT_RE =
  /returned payment|payment thank you|automatic payment|autopay|epay|card pmt|crcardpmt|cardpmt|loan payments|credit card payment/;
// BNPL settles a purchase of goods, so it is spend — not debt service like a personal
// or student loan. Plaid files all of them under LOAN_PAYMENTS, which conflates the two.
const BNPL_RE = /klarna|affirm|afterpay|sezzle|quadpay|pay in 4|\bspaff\b/;

export function deriveTxnType(
  t: Pick<FinanceTxnFull, 'merchant' | 'category' | 'amount' | 'source' | 'kind'>,
): TxnType {
  const cat = (t.category ?? '').toLowerCase().replace(/_/g, ' ');
  const merch = (t.merchant ?? '').toLowerCase();
  if (t.kind === 'income' || /income|paycheck|payroll|salary|dividend|direct deposit/.test(cat)) return 'income';
  if (BNPL_RE.test(merch)) return 'spend';
  if (PAYMENT_RE.test(merch) || PAYMENT_RE.test(cat)) return 'payment';
  if (/interest/.test(cat)) return 'interest';
  if (/refund|reimburse|chargeback/.test(cat)) return 'refund';
  if (/\bfees?\b|service charge|overdraft/.test(cat)) return 'fee';
  if (/transfer|zelle|withdrawal/.test(cat) || /transfer|zelle|withdrawal/.test(merch)) return 'transfer';
  if (t.amount < 0) return t.source === 'copilot' ? 'refund' : 'income';
  return 'spend';
}

// --- account classing / display ----------------------------------------------
export type AccountClass = 'cash' | 'credit' | 'investment';

export function accountClass(type: string): AccountClass {
  const t = (type ?? '').toLowerCase();
  if (/credit/.test(t)) return 'credit';
  if (/brokerage|investment|roth|ira|401|crypto/.test(t)) return 'investment';
  return 'cash';
}

// account_last4 / last4 is an opaque account key: a 4-digit mask for real
// cards, or a lowercase institution slug ("venmo", "cash") for maskless
// Copilot accounts. Only real masks get the "…1234" treatment.
export function isMaskKey(key: string): boolean {
  return /^\d+$/.test(key);
}

export function accountKeyLabel(key: string): string {
  if (isMaskKey(key)) return `…${key}`;
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : 'Account';
}

/**
 * Institution alone can't tell "Example Bank Checking" from "Example Bank Savings" — both
 * rendered as plain "Example Bank". Fold the account name in, but only keep the mask when
 * the name still doesn't disambiguate (three cards from one issuer all named "CREDIT CARD",
 * two accounts both "Example Bank individual").
 *
 * An issuer that returns every card as "CREDIT CARD" tells you nothing and forces the
 * mask to do the identifying, so a nickname the user set (accountDisplay.ts, keyed by
 * last4; none by default) wins outright.
 */
export function buildAccountLabels(
  accounts: FinanceAccount[],
  nicknames: Readonly<Record<string, string>> = ACCOUNT_DISPLAY.nicknames,
  known: readonly string[] = ACCOUNT_DISPLAY.institutions,
): Map<string, string> {
  const base = new Map<string, string>();
  for (const a of accounts) {
    if (base.has(a.last4)) continue;
    const nick = lookup(nicknames, a.last4);
    if (nick) {
      base.set(a.last4, nick);
      continue;
    }
    const inst = cleanInstitution(a.institution, known);
    const raw = (a.name ?? '').replace(/[{}'"]/g, '').trim();
    // Plaid hands back shouty names ("CREDIT CARD"); title-case those, leave mixed case alone.
    const name = raw === raw.toUpperCase() ? raw.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : raw;
    // Drop an institution echo so we get "Example Bank Roth IRA", not "Example Bank Example Bank Roth IRA".
    // ALIASES covers the case where the name spells out an abbreviated institution.
    const ALIASES: Record<string, string> = { amex: 'american express' };
    const echo = ALIASES[inst.toLowerCase()] ?? inst;
    const tail = name.replace(new RegExp(`^${echo}\\s*`, 'i'), '').trim();
    const pretty = tail && tail.toLowerCase() !== inst.toLowerCase() ? tail : '';
    base.set(a.last4, pretty ? `${inst} ${pretty}` : inst);
  }
  const counts = new Map<string, number>();
  for (const label of base.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const [last4, label] of base) {
    out.set(last4, (counts.get(label) ?? 0) > 1 ? `${label} …${last4}` : label);
  }
  return out;
}

/**
 * Live data carries some institutions as truncated dict-reprs — extract the name.
 * The sanitizer's 40-char cap also truncates them mid-word ("Example Ba", "Sample Cre"),
 * so a prefix of a name in `known` (the user's list in accountDisplay.ts; empty by
 * default) snaps back to it.
 */
export function cleanInstitution(raw: string, known: readonly string[] = ACCOUNT_DISPLAY.institutions): string {
  const m = /'name':\s*'([^']*)/.exec(raw) ?? /'id':\s*'([^']*)/.exec(raw);
  const v = (m ? m[1] : raw).replace(/[{}'"]/g, '').trim();
  if (!v) return 'Account';
  const full = known.find((k) => v.length >= 4 && k.toLowerCase().startsWith(v.toLowerCase()));
  if (full) return full;
  return v.charAt(0).toUpperCase() + v.slice(1);
}

// Deterministic account palette, assigned in flow-rank order. Identity is the
// SLOT, not the hex — dedup below compares these strings, so holding token
// references rather than values keeps a colour meaning the same account across
// both themes.
// A colour the user pins (accountDisplay.ts — per account, or per institution so every
// account there shares one) keeps meaning the same thing between refreshes; the rest
// fill from the palette around them. None are pinned by default.
export const ACCOUNT_PALETTE = [
  'series-1',
  'series-5',
  'series-2',
  'series-4',
  'series-3',
  'series-6',
  'series-7',
];
export const NEUTRAL = 'series-other';

export function sourceLabel(source: string): string {
  return source === 'plaid' ? 'Plaid' : source === 'copilot' ? 'Copilot' : source;
}

function titleCaseIfShouting(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Institution-first display labels. Bank-provided names are junk half the time
 * ("CREDIT CARD" ×3, "Example Owner", "Manual account") — the institution is the
 * identity. The name joins only when it distinguishes among siblings at the
 * same institution; duplicate/empty names leave the mask chip to disambiguate.
 */
export function accountLabels(accounts: FinanceAccount[]): Map<FinanceAccount, string> {
  const byInst = new Map<string, FinanceAccount[]>();
  for (const a of accounts) {
    const inst = cleanInstitution(a.institution);
    byInst.set(inst, [...(byInst.get(inst) ?? []), a]);
  }
  const out = new Map<FinanceAccount, string>();
  for (const [inst, list] of byInst) {
    const strip = (n: string) => n.replace(new RegExp(`^${inst}\\s*`, 'i'), '').trim();
    const names = list.map((a) => titleCaseIfShouting(strip(a.name ?? '')));
    for (let i = 0; i < list.length; i++) {
      const n = names[i];
      const distinct = n && names.filter((x) => x.toLowerCase() === n.toLowerCase()).length === 1;
      out.set(list[i], list.length > 1 && distinct ? `${inst} · ${n}` : inst);
    }
  }
  return out;
}

// --- flow aggregation ----------------------------------------------------------
export interface AccountFlow {
  last4: string;
  label: string; // full display name, disambiguated across ALL accounts (lists want detail)
  institution: string; // just the bank — charts identify an account by this first
  accountName: string; // "Checking", "Individual Cash Account" — a qualifier when needed
  nickname?: string; // the user's own name for it (accountDisplay.ts), when they set one
  cls: AccountClass;
  color: string;
  balance: number | null;
  inflow: number; // income + refunds + interest received
  inflowByType: { income: number; refund: number; interest: number };
  spend: number; // spend + fees out
  transferOut: number;
  transferIn: number;
  paymentOut: number;
  paymentIn: number;
  total: number; // total moved (abs sum) — node sizing
}

export interface MatchedEdge {
  from: string; // last4
  to: string; // last4
  amount: number;
  type: 'transfer' | 'payment';
}

/**
 * Pair internal moves: a transfer/payment outflow on one account matching an
 * equal-magnitude inflow on another within 3 days is one internal edge, not two
 * independent flows. Greedy, deterministic (date-ordered).
 */
export function matchInternalMoves(txns: (FinanceTxn & { type: TxnType })[]): {
  edges: MatchedEdge[];
  matched: Set<FinanceTxn & { type: TxnType }>;
} {
  const movers = txns.filter((t) => t.type === 'transfer' || t.type === 'payment');
  const outs = movers.filter((t) => t.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
  const ins = movers.filter((t) => t.amount < 0).sort((a, b) => a.date.localeCompare(b.date));
  const edges: MatchedEdge[] = [];
  const matched = new Set<FinanceTxn & { type: TxnType }>();
  for (const out of outs) {
    const hit = ins.find(
      (i) =>
        !matched.has(i) &&
        i.account_last4 !== out.account_last4 &&
        Math.abs(Math.abs(i.amount) - out.amount) < 0.01 &&
        Math.abs(Date.parse(i.date) - Date.parse(out.date)) <= 3 * 86400_000,
    );
    if (!hit) continue;
    matched.add(out);
    matched.add(hit);
    edges.push({
      from: out.account_last4,
      to: hit.account_last4,
      amount: out.amount,
      type: out.type === 'payment' || hit.type === 'payment' ? 'payment' : 'transfer',
    });
  }
  return { edges, matched };
}

/**
 * Amount matching cannot pair a conduit. Three Venmo inflows of $300/$50/$25 arrive at
 * the bank as ONE $375 deposit, so both legs survive as separate external flows and the
 * same money is drawn twice. But the bank leg literally NAMES the counterparty account
 * ("Venmo"), which is a stronger signal than an amount coincidence — use it to build the
 * edge the matcher missed.
 */
export function inferNamedEdges(
  txns: (FinanceTxn & { type: TxnType })[],
  accounts: FinanceAccount[],
  already: Set<FinanceTxn & { type: TxnType }>,
  known: readonly string[] = ACCOUNT_DISPLAY.institutions,
): MatchedEdge[] {
  const byName = new Map<string, string>();
  for (const a of accounts) {
    const key = cleanInstitution(a.institution, known).toLowerCase();
    if (key.length >= 4 && !byName.has(key)) byName.set(key, a.last4);
  }
  const edges: MatchedEdge[] = [];
  for (const t of txns) {
    if (already.has(t) || (t.type !== 'transfer' && t.type !== 'payment')) continue;
    const merch = (t.merchant ?? '').toLowerCase();
    const hit = [...byName.entries()].find(([name]) => merch.includes(name));
    if (!hit || hit[1] === t.account_last4) continue;
    const [, other] = hit;
    edges.push(
      t.amount > 0
        ? { from: t.account_last4, to: other, amount: Math.abs(t.amount), type: t.type }
        : { from: other, to: t.account_last4, amount: Math.abs(t.amount), type: t.type },
    );
    already.add(t);
  }
  return edges;
}

export interface FlowGraph {
  accounts: AccountFlow[]; // active first, by total moved desc
  byLast4: Map<string, AccountFlow>;
  edges: MatchedEdge[]; // account → account internal moves
  inflowByType: { type: TxnType; total: number }[]; // income / refund / interest
  out: { spent: number; savings: number; card: number; invest: number; moved: number };
  institutions: Record<string, { logo: string | null; color: string | null }>;
  windowDays: number;
}

/** Aggregate the snapshot's transactions into the flow picture both visuals share.
 * `display` is the user's account names and colour pins (accountDisplay.ts). */
export function buildFlows(snap: FinanceSnapshotFull, display: AccountDisplay = ACCOUNT_DISPLAY): FlowGraph {
  const acctMeta = new Map<string, FinanceAccount>();
  for (const a of snap.accounts ?? []) if (!acctMeta.has(a.last4)) acctMeta.set(a.last4, a);
  const acctLabels = buildAccountLabels(snap.accounts ?? [], display.nicknames, display.institutions);
  const institutionOf = (raw: string) => cleanInstitution(raw, display.institutions);

  // deriveTxnType reads category text, which cannot tell where money went: an unlabeled
  // credit on a charge card fell through to "income", so the chart drew a paycheck flowing INTO
  // a credit card and straight back out as "→ Card". Correct the type against the account
  // it landed on — the same invariants the snapshot now enforces server-side. A card
  // never earns income, and a card never pays another card.
  const classFor = (last4: string): AccountClass => {
    const meta = acctMeta.get(last4);
    return meta ? accountClass(meta.type) : 'cash';
  };
  const txns = (snap.recent_transactions ?? []).map((t) => {
    let type = deriveTxnType(t);
    if (classFor(t.account_last4) === 'credit') {
      if (t.amount < 0) {
        // Money arriving on a card settles it or refunds you — never earnings.
        if (type === 'income' || type === 'interest') type = 'refund';
      } else if (type === 'payment' || type === 'transfer') {
        // An outflow on a card is a charge, not the card paying something off.
        type = 'spend';
      }
    }
    return { ...t, type };
  });
  // A bounced payment and its reversal are one round trip that nets to zero. A card shows
  // AUTOPAY PAYMENT -$1,000.00 and RETURNED AUTOPAY +$1,000.00 ten days apart; counting
  // both put $1,000 of spending on the card that never happened. The merger already drops
  // these — this is the same rule, which is the fifth accounting rule to exist twice.
  // Require an explicit reversal word AND same account, same amount, opposite direction:
  // two genuine payments of equal size a week apart must NOT cancel each other.
  const reversed = new Set<(typeof txns)[number]>();
  for (const r of txns) {
    if (reversed.has(r) || !/return|revers/i.test(r.merchant ?? '')) continue;
    const mate = txns.find(
      (t) =>
        t !== r &&
        !reversed.has(t) &&
        t.account_last4 === r.account_last4 &&
        Math.abs(Math.abs(t.amount) - Math.abs(r.amount)) < 0.01 &&
        Math.sign(t.amount) !== Math.sign(r.amount) &&
        Math.abs(Date.parse(t.date) - Date.parse(r.date)) <= 21 * 86400_000,
    );
    if (mate) {
      reversed.add(r);
      reversed.add(mate);
    }
  }
  const live = txns.filter((t) => !reversed.has(t));

  const { edges, matched } = matchInternalMoves(live);
  edges.push(...inferNamedEdges(live, snap.accounts ?? [], matched, display.institutions));

  const flows = new Map<string, AccountFlow>();
  const flowFor = (last4: string): AccountFlow => {
    let f = flows.get(last4);
    if (!f) {
      const meta = acctMeta.get(last4);
      const nickname = lookup(display.nicknames, last4);
      f = {
        last4,
        label: acctLabels.get(last4) ?? (meta ? institutionOf(meta.institution) : accountKeyLabel(last4)),
        institution: meta ? institutionOf(meta.institution) : accountKeyLabel(last4),
        accountName: (meta?.name ?? '').replace(/[{}'"]/g, '').trim(),
        ...(nickname ? { nickname } : {}),
        cls: meta ? accountClass(meta.type) : 'cash',
        color: NEUTRAL,
        balance: meta?.balance ?? null,
        inflow: 0,
        inflowByType: { income: 0, refund: 0, interest: 0 },
        spend: 0,
        transferOut: 0,
        transferIn: 0,
        paymentOut: 0,
        paymentIn: 0,
        total: 0,
      };
      flows.set(last4, f);
    }
    return f;
  };

  const inflowTotals: Partial<Record<TxnType, number>> = {};
  for (const t of live) {
    const f = flowFor(t.account_last4);
    const abs = Math.abs(t.amount);
    f.total += abs;
    if (isInflowType(t.type)) {
      f.inflow += abs;
      f.inflowByType[t.type as 'income' | 'refund' | 'interest'] += abs;
      inflowTotals[t.type] = (inflowTotals[t.type] ?? 0) + abs;
    } else if (t.type === 'spend' || t.type === 'fee') {
      f.spend += abs;
    } else if (t.type === 'transfer') {
      if (t.amount > 0) f.transferOut += abs;
      else f.transferIn += abs;
    } else if (t.type === 'payment') {
      if (t.amount > 0) f.paymentOut += abs;
      else f.paymentIn += abs;
    }
  }

  const accounts = [...flows.values()].sort((a, b) => b.total - a.total);
  // Rank-based colour means an account changes hue whenever the amounts reshuffle, so a
  // colour you learned stops meaning what it meant. Pinned accounts and institutions keep
  // theirs (an account's own pin first: two cards from one issuer want telling apart); the
  // rest fill from the palette around them, skipping anything already claimed.
  const used = new Set([...Object.values(display.institutionColors), ...Object.values(display.last4Colors)]);
  let next = 0;
  for (const f of accounts) {
    const pin = lookup(display.last4Colors, f.last4) ?? lookup(display.institutionColors, f.institution);
    if (pin) {
      f.color = pin;
      continue;
    }
    while (next < ACCOUNT_PALETTE.length && used.has(ACCOUNT_PALETTE[next])) next++;
    f.color = ACCOUNT_PALETTE[next % ACCOUNT_PALETTE.length];
    used.add(f.color);
    next++;
  }
  // Several accounts at one institution (three cards from one issuer) need the last4 to
  // stay tellable-apart in the visuals.
  const labelCounts = new Map<string, number>();
  for (const f of accounts) labelCounts.set(f.label, (labelCounts.get(f.label) ?? 0) + 1);
  for (const f of accounts) if ((labelCounts.get(f.label) ?? 0) > 1) f.label = `${f.label} ${f.last4}`;

  // Outflow buckets (locked design: max 4 — Spent / Savings / Card / Invest).
  // A matched edge tells us the destination class; unmatched moves stay "Savings"
  // (moved-to-cash is the honest default for an unpaired transfer).
  let savings = 0;
  let invest = 0;
  let cardMatched = 0;
  for (const e of edges) {
    const cls = flows.get(e.to)?.cls ?? 'cash';
    if (e.type === 'payment') cardMatched += e.amount;
    else if (cls === 'investment') invest += e.amount;
    else savings += e.amount;
  }
  const totalTransferOut = accounts.reduce((s, f) => s + f.transferOut, 0);
  const totalPaymentOut = accounts.reduce((s, f) => s + f.paymentOut, 0);
  const matchedTransferOut = savings + invest;
  const out = {
    spent: accounts.reduce((s, f) => s + f.spend, 0),
    savings: savings + Math.max(0, totalTransferOut - matchedTransferOut),
    card: Math.max(totalPaymentOut, cardMatched),
    invest,
    moved: 0,
  };
  out.moved = out.savings + out.card + out.invest;

  const inflowByType = (['income', 'refund', 'interest'] as TxnType[])
    .map((type) => ({ type, total: inflowTotals[type] ?? 0 }))
    .filter((r) => r.total > 0.005);

  const dates = txns.map((t) => Date.parse(t.date)).filter((n) => !Number.isNaN(n));
  const windowDays = dates.length
    ? Math.min(32, Math.max(1, Math.round((Date.now() - Math.min(...dates)) / 86400_000)))
    : 30;

  return { accounts, byLast4: flows, edges, inflowByType, out, windowDays, institutions: snap.institutions ?? {} };
}

// --- shared formatting ----------------------------------------------------------
export function relDay(date: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (date === today) return 'today';
  const days = Math.round((Date.now() - new Date(date + 'T00:00:00').getTime()) / 86400_000);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return date.slice(5); // MM-DD
}
