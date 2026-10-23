/**
 * A small mirrored EN (/int/) / DE (/de/) website served from 127.0.0.1 for integration tests.
 * It contains every edge case the crawler must survive: site chrome, cookie banner, language
 * selector, live widgets, a 404 target, a redirecting target, a robots-disallowed page, an
 * untranslated fallback page, localised slugs (page-level and sitemap-level hreflang), a
 * structurally divergent page, a transient 503, special XML characters and a control character.
 */

import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const BELL = String.fromCharCode(7);

const LONG_EN = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} of the long legal style paragraph.`).join(' ');
const LONG_DE = Array.from({ length: 12 }, (_, i) => `Satz Nummer ${i + 1} des langen juristischen Absatzes hier.`).join(' ');

const NAV_EN = `
  <nav><ul>
    <li><a href="/int/">Home</a></li>
    <li><a href="/int/about/">About</a></li>
    <li><a href="/int/products/">Products</a></li>
    <li><a href="/int/missing/">Missing</a></li>
    <li><a href="/int/moved/">Moved</a></li>
    <li><a href="/int/private/secret/">Private</a></li>
    <li><a href="/int/localized/#top">Localized</a></li>
    <li><a href="/int/fallback/?utm_source=nav">Fallback</a></li>
    <li><a href="/int/brochure.pdf">Brochure</a></li>
    <li><a href="https://external.example.com/int/">External</a></li>
    <li><a href="mailto:info@example.com">Mail</a></li>
  </ul></nav>`;

const NAV_DE = `
  <nav><ul>
    <li><a href="/de/">Startseite</a></li>
    <li><a href="/de/about/">Über uns</a></li>
  </ul></nav>`;

function layout({ lang, title, head = '', nav, main }) {
  const de = lang.startsWith('de');
  return `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><title>${title}</title>${head}</head>
<body>
  <div id="onetrust-consent-sdk"><p>${de
    ? 'Wir verwenden Cookies, um Ihre Erfahrung auf unserer Website zu verbessern.'
    : 'We use cookies to improve your experience on our website.'}</p></div>
  <header role="banner">
    ${nav}
    <div class="language-selector"><ul>
      <li><a href="/int/">International English language selector entry</a></li>
      <li><a href="/de/">Deutschland Deutsch Auswahl der Sprache hier</a></li>
    </ul></div>
  </header>
  <main>${main}</main>
  <footer><p>${de
    ? 'Diese Informationen richten sich ausschließlich an medizinische Fachkräfte und dienen nur zu Informationszwecken.'
    : 'This information is aimed exclusively at healthcare professionals and is for informational purposes only.'}</p></footer>
