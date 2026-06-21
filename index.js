const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes
const sitemapCache = new Map();

let parsedGoogleCredentials = null;
let analyticsDataClient = null;

/**
 * Allowed domains:
 * Default:
 * - turkishdishes.net
 * - saglikliturkiye.net
 *
 * Future sites can be added from Render ENV:
 * ALLOWED_DOMAINS=turkishdishes.net,saglikliturkiye.net,newsite.com
 */
const DEFAULT_ALLOWED_DOMAINS = [
  'turkishdishes.net',
  'saglikliturkiye.net',
];

function normalizeDomain(domain = '') {
  return String(domain)
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function getAllowedDomains() {
  const envDomains = process.env.ALLOWED_DOMAINS;

  if (!envDomains) {
    return DEFAULT_ALLOWED_DOMAINS;
  }

  return envDomains
    .split(',')
    .map(domain => normalizeDomain(domain))
    .filter(Boolean);
}

function getDomainFromUrl(input = '') {
  const value = String(input).trim();

  if (value.startsWith('sc-domain:')) {
    return normalizeDomain(value.replace('sc-domain:', ''));
  }

  try {
    const parsed = new URL(value);
    return normalizeDomain(parsed.hostname);
  } catch {
    return '';
  }
}

function isAllowedDomain(input = '') {
  const domain = getDomainFromUrl(input);
  const allowedDomains = getAllowedDomains();

  return allowedDomains.includes(domain);
}

function requireAllowedDomain(input, fieldName = 'url') {
  if (!input) {
    throw new Error(`${fieldName} is required.`);
  }

  if (!isAllowedDomain(input)) {
    throw new Error(
      `${fieldName} domain is not allowed. Allowed domains: ${getAllowedDomains().join(', ')}`
    );
  }
}

function getGoogleCredentials() {
  if (parsedGoogleCredentials) {
    return parsedGoogleCredentials;
  }

  if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error('GOOGLE_CREDENTIALS environment variable is missing.');
  }

  try {
    parsedGoogleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    return parsedGoogleCredentials;
  } catch (error) {
    throw new Error(`GOOGLE_CREDENTIALS is not valid JSON: ${error.message}`);
  }
}

/**
 * Google Auth is created lazily.
 * This prevents sitemap/internal-link endpoints from failing
 * if GOOGLE_CREDENTIALS has an issue.
 */
function getGoogleAuth() {
  return new google.auth.GoogleAuth({
    credentials: getGoogleCredentials(),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
}

/**
 * GA4 client is created lazily.
 * It uses the same GOOGLE_CREDENTIALS service account.
 * Make sure this service account has Viewer or Analyst access in GA4.
 */
function getGA4Client() {
  if (!analyticsDataClient) {
    analyticsDataClient = new BetaAnalyticsDataClient({
      credentials: getGoogleCredentials(),
    });
  }

  return analyticsDataClient;
}

function getGA4PropertyId(inputPropertyId) {
  const propertyId = inputPropertyId || process.env.GA4_PROPERTY_ID;

  if (!propertyId) {
    throw new Error(
      'propertyId is required or GA4_PROPERTY_ID environment variable must be set.'
    );
  }

  return String(propertyId).replace(/^properties\//, '').trim();
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getSafeRowLimit(rowLimit, fallback = 100, max = 1000) {
  const parsed = Number(rowLimit);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

// ---------- Health & Routes ----------

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'multi-site-seo-api',
    message: 'API is running.',
    allowedDomains: getAllowedDomains(),
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'multi-site-seo-api',
    allowedDomains: getAllowedDomains(),
    time: new Date().toISOString(),
  });
});

app.get('/routes', (req, res) => {
  res.json({
    status: 'ok',
    service: 'multi-site-seo-api',
    routes: [
      'GET /',
      'GET /health',
      'GET /routes',

      // GSC
      'POST /gsc-data',
      'POST /gsc-pages',
      'POST /gsc-query-pages',
      'POST /gsc-pages-zero-clicks',
      'POST /gsc-pages-low-ctr',
      'POST /gsc-pages-position-5-20',
      'POST /gsc-page-queries',

      // GA4
      'POST /ga4-pages',
      'POST /ga4-traffic',

      // Sitemap
      'POST /sitemap-urls',

      // Internal Links
      'POST /internal-links',
      'POST /get-internal-links',
      'POST /getInternalLinkSuggestions',
      'POST /internal-link-suggestions-v2',
      'POST /getInternalLinkSuggestionsV2',

      // SEO
      'POST /page-seo-audit',
    ],
    time: new Date().toISOString(),
  });
});

// ---------- GSC Endpoints ----------

app.post('/gsc-data', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, dimensions, rowLimit } = req.body;

    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({
        error: 'siteUrl, startDate and endDate are required.',
      });
    }

    requireAllowedDomain(siteUrl, 'siteUrl');

    const auth = getGoogleAuth();
    const authClient = await auth.getClient();

    const searchconsole = google.searchconsole({
      version: 'v1',
      auth: authClient,
    });

    const response = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions:
          Array.isArray(dimensions) && dimensions.length ? dimensions : ['query'],
        rowLimit: getSafeRowLimit(rowLimit, 1000, 5000),
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error('GSC DATA ERROR:', error);
    res.status(500).json({
      error: error.toString(),
    });
  }
});

