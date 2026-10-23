/**
 * URL normalisation, scoping and source → target mapping.
 */

const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|_ga|_gl|ref)$/i;

/**
 * Parses and canonicalises a URL. Returns null for anything that is not a crawlable http(s) URL.
 * - resolves relative references against `base`
 * - drops the fragment
 * - drops the whole query string (`dropQuery`, default) or only tracking parameters
 * @param {string} input
 * @param {{ base?: string, dropQuery?: boolean }} [options]
 * @returns {string | null}
 */
export function normalizeUrl(input, { base, dropQuery = true } = {}) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const raw = input.trim();
  if (/^(mailto|tel|javascript|data|ftp|sms|whatsapp):/i.test(raw)) return null;

  let url;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  if (dropQuery) {
    url.search = '';
  } else {
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
  }
  return url.toString();
}

/**
 * Normalises a base URL so that prefix checks are unambiguous ("…/int" → "…/int/").
 * @param {string} value
 */
export function normalizeBaseUrl(value) {
  const normalized = normalizeUrl(value, { dropQuery: true });
  if (!normalized) throw new Error(`Invalid base URL: "${value}"`);
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

/**
 * True when `url` is the base itself or lives underneath it.
 * @param {string} url  normalised URL
 * @param {string} base normalised base URL ending in "/"
 */
export function isUnderBase(url, base) {
  return url.startsWith(base) || `${url}/` === base;
}

/**
 * Structural mirroring: swaps the source base prefix for the target base prefix.
 * https://www.getinge.com/int/a/b/ → https://www.getinge.com/de/a/b/
 * @returns {string | null} null when the URL is outside the source base
 */
export function mapByBase(sourceUrl, sourceBase, targetBase) {
  if (!isUnderBase(sourceUrl, sourceBase)) return null;
  const remainder = sourceUrl.length >= sourceBase.length ? sourceUrl.slice(sourceBase.length) : '';
  return `${targetBase}${remainder}`;
}

/**
 * Compares two URLs as "the same document": ignores trailing slash and path case
 * (many CMSs, e.g. Optimizely/EPiServer, route case-insensitively).
 */
export function isSameDocument(a, b) {
  const key = (value) => {
    try {
      const u = new URL(value);
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '').toLowerCase()}${u.search}`;
    } catch {
      return value;
    }
  };
  return key(a) === key(b);
}

/**
 * Compiles user-supplied pattern strings into case-insensitive regular expressions.
 * @param {string[]} patterns
 * @param {string} label used in error messages
 */
export function compilePatterns(patterns = [], label = 'pattern') {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, 'i');
    } catch (error) {
      throw new Error(`Invalid ${label} regular expression "${pattern}": ${error.message}`, { cause: error });
    }
  });
}

/**
 * Applies include/exclude filters to a URL.
 * @param {string} url
 * @param {{ include: RegExp[], exclude: RegExp[] }} filters
 */
export function passesFilters(url, { include = [], exclude = [] }) {
  if (exclude.some((re) => re.test(url))) return false;
  if (include.length && !include.some((re) => re.test(url))) return false;
  return true;
}

/**
 * True when a hreflang value denotes the wanted language ("de" matches "de", "de-DE", "de-at").
 * @param {string} hreflang
 * @param {string} lang
 */
export function hreflangMatches(hreflang, lang) {
  const h = (hreflang ?? '').toLowerCase();
  const l = (lang ?? '').toLowerCase();
  return h === l || h.startsWith(`${l}-`) || l.startsWith(`${h}-`);
}
