/**
 * DOM parsing and segment extraction with cheerio.
 *
 * Each extracted block carries a scope and two structural paths used for alignment:
 *   scope       the CMS block it belongs to (value of the anchor attribute, e.g. "block-3945")
 *               when an anchorSelector is configured, otherwise "@<root index>"
 *   path        tag[i]/tag[i]/…        index among same-tag siblings, relative to the scope
 *   strictPath  tag[i:n]/tag[i:n]/…    additionally the number of same-tag siblings, so an
 *                                       extra paragraph/section on one page can never shift
 *                                       later blocks into a wrong pairing
 *
 * Anchors make alignment robust against pages whose blocks are re-ordered, or where one
 * language has extra blocks: CMSs such as Optimizely give a block the same id in every
 * language, so pairing happens block-to-block instead of by global page position.
 */

import * as cheerio from 'cheerio';
import { normalizeText } from './text.js';

/**
 * Elements that never contain translatable page copy. Always removed.
 * Note: the HTML `hidden` attribute is deliberately NOT in this list - CMSs render collapsed
 * accordion and tab panels with `hidden`, and their text is genuine page content.
 */
const ALWAYS_REMOVE = [
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'canvas',
  'head', '[aria-hidden="true"]',
];

/**
 * Global site chrome removed as whole subtrees before extraction:
 * navigation, language/region selectors, cookie & consent banners, global footer/legal blocks.
 */
export const DEFAULT_NOISE_SELECTORS = [
  // Navigation and site chrome
  'nav', '[role="navigation"]', '[role="banner"]', '[role="search"]',
  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
  '[class*="breadcrumb" i]', '[class*="skip-link" i]', '.sr-only', '.visually-hidden',
  // Language / country / region selectors
  '[class*="language" i]', '[id*="language" i]', '[class*="lang-switch" i]', '[class*="lang-select" i]',
  '[class*="locale" i]', '[class*="country-select" i]', '[class*="region-select" i]',
  '[class*="market-select" i]', '[class*="site-select" i]',
  // Cookie & consent banners (generic + OneTrust, Cookiebot, Usercentrics, Osano)
  '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
  '#onetrust-consent-sdk', '#CybotCookiebotDialog', '#usercentrics-root', '.osano-cm-window',
  // Global footer and legal disclaimers
  'footer', '[role="contentinfo"]', '[class*="footer" i]', '[id*="footer" i]', '[class*="disclaimer" i]',
  // Social / share widgets
  '[class*="social-share" i]', '[class*="share-buttons" i]', '[class*="sharing" i]',
];

/**
 * Dynamic widgets (live clocks, countdowns, event counters, tickers). When one of these sits
 * inside a text block, the *whole block* is dropped: removing only the widget would leave a
 * truncated sentence ("The event starts on  in Berlin") that pollutes the TM.
 */
export const DEFAULT_DYNAMIC_SELECTORS = [
  'time', '[aria-live]', '[role="timer"]', '[role="marquee"]', '[role="status"]',
  '[class*="clock" i]', '[class*="countdown" i]', '[class*="ticker" i]', '[class*="counter" i]',
  '[class*="event-count" i]', '[class*="eventcount" i]', '[data-countdown]', '[data-counter]',
];

export const DEFAULT_BLOCK_SELECTOR = 'h1, h2, h3, p, li';

const BLOCK_LEVEL = [
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'ol', 'p', 'pre',
  'section', 'table', 'td', 'th', 'tr', 'ul', 'button', 'label', 'option',
].join(', ');

function safeSelect($, scope, selector, onInvalid) {
  try {
    return scope ? $(scope).find(selector) : $(selector);
  } catch (error) {
    onInvalid?.(selector, error);
    return $([]);
  }
}

function elementName(node) {
  return typeof node?.name === 'string' ? node.name.toLowerCase() : null;
}

function structuralPaths(node, root) {
  const loose = [];
  const strict = [];
  let current = node;
  while (current && current !== root && elementName(current)) {
    const tag = elementName(current);
    let index = 0;
    for (let sib = current.prev; sib; sib = sib.prev) if (elementName(sib) === tag) index += 1;
    let total = index + 1;
    for (let sib = current.next; sib; sib = sib.next) if (elementName(sib) === tag) total += 1;
    loose.push(`${tag}[${index}]`);
    strict.push(`${tag}[${index}:${total}]`);
    current = current.parent;
  }
  return { path: loose.reverse().join('/'), strictPath: strict.reverse().join('/') };
}