app.post('/gsc-pages', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, rowLimit } = req.body;

    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({
        error: 'siteUrl, startDate and endDate are required.',
      });
    }

    requireAllowedDomain(siteUrl, 'siteUrl');

    const auth = getGoogleAuth();
    const authClient = await auth.getClient();

    const searchconsole = google.searchconsole({
      version: 'v1',
      auth: authClient,
    });

    const response = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['page'],
        rowLimit: getSafeRowLimit(rowLimit, 1000, 5000),
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error('GSC PAGES ERROR:', error);
    res.status(500).json({
      error: error.toString(),
    });
  }
});

app.post('/gsc-query-pages', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, rowLimit } = req.body;

    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({
        error: 'siteUrl, startDate and endDate are required.',
      });
    }

    requireAllowedDomain(siteUrl, 'siteUrl');

    const auth = getGoogleAuth();
    const authClient = await auth.getClient();

    const searchconsole = google.searchconsole({
      version: 'v1',
      auth: authClient,
    });

    const response = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query', 'page'],
        rowLimit: getSafeRowLimit(rowLimit, 1000, 5000),
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error('GSC QUERY PAGES ERROR:', error);
    res.status(500).json({
      error: error.toString(),
    });
  }
});

app.post('/gsc-pages-zero-clicks', async (req, res) => {
  try {
    const {
      siteUrl,
      startDate,
      endDate,
      rowLimit = 5000,
      minImpressions = 1,
    } = req.body;

    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({
        error: 'siteUrl, startDate and endDate are required.',
      });
    }

    requireAllowedDomain(siteUrl, 'siteUrl');

    const auth = getGoogleAuth();
    const authClient = await auth.getClient();

    const searchconsole = google.searchconsole({
      version: 'v1',
      auth: authClient,
    });

    const response = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['page'],
        rowLimit: getSafeRowLimit(rowLimit, 1000, 5000),
      },
    });

    const rows = (response.data.rows || [])
      .map(row => ({
        page: row.keys?.[0] || '',
        clicks: toNumber(row.clicks),
        impressions: toNumber(row.impressions),
        ctr: toNumber(row.ctr),
        position: toNumber(row.position),
      }))
      .filter(row => row.clicks === 0 && row.impressions >= Number(minImpressions))
      .sort((a, b) => b.impressions - a.impressions);

    res.json({
      siteUrl,
      startDate,
      endDate,
      minImpressions: Number(minImpressions),
      count: rows.length,
      rows,
    });
  } catch (error) {
    console.error('GSC ZERO CLICKS ERROR:', error);
    res.status(500).json({
      error: error.toString(),
    });
  }
});
app.post('/gsc-page-queries', async (req, res) => {
  try {
    const {
      siteUrl,
      pageUrl,
      startDate,
      endDate,
      rowLimit = 5000,
    } = req.body;

    if (!siteUrl || !pageUrl || !startDate || !endDate) {
      return res.status(400).json({
        error: 'siteUrl, pageUrl, startDate and endDate are required.',
      });
    }

    requireAllowedDomain(siteUrl, 'siteUrl');
    requireAllowedDomain(pageUrl, 'pageUrl');

    const auth = getGoogleAuth();
    const authClient = await auth.getClient();

    const searchconsole = google.searchconsole({
      version: 'v1',
      auth: authClient,
    });

    const response = await searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate,
        endDate,
        dimensions: ['query', 'page'],
        rowLimit: getSafeRowLimit(rowLimit, 1000, 5000),
      },
    });

    const rows = (response.data.rows || [])
      .map(row => ({
        query: row.keys?.[0] || '',
        page: row.keys?.[1] || '',
        clicks: toNumber(row.clicks),
        impressions: toNumber(row.impressions),
        ctr: toNumber(row.ctr),
        position: toNumber(row.position),
      }))
      .filter(row => row.page === pageUrl)
      .sort((a, b) => b.impressions - a.impressions);

    res.json({
      siteUrl,
      pageUrl,
      startDate,
      endDate,
      count: rows.length,
      rows,
    });

  } catch (error) {
    console.error('GSC PAGE QUERIES ERROR:', error);

    res.status(500).json({
      error: error.toString(),
    });
  }
});
// ---------- GA4 Endpoints ----------

