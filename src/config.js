/**
 * Configuration: built-in defaults ← JSON config file ← CLI flags.
 */

import { readFile } from 'node:fs/promises';
import { DEFAULT_BLOCK_SELECTOR, DEFAULT_DYNAMIC_SELECTORS, DEFAULT_NOISE_SELECTORS, compileAnchors } from './extract.js';
import { ALIGNMENT_MODES } from './align.js';
import { DEEPL_MAX_TMX_BYTES, TMX_SEGTYPES } from './tmx-writer.js';
import { normalizeBaseUrl, normalizeUrl } from './url-utils.js';

export const DEFAULT_CONFIG = Object.freeze({
  source: { baseUrl: null, lang: 'en' },
  target: { baseUrl: null, lang: 'de', hreflang: null },
  discovery: {
    sitemapUrl: null,
    followLinks: null, // null = auto: follow links in crawl mode, not in sitemap mode
    order: 'shallow-first', // sitemap URL order: shallow-first | sitemap
    maxPages: 500,
    maxDepth: 6,
    dropQuery: true,
    include: [],
    exclude: [
      '\\.(pdf|jpe?g|png|gif|svg|webp|ico|zip|gz|docx?|xlsx?|pptx?|mp4|mp3|mov|avi|xml|json|txt|css|js)(\\?.*)?$',
      '/search/?$',
    ],
  },
  http: {
    userAgent: 'SiteTmxAligner/1.0 (+localization TM builder; polite crawler)',
    delayMs: 500,
    concurrency: 2,
    timeoutMs: 20000,
    retries: 3,
    backoffBaseMs: 1000,
    maxBodyBytes: 15 * 1024 * 1024,
    respectRobotsTxt: true,
  },
  extraction: {
    contentRoot: 'main, [role="main"]',
    // Elements whose identifier is shared between language versions, innermost wins, e.g.
    // [{ "selector": "[id^=\"block-\"]" }, { "selector": "[data-item-id]", "attribute": "data-item-id", "pattern": "(\\d+)$" }]
    anchors: null,
    // Page-level identity, e.g. { "id": { "selector": "meta[name=\"pageid\"]", "attribute": "content" },
    //   "contentLanguage": { "selector": "meta[name=\"pagecontent\"]", "attribute": "content", "pattern": "..." } }
    pageIdentity: null,
    anchorSelector: null, // legacy single-anchor form
    anchorAttribute: 'id',
    blockSelector: DEFAULT_BLOCK_SELECTOR,
    noiseSelectors: DEFAULT_NOISE_SELECTORS,
    extraNoiseSelectors: [],
    dynamicSelectors: DEFAULT_DYNAMIC_SELECTORS,
    checkHtmlLang: true,
  },
  alignment: {
    mapping: 'auto', // auto | hreflang | path
    mode: 'strict', // strict | path | sequence
    minWords: 4,
    maxWords: 80,
    minLengthRatio: 0.5,
    maxLengthRatio: 2.5,
    minWordsByTag: {}, // e.g. { "h1": 1, "h2": 1, "h3": 1 } to keep short headings
    lengthRatioMinWords: 4,
    requireNumberMatch: true,
    requireProtectedTokens: true,
    checkTargetLanguage: true,
    requireSameStructure: true, // drop a block's pairs when its tag sequence differs between languages
    checkCharacters: true, // drop pseudo-localised / garbled text
    // Localised forms of protected tokens per target language, e.g. { "de": { "CSSD": ["AEMP"] } }
    tokenEquivalents: {},
    // Known mis-pairings to leave out: [{ "source": "…", "target": "…", "note": "…" }]; omit target to drop any translation
    suppressPairs: [],
    // Same source, different translations: on a tie the first is kept only if the variants are this similar (0–1)
    minVariantSimilarity: 0.4,
    allowTargetRedirects: false,
  },
  output: {
    file: null, // default: output/<src>-<tgt>.tmx
    reportFile: null, // default: output/<src>-<tgt>.report.json
    segtype: 'sentence',
    oTmf: 'UTF-8',
    adminLang: 'en',
    dataType: 'plaintext',
    includeProvenance: true,
    rejectedSamplesPerReason: 50,
    maxBytes: DEEPL_MAX_TMX_BYTES,
  },
  logging: { level: 'info', json: false },
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Deep merge where arrays and scalars from `override` replace those in `base`; undefined is ignored. */
export function deepMerge(base, override) {
  if (!isPlainObject(override)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? deepMerge(result[key], value) : structuredClone(value);
  }
  return result;
}

export async function loadConfigFile(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read config file "${path}": ${error.message}`, { cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Config file "${path}" is not valid JSON: ${error.message}`, { cause: error });
  }
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

function isLangCode(value) {
  return typeof value === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value);
}

