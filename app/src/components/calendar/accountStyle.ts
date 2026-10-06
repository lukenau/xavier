// How the two calendars are told apart. Work is most of any week, so it takes
// the quiet greys; personal takes petrol, the design system's identity colour
// (tokens.css: "earthy blue, identity marks only"). Not the accent: that is
// chrome, already carries "today" and "selected", and must stay under 5% of a
// screen. Colour is never the only cue — every label names the calendar.
import type { CalendarAccount } from '../../lib/calendarTypes';
import type { TokenName } from '../../theme/tokens.gen';

export interface AccountTokens {
  edge: TokenName;
  fill: TokenName;
  bar: TokenName;
}

const TOKENS: Record<CalendarAccount, AccountTokens> = {
  work: { edge: 'fg-3', fill: 'bg-2', bar: 'fg-3' },
  personal: { edge: 'petrol', fill: 'petrol-soft', bar: 'petrol' },
};

export function accountTokens(account: CalendarAccount): AccountTokens {
  return TOKENS[account] ?? TOKENS.work;
}

export const ACCOUNT_LABEL: Record<CalendarAccount, string> = { work: 'work', personal: 'personal' };