function isAncestor(ancestor, node) {
  for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

/**
 * @typedef {object} AnchorDefinition
 * @property {string} selector        CSS selector of elements that identify content across languages
 * @property {string} [attribute='id'] attribute holding the identifier
 * @property {string} [pattern]       regular expression; its first capture group (or whole match)
 *                                    is the language-independent part, e.g. "(\\d+)$" turns
 *                                    "pulsiocare-1851545" and "pulsiocare-de-1851545" into 1851545
 */

/**
 * Normalises anchor options: an explicit `anchors` list wins, otherwise the legacy single
 * `anchorSelector`/`anchorAttribute` pair is used. Patterns are compiled once.
 */
export function compileAnchors(anchors, anchorSelector, anchorAttribute = 'id') {
  const defs = Array.isArray(anchors) && anchors.length
    ? anchors
    : anchorSelector ? [{ selector: anchorSelector, attribute: anchorAttribute }] : [];
  return defs.map((def, i) => {
    if (!def || typeof def.selector !== 'string' || !def.selector.trim()) {
      throw new Error(`anchors[${i}].selector must be a non-empty CSS selector`);
    }
    let pattern = null;
    if (def.pattern) {
      try {
        pattern = new RegExp(def.pattern);
      } catch (error) {
        throw new Error(`anchors[${i}].pattern is not a valid regular expression: ${error.message}`, { cause: error });
      }
    }
    return { selector: def.selector, attribute: def.attribute ?? 'id', pattern };
  });
}

const patternCache = new Map();
function cachedPattern(source) {
  if (!patternCache.has(source)) patternCache.set(source, new RegExp(source, 'i'));
  return patternCache.get(source);
}

/**
 * @typedef {object} PageIdentityOptions
 * @property {{ selector: string, attribute?: string }} [id]   element holding a page id shared by all
 *           language versions, e.g. { selector: 'meta[name="pageid"]', attribute: 'content' }
 * @property {{ selector: string, attribute?: string, pattern?: string }} [contentLanguage] element
 *           revealing which language version the CMS actually rendered; `pattern`'s first group
 *           is the language code, e.g. "_([a-z]{2}(?:-[a-z]{2,4})?)_\\d+$" for "produkte_picco_de_10654"
 * @property {boolean} [required=false]  skip pages where the id is missing on either side
 */

/**
 * Reads page-level identity metadata. Must run before the <head> is stripped.
 * @param {import('cheerio').CheerioAPI} $
 * @param {PageIdentityOptions | null} identity
 * @returns {{ pageId: string | null, contentLanguage: string | null }}
 */
function readPageIdentity($, identity) {
  const read = (def) => {
    if (!def?.selector) return null;
    try {
      const el = $(def.selector).first();
      if (!el.length) return null;
      const value = (def.attribute ? el.attr(def.attribute) : el.text())?.trim();
      return value || null;
    } catch {
      return null;
    }
  };
  const pageId = read(identity?.id);
  let contentLanguage = read(identity?.contentLanguage);
  if (contentLanguage && identity.contentLanguage.pattern) {
    const match = cachedPattern(identity.contentLanguage.pattern).exec(contentLanguage);
    contentLanguage = match ? (match[1] ?? match[0]) : null;
  }
  return { pageId, contentLanguage };
}

function anchorKeyFor(value, def) {
  if (!value) return null;
  if (!def.pattern) return value;
  const match = def.pattern.exec(value);
  if (!match) return null;
  // Namespaced by attribute, so ids from different anchor types can never collide.
  return `${def.attribute}=${match[1] ?? match[0]}`;
}

/**
 * @typedef {object} Block
 * @property {number} index      order of appearance on the page
 * @property {string} tag
 * @property {string} scope      anchor key ("block-3945") or root key ("@0")
 * @property {string} path       relative to the scope element
 * @property {string} strictPath relative to the scope element
 * @property {string} text       normalised text
 */

/**
 * @param {string} html
 * @param {object} [options]
 * @param {string} [options.baseUrl]            used to resolve relative links / alternates
 * @param {string} [options.contentRoot]        CSS selector of the content container(s). Every outermost
 *                                              match is used, in document order (e.g. a hero banner that
 *                                              sits outside <main> plus <main>); falls back to <body>
 * @param {AnchorDefinition[]} [options.anchors] elements whose identifier is shared between language
 *                                              versions (CMS blocks, list items); the innermost anchor
 *                                              around a text block becomes its scope
 * @param {PageIdentityOptions|null} [options.pageIdentity] page-level id / content-language metadata
 * @param {string|null} [options.anchorSelector] legacy single-anchor form of `anchors`
 * @param {string} [options.anchorAttribute='id']
 * @param {string} [options.blockSelector]
 * @param {string[]} [options.noiseSelectors]
 * @param {string[]} [options.dynamicSelectors]
 * @param {(selector: string, error: Error) => void} [options.onInvalidSelector]
 * @returns {{ lang: string, title: string, canonical: string | null, pageId: string | null,
 *   contentLanguage: string | null, alternates: { hreflang: string, href: string }[],
 *   links: string[], blocks: Block[] }}
 */
export function extractPage(html, {
  baseUrl,
  contentRoot = 'main, [role="main"]',
  anchors = null,
  pageIdentity = null,
  anchorSelector = null,
  anchorAttribute = 'id',
  blockSelector = DEFAULT_BLOCK_SELECTOR,
  noiseSelectors = DEFAULT_NOISE_SELECTORS,
  dynamicSelectors = DEFAULT_DYNAMIC_SELECTORS,
  onInvalidSelector,
} = {}) {
  const $ = cheerio.load(html, { baseURI: baseUrl });

  const lang = ($('html').attr('lang') ?? $('html').attr('xml:lang') ?? '').trim();
  const title = normalizeText($('title').first().text());
  const canonical = $('link[rel="canonical"]').attr('href') ?? null;
  const { pageId, contentLanguage } = readPageIdentity($, pageIdentity);

  const alternates = [];
  $('link[rel="alternate"][hreflang][href]').each((_, el) => {
    alternates.push({ hreflang: $(el).attr('hreflang').trim(), href: $(el).attr('href').trim() });
  });

  // Links are harvested from the full document *before* stripping chrome: menus and footers
  // are the best source of URLs for the recursive crawler.
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) links.push(href);
  });

  // --- Clean the DOM ---------------------------------------------------------------------
  for (const selector of ALWAYS_REMOVE) safeSelect($, null, selector, onInvalidSelector).remove();
  for (const selector of noiseSelectors) safeSelect($, null, selector, onInvalidSelector).remove();
  for (const selector of dynamicSelectors) {
    safeSelect($, null, selector, onInvalidSelector).each((_, el) => {
      const block = $(el).closest(blockSelector);
      (block.length ? block : $(el)).remove();
    });
  }

  // <br> and block boundaries become spaces so "<li><div>A</div><div>B</div></li>" → "A B".
  $('br').replaceWith(' ');
  $(BLOCK_LEVEL).after(' ');

  // --- Content roots: every outermost match, in document order ------------------------------
  const candidates = contentRoot ? safeSelect($, null, contentRoot, onInvalidSelector).toArray() : [];
  let roots = candidates.filter((node) => !candidates.some((other) => other !== node && isAncestor(other, node)));
  if (!roots.length) roots = $('body').toArray();

  // --- Anchors: identifiers shared between language versions ---------------------------------
  // The first matching definition wins for an element; a key seen twice on one page (the same
  // block or product used twice) gets an occurrence suffix so it stays unique.
  const anchorKeys = new Map();
  const occurrences = new Map();
  for (const def of compileAnchors(anchors, anchorSelector, anchorAttribute)) {
    safeSelect($, null, def.selector, onInvalidSelector).each((_, el) => {
      if (anchorKeys.has(el)) return;
      const key = anchorKeyFor($(el).attr(def.attribute), def);
      if (!key) return;
      const n = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, n);
      anchorKeys.set(el, n === 1 ? key : `${key}#${n}`);
    });
  }

  const blocks = [];
  roots.forEach((rootNode, rootIndex) => {
    $(rootNode).find(blockSelector).each((_, el) => {
      // Keep only the innermost matches: <li><p>…</p></li> yields the <p>, not both.
      if ($(el).find(blockSelector).length > 0) return;
      const text = normalizeText($(el).text());
      if (!text) return;

      let scopeNode = rootNode;
      let scope = `@${rootIndex}`;
      if (anchorKeys.size) {
        for (let node = el; node && node !== rootNode; node = node.parent) {
          const key = anchorKeys.get(node);
          if (key) {
            scopeNode = node;
            scope = key;
            break;
          }
        }
      }
      const { path, strictPath } = structuralPaths(el, scopeNode);
      blocks.push({ index: blocks.length, tag: elementName(el), scope, path, strictPath, text });
    });
  });

  return { lang, title, canonical, pageId, contentLanguage, alternates, links, blocks };
}
