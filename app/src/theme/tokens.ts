// Hand-written wrapper over the generated token table (tokens.gen.ts).
// Regenerate the generated half with `node scripts/gen-tokens.mjs`.
import { dark, light } from './tokens.gen';
import type { TokenName } from './tokens.gen';

export const tokens = { dark, light } as const;

export type { TokenName };
export type Token = TokenName;