app.post('/ga4-pages', async (req, res) => {
  try {
    const {
      propertyId,
      startDate,
      endDate,
      rowLimit = 100,
    } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({
        error: 'startDate and endDate are required.',
      });
    }

    const cleanPropertyId = getGA4PropertyId(propertyId);
    const safeRowLimit = getSafeRowLimit(rowLimit, 100, 1000);
    const analyticsClient = getGA4Client();

    const [response] = await analyticsClient.runReport({
      property: `properties/${cleanPropertyId}`,
      dateRanges: [
        {
          startDate,
          endDate,
        },
      ],
      dimensions: [
        { name: 'landingPagePlusQueryString' },
        { name: 'pageTitle' },
      ],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'sessions' },
        { name: 'activeUsers' },
        { name: 'engagedSessions' },
        { name: 'engagementRate' },
        { name: 'averageSessionDuration' },
        { name: 'bounceRate' },
      ],
      orderBys: [
        {
          metric: {
            metricName: 'sessions',
          },
          desc: true,
        },
      ],
      limit: safeRowLimit,
    });

    const rows = (response.rows || []).map(row => ({
      landingPage: row.dimensionValues?.[0]?.value || '',
      pageTitle: row.dimensionValues?.[1]?.value || '',
      views: toNumber(row.metricValues?.[0]?.value),
      sessions: toNumber(row.metricValues?.[1]?.value),
      activeUsers: toNumber(row.metricValues?.[2]?.value),
      engagedSessions: toNumber(row.metricValues?.[3]?.value),
      engagementRate: toNumber(row.metricValues?.[4]?.value),
      averageSessionDuration: toNumber(row.metricValues?.[5]?.value),
      bounceRate: toNumber(row.metricValues?.[6]?.value),
    }));

    res.json({
      propertyId: cleanPropertyId,
      startDate,
      endDate,
      rowLimit: safeRowLimit,
      count: rows.length,
      rows,
    });
  } catch (error) {
    console.error('GA4 PAGES ERROR:', error);
    res.status(500).json({
      error: error.toString(),
    });
  }
});

