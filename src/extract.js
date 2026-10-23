/**
 * DOM parsing and segment extraction with cheerio.
 *
 * Each extracted block carries two structural keys used for alignment:
 *   path        tag[i]/tag[i]/…        index among same-tag siblings at every level
 *   strictPath  tag[i:n]/tag[i:n]/…    additionally the number of same-tag siblings, so an
 *                                       extra paragraph/section on one page can never shift
 *                                       later blocks into a wrong pairing
 */

import * as cheerio from 'cheerio';
import { normalizeText } from './text.js';

/** Elements that never contain translatable page copy. Always removed. */
const ALWAYS_REMOVE = [
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'canvas',
  'head', '[hidden]', '[aria-hidden="true"]',
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

/**
 * @typedef {object} Block
 * @property {number} index      order of appearance on the page
 * @property {string} tag
 * @property {string} path
 * @property {string} strictPath
 * @property {string} text       normalised text
 */

/**
 * @param {string} html
 * @param {object} [options]
 * @param {string} [options.baseUrl]            used to resolve relative links / alternates
 * @param {string} [options.contentRoot]        CSS selector of the main content container; falls back to <body>
 * @param {string} [options.blockSelector]
 * @param {string[]} [options.noiseSelectors]
 * @param {string[]} [options.dynamicSelectors]
 * @param {(selector: string, error: Error) => void} [options.onInvalidSelector]
 * @returns {{ lang: string, title: string, canonical: string | null,
 *   alternates: { hreflang: string, href: string }[], links: string[], blocks: Block[] }}
 */
export function extractPage(html, {
  baseUrl,
  contentRoot = 'main, [role="main"]',
  blockSelector = DEFAULT_BLOCK_SELECTOR,
  noiseSelectors = DEFAULT_NOISE_SELECTORS,
  dynamicSelectors = DEFAULT_DYNAMIC_SELECTORS,
  onInvalidSelector,
} = {}) {
  const $ = cheerio.load(html, { baseURI: baseUrl });

  const lang = ($('html').attr('lang') ?? $('html').attr('xml:lang') ?? '').trim();
  const title = normalizeText($('title').first().text());
  const canonical = $('link[rel="canonical"]').attr('href') ?? null;

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

  const rootCandidates = contentRoot ? safeSelect($, null, contentRoot, onInvalidSelector) : $([]);
  const root = rootCandidates.length ? rootCandidates.first() : $('body');
  const rootNode = root.get(0);

  const blocks = [];
  if (rootNode) {
    root.find(blockSelector).each((_, el) => {
      // Keep only the innermost matches: <li><p>…</p></li> yields the <p>, not both.
      if ($(el).find(blockSelector).length > 0) return;
      const text = normalizeText($(el).text());
      if (!text) return;
      const { path, strictPath } = structuralPaths(el, rootNode);
      blocks.push({ index: blocks.length, tag: elementName(el), path, strictPath, text });
    });
  }

  return { lang, title, canonical, alternates, links, blocks };
}
