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

// A single digit right after C, H, N or O is a chemical-formula index (CO₂, H2O2, PaO2, cmH2O),
// not a quantity – "carbon footprint" is legitimately translated as "CO₂-Bilanz".
const FORMULA_DIGIT = /(?<=[CHNO])\d(?!\d)/g;

/**
 * Locale-agnostic fingerprint of the numbers in a segment: separators are stripped so that
 * "1,000.5" (en) and "1.000,5" (de) compare equal. Sub- and superscript digits count as plain
 * digits (NFKC) and chemical-formula indices are ignored, so "H₂O" and "H2O" match.
 * Returned sorted and de-duplicated.
 * @param {string} value
 * @returns {string[]}
 */
export function numberFingerprint(value) {
  const matches = (value ?? '').normalize('NFKC').replace(FORMULA_DIGIT, '').match(NUMBER_PATTERN) ?? [];
  return [...new Set(matches.map((m) => m.replace(/\D/g, '')))].sort();
}

// Number words two..twelve per language. "one"/"ein" are deliberately absent: they are articles
// and pronouns far more often than numbers ("one of the…", "eine der…").
const NUMBER_WORDS = {
  en: 'two three four five six seven eight nine ten eleven twelve',
  de: 'zwei drei vier fünf sechs sieben acht neun zehn elf zwölf',
  sv: 'två tre fyra fem sex sju åtta nio tio elva tolv',
  fr: 'deux trois quatre cinq six sept huit neuf dix onze douze',
  es: 'dos tres cuatro cinco seis siete ocho nueve diez once doce',
  it: 'due tre quattro cinque sei sette otto nove dieci undici dodici',
  nl: 'twee drie vier vijf zes zeven acht negen tien elf twaalf',
};
const NUMBER_WORD_MAPS = Object.fromEntries(Object.entries(NUMBER_WORDS).map(([lang, words]) => [
  lang,
  new Map(words.split(' ').map((word, i) => [word, String(i + 2)])),
]));

/**
 * Numbers written as words ("zwei oder drei") in the given language, as digit strings.
 * @param {string} value
 * @param {string} [lang]
 * @returns {Set<string>}
 */
export function numberWordValues(value, lang) {
  const map = NUMBER_WORD_MAPS[String(lang ?? '').toLowerCase().split('-')[0]];
  const values = new Set();
  if (!map) return values;
  for (const word of (value ?? '').toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (map.has(word)) values.add(map.get(word));
  }
  return values;
}

/**
 * True when both segments contain the same numbers. Every digit-number on one side must appear
 * on the other side either as digits or as a number word ("2 or 3" ↔ "zwei oder drei"). Number
 * words alone never cause a mismatch ("the two modes" ↔ "die beiden Modi" is fine).
 * @param {string} a
 * @param {string} b
 * @param {string} [langA]
 * @param {string} [langB]
 */