app.post('/ga4-traffic', async (req, res) => {
  try {
    const {
      propertyId,
      startDate,
      endDate,
      rowLimit = 100,
    } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({
        error: 'startDate and endDate are required.',
      });
    }

    const cleanPropertyId = getGA4PropertyId(propertyId);
    const safeRowLimit = getSafeRowLimit(rowLimit, 100, 1000);
    const analyticsClient = getGA4Client();

    const [response] = await analyticsClient.runReport({
      property: `properties/${cleanPropertyId}`,
      dateRanges: [
        {
          startDate,
          endDate,
        },
      ],
      dimensions: [
        { name: 'sessionDefaultChannelGroup' },
        { name: 'sessionSourceMedium' },
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'activeUsers' },
        { name: 'engagedSessions' },
        { name: 'engagementRate' },
      ],
      orderBys: [
        {
          metric: {
            metricName: 'sessions',
          },
          desc: true,
        },
      ],
      limit: safeRowLimit,
    });

    const rows = (response.rows || []).map(row => ({
      channelGroup: row.dimensionValues?.[0]?.value || '',
      sourceMedium: row.dimensionValues?.[1]?.value || '',
      sessions: toNumber(row.metricValues?.[0]?.value),
      activeUsers: toNumber(row.metricValues?.[1]?.value),
      engagedSessions: toNumber(row.metricValues?.[2]?.value),
      engagementRate: toNumber(row.metricValues?.[3]?.value),
    }));

    res.json({
      propertyId: cleanPropertyId,
      startDate,
      endDate,
      rowLimit: safeRowLimit,
      count: rows.length,
      rows,
    });
  } catch (error) {
    console.error('GA4 TRAFFIC ERROR:', error);
    res.status(500).json({
      error: error.toString(),
    });
  }
});

// ---------- Sitemap Helpers ----------

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeText(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function slugToTitle(url) {
  try {
    const pathname = new URL(url).pathname;
    const cleanPath = pathname.replace(/^\/|\/$/g, '');
    const slug = cleanPath.split('/').pop() || '';

    if (!slug) return 'Homepage';

    return slug
      .split('-')
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  } catch {
    return url;
  }
}

function guessUrlType(url) {
  const normalized = normalizeText(url);

  if (normalized.includes('/category/')) return 'category';
  if (normalized.includes('/tag/')) return 'tag';
  if (normalized.includes('/author/')) return 'author';
  if (normalized.includes('/page/')) return 'page';
  if (normalized.includes('/wp-')) return 'technical';
  if (normalized.includes('/feed')) return 'feed';

  return 'post_or_page';
}

async function fetchXml(url) {
  requireAllowedDomain(url, 'sitemapUrl');

  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'MultiSiteSEOAPI/1.3',
      Accept: 'application/xml,text/xml,*/*',
    },
  });

  return response.data;
}

async function parseSitemap(sitemapUrl, visited = new Set(), maxUrls = 5000) {
  requireAllowedDomain(sitemapUrl, 'sitemapUrl');

  if (visited.has(sitemapUrl)) return [];
  visited.add(sitemapUrl);

  const xml = await fetchXml(sitemapUrl);

  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    trim: true,
  });

  let urls = [];

  if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
    const sitemaps = toArray(parsed.sitemapindex.sitemap);

    for (const sitemap of sitemaps) {
      if (urls.length >= maxUrls) break;

      const childSitemapUrl = sitemap.loc;
      if (!childSitemapUrl) continue;

      if (!isAllowedDomain(childSitemapUrl)) {
        continue;
      }

      const childUrls = await parseSitemap(
        childSitemapUrl,
        visited,
        maxUrls - urls.length
      );

      urls = urls.concat(childUrls);
    }
  }

  if (parsed.urlset && parsed.urlset.url) {
    const urlEntries = toArray(parsed.urlset.url);

    for (const item of urlEntries) {
      if (urls.length >= maxUrls) break;
      if (!item.loc) continue;

      if (!isAllowedDomain(item.loc)) {
        continue;
      }

      urls.push({
        url: item.loc,
        lastmod: item.lastmod || null,
        titleFromSlug: slugToTitle(item.loc),
        type: guessUrlType(item.loc),
      });
    }
  }

  return urls;
}

async function getCachedSitemapUrls(sitemapUrl, maxUrls = 5000) {
  requireAllowedDomain(sitemapUrl, 'sitemapUrl');

  const cacheKey = `${sitemapUrl}:${maxUrls}`;
  const cached = sitemapCache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const urls = await parseSitemap(sitemapUrl, new Set(), maxUrls);

  sitemapCache.set(cacheKey, {
    createdAt: Date.now(),
    data: urls,
  });

  return urls;
}