/**
 * Merges and validates configuration layers. Throws one error listing every problem.
 * @param {...object} layers  later layers win
 */
export function resolveConfig(...layers) {
  const merged = layers.reduce((acc, layer) => deepMerge(acc, layer ?? {}), DEFAULT_CONFIG);
  const errors = [];
  const { source, target, discovery, http, extraction, alignment, output } = merged;

  assert(source.baseUrl, 'source.baseUrl is required (e.g. https://www.getinge.com/int/)', errors);
  assert(target.baseUrl, 'target.baseUrl is required (e.g. https://www.getinge.com/de/)', errors);
  for (const [label, side] of [['source', source], ['target', target]]) {
    if (side.baseUrl) {
      try {
        side.baseUrl = normalizeBaseUrl(side.baseUrl);
      } catch (error) {
        errors.push(`${label}.baseUrl: ${error.message}`);
      }
    }
    assert(isLangCode(side.lang), `${label}.lang must be a language code like "en" or "de-DE" (got "${side.lang}")`, errors);
  }
  if (source.baseUrl && target.baseUrl) {
    assert(source.baseUrl !== target.baseUrl, 'source.baseUrl and target.baseUrl must differ', errors);
  }
  if (source.lang && target.lang) {
    assert(source.lang.toLowerCase() !== target.lang.toLowerCase(), 'source.lang and target.lang must differ', errors);
  }

  if (discovery.sitemapUrl && discovery.sitemapUrl !== 'auto') {
    const normalized = normalizeUrl(discovery.sitemapUrl, { dropQuery: false });
    assert(normalized, `discovery.sitemapUrl is not a valid URL: "${discovery.sitemapUrl}"`, errors);
    if (normalized) discovery.sitemapUrl = normalized;
  }
  assert(Number.isInteger(discovery.maxPages) && discovery.maxPages > 0, 'discovery.maxPages must be a positive integer', errors);
  assert(Number.isInteger(discovery.maxDepth) && discovery.maxDepth >= 0, 'discovery.maxDepth must be an integer >= 0', errors);
  assert(Array.isArray(discovery.include) && Array.isArray(discovery.exclude), 'discovery.include/exclude must be arrays', errors);
  assert(['shallow-first', 'sitemap'].includes(discovery.order), 'discovery.order must be shallow-first or sitemap', errors);

  assert(typeof http.userAgent === 'string' && http.userAgent.trim().length >= 8, 'http.userAgent must be a descriptive string', errors);
  assert(Number.isFinite(http.delayMs) && http.delayMs >= 0, 'http.delayMs must be >= 0', errors);
  assert(Number.isInteger(http.concurrency) && http.concurrency >= 1 && http.concurrency <= 16, 'http.concurrency must be 1–16', errors);
  assert(Number.isFinite(http.timeoutMs) && http.timeoutMs >= 1000, 'http.timeoutMs must be >= 1000', errors);
  assert(Number.isInteger(http.retries) && http.retries >= 0 && http.retries <= 10, 'http.retries must be 0–10', errors);

  extraction.noiseSelectors = [...extraction.noiseSelectors, ...(extraction.extraNoiseSelectors ?? [])];
  if (extraction.anchors !== null && !Array.isArray(extraction.anchors)) {
    errors.push('extraction.anchors must be an array of { selector, attribute?, pattern? }');
  } else {
    try {
      compileAnchors(extraction.anchors, extraction.anchorSelector, extraction.anchorAttribute);
    } catch (error) {
      errors.push(`extraction.${error.message}`);
    }
  }

  assert(ALIGNMENT_MODES.includes(alignment.mode), `alignment.mode must be one of ${ALIGNMENT_MODES.join(', ')}`, errors);
  assert(['auto', 'hreflang', 'path'].includes(alignment.mapping), 'alignment.mapping must be auto, hreflang or path', errors);
  assert(Number.isInteger(alignment.minWords) && alignment.minWords >= 1, 'alignment.minWords must be >= 1', errors);
  assert(Number.isInteger(alignment.maxWords) && alignment.maxWords >= alignment.minWords, 'alignment.maxWords must be >= minWords', errors);
  assert(alignment.minLengthRatio > 0 && alignment.maxLengthRatio > alignment.minLengthRatio, 'alignment length ratios are invalid', errors);
  assert(
    alignment.minWordsByTag !== null && typeof alignment.minWordsByTag === 'object' && !Array.isArray(alignment.minWordsByTag)
      && Object.values(alignment.minWordsByTag).every((n) => Number.isInteger(n) && n >= 1),
    'alignment.minWordsByTag must map tag names to integers >= 1',
    errors,
  );
  assert(Number.isInteger(alignment.lengthRatioMinWords) && alignment.lengthRatioMinWords >= 1, 'alignment.lengthRatioMinWords must be an integer >= 1', errors);
  for (const key of ['requireNumberMatch', 'requireProtectedTokens', 'checkTargetLanguage', 'requireSameStructure', 'checkCharacters']) {
    assert(typeof alignment[key] === 'boolean', `alignment.${key} must be true or false`, errors);
  }
  assert(
    isPlainObject(alignment.tokenEquivalents)
      && Object.values(alignment.tokenEquivalents).every((forLang) => isPlainObject(forLang)
        && Object.values(forLang).every((forms) => Array.isArray(forms) && forms.every((f) => typeof f === 'string' && f.trim()))),
    'alignment.tokenEquivalents must look like { "de": { "CSSD": ["AEMP"] } }',
    errors,
  );
  assert(
    Array.isArray(alignment.suppressPairs) && alignment.suppressPairs.every((entry) => isPlainObject(entry)
      && typeof entry.source === 'string' && entry.source.trim()
      && (entry.target === undefined || typeof entry.target === 'string')),
    'alignment.suppressPairs must be a list of { "source": "…", "target": "…" } (target optional)',
    errors,
  );
  assert(Number.isFinite(alignment.minVariantSimilarity) && alignment.minVariantSimilarity >= 0 && alignment.minVariantSimilarity <= 1,
    'alignment.minVariantSimilarity must be between 0 and 1', errors);

  const identity = extraction.pageIdentity;
  if (identity !== null) {
    if (typeof identity !== 'object' || Array.isArray(identity)) {
      errors.push('extraction.pageIdentity must be an object with "id" and/or "contentLanguage"');
    } else {
      for (const key of ['id', 'contentLanguage']) {
        const def = identity[key];
        if (def !== undefined && (typeof def?.selector !== 'string' || !def.selector.trim())) {
          errors.push(`extraction.pageIdentity.${key}.selector must be a CSS selector`);
        }
      }
      if (identity.contentLanguage?.pattern) {
        try {
          new RegExp(identity.contentLanguage.pattern, 'i');
        } catch (error) {
          errors.push(`extraction.pageIdentity.contentLanguage.pattern is invalid: ${error.message}`);
        }
      }
    }
  }
  assert(Number.isInteger(output.rejectedSamplesPerReason) && output.rejectedSamplesPerReason >= 0,
    'output.rejectedSamplesPerReason must be an integer >= 0', errors);

  assert(TMX_SEGTYPES.includes(output.segtype), `output.segtype must be one of ${TMX_SEGTYPES.join(', ')}`, errors);
  assert(Number.isFinite(output.maxBytes) && output.maxBytes > 0, 'output.maxBytes must be > 0', errors);
  const stem = `output/${source.lang}-${target.lang}`;
  output.file ??= `${stem}.tmx`;
  output.reportFile ??= `${stem}.report.json`;

  if (errors.length) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);
  }
  return merged;
}
