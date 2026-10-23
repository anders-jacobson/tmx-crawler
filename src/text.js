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

// --- Protected tokens ------------------------------------------------------------------------
// Tokens that a translator keeps verbatim: brand/product names with internal capitals (PiCCO,
// IntelliVue, FleetView), model names like "Servo-u", and acronyms given in parentheses
// ("(IABP)"). If such a token is missing from the target, the two segments almost certainly
// describe different things (e.g. list items in a different order on the translated page).
const PROTECTED_PATTERNS = [
  { re: /\b[A-Za-z]*[a-z][A-Z][A-Za-z]*\b/g, group: 0 },
  { re: /\b[A-Z][a-z]+-[a-z0-9]\b/g, group: 0 },
  { re: /\(([A-Z][A-Z0-9-]+)\)/g, group: 1 },
];

/**
 * @param {string} value
 * @returns {string[]} unique protected tokens in order of appearance
 */
export function protectedTokens(value) {
  const tokens = new Set();
  for (const { re, group } of PROTECTED_PATTERNS) {
    for (const match of (value ?? '').matchAll(re)) tokens.add(match[group]);
  }
  return [...tokens];
}

/**
 * Protected tokens of `source` that do not occur (case-insensitively) in `target`.
 * @returns {string[]}
 */
export function missingProtectedTokens(source, target) {
  const haystack = (target ?? '').toLowerCase();
  return protectedTokens(source).filter((token) => !haystack.includes(token.toLowerCase()));
}

// --- Language plausibility -------------------------------------------------------------------
// Small function-word lists are enough to tell whether a segment on the target page is in fact
// still written in the source language (untranslated fallback content).
const STOPWORDS = {
  en: 'the and of to is are was were with for on your our that this these by from be can will has have it its which their you we not or',
  de: 'der die das und ist sind war mit für von zu den dem des ein eine einer eines im auf sie wir unsere ihre nicht auch bei oder sich werden wird kann können',
  sv: 'och att det som är för med på av till den har ett inte kan vi du ni eller också från vid samt',
  fr: 'le la les et est sont des du un une pour avec dans sur au aux que qui nous vous votre notre pas par ou',
  es: 'el la los las y es son del un una para con en por que su sus nuestro nuestra no más o se',
  it: 'il lo la gli le e è sono del della un una per con che di da non nostro nostra più o',
  nl: 'de het een en is zijn van voor met op dat die niet ook bij of wij u uw onze worden',
};
const STOPWORD_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words.split(' '))]));

const baseLang = (lang) => String(lang ?? '').toLowerCase().split('-')[0];

/**
 * True when `text`, which should be in `targetLang`, reads like `sourceLang` instead.
 * Requires at least two function words that are exclusive to the source language and more of
 * them than target-language function words. Unknown languages never trigger.
 */
export function readsAsSourceLanguage(text, sourceLang, targetLang) {
  const src = STOPWORD_SETS[baseLang(sourceLang)];
  const tgt = STOPWORD_SETS[baseLang(targetLang)];
  if (!src || !tgt || src === tgt) return false;
  let srcHits = 0;
  let tgtHits = 0;
  for (const word of (text ?? '').toLowerCase().match(/\p{L}+/gu) ?? []) {
    const inSrc = src.has(word);
    const inTgt = tgt.has(word);
    if (inSrc && !inTgt) srcHits += 1;
    else if (inTgt && !inSrc) tgtHits += 1;
  }
  return srcHits >= 2 && srcHits > tgtHits;
}