// ---------- Sitemap Endpoint ----------

app.post('/sitemap-urls', async (req, res) => {
  try {
    const { sitemapUrl, maxUrls } = req.body;

    if (!sitemapUrl) {
      return res.status(400).json({
        error: 'sitemapUrl is required. No default sitemap is used for multi-site safety.',
      });
    }

    requireAllowedDomain(sitemapUrl, 'sitemapUrl');

    const urls = await getCachedSitemapUrls(sitemapUrl, maxUrls || 5000);

    res.json({
      sitemapUrl,
      allowedDomain: getDomainFromUrl(sitemapUrl),
      count: urls.length,
      urls,
    });
  } catch (error) {
    console.error('SITEMAP URLS ERROR:', error);
    res.status(500).json({
      error: error.toString(),
    });
  }
});

// ---------- Internal Link Helpers ----------

function expandTopicTokens(topic) {
  const normalized = normalizeText(topic);

  const stopwords = new Set([
    'recipe',
    'authentic',
    'traditional',
    'turkish',
    'easy',
    'homemade',
    'how',
    'make',
    'with',
    'and',
    'the',
    'for',
    'from',
    'tarifi',
    'yemek',
    'yemegi',
    'dish',
    'food',
    'health',
    'medical',
    'symptoms',
    'treatment',
    'nedir',
    'neden',
    'nasil',
    'belirti',
    'tedavi',
  ]);

  const tokens = normalized
    .split(/[^a-z0-9]+/i)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !stopwords.has(t));

  return [...new Set(tokens)];
}

function isLowValueUrl(searchable) {
  return (
    searchable.includes('/wp-') ||
    searchable.includes('/feed') ||
    searchable.includes('/tag/') ||
    searchable.includes('/author/') ||
    searchable.includes('/attachment/') ||
    searchable.includes('?') ||
    searchable.includes('#')
  );
}

function getTopicContext(topic) {
  const normalized = normalizeText(topic);

  const isDessertTopic =
    normalized.includes('dessert') ||
    normalized.includes('sweet') ||
    normalized.includes('kunefe') ||
    normalized.includes('künefe') ||
    normalized.includes('baklava') ||
    normalized.includes('syrup') ||
    normalized.includes('serbet') ||
    normalized.includes('kadayıf') ||
    normalized.includes('kadayif') ||
    normalized.includes('halva') ||
    normalized.includes('sutlac') ||
    normalized.includes('pudding');

  const isSoupTopic =
    normalized.includes('soup') ||
    normalized.includes('corba') ||
    normalized.includes('çorba');

  const isKebabTopic =
    normalized.includes('kebab') ||
    normalized.includes('kebap') ||
    normalized.includes('lamb') ||
    normalized.includes('beef') ||
    normalized.includes('meat');

  return {
    isDessertTopic,
    isSoupTopic,
    isKebabTopic,
  };
}

