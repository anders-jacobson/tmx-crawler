/**
 * Text normalisation and segment-level heuristics used for filtering and alignment checks.
 */

// Zero-width characters, word joiner, BOM and soft hyphens (very common in German CMS content)
// would otherwise make otherwise identical segments look different to a TM engine.
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

/**
 * Canonical form of an extracted text segment:
 * Unicode NFC, invisible characters removed, all whitespace (incl. NBSP) collapsed, trimmed.
 * @param {string} value
 * @returns {string}
 */
export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').replace(INVISIBLE_CHARS, '').replace(/\s+/gu, ' ').trim();
}

/**
 * Whitespace-delimited word count (adequate for the space-separated languages this tool targets).
 * @param {string} value
 */
export function countWords(value) {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

// Digits grouped by locale-specific separators: 1,000.50 / 1.000,50 / 1 000 (NBSP / narrow NBSP) / 1'000.
const NUMBER_PATTERN = /\d+(?:[.,'\u00A0\u202F]\d+)*/gu;

/**
 * Locale-agnostic fingerprint of the numbers in a segment: separators are stripped so that
 * "1,000.5" (en) and "1.000,5" (de) compare equal. Returned sorted and de-duplicated.
 * @param {string} value
 * @returns {string[]}
 */
export function numberFingerprint(value) {
  const matches = (value ?? '').match(NUMBER_PATTERN) ?? [];
  return [...new Set(matches.map((m) => m.replace(/\D/g, '')))].sort();
}

/**
 * True when both segments contain the same set of numbers.
 * @param {string} a
 * @param {string} b
 */
export function numbersMatch(a, b) {
  const fa = numberFingerprint(a);
  const fb = numberFingerprint(b);
  return fa.length === fb.length && fa.every((n, i) => n === fb[i]);
}

/**
 * Detects segments that were left untranslated on the target page.
 * @param {string} source
 * @param {string} target
 */
export function isUntranslated(source, target) {
  return source.toLocaleLowerCase() === target.toLocaleLowerCase();
}