</body>
</html>`;
}

const PAGES = {
  // ---------------------------------------------------------------- home
  '/int/': {
    title: 'Home',
    main: `
      <section>
        <h1>Passion for life in every hospital</h1>
        <p>We help healthcare professionals save lives with reliable medical technology.</p>
      </section>
      <section class="events">
        <h2>Upcoming events this autumn</h2>
        <p>Next event starts in <span class="countdown">3 days</span> at the congress centre.</p>
        <p>Local time <time>11:21</time> in Gothenburg today right now.</p>
        <div aria-live="polite">Currently 12 events are listed in the calendar overview.</div>
      </section>
      <section>
        <h2>Fish &amp; Chips &lt;tasty&gt; "quoted" 'single' special characters</h2>
        <p><a href="/int/about/">Read more</a></p>
        <p>Servo-air Lite NIV ventilator product family</p>
        <p>Contact our sales team for more information today.</p>
      </section>`,
  },
  '/de/': {
    title: 'Startseite',
    main: `
      <section>
        <h1>Leidenschaft für das Leben in jedem Krankenhaus</h1>
        <p>Wir helfen medizinischen Fachkräften, mit zuverlässiger Medizintechnik Leben zu retten.</p>
      </section>
      <section class="events">
        <h2>Kommende Veranstaltungen in diesem Herbst</h2>
        <p>Die nächste Veranstaltung beginnt in <span class="countdown">3 Tagen</span> im Kongresszentrum.</p>
        <p>Ortszeit <time>11:21</time> heute in Göteborg genau jetzt.</p>
        <div aria-live="polite">Derzeit sind 12 Veranstaltungen im Kalender aufgeführt.</div>
      </section>
      <section>
        <h2>Fisch &amp; Pommes &lt;lecker&gt; „zitiert“ 'einfach' Sonderzeichen</h2>
        <p><a href="/de/about/">Mehr lesen</a></p>
        <p>Servo-air Lite NIV ventilator product family</p>
        <p>Kontaktieren Sie unser Vertriebsteam noch heute für weitere Informationen.</p>
      </section>`,
  },

  // ---------------------------------------------------------------- about
  '/int/about/': {
    title: 'About',
    main: `
      <h1>About our company and its history</h1>
      <p>Founded in 1904, the company now employs more than 10,000 people worldwide.</p>
      <p>Our headquarters are located in Gothenburg, Sweden, close to the sea.</p>
      <ul>
        <li>Over 120 years of experience in medical technology</li>
        <li>Sales and service in more than 135 countries</li>
      </ul>
      <p>Contact our sales team for more information today.</p>
      <p>We operate 25 production sites across three continents.</p>
      <p>${LONG_EN}</p>
      <p>Quality${BELL} assured products and services for every patient.</p>`,
  },
  '/de/about/': {
    title: 'Über uns',
    main: `
      <h1>Über unser Unternehmen und seine Geschichte</h1>
      <p>Das 1904 gegründete Unternehmen beschäftigt heute weltweit mehr als 10.000 Mitarbeitende.</p>
      <p>Unser Hauptsitz befindet sich in Göteborg, Schweden, direkt am Meer.</p>
      <ul>
        <li>Über 120 Jahre Erfahrung in der Medizintechnik</li>
        <li>Vertrieb und Service in mehr als 135 Ländern</li>
      </ul>
      <p>Kontaktieren Sie unser Vertriebsteam noch heute für weitere Informationen.</p>
      <p>Wir betreiben 26 Produktionsstätten auf drei Kontinenten.</p>
      <p>${LONG_DE}</p>
      <p>Qualitätsgesicherte${BELL} Produkte und Dienstleistungen für jeden Patienten.</p>`,
  },

  // ---------------------------------------------------------------- products (DE has an extra section)
  '/int/products/': {
    title: 'Products',
    main: `
      <section><h2>Intensive care ventilation solutions</h2>
        <p>Ventilators for adults, children and neonatal patients in intensive care.</p></section>
      <section><h2>Operating room equipment and integration</h2>
        <p>Surgical tables, lights and integration systems for modern operating rooms.</p></section>`,
  },
  '/de/products/': {
    title: 'Produkte',
    main: `
      <section><p>Dieser Hinweis erscheint nur auf der deutschen Seite.</p></section>
      <section><h2>Beatmungslösungen für die Intensivpflege</h2>
        <p>Beatmungsgeräte für Erwachsene, Kinder und Neugeborene in der Intensivpflege.</p></section>
      <section><h2>Ausstattung und Integration für den Operationssaal</h2>
        <p>OP-Tische, Leuchten und Integrationssysteme für moderne Operationssäle.</p></section>`,
  },

  // ---------------------------------------------------------------- missing target (DE 404)
  '/int/missing/': {
    title: 'Missing',
    main: '<p>This page only exists in the English version of the site.</p>',
  },

  // ---------------------------------------------------------------- target redirects to DE home
  '/int/moved/': {
    title: 'Moved',
    main: '<p>The German version of this page redirects to the start page.</p>',
  },

  // ---------------------------------------------------------------- disallowed by robots.txt
  '/int/private/secret/': {
    title: 'Secret',
    main: '<p>This page must never be fetched by a polite crawler.</p>',
  },
  '/de/private/secret/': {
    title: 'Geheim',
    main: '<p>Diese Seite darf niemals von einem höflichen Crawler abgerufen werden.</p>',
  },

  // ---------------------------------------------------------------- localised slug via page hreflang
  '/int/localized/': {
    title: 'Localized',
    head: '<link rel="alternate" hreflang="de-DE" href="/de/lokalisiert/"><link rel="alternate" hreflang="en" href="/int/localized/">',
    main: `
      <h2>Localized URL slugs are supported</h2>
      <p>This page is found through its hreflang alternate link.</p>`,
  },
  '/de/lokalisiert/': {
    title: 'Lokalisiert',
    main: `
      <h2>Lokalisierte URL-Pfade werden unterstützt</h2>
      <p>Diese Seite wird über ihren hreflang-Alternativlink gefunden.</p>`,
  },

  // ---------------------------------------------------------------- localised slug via sitemap hreflang
  '/int/localized2/': {
    title: 'Localized 2',
    main: `
      <h2>Sitemap alternates map localized slugs</h2>
      <p>This page is mapped through the sitemap hreflang annotation.</p>`,
  },
  '/de/lokalisiert-zwei/': {
    title: 'Lokalisiert 2',
    main: `
      <h2>Sitemap-Alternativen ordnen lokalisierte Pfade zu</h2>
      <p>Diese Seite wird über die hreflang-Angabe der Sitemap zugeordnet.</p>`,
  },

  // ---------------------------------------------------------------- DE page is an untranslated English fallback
  '/int/fallback/': {
    title: 'Fallback',
    main: '<p>This page has not been translated into German yet.</p>',
  },
  '/de/fallback/': {
    title: 'Fallback',
    lang: 'en',
    main: '<p>This page has not been translated into German yet.</p>',
  },
};

function sitemapIndex(base) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${base}/sitemap-int.xml</loc></sitemap>
  <sitemap><loc>${base}/sitemap-de.xml</loc></sitemap>
  <sitemap><loc>${base}/sitemap-extra.xml.gz</loc></sitemap>
  <sitemap><loc>${base}/sitemap-broken.xml</loc></sitemap>
</sitemapindex>`;
}