function scoreInternalLink(item, topic, currentUrl = '') {
  const tokens = expandTopicTokens(topic);
  const searchable = normalizeText(`${item.url} ${item.titleFromSlug}`);
  const context = getTopicContext(topic);

  let score = 0;
  const reasons = [];

  if (currentUrl && normalizeText(item.url) === normalizeText(currentUrl)) {
    return {
      score: -999,
      reasons: ['Current URL excluded'],
    };
  }

  if (isLowValueUrl(searchable)) {
    return {
      score: -999,
      reasons: ['Low-value URL type excluded'],
    };
  }

  for (const token of tokens) {
    if (searchable.includes(token)) {
      score += 10;
      reasons.push(`Matches topic/entity: ${token}`);
    }
  }

  const isPossibleHub =
    searchable.includes('/desserts') ||
    searchable.includes('/soups') ||
    searchable.includes('/kebab') ||
    searchable.includes('/breakfast') ||
    searchable.includes('/dinner') ||
    searchable.includes('/turkish') ||
    searchable.includes('/health') ||
    searchable.includes('/category');

  if (isPossibleHub && score > 0) {
    score += 2;
    reasons.push('Possible related hub/category page');
  }

  if (context.isDessertTopic) {
    const dessertSignals = [
      'dessert',
      'sweet',
      'baklava',
      'kunefe',
      'kadayif',
      'pumpkin-dessert',
      'halva',
      'sutlac',
      'pudding',
      'sekerpare',
      'cake',
      'cheesecake',
    ];

    const savorySignals = [
      'borek',
      'kebab',
      'soup',
      'corba',
      'salad',
      'chicken',
      'lamb',
      'beef',
      'meat',
      'dinner',
    ];

    if (dessertSignals.some(signal => searchable.includes(signal))) {
      score += 5;
      reasons.push('Dessert topic match');
    }

    if (savorySignals.some(signal => searchable.includes(signal))) {
      score -= 8;
      reasons.push('Possible savory mismatch for dessert topic');
    }
  }

  if (context.isSoupTopic && searchable.includes('soup')) {
    score += 5;
    reasons.push('Soup topic match');
  }

  if (context.isKebabTopic && searchable.includes('kebab')) {
    score += 5;
    reasons.push('Kebab topic match');
  }

  return {
    score,
    reasons: [...new Set(reasons)],
  };
}

// ---------- Internal Link Endpoints ----------

async function handleInternalLinks(req, res) {
  try {
    const {
      topic,
      currentUrl,
      sitemapUrl,
      limit = 8,
      maxUrls = 5000,
    } = req.body;

    if (!topic) {
      return res.status(400).json({
        error: 'topic is required.',
      });
    }

    if (!sitemapUrl) {
      return res.status(400).json({
        error: 'sitemapUrl is required. No default sitemap is used for multi-site safety.',
      });
    }

    requireAllowedDomain(sitemapUrl, 'sitemapUrl');

    if (currentUrl) {
      requireAllowedDomain(currentUrl, 'currentUrl');
    }

    const urls = await getCachedSitemapUrls(sitemapUrl, maxUrls);

    const suggestions = urls
      .map(item => {
        const scoring = scoreInternalLink(item, topic, currentUrl);

        return {
          url: item.url,
          lastmod: item.lastmod,
          type: item.type,
          titleFromSlug: item.titleFromSlug,
          anchorSuggestion: item.titleFromSlug,
          score: scoring.score,
          reasons: scoring.reasons,
        };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    res.json({
      topic,
      sitemapUrl,
      allowedDomain: getDomainFromUrl(sitemapUrl),
      count: suggestions.length,
      suggestions,
    });
  } catch (error) {
    console.error('INTERNAL LINKS ERROR:', error);
    res.status(500).json({
      error: error.toString(),
    });
  }
}

app.post('/internal-links', handleInternalLinks);
app.post('/get-internal-links', handleInternalLinks);
app.post('/getInternalLinkSuggestions', handleInternalLinks);
app.post('/internal-link-suggestions-v2', handleInternalLinks);
app.post('/getInternalLinkSuggestionsV2', handleInternalLinks);

// ---------- Page SEO Audit ----------

app.post('/page-seo-audit', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        error: 'url is required.'
      });
    }

    requireAllowedDomain(url, 'url');

    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/1.0)'
      }
    });

    const html = response.data;
    const $ = cheerio.load(html);

    const title = $('title').first().text().trim();

    const metaDescription =
      $('meta[name="description"]').attr('content') || '';

    const canonical =
      $('link[rel="canonical"]').attr('href') || '';

    const robots =
      $('meta[name="robots"]').attr('content') || '';

    const h1List = $('h1')
      .map((i, el) => $(el).text().trim())
      .get();

    res.json({
      success: true,
      url,
      seo: {
        title,
        metaDescription,
        canonical,
        robots,
        h1Count: h1List.length,
        h1: h1List
      }
    });

  } catch (error) {
    console.error('PAGE SEO AUDIT ERROR:', error);

    res.status(500).json({
      error: error.toString()
    });
  }
});
// ---------- Render PORT ----------

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API çalışıyor: ${PORT}`);
});
