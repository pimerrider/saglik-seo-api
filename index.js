const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');

const app = express();
app.use(express.json());

const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes
const sitemapCache = new Map();

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
  'saglikliturkiye.net'
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

/**
 * Google Auth is created lazily.
 * This prevents sitemap/internal-link endpoints from failing
 * if GOOGLE_CREDENTIALS has an issue.
 */
function getGoogleAuth() {
  if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error('GOOGLE_CREDENTIALS environment variable is missing.');
  }

  return new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
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
  'POST /gsc-data',
  'POST /gsc-pages',
  'POST /gsc-query-pages',
  'POST /sitemap-urls',
  'POST /internal-links',
  'POST /get-internal-links',
  'POST /getInternalLinkSuggestions'
],
    time: new Date().toISOString()
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
        dimensions: Array.isArray(dimensions) && dimensions.length ? dimensions : ['query'],
        rowLimit: rowLimit || 1000,
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
        rowLimit: rowLimit || 1000,
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
        rowLimit: rowLimit || 1000,
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
      'User-Agent': 'MultiSiteSEOAPI/1.2',
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

function scoreInternalLink(item, topic, currentUrl = '') {
  const tokens = expandTopicTokens(topic);
  const searchable = normalizeText(`${item.url} ${item.titleFromSlug}`);

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

// ---------- Render PORT ----------

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API çalışıyor: ${PORT}`);
});