export function numbersMatch(a, b, langA, langB) {
  const digitsA = numberFingerprint(a);
  const digitsB = numberFingerprint(b);
  const coverA = new Set([...digitsA, ...numberWordValues(a, langA)]);
  const coverB = new Set([...digitsB, ...numberWordValues(b, langB)]);
  return digitsA.every((n) => coverB.has(n)) && digitsB.every((n) => coverA.has(n));
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
  { re: /\b[A-Za-z]*[a-z][A-Z][A-Za-z]*\b/g, group: 0 }, // PiCCO, IntelliVue, FleetView
  { re: /\b[A-Z][a-z]+-[a-z0-9]\b/g, group: 0 }, // Servo-u, Servo-n
  { re: /\b[A-Z][A-Z0-9]*-[A-Z][A-Z0-9]+\b/g, group: 0 }, // T-DOC, VV-ECMO
  { re: /\(([A-Z][A-Z0-9-]+)\)/g, group: 1 }, // (IABP), (ECMO)
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

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Accepted target-language forms of protected tokens – localised acronyms such as
 * CSSD → AEMP or AI → KI. Config shape: { "<target lang>": { "<token>": ["<form>", …] } };
 * an exact language entry ("de-CH") wins over its base language ("de"). Token keys are
 * case-insensitive; each form must appear in the target as a whole word.
 * @returns {Map<string, RegExp[]>}  lower-cased token → whole-word matchers
 */
export function compileTokenEquivalents(byLanguage, targetLang) {
  const compiled = new Map();
  if (!byLanguage || typeof byLanguage !== 'object') return compiled;
  const lang = String(targetLang ?? '').toLowerCase();
  const entries = Object.entries(byLanguage);
  const forLang = entries.find(([key]) => key.toLowerCase() === lang)?.[1]
    ?? entries.find(([key]) => key.toLowerCase() === lang.split('-')[0])?.[1];
  for (const [token, forms] of Object.entries(forLang ?? {})) {
    const matchers = (Array.isArray(forms) ? forms : [forms])
      .filter((form) => typeof form === 'string' && form.trim())
      .map((form) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(form.trim())}(?![\\p{L}\\p{N}])`, 'u'));
    compiled.set(token.toLowerCase(), matchers);
  }
  return compiled;
}

/**
 * Protected tokens of `source` that do not occur (case-insensitively) in `target`, nor in one of
 * their accepted equivalent forms.
 * @param {Map<string, RegExp[]>} [equivalents]  from compileTokenEquivalents
 * @returns {string[]}
 */
export function missingProtectedTokens(source, target, equivalents) {
  const text = target ?? '';
  const haystack = text.toLowerCase();
  return protectedTokens(source).filter((token) => {
    if (haystack.includes(token.toLowerCase())) return false;
    return !(equivalents?.get(token.toLowerCase()) ?? []).some((re) => re.test(text));
  });
}

// --- Character plausibility ------------------------------------------------------------------
// Letters beyond A–Z that each language uses. Text where most letters fall outside this set is
// not real text in that language – typically pseudo-localised placeholder content ("Å ŉęŵ şŧūđy")
// that was published by mistake.
const LANGUAGE_LETTERS = {
  en: '',
  de: 'äöüßÄÖÜẞ',
  sv: 'åäöéÅÄÖÉ',
  da: 'æøåéÆØÅÉ',
  nb: 'æøåéÆØÅÉ',
  no: 'æøåéÆØÅÉ',
  fi: 'äöåÄÖÅ',
  nl: 'áéíóúàèëïöüÁÉÍÓÚÀÈËÏÖÜ',
  fr: 'àâæçéèêëîïôœùûüÿÀÂÆÇÉÈÊËÎÏÔŒÙÛÜŸ',
  es: 'áéíñóúüÁÉÍÑÓÚÜ',
  it: 'àèéìíîòóùúÀÈÉÌÍÎÒÓÙÚ',
  pt: 'áâãàçéêíóôõúÁÂÃÀÇÉÊÍÓÔÕÚ',
};
const LANGUAGE_LETTER_SETS = Object.fromEntries(Object.entries(LANGUAGE_LETTERS).map(([lang, letters]) => [lang, new Set(letters)]));

/**
 * True when at least `minLetters` letters are present and more than `maxShare` of them are
 * foreign to `lang`. Languages without a letter table (e.g. Polish, Japanese) never trigger.
 */
export function looksGarbled(text, lang, { minLetters = 10, maxShare = 0.25 } = {}) {
  const allowed = LANGUAGE_LETTER_SETS[String(lang ?? '').toLowerCase().split('-')[0]];
  if (!allowed) return false;
  let letters = 0;
  let foreign = 0;
  for (const ch of (text ?? '').normalize('NFC')) {
    if (!/\p{L}/u.test(ch)) continue;
    letters += 1;
    if (!/[A-Za-z]/.test(ch) && !allowed.has(ch)) foreign += 1;
  }
  return letters >= minLetters && foreign / letters > maxShare;
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

/** Function words of a language (empty set for languages without a list). */
export function stopwordsFor(lang) {
  return STOPWORD_SETS[baseLang(lang)] ?? new Set();
}

/**
 * Marks target words that belong to a title-like phrase kept verbatim from the source: a run of
 * consecutive words whose every word pair also occurs in the source, containing at least two
 * capitalised words ("From Culture to Cure – Film ansehen"). Such retained English brand or
 * campaign titles are legitimate inside a translation and must not count as source language.
 * Ordinary sentences copied with small edits are not title-like and stay counted.
 */
function retainedTitleWords(words, sourceText) {
  const keep = new Array(words.length).fill(false);
  if (!sourceText) return keep;
  const src = (sourceText.match(/\p{L}+/gu) ?? []).map((w) => w.toLowerCase());
  const bigrams = new Set(src.slice(1).map((w, i) => `${src[i]} ${w}`));
  let start = 0;
  for (let i = 1; i <= words.length; i += 1) {
    const continues = i < words.length && bigrams.has(`${words[i - 1].toLowerCase()} ${words[i].toLowerCase()}`);
    if (continues) continue;
    const run = words.slice(start, i);
    if (run.length >= 2 && run.filter((w) => /^\p{Lu}/u.test(w)).length >= 2) {
      for (let j = start; j < i; j += 1) keep[j] = true;
    }
    start = i;
  }
  return keep;
}

/**
 * True when `text`, which should be in `targetLang`, reads like `sourceLang` instead.
 * Requires at least two function words that are exclusive to the source language and more of
 * them than target-language function words. Unknown languages never trigger. When `sourceText`
 * is given, title-like phrases retained verbatim from it are ignored.
 */
export function readsAsSourceLanguage(text, sourceLang, targetLang, sourceText) {
  const src = STOPWORD_SETS[baseLang(sourceLang)];
  const tgt = STOPWORD_SETS[baseLang(targetLang)];
  if (!src || !tgt || src === tgt) return false;
  const words = (text ?? '').match(/\p{L}+/gu) ?? [];
  const retained = retainedTitleWords(words, sourceText);
  let srcHits = 0;
  let tgtHits = 0;
  words.forEach((original, i) => {
    if (retained[i]) return;
    const word = original.toLowerCase();
    const inSrc = src.has(word);
    const inTgt = tgt.has(word);
    if (inSrc && !inTgt) srcHits += 1;
    else if (inTgt && !inSrc) tgtHits += 1;
  });
  return srcHits >= 2 && srcHits > tgtHits;
}