function urlset(base, entries) {
  const urls = entries.map(([loc, alternates = []]) => `  <url><loc>${base}${loc}</loc>${alternates
    .map(([lang, href]) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${base}${href}"/>`).join('')}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>`;
}

/**
 * @returns {Promise<{ baseUrl: string, hits: Map<string, number>, userAgents: Set<string>, close: () => Promise<void> }>}
 */
export async function startMockSite() {
  const hits = new Map();
  const userAgents = new Set();
  let base = '';

  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    userAgents.add(req.headers['user-agent']);

    const send = (status, body, type = 'text/html; charset=utf-8', extra = {}) => {
      res.writeHead(status, { 'content-type': type, ...extra });
      res.end(body);
    };

    if (path === '/robots.txt') {
      return send(200, `User-agent: *\nDisallow: /int/private/\nDisallow: /de/private/\n\nSitemap: ${base}/sitemap_index.xml\n`, 'text/plain');
    }
    if (path === '/sitemap_index.xml') return send(200, sitemapIndex(base), 'application/xml');
    if (path === '/sitemap-int.xml') {
      return send(200, urlset(base, [
        ['/int/'], ['/int/about/'], ['/int/products/'], ['/int/missing/'], ['/int/moved/'],
        ['/int/private/secret/'], ['/int/localized2/', [['de', '/de/lokalisiert-zwei/'], ['en', '/int/localized2/']]],
      ]), 'application/xml');
    }
    if (path === '/sitemap-de.xml') return send(200, urlset(base, [['/de/'], ['/de/about/']]), 'application/xml');
    if (path === '/sitemap-extra.xml.gz') {
      return send(200, gzipSync(urlset(base, [['/int/localized/']])), 'application/gzip');
    }
    if (path === '/sitemap-broken.xml') return send(500, 'Internal Server Error', 'text/plain');

    // Transient failure: first request for /de/about/ gets 503 + Retry-After.
    if (path === '/de/about/' && hits.get(path) === 1) {
      return send(503, 'Service Unavailable', 'text/plain', { 'retry-after': '0' });
    }
    if (path === '/de/moved/') return send(302, '', 'text/plain', { location: '/de/' });

    const page = PAGES[path];
    if (!page) return send(404, '<!doctype html><title>Not found</title><p>Not found</p>');
    const lang = page.lang ?? (path.startsWith('/de/') ? 'de' : 'en');
    return send(200, layout({
      lang,
      title: page.title,
      head: page.head,
      nav: path.startsWith('/de/') ? NAV_DE : NAV_EN,
      main: page.main,
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl: base,
    hits,
    userAgents,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
