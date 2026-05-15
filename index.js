const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');

const app = express();
app.use(express.json());

const DEFAULT_SITEMAP_URL = 'https://turkishdishes.net/sitemap_index.xml';
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes
const sitemapCache = new Map();

// ✅ Google Search Console Auth
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});

// ✅ Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'turkishdishes-seo-api',
    time: new Date().toISOString(),
  });
});

// ✅ Existing GSC endpoint - improved but backward compatible
app.post('/gsc-data', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, dimensions, rowLimit } = req.body;

    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({
        error: 'siteUrl, startDate and endDate are required.',
      });
    }

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

// ✅ Page-based GSC endpoint
app.post('/gsc-pages', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, rowLimit } = req.body;

    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({
        error: 'siteUrl, startDate and endDate are required.',
      });
    }

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

// ✅ Query + page combined GSC endpoint
app.post('/gsc-query-pages', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, rowLimit } = req.body;

    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({
        error: 'siteUrl, startDate and endDate are required.',
      });
    }

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
    .replace(/İ/g, 'i')
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
    const slug = pathname.replace(/^\/|\/$/g, '').split('/').pop() || '';

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

async function fetchXml(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'TurkishDishesSEOAPI/1.0',
      'Accept': 'application/xml,text/xml,*/*',
    },
  });

  return response.data;
}

async function parseSitemap(sitemapUrl, visited = new Set(), maxUrls = 5000) {
  if (visited.has(sitemapUrl)) return [];
  visited.add(sitemapUrl);

  const xml = await fetchXml(sitemapUrl);
  const parsed = await parseStringPromise(xml, {
    explicitArray: false,
    trim: true,
  });

  let urls = [];

  // Sitemap index
  if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
    const sitemaps = toArray(parsed.sitemapindex.sitemap);

    for (const sitemap of sitemaps) {
      if (urls.length >= maxUrls) break;

      const childSitemapUrl = sitemap.loc;
      if (!childSitemapUrl) continue;

      const childUrls = await parseSitemap(childSitemapUrl, visited, maxUrls - urls.length);
      urls = urls.concat(childUrls);
    }
  }

  // URL set
  if (parsed.urlset && parsed.urlset.url) {
    const urlEntries = toArray(parsed.urlset.url);

    for (const item of urlEntries) {
      if (urls.length >= maxUrls) break;

      if (!item.loc) continue;

      urls.push({
        url: item.loc,
        lastmod: item.lastmod || null,
        titleFromSlug: slugToTitle(item.loc),
      });
    }
  }

  return urls;
}

async function getCachedSitemapUrls(sitemapUrl, maxUrls = 5000) {
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
    'to',
    'make',
    'with',
    'and',
    'the',
    'a',
    'an',
    'tarifi',
    'yemek',
    'yemegi',
  ]);

  let tokens = normalized
    .split(/[^a-z0-9]+/i)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !stopwords.has(t));

  const add = extra => {
    for (const item of extra) {
      if (!tokens.includes(item)) tokens.push(item);
    }
  };

  // Dessert cluster
  if (
    normalized.includes('kunefe') ||
    normalized.includes('kadayif') ||
    normalized.includes('baklava') ||
    normalized.includes('sekerpare') ||
    normalized.includes('sutlac') ||
    normalized.includes('dessert')
  ) {
    add([
      'dessert',
      'desserts',
      'baklava',
      'sekerpare',
      'sutlac',
      'pudding',
      'kadayif',
      'syrup',
      'sweet',
    ]);
  }

  // Kebab / lamb cluster
  if (
    normalized.includes('kebab') ||
    normalized.includes('kebabi') ||
    normalized.includes('lamb') ||
    normalized.includes('cag') ||
    normalized.includes('doner') ||
    normalized.includes('adana') ||
    normalized.includes('tandir')
  ) {
    add([
      'kebab',
      'kebabi',
      'lamb',
      'doner',
      'adana',
      'beyti',
      'tandir',
      'cokertme',
      'grill',
    ]);
  }

  // Soup cluster
  if (
    normalized.includes('soup') ||
    normalized.includes('corba') ||
    normalized.includes('beyran') ||
    normalized.includes('iskembe') ||
    normalized.includes('lentil') ||
    normalized.includes('tarhana')
  ) {
    add([
      'soup',
      'soups',
      'corba',
      'lentil',
      'beyran',
      'iskembe',
      'tarhana',
      'broth',
    ]);
  }

  // Bread / pastry cluster
  if (
    normalized.includes('bread') ||
    normalized.includes('lavash') ||
    normalized.includes('lahmacun') ||
    normalized.includes('pide') ||
    normalized.includes('simit')
  ) {
    add([
      'bread',
      'lavash',
      'lahmacun',
      'pide',
      'simit',
      'flatbread',
    ]);
  }

  return tokens;
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

  for (const token of tokens) {
    if (searchable.includes(token)) {
      score += 5;
      reasons.push(`Matches topic/entity: ${token}`);
    }
  }

  // Prefer hubs and category-like pages
  if (
    searchable.includes('/desserts') ||
    searchable.includes('/soups') ||
    searchable.includes('/kebab') ||
    searchable.includes('/turkish-soup-recipes') ||
    searchable.includes('/turkish-dinner')
  ) {
    score += 4;
    reasons.push('Possible hub/category page');
  }

  // Prefer recipe URLs over technical pages
  if (
    searchable.includes('recipe') ||
    searchable.includes('tarif') ||
    searchable.includes('kebab') ||
    searchable.includes('soup') ||
    searchable.includes('dessert')
  ) {
    score += 2;
    reasons.push('Likely recipe-related page');
  }

  // Avoid low-value technical URLs
  if (
    searchable.includes('/wp-') ||
    searchable.includes('/feed') ||
    searchable.includes('/tag/') ||
    searchable.includes('/author/') ||
    searchable.includes('/attachment/')
  ) {
    score -= 20;
    reasons.push('Low-value URL type');
  }

  return {
    score,
    reasons: [...new Set(reasons)],
  };
}

// ✅ Live sitemap URL endpoint
app.post('/sitemap-urls', async (req, res) => {
  try {
    const sitemapUrl = req.body.sitemapUrl || DEFAULT_SITEMAP_URL;
    const maxUrls = req.body.maxUrls || 5000;

    const urls = await getCachedSitemapUrls(sitemapUrl, maxUrls);

    res.json({
      sitemapUrl,
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

// ✅ Internal link suggestion endpoint
app.post('/internal-links', async (req, res) => {
  try {
    const {
      topic,
      currentUrl,
      sitemapUrl = DEFAULT_SITEMAP_URL,
      limit = 8,
      maxUrls = 5000,
    } = req.body;

    if (!topic) {
      return res.status(400).json({
        error: 'topic is required.',
      });
    }

    const urls = await getCachedSitemapUrls(sitemapUrl, maxUrls);

    const suggestions = urls
      .map(item => {
        const scoring = scoreInternalLink(item, topic, currentUrl);

        return {
          url: item.url,
          lastmod: item.lastmod,
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
      count: suggestions.length,
      suggestions,
    });
  } catch (error) {
    console.error('INTERNAL LINKS ERROR:', error);
    res.status(500).json({
      error: error.toString(),
    });
  }
});

// ✅ Render PORT
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API çalışıyor: ${PORT}`);
});
