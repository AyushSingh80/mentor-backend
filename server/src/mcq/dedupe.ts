/**
 * Duplicate detection. Pure functions, no state — the index that holds state
 * is bank-index.ts.
 *
 * Three mechanisms, because they fail in different places:
 *
 *  1. Normalised stem hash — catches the identical question asked twice.
 *     Cheap and exact, and useless against a reworded repeat.
 *
 *  2. factKey exact match — the one that still works after eighteen months.
 *     Lexical similarity does not: "Consider the following statements about
 *     Article 368" and "Consider the following statements about the procedure
 *     for amending the Constitution" share almost no tokens and are the same
 *     question. A key the model assigns to the FACT survives every rewording,
 *     which no string metric over the stem can do.
 *
 *  3. 64-bit SimHash, Hamming <= 6 — catches the near-miss the factKey missed
 *     because the model chose a slightly different key for the same fact.
 *     Backstop, not primary.
 */

import { createHash } from 'node:crypto';

/**
 * Lowercase, unaccented, punctuation-free, single-spaced.
 *
 * The `[SAMPLE]` marker the fake runner prepends is stripped here so that a
 * fake and a real question about the same thing hash identically. A dedup
 * scheme that treats them as different would let `dev:fake` mask a real
 * duplication bug.
 */
export function normaliseStem(stem: string): string {
  return stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\[sample\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** 16 hex chars of sha256 over the normalised stem. */
export function stemHash(stem: string): string {
  return createHash('sha256').update(normaliseStem(stem)).digest('hex').slice(0, 16);
}

/**
 * factKeys are compared case- and whitespace-insensitively.
 *
 * Still an exact match in the sense that matters — no fuzzy scoring, no
 * threshold to tune — but "Polity:Article 368" and "polity:article-368" are
 * the same key, and a model will produce both.
 */
export function normaliseFactKey(key: string): string {
  return key
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-');
}

/* ------------------------------------------------------------------ SimHash */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a, 64 bit. Not cryptographic; it only needs to spread bits evenly. */
export function hash64(token: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < token.length; i += 1) {
    h ^= BigInt(token.charCodeAt(i) & 0xff);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/**
 * Word 3-grams, falling back to single words for short text.
 *
 * Shingles rather than bare words because word-level SimHash over question
 * stems is dominated by shared boilerplate ("consider the following statements
 * which of the statements given above is correct"), which every question in
 * the bank contains. Trigrams put the weight on the subject matter.
 */
export function shingles(text: string, size = 3): string[] {
  const words = text.split(' ').filter(Boolean);
  if (words.length === 0) return [];
  if (words.length < size) return words;
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) out.push(words.slice(i, i + size).join(' '));
  return out;
}

/** 64-bit SimHash of the normalised text. */
export function simHash64(text: string): bigint {
  const tokens = shingles(normaliseStem(text));
  if (tokens.length === 0) return 0n;

  const weights = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const h = hash64(token);
    for (let bit = 0; bit < 64; bit += 1) {
      const isSet = (h >> BigInt(bit)) & 1n;
      weights[bit] = (weights[bit] ?? 0) + (isSet === 1n ? 1 : -1);
    }
  }

  let out = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if ((weights[bit] ?? 0) > 0) out |= 1n << BigInt(bit);
  }
  return out;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK64;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

/** 16 hex chars, so the value survives JSON without BigInt serialisation. */
export function simHashHex(value: bigint): string {
  return value.toString(16).padStart(16, '0');
}

export function simHashFromHex(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

/**
 * Near-duplicate threshold.
 *
 * 6 of 64 bits. Tuned toward false positives on purpose: dropping a good
 * question costs one API call, while banking a near-duplicate wastes a review
 * slot every day for months and makes the deck feel padded.
 */
export const SIMHASH_MAX_DISTANCE = 6;
