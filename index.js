'use strict';

/**
 * TurkishDishes SEO API — v2.0 Final
 * ===================================
 * Multi-site destekli, modüler Node.js / Express SEO API.
 *
 * Endpointler:
 *   GET  /                          → Sağlık + bilgi
 *   GET  /health
 *   GET  /routes
 *
 *   POST /gsc-data                  → Sorgu bazlı GSC verisi
 *   POST /gsc-pages                 → Sayfa bazlı GSC verisi
 *   POST /gsc-query-pages           → Sorgu+sayfa kombinasyonu
 *   POST /gsc-pages-zero-clicks     → Gösterim var, tıklama yok
 *   POST /gsc-top-pages             → En çok tıklanan sayfalar
 *   POST /gsc-page-queries          → Belirli sayfanın sorguları
 *   POST /gsc-pages-low-ctr         → Düşük CTR sayfaları
 *   POST /gsc-pages-position-5-20   → Fırsat sayfaları (pos 5-20)
 *
 *   POST /ga4-pages                 → GA4 landing page verisi
 *   POST /ga4-traffic               → GA4 trafik kaynağı verisi
 *
 *   POST /sitemap-urls              → Sitemap URL listesi
 *   POST /internal-link-suggestions → İç link önerileri
 *
 *   POST /page-seo-audit            → Tek sayfa SEO audit
 *   POST /page-deep-analysis        → Derin sayfa analizi (GSC+SEO+Links)
 *
 *   POST /site-summary              → 90 günlük site özeti
 *   POST /content-plan              → Yeni makale için veri destekli plan
 *   POST /revision-analysis         → Revize/sil/birleştir kararı
 *
 * Kurulum:
 *   npm install express googleapis @google-analytics/data axios xml2js cheerio
 *
 * ENV değişkenleri:
 *   GOOGLE_CREDENTIALS  → Service account JSON (string)
 *   GA4_PROPERTY_ID     → GA4 property ID (opsiyonel, request'te de verilebilir)
 *   ALLOWED_DOMAINS     → Virgülle ayrılmış domain listesi (opsiyonel)
 *   PORT                → Port numarası (varsayılan: 3000)
 */

const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const cheerio = require('cheerio');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ─────────────────────────────────────────────
// SABITLER
// ─────────────────────────────────────────────

const CACHE_TTL_MS = 1000 * 60 * 30; // 30 dakika
const GSC_MAX_ROW_LIMIT = 5000;
const GA4_MAX_ROW_LIMIT = 1000;
const SITEMAP_MAX_URLS = 5000;

const DEFAULT_ALLOWED_DOMAINS = [
  'turkishdishes.net',
  'saglikliturkiye.net',
];

// ─────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────

const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { createdAt: Date.now(), data });
}

// ─────────────────────────────────────────────
// DOMAIN DOĞRULAMA
// ─────────────────────────────────────────────

function normalizeDomain(input = '') {
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function getAllowedDomains() {
  const env = process.env.ALLOWED_DOMAINS;
  if (!env) return DEFAULT_ALLOWED_DOMAINS;
  return env.split(',').map(normalizeDomain).filter(Boolean);
}

function getDomainFromUrl(input = '') {
  const val = String(input).trim();
  if (val.startsWith('sc-domain:')) {
    return normalizeDomain(val.replace('sc-domain:', ''));
  }
  try {
    return normalizeDomain(new URL(val).hostname);
  } catch {
    return '';
  }
}

function isAllowedDomain(input = '') {
  return getAllowedDomains().includes(getDomainFromUrl(input));
}

function requireAllowedDomain(input, fieldName = 'url') {
  if (!input) throw new Error(`${fieldName} zorunludur.`);
  if (!isAllowedDomain(input)) {
    throw new Error(
      `${fieldName} için izin verilmeyen domain. İzinliler: ${getAllowedDomains().join(', ')}`
    );
  }
}

// ─────────────────────────────────────────────
// GOOGLE AUTH
// ─────────────────────────────────────────────

let _parsedCreds = null;
let _ga4Client = null;

function getCredentials() {
  if (_parsedCreds) return _parsedCreds;
  if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error('GOOGLE_CREDENTIALS environment variable eksik.');
  }
  try {
    _parsedCreds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    return _parsedCreds;
  } catch (e) {
    throw new Error(`GOOGLE_CREDENTIALS geçersiz JSON: ${e.message}`);
  }
}

function getGoogleAuth() {
  return new google.auth.GoogleAuth({
    credentials: getCredentials(),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
}

function getGA4Client() {
  if (!_ga4Client) {
    _ga4Client = new BetaAnalyticsDataClient({ credentials: getCredentials() });
  }
  return _ga4Client;
}

function resolveGA4PropertyId(inputId) {
  const id = inputId || process.env.GA4_PROPERTY_ID;
  if (!id) {
    throw new Error('propertyId zorunlu veya GA4_PROPERTY_ID env set edilmeli.');
  }
  return String(id).replace(/^properties\//, '').trim();
}

// ─────────────────────────────────────────────
// YARDIMCI FONKSİYONLAR
// ─────────────────────────────────────────────

function toNum(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function safeLimit(val, fallback = 100, max = 5000) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function normalizeUrlForCompare(url) {
  return String(url || '').trim().toLowerCase().replace(/\/$/, '');
}

function normalizeText(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/ı/g, 'i').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ş/g, 's')
    .replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isLowValueUrl(url) {
  return [
    '/wp-', '/wp-content/', '/feed', '/tag/', '/author/',
    '/attachment/', '/page/', '/newsletter/', '/privacy-policy',
    '/user-policy', '/about-us',
  ].some(p => url.includes(p)) || url.includes('?') || url.includes('#');
}

function slugToTitle(url) {
  try {
    const slug = new URL(url).pathname.replace(/^\/|\/$/g, '').split('/').pop() || '';
    if (!slug) return 'Homepage';
    return slug.split('-').filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  } catch {
    return url;
  }
}

function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function dateRange(days = 90) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  const fmt = d => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

// ─────────────────────────────────────────────
// GSC SERVİSİ
// ─────────────────────────────────────────────

async function gscQuery({ siteUrl, startDate, endDate, dimensions, rowLimit, filters }) {
  requireAllowedDomain(siteUrl, 'siteUrl');
  const auth = getGoogleAuth();
  const authClient = await auth.getClient();
  const sc = google.searchconsole({ version: 'v1', auth: authClient });

  const requestBody = {
    startDate,
    endDate,
    dimensions: Array.isArray(dimensions) && dimensions.length ? dimensions : ['query'],
    rowLimit: safeLimit(rowLimit, 1000, GSC_MAX_ROW_LIMIT),
  };

  if (filters && filters.length) {
    requestBody.dimensionFilterGroups = [{
      filters: filters.map(f => ({
        dimension: f.dimension,
        operator: f.operator || 'equals',
        expression: f.expression,
      })),
    }];
  }

  const res = await sc.searchanalytics.query({ siteUrl, requestBody });
  return res.data.rows || [];
}

function mapGscRow(row, dims) {
  const obj = {};
  (dims || []).forEach((d, i) => { obj[d] = row.keys?.[i] || ''; });
  obj.clicks = toNum(row.clicks);
  obj.impressions = toNum(row.impressions);
  obj.ctr = toNum(row.ctr);
  obj.position = toNum(row.position);
  return obj;
}

// ─────────────────────────────────────────────
// GA4 SERVİSİ
// ─────────────────────────────────────────────

async function ga4Report({ propertyId, startDate, endDate, dimensions, metrics, orderBy, rowLimit }) {
  const cleanId = resolveGA4PropertyId(propertyId);
  const client = getGA4Client();
  const [res] = await client.runReport({
    property: `properties/${cleanId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: dimensions.map(name => ({ name })),
    metrics: metrics.map(name => ({ name })),
    orderBys: orderBy ? [{ metric: { metricName: orderBy }, desc: true }] : [],
    limit: safeLimit(rowLimit, 100, GA4_MAX_ROW_LIMIT),
  });
  return { propertyId: cleanId, rows: res.rows || [] };
}

// ─────────────────────────────────────────────
// SİTEMAP SERVİSİ
// ─────────────────────────────────────────────

async function fetchXml(url) {
  requireAllowedDomain(url, 'sitemapUrl');
  const res = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'MultiSiteSEOAPI/2.0', Accept: 'application/xml,text/xml,*/*' },
  });
  return res.data;
}

async function parseSitemap(sitemapUrl, visited = new Set(), maxUrls = SITEMAP_MAX_URLS) {
  requireAllowedDomain(sitemapUrl, 'sitemapUrl');
  if (visited.has(sitemapUrl)) return [];
  visited.add(sitemapUrl);

  const xml = await fetchXml(sitemapUrl);
  const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true });
  let urls = [];

  if (parsed.sitemapindex?.sitemap) {
    for (const sitemap of toArray(parsed.sitemapindex.sitemap)) {
      if (urls.length >= maxUrls) break;
      const child = sitemap.loc;
      if (!child || !isAllowedDomain(child)) continue;
      const childUrls = await parseSitemap(child, visited, maxUrls - urls.length);
      urls = urls.concat(childUrls);
    }
  }

  if (parsed.urlset?.url) {
    for (const item of toArray(parsed.urlset.url)) {
      if (urls.length >= maxUrls) break;
      if (!item.loc || !isAllowedDomain(item.loc)) continue;
      urls.push({
        url: item.loc,
        lastmod: item.lastmod || null,
        titleFromSlug: slugToTitle(item.loc),
      });
    }
  }

  return urls;
}

async function getCachedSitemap(sitemapUrl, maxUrls = SITEMAP_MAX_URLS) {
  requireAllowedDomain(sitemapUrl, 'sitemapUrl');
  const key = `sitemap:${sitemapUrl}:${maxUrls}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await parseSitemap(sitemapUrl, new Set(), maxUrls);
  cacheSet(key, data);
  return data;
}

// ─────────────────────────────────────────────
// İÇ LİNK SCORING
// ─────────────────────────────────────────────

function expandTokens(topic) {
  const stopwords = new Set([
    'recipe','authentic','traditional','turkish','easy','homemade',
    'how','make','with','and','the','for','from','tarifi','yemek',
    'dish','food','health','medical','symptoms','treatment',
  ]);
  return [...new Set(
    normalizeText(topic).split(/[^a-z0-9]+/i)
      .map(t => t.trim())
      .filter(t => t.length >= 3 && !stopwords.has(t))
  )];
}

function scoreLink(item, topic, currentUrl = '') {
  if (currentUrl && normalizeUrlForCompare(item.url) === normalizeUrlForCompare(currentUrl)) {
    return -999;
  }
  const searchable = normalizeText(`${item.url} ${item.titleFromSlug}`);
  if (isLowValueUrl(searchable)) return -999;

  const tokens = expandTokens(topic);
  let score = 0;
  for (const token of tokens) {
    if (searchable.includes(token)) score += 10;
  }

  const normTopic = normalizeText(topic);
  const dessertWords = ['dessert','sweet','baklava','kunefe','kadayif','halva','sutlac','pudding','cake'];
  const savoryWords = ['kebab','soup','corba','salad','chicken','lamb','beef','meat'];
  const isDessert = dessertWords.some(w => normTopic.includes(w));

  if (isDessert) {
    if (dessertWords.some(w => searchable.includes(w))) score += 5;
    if (savoryWords.some(w => searchable.includes(w))) score -= 8;
  }
  if (normTopic.includes('soup') && searchable.includes('soup')) score += 5;
  if (normTopic.includes('kebab') && searchable.includes('kebab')) score += 5;

  const hubSignals = ['/desserts','/soups','/kebab','/breakfast','/dinner','/turkish','/category'];
  if (score > 0 && hubSignals.some(h => searchable.includes(h))) score += 2;

  return score;
}

// ─────────────────────────────────────────────
// ORTAK HATA HANDLER
// ─────────────────────────────────────────────

function handleError(res, error, label = 'ERROR') {
  console.error(`[${label}]`, error?.message || error);
  res.status(500).json({ error: error?.message || String(error) });
}

// ─────────────────────────────────────────────
// TEMEL ROTALAR
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'multi-site-seo-api',
    version: '2.0.0',
    allowedDomains: getAllowedDomains(),
    time: new Date().toISOString(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    allowedDomains: getAllowedDomains(),
    time: new Date().toISOString(),
  });
});

app.get('/routes', (req, res) => {
  res.json({
    routes: [
      'GET  /',
      'GET  /health',
      'GET  /routes',
      'POST /gsc-data',
      'POST /gsc-pages',
      'POST /gsc-query-pages',
      'POST /gsc-pages-zero-clicks',
      'POST /gsc-top-pages',
      'POST /gsc-page-queries',
      'POST /gsc-pages-low-ctr',
      'POST /gsc-pages-position-5-20',
      'POST /ga4-pages',
      'POST /ga4-traffic',
      'POST /sitemap-urls',
      'POST /internal-link-suggestions',
      'POST /page-seo-audit',
      'POST /page-deep-analysis',
      'POST /site-summary',
      'POST /content-plan',
      'POST /revision-analysis',
    ],
  });
});

// ─────────────────────────────────────────────
// GSC ENDPOİNTLERİ
// ─────────────────────────────────────────────

// POST /gsc-data — dimensions serbest, sorgu bazlı ham veri
app.post('/gsc-data', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, dimensions, rowLimit } = req.body;
    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({ error: 'siteUrl, startDate, endDate zorunlu.' });
    }
    const dims = Array.isArray(dimensions) && dimensions.length ? dimensions : ['query'];
    const rows = await gscQuery({ siteUrl, startDate, endDate, dimensions: dims, rowLimit });
    res.json({
      siteUrl, startDate, endDate, dimensions: dims,
      count: rows.length,
      rows: rows.map(r => mapGscRow(r, dims)),
    });
  } catch (e) { handleError(res, e, 'GSC-DATA'); }
});

// POST /gsc-pages — sayfa bazlı performans
app.post('/gsc-pages', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, rowLimit } = req.body;
    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({ error: 'siteUrl, startDate, endDate zorunlu.' });
    }
    const dims = ['page'];
    const rows = await gscQuery({ siteUrl, startDate, endDate, dimensions: dims, rowLimit });
    res.json({
      siteUrl, startDate, endDate,
      count: rows.length,
      rows: rows.map(r => mapGscRow(r, dims)),
    });
  } catch (e) { handleError(res, e, 'GSC-PAGES'); }
});

// POST /gsc-query-pages — sorgu + sayfa kombinasyonu
app.post('/gsc-query-pages', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, rowLimit } = req.body;
    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({ error: 'siteUrl, startDate, endDate zorunlu.' });
    }
    const dims = ['query', 'page'];
    const rows = await gscQuery({ siteUrl, startDate, endDate, dimensions: dims, rowLimit });
    res.json({
      siteUrl, startDate, endDate,
      count: rows.length,
      rows: rows.map(r => mapGscRow(r, dims)),
    });
  } catch (e) { handleError(res, e, 'GSC-QUERY-PAGES'); }
});

// POST /gsc-pages-zero-clicks — gösterim var, tıklama yok
app.post('/gsc-pages-zero-clicks', async (req, res) => {
  try {
    const {
      siteUrl, startDate, endDate,
      rowLimit = 5000,
      minImpressions = 1,
      postsOnly = true,
    } = req.body;
    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({ error: 'siteUrl, startDate, endDate zorunlu.' });
    }
    const dims = ['page'];
    const rawRows = await gscQuery({ siteUrl, startDate, endDate, dimensions: dims, rowLimit });
    const rows = rawRows
      .map(r => mapGscRow(r, dims))
      .filter(r => r.clicks === 0 && r.impressions >= Number(minImpressions))
      .filter(r => !postsOnly || !isLowValueUrl(r.page))
      .sort((a, b) => b.impressions - a.impressions);

    res.json({
      siteUrl, startDate, endDate,
      minImpressions: Number(minImpressions),
      postsOnly: Boolean(postsOnly),
      count: rows.length,
      rows,
    });
  } catch (e) { handleError(res, e, 'GSC-ZERO-CLICKS'); }
});

// POST /gsc-top-pages — en çok tıklanan sayfalar
app.post('/gsc-top-pages', async (req, res) => {
  try {
    const {
      siteUrl, startDate, endDate,
      rowLimit = 100,
      minClicks = 1,
      postsOnly = true,
    } = req.body;
    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({ error: 'siteUrl, startDate, endDate zorunlu.' });
    }
    const dims = ['page'];
    const rawRows = await gscQuery({ siteUrl, startDate, endDate, dimensions: dims, rowLimit });
    const rows = rawRows
      .map(r => mapGscRow(r, dims))
      .filter(r => r.clicks >= Number(minClicks))
      .filter(r => !postsOnly || !isLowValueUrl(r.page))
      .sort((a, b) => b.clicks - a.clicks);

    res.json({
      siteUrl, startDate, endDate,
      minClicks: Number(minClicks),
      postsOnly: Boolean(postsOnly),
      count: rows.length,
      rows,
    });
  } catch (e) { handleError(res, e, 'GSC-TOP-PAGES'); }
});

// POST /gsc-page-queries — belirli sayfanın sorguları
app.post('/gsc-page-queries', async (req, res) => {
  try {
    const {
      siteUrl, pageUrl, startDate, endDate,
      rowLimit = 5000,
    } = req.body;
    if (!siteUrl || !pageUrl || !startDate || !endDate) {
      return res.status(400).json({ error: 'siteUrl, pageUrl, startDate, endDate zorunlu.' });
    }
    requireAllowedDomain(pageUrl, 'pageUrl');

    const dims = ['query', 'page'];
    const rawRows = await gscQuery({ siteUrl, startDate, endDate, dimensions: dims, rowLimit });
    const normPage = normalizeUrlForCompare(pageUrl);
    const rows = rawRows
      .map(r => mapGscRow(r, dims))
      .filter(r => normalizeUrlForCompare(r.page) === normPage)
      .sort((a, b) => b.impressions - a.impressions);

    res.json({
      siteUrl, pageUrl, startDate, endDate,
      count: rows.length,
      rows,
    });
  } catch (e) { handleError(res, e, 'GSC-PAGE-QUERIES'); }
});

// POST /gsc-pages-low-ctr — yüksek gösterim, düşük CTR
app.post('/gsc-pages-low-ctr', async (req, res) => {
  try {
    const {
      siteUrl, startDate, endDate,
      maxCtr = 0.03,
      minImpressions = 100,
      rowLimit = 5000,
      postsOnly = true,
    } = req.body;
    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({ error: 'siteUrl, startDate, endDate zorunlu.' });
    }
    const dims = ['page'];
    const rawRows = await gscQuery({ siteUrl, startDate, endDate, dimensions: dims, rowLimit });
    const rows = rawRows
      .map(r => mapGscRow(r, dims))
      .filter(r =>
        r.ctr <= Number(maxCtr) &&
        r.impressions >= Number(minImpressions) &&
        r.clicks > 0
      )
      .filter(r => !postsOnly || !isLowValueUrl(r.page))
      .sort((a, b) => b.impressions - a.impressions)
      .map(r => ({
        ...r,
        ctrPercent: `${(r.ctr * 100).toFixed(2)}%`,
        issue: 'low_ctr',
      }));

    res.json({
      siteUrl, startDate, endDate,
      maxCtr: Number(maxCtr),
      minImpressions: Number(minImpressions),
      count: rows.length,
      rows,
    });
  } catch (e) { handleError(res, e, 'GSC-LOW-CTR'); }
});

// POST /gsc-pages-position-5-20 — fırsat sayfaları
app.post('/gsc-pages-position-5-20', async (req, res) => {
  try {
    const {
      siteUrl, startDate, endDate,
      minPosition = 5,
      maxPosition = 20,
      minImpressions = 50,
      rowLimit = 5000,
      postsOnly = true,
    } = req.body;
    if (!siteUrl || !startDate || !endDate) {
      return res.status(400).json({ error: 'siteUrl, startDate, endDate zorunlu.' });
    }
    const dims = ['page'];
    const rawRows = await gscQuery({ siteUrl, startDate, endDate, dimensions: dims, rowLimit });
    const rows = rawRows
      .map(r => mapGscRow(r, dims))
      .filter(r =>
        r.position >= Number(minPosition) &&
        r.position <= Number(maxPosition) &&
        r.impressions >= Number(minImpressions)
      )
      .filter(r => !postsOnly || !isLowValueUrl(r.page))
      .sort((a, b) => a.position - b.position);

    res.json({
      siteUrl, startDate, endDate,
      minPosition: Number(minPosition),
      maxPosition: Number(maxPosition),
      minImpressions: Number(minImpressions),
      label: 'opportunity_pages',
      count: rows.length,
      rows,
    });
  } catch (e) { handleError(res, e, 'GSC-POSITION-5-20'); }
});

// ─────────────────────────────────────────────
// GA4 ENDPOİNTLERİ
// ─────────────────────────────────────────────

// POST /ga4-pages — landing page performansı
app.post('/ga4-pages', async (req, res) => {
  try {
    const { propertyId, startDate, endDate, rowLimit = 100 } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate, endDate zorunlu.' });
    }
    const result = await ga4Report({
      propertyId, startDate, endDate, rowLimit,
      dimensions: ['landingPagePlusQueryString', 'pageTitle'],
      metrics: ['screenPageViews', 'sessions', 'activeUsers', 'engagedSessions', 'engagementRate', 'averageSessionDuration', 'bounceRate'],
      orderBy: 'sessions',
    });

    const rows = result.rows.map(row => ({
      landingPage: row.dimensionValues?.[0]?.value || '',
      pageTitle: row.dimensionValues?.[1]?.value || '',
      views: toNum(row.metricValues?.[0]?.value),
      sessions: toNum(row.metricValues?.[1]?.value),
      activeUsers: toNum(row.metricValues?.[2]?.value),
      engagedSessions: toNum(row.metricValues?.[3]?.value),
      engagementRate: toNum(row.metricValues?.[4]?.value),
      avgSessionDuration: toNum(row.metricValues?.[5]?.value),
      bounceRate: toNum(row.metricValues?.[6]?.value),
    }));

    res.json({ propertyId: result.propertyId, startDate, endDate, count: rows.length, rows });
  } catch (e) { handleError(res, e, 'GA4-PAGES'); }
});

// POST /ga4-traffic — trafik kaynağı
app.post('/ga4-traffic', async (req, res) => {
  try {
    const { propertyId, startDate, endDate, rowLimit = 100 } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate, endDate zorunlu.' });
    }
    const result = await ga4Report({
      propertyId, startDate, endDate, rowLimit,
      dimensions: ['sessionDefaultChannelGroup', 'sessionSourceMedium'],
      metrics: ['sessions', 'activeUsers', 'engagedSessions', 'engagementRate'],
      orderBy: 'sessions',
    });

    const rows = result.rows.map(row => ({
      channelGroup: row.dimensionValues?.[0]?.value || '',
      sourceMedium: row.dimensionValues?.[1]?.value || '',
      sessions: toNum(row.metricValues?.[0]?.value),
      activeUsers: toNum(row.metricValues?.[1]?.value),
      engagedSessions: toNum(row.metricValues?.[2]?.value),
      engagementRate: toNum(row.metricValues?.[3]?.value),
    }));

    res.json({ propertyId: result.propertyId, startDate, endDate, count: rows.length, rows });
  } catch (e) { handleError(res, e, 'GA4-TRAFFIC'); }
});

// ─────────────────────────────────────────────
// SİTEMAP ENDPOİNTİ
// ─────────────────────────────────────────────

// POST /sitemap-urls
app.post('/sitemap-urls', async (req, res) => {
  try {
    const { sitemapUrl, maxUrls } = req.body;
    if (!sitemapUrl) {
      return res.status(400).json({ error: 'sitemapUrl zorunlu.' });
    }
    const urls = await getCachedSitemap(sitemapUrl, maxUrls || SITEMAP_MAX_URLS);
    res.json({
      sitemapUrl,
      domain: getDomainFromUrl(sitemapUrl),
      count: urls.length,
      urls,
    });
  } catch (e) { handleError(res, e, 'SITEMAP-URLS'); }
});

// ─────────────────────────────────────────────
// İÇ LİNK ENDPOİNTİ
// ─────────────────────────────────────────────

// POST /internal-link-suggestions
app.post('/internal-link-suggestions', async (req, res) => {
  try {
    const {
      topic, currentUrl, sitemapUrl,
      limit = 8, maxUrls = SITEMAP_MAX_URLS,
    } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic zorunlu.' });
    if (!sitemapUrl) return res.status(400).json({ error: 'sitemapUrl zorunlu.' });
    if (currentUrl) requireAllowedDomain(currentUrl, 'currentUrl');

    const urls = await getCachedSitemap(sitemapUrl, maxUrls);
    const suggestions = urls
      .map(item => ({ ...item, score: scoreLink(item, topic, currentUrl) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ url, lastmod, titleFromSlug, score }) => ({
        url, lastmod, titleFromSlug, anchorSuggestion: titleFromSlug, score,
      }));

    res.json({ topic, sitemapUrl, count: suggestions.length, suggestions });
  } catch (e) { handleError(res, e, 'INTERNAL-LINKS'); }
});

// Geriye dönük uyumluluk — eski endpoint isimleri aynı handler'a yönlendiriliyor
app.post('/internal-link-suggestions-v2', (req, res) => {
  req.url = '/internal-link-suggestions';
  app._router.handle(req, res, () => {});
});

// ─────────────────────────────────────────────
// SAYFA SEO AUDIT
// ─────────────────────────────────────────────

// POST /page-seo-audit
app.post('/page-seo-audit', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url zorunlu.' });
    requireAllowedDomain(url, 'url');

    const response = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/2.0)' },
    });

    const $ = cheerio.load(response.data);

    const title = $('title').first().text().trim();
    const metaDescription = $('meta[name="description"]').attr('content')?.trim() || '';
    const canonical = $('link[rel="canonical"]').attr('href')?.trim() || '';
    const robots = $('meta[name="robots"]').attr('content')?.trim() || '';
    const h1List = $('h1').map((_, el) => $(el).text().trim()).get();
    const h2List = $('h2').map((_, el) => $(el).text().trim()).get();

    const issues = [];
    if (!title) issues.push('title eksik');
    else if (title.length < 30) issues.push('title çok kısa (<30 karakter)');
    else if (title.length > 65) issues.push('title çok uzun (>65 karakter)');
    if (!metaDescription) issues.push('meta description eksik');
    else if (metaDescription.length < 80) issues.push('meta description çok kısa (<80 karakter)');
    else if (metaDescription.length > 165) issues.push('meta description çok uzun (>165 karakter)');
    if (!canonical) issues.push('canonical tag eksik');
    if (h1List.length === 0) issues.push('H1 eksik');
    if (h1List.length > 1) issues.push(`Birden fazla H1 (${h1List.length} adet)`);

    res.json({
      url,
      seo: {
        title,
        titleLength: title.length,
        metaDescription,
        metaDescriptionLength: metaDescription.length,
        canonical,
        robots,
        h1: h1List,
        h1Count: h1List.length,
        h2: h2List,
        h2Count: h2List.length,
      },
      issues,
      issueCount: issues.length,
    });
  } catch (e) { handleError(res, e, 'PAGE-SEO-AUDIT'); }
});

// ─────────────────────────────────────────────
// SAYFA DERİN ANALİZ
// ─────────────────────────────────────────────

// POST /page-deep-analysis — GSC + SEO audit + iç link paralel
app.post('/page-deep-analysis', async (req, res) => {
  try {
    const {
      siteUrl, sitemapUrl, pageUrl,
      startDate, endDate, rowLimit = 5000,
    } = req.body;
    if (!siteUrl || !pageUrl || !startDate || !endDate) {
      return res.status(400).json({ error: 'siteUrl, pageUrl, startDate, endDate zorunlu.' });
    }
    requireAllowedDomain(pageUrl, 'pageUrl');

    // Paralel veri çekimi
    const topic = slugToTitle(pageUrl).toLowerCase();
    const [gscPageData, gscAllRows, auditRes, sitemapUrls] = await Promise.all([
      // Sayfanın genel metrikleri
      gscQuery({ siteUrl, startDate, endDate, dimensions: ['page'], rowLimit: 5000 }),
      // Sayfanın sorgu detayları
      gscQuery({ siteUrl, startDate, endDate, dimensions: ['query', 'page'], rowLimit }),
      // SEO audit
      axios.get(pageUrl, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/2.0)' },
      }),
      // Sitemap (iç link için)
      sitemapUrl ? getCachedSitemap(sitemapUrl, SITEMAP_MAX_URLS) : Promise.resolve([]),
    ]);

    // Sayfa metrikleri
    const normPage = normalizeUrlForCompare(pageUrl);
    const pageRow = gscPageData
      .map(r => mapGscRow(r, ['page']))
      .find(r => normalizeUrlForCompare(r.page) === normPage) || {};

    // Sorgu metrikleri
    const queries = gscAllRows
      .map(r => mapGscRow(r, ['query', 'page']))
      .filter(r => normalizeUrlForCompare(r.page) === normPage)
      .sort((a, b) => b.impressions - a.impressions);

    // SEO audit
    const $ = cheerio.load(auditRes.data);
    const title = $('title').first().text().trim();
    const metaDescription = $('meta[name="description"]').attr('content')?.trim() || '';
    const canonical = $('link[rel="canonical"]').attr('href')?.trim() || '';
    const robots = $('meta[name="robots"]').attr('content')?.trim() || '';
    const h1List = $('h1').map((_, el) => $(el).text().trim()).get();
    const h2List = $('h2').map((_, el) => $(el).text().trim()).get();

    // Sorgu sınıflandırması
    const primaryTarget = queries.filter(q => q.position <= 5 && q.clicks > 0);
    const h2Candidates = queries.filter(q => q.position > 5 && q.position <= 20 && q.impressions >= 50);
    const faqCandidates = queries.filter(q => {
      const w = q.query.toLowerCase();
      return w.startsWith('how') || w.startsWith('what') || w.startsWith('can') ||
             w.startsWith('is') || w.startsWith('why') || w.startsWith('when') || w.includes('?');
    });
    const titleOpportunities = queries.filter(q => q.impressions >= 200 && q.ctr < 0.03);

    // İç link önerileri
    const internalLinks = sitemapUrls.length
      ? sitemapUrls
          .map(item => ({ ...item, score: scoreLink(item, topic, pageUrl) }))
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 8)
          .map(({ url, titleFromSlug, score }) => ({ url, titleFromSlug, score }))
      : [];

    // Aksiyon listesi
    const actionPlan = [];
    if (title.length < 30 || title.length > 65) actionPlan.push('Title uzunluğunu 40-65 karakter arasına getir');
    if (titleOpportunities.length) {
      actionPlan.push(`Title fırsatı: "${titleOpportunities[0].query}" ifadesini title'a ekle`);
    }
    if (faqCandidates.length) {
      actionPlan.push(`FAQ bölümü ekle: ${faqCandidates.slice(0, 3).map(q => `"${q.query}"`).join(', ')}`);
    }
    if (h2Candidates.length) {
      actionPlan.push(`H2 başlık ekle: ${h2Candidates.slice(0, 2).map(q => `"${q.query}"`).join(', ')}`);
    }
    if (internalLinks.length) {
      actionPlan.push(`${internalLinks.length} iç link ekle`);
    }
    if (metaDescription.length < 80) actionPlan.push('Meta description çok kısa, yeniden yaz');

    res.json({
      pageUrl,
      performance: {
        clicks: pageRow.clicks || 0,
        impressions: pageRow.impressions || 0,
        ctr: pageRow.ctr || 0,
        avgPosition: pageRow.position || 0,
      },
      seo: {
        title, titleLength: title.length,
        metaDescription, metaDescriptionLength: metaDescription.length,
        canonical, robots,
        h1: h1List, h1Count: h1List.length,
        h2: h2List, h2Count: h2List.length,
      },
      queries: {
        total: queries.length,
        all: queries,
        primaryTarget,
        h2Candidates,
        faqCandidates,
        titleOpportunities,
      },
      internalLinks,
      actionPlan,
    });
  } catch (e) { handleError(res, e, 'PAGE-DEEP-ANALYSIS'); }
});

// ─────────────────────────────────────────────
// SİTE ÖZETİ
// ─────────────────────────────────────────────

// POST /site-summary — 90 günlük site geneli analiz
app.post('/site-summary', async (req, res) => {
  try {
    const {
      siteUrl, sitemapUrl, propertyId,
      startDate, endDate,
    } = req.body;

    const dates = (startDate && endDate)
      ? { startDate, endDate }
      : dateRange(90);

    if (!siteUrl) return res.status(400).json({ error: 'siteUrl zorunlu.' });

    // Paralel veri çekimi
    const [gscPages, ga4Result, sitemapUrls] = await Promise.all([
      gscQuery({
        siteUrl,
        startDate: dates.startDate,
        endDate: dates.endDate,
        dimensions: ['page'],
        rowLimit: 5000,
      }),
      propertyId || process.env.GA4_PROPERTY_ID
        ? ga4Report({
            propertyId,
            startDate: dates.startDate,
            endDate: dates.endDate,
            dimensions: ['landingPagePlusQueryString'],
            metrics: ['sessions', 'activeUsers'],
            orderBy: 'sessions',
            rowLimit: 500,
          })
        : Promise.resolve(null),
      sitemapUrl ? getCachedSitemap(sitemapUrl, SITEMAP_MAX_URLS) : Promise.resolve([]),
    ]);

    const pages = gscPages.map(r => mapGscRow(r, ['page']));

    // Toplam metrikler
    const totalClicks = pages.reduce((s, r) => s + r.clicks, 0);
    const totalImpressions = pages.reduce((s, r) => s + r.impressions, 0);
    const avgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
    const avgPosition = pages.length > 0
      ? pages.reduce((s, r) => s + r.position, 0) / pages.length
      : 0;

    // Segmentler
    const contentPages = pages.filter(r => !isLowValueUrl(r.page));

    const winners = contentPages
      .filter(r => r.clicks > 50 && r.ctr > 0.05 && r.position < 10)
      .sort((a, b) => b.clicks - a.clicks).slice(0, 10);

    const lowCtrPages = contentPages
      .filter(r => r.impressions >= 100 && r.ctr < 0.03 && r.clicks > 0)
      .sort((a, b) => b.impressions - a.impressions).slice(0, 20);

    const opportunityPages = contentPages
      .filter(r => r.position >= 5 && r.position <= 20 && r.impressions >= 50)
      .sort((a, b) => a.position - b.position).slice(0, 20);

    const zeroClickPages = contentPages
      .filter(r => r.clicks === 0 && r.impressions >= 10)
      .sort((a, b) => b.impressions - a.impressions).slice(0, 20);

    // Sitemap'te var ama GSC'de yok (ölü içerikler)
    const gscPageUrls = new Set(pages.map(r => normalizeUrlForCompare(r.page)));
    const deadPages = sitemapUrls
      .filter(s => !isLowValueUrl(s.url) && !gscPageUrls.has(normalizeUrlForCompare(s.url)))
      .slice(0, 20);

    // GA4 ile çapraz kontrol
    let gscOnlyPages = [];
    if (ga4Result) {
      const ga4Urls = new Set(
        ga4Result.rows
          .map(r => normalizeUrlForCompare(r.dimensionValues?.[0]?.value || ''))
          .filter(Boolean)
      );
      gscOnlyPages = contentPages
        .filter(r => r.clicks > 10 && !ga4Urls.has(normalizeUrlForCompare(r.page)))
        .slice(0, 10)
        .map(r => ({ ...r, note: 'GSC tıklama var ama GA4 oturumu yok' }));
    }

    res.json({
      siteUrl,
      period: { startDate: dates.startDate, endDate: dates.endDate },
      overview: {
        totalClicks,
        totalImpressions,
        avgCtr: parseFloat(avgCtr.toFixed(4)),
        avgPosition: parseFloat(avgPosition.toFixed(1)),
        indexedPageCount: contentPages.length,
        sitemapUrlCount: sitemapUrls.length,
      },
      segments: {
        winners,
        lowCtrPages,
        opportunityPages,
        zeroClickPages,
        deadPages,
        gscOnlyPages,
      },
    });
  } catch (e) { handleError(res, e, 'SITE-SUMMARY'); }
});

// ─────────────────────────────────────────────
// İÇERİK PLANI
// ─────────────────────────────────────────────

// POST /content-plan — yeni makale için veri destekli plan
app.post('/content-plan', async (req, res) => {
  try {
    const {
      siteUrl, sitemapUrl, topic,
      startDate, endDate,
    } = req.body;
    if (!siteUrl || !topic) {
      return res.status(400).json({ error: 'siteUrl ve topic zorunlu.' });
    }

    const dates = (startDate && endDate) ? { startDate, endDate } : dateRange(90);
    const normTopic = normalizeText(topic);
    const tokens = expandTokens(topic);

    const [gscRows, sitemapUrls] = await Promise.all([
      gscQuery({
        siteUrl,
        startDate: dates.startDate,
        endDate: dates.endDate,
        dimensions: ['query'],
        rowLimit: 5000,
      }),
      sitemapUrl ? getCachedSitemap(sitemapUrl, SITEMAP_MAX_URLS) : Promise.resolve([]),
    ]);

    // Sitemap'te benzer içerik var mı?
    const existingPages = sitemapUrls
      .filter(s => {
        const searchable = normalizeText(`${s.url} ${s.titleFromSlug}`);
        return tokens.some(t => searchable.includes(t));
      })
      .map(s => ({ url: s.url, title: s.titleFromSlug }));

    // GSC'de ilişkili sorgular
    const relatedQueries = gscRows
      .map(r => mapGscRow(r, ['query']))
      .filter(r => tokens.some(t => normalizeText(r.query).includes(t)))
      .sort((a, b) => b.impressions - a.impressions);

    const primaryKeyword = relatedQueries.length
      ? relatedQueries[0].query
      : topic;

    const longtailQueries = relatedQueries
      .filter(q => q.query.split(' ').length >= 3)
      .slice(0, 10)
      .map(q => q.query);

    // Karar: yaz mı, revize et mi?
    let decision, reason;
    if (existingPages.length === 0) {
      decision = 'write_new';
      reason = `Sitemap'te "${topic}" için içerik bulunamadı.`;
    } else if (existingPages.length === 1) {
      decision = 'revise_existing';
      reason = `"${existingPages[0].title}" sayfası mevcut. Yeni yazmak yerine revize etmek daha verimli.`;
    } else {
      decision = 'merge_or_write_new';
      reason = `${existingPages.length} benzer içerik mevcut. Birleştirme veya yeni canonical strateji önerilir.`;
    }

    // Slug ve yapı önerisi
    const slug = tokens.slice(0, 4).join('-') || normTopic.replace(/\s+/g, '-');
    const titleCase = s => s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const suggestedH1 = `Authentic ${titleCase(topic)} (Step-by-Step)`;
    const suggestedTitle = `${titleCase(topic)}: How to Make It at Home | ${getDomainFromUrl(siteUrl).split('.')[0].toUpperCase()}`;
    const suggestedMeta = `Learn how to make authentic ${topic.toLowerCase()} with this easy step-by-step recipe. Tips, variations, and serving suggestions included.`;

    // İç link önerileri
    const internalLinks = sitemapUrls.length
      ? sitemapUrls
          .map(item => ({ ...item, score: scoreLink(item, topic, '') }))
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 6)
          .map(({ url, titleFromSlug }) => ({ url, titleFromSlug }))
      : [];

    // FAQ önerileri (sorgu bazlı)
    const faqSuggestions = relatedQueries
      .filter(q => {
        const w = q.query.toLowerCase();
        return w.startsWith('how') || w.startsWith('what') || w.startsWith('can') ||
               w.startsWith('is') || w.startsWith('why') || w.includes('?');
      })
      .slice(0, 5)
      .map(q => q.query);

    res.json({
      topic,
      decision: { action: decision, reason, existingPages },
      keyword: {
        primary: primaryKeyword,
        longtail: longtailQueries,
        gscRelatedQueries: relatedQueries.slice(0, 20),
      },
      structure: {
        suggestedSlug: slug,
        h1: suggestedH1,
        seoTitle: suggestedTitle,
        metaDescription: suggestedMeta,
        sections: [
          `What is ${titleCase(topic)}?`,
          'Ingredients',
          `How to Make ${titleCase(topic)}`,
          'Expert Tips',
          'Common Mistakes',
          'Serving Suggestions',
          'Storage & Reheating',
          'FAQ',
        ],
        faqSuggestions,
      },
      internalLinks,
    });
  } catch (e) { handleError(res, e, 'CONTENT-PLAN'); }
});

// ─────────────────────────────────────────────
// REVİZYON ANALİZİ
// ─────────────────────────────────────────────

// POST /revision-analysis — revize/sil/birleştir kararı
app.post('/revision-analysis', async (req, res) => {
  try {
    const {
      siteUrl, sitemapUrl, pageUrl,
      startDate, endDate,
    } = req.body;
    if (!siteUrl || !pageUrl) {
      return res.status(400).json({ error: 'siteUrl ve pageUrl zorunlu.' });
    }
    requireAllowedDomain(pageUrl, 'pageUrl');

    const dates = (startDate && endDate) ? { startDate, endDate } : dateRange(90);

    const [gscAllRows, gscPageRows, auditRes, sitemapUrls] = await Promise.all([
      gscQuery({
        siteUrl,
        startDate: dates.startDate,
        endDate: dates.endDate,
        dimensions: ['query', 'page'],
        rowLimit: 5000,
      }),
      gscQuery({
        siteUrl,
        startDate: dates.startDate,
        endDate: dates.endDate,
        dimensions: ['page'],
        rowLimit: 5000,
      }),
      axios.get(pageUrl, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOAuditBot/2.0)' },
      }),
      sitemapUrl ? getCachedSitemap(sitemapUrl, SITEMAP_MAX_URLS) : Promise.resolve([]),
    ]);

    const normPage = normalizeUrlForCompare(pageUrl);

    const pageMetrics = gscPageRows
      .map(r => mapGscRow(r, ['page']))
      .find(r => normalizeUrlForCompare(r.page) === normPage) || {};

    const queries = gscAllRows
      .map(r => mapGscRow(r, ['query', 'page']))
      .filter(r => normalizeUrlForCompare(r.page) === normPage)
      .sort((a, b) => b.impressions - a.impressions);

    // SEO audit
    const $ = cheerio.load(auditRes.data);
    const title = $('title').first().text().trim();
    const metaDescription = $('meta[name="description"]').attr('content')?.trim() || '';
    const h1List = $('h1').map((_, el) => $(el).text().trim()).get();

    // Sorun tespiti
    const problems = {
      titleIssue: !title || title.length < 30 || title.length > 65,
      metaIssue: !metaDescription || metaDescription.length < 80 || metaDescription.length > 165,
      h1Issue: h1List.length !== 1,
      contentGap: queries.filter(q => q.position > 10 && q.impressions > 50).length > 3,
      intentMismatch: false, // Manuel değerlendirme gerekir; faq sorgularından tahmin
      internalLinkGap: sitemapUrls.length > 0,
    };

    // Skor hesabı (0-100)
    const { clicks = 0, impressions = 0, ctr = 0, position = 0 } = pageMetrics;
    let score = 0;
    if (clicks > 50) score += 20;
    else if (clicks > 10) score += 10;
    if (impressions > 500) score += 20;
    else if (impressions > 100) score += 10;
    if (position <= 10) score += 20;
    else if (position <= 20) score += 10;
    if (queries.length > 5) score += 20;
    if (!problems.titleIssue) score += 10;
    if (!problems.metaIssue) score += 10;

    // Karar
    let decision;
    if (score >= 60) decision = 'revise';
    else if (score >= 30) decision = 'rewrite';
    else if (impressions < 10 && clicks === 0) decision = 'delete';
    else decision = 'merge_or_rewrite';

    // Sorgu sınıflandırması
    const keepQueries = queries.filter(q => q.clicks > 0 || q.position <= 10);
    const addSections = queries.filter(q => q.position > 10 && q.impressions > 30);
    const dropQueries = queries.filter(q => q.impressions < 5 && q.clicks === 0);

    // Aksiyon listesi
    const actionList = [];
    if (problems.titleIssue) actionList.push('Title yeniden yaz (40-65 karakter)');
    if (problems.metaIssue) actionList.push('Meta description güncelle (80-165 karakter)');
    if (problems.h1Issue) actionList.push(`H1 ${h1List.length === 0 ? 'eksik, ekle' : 'birden fazla, birleştir'}`);
    if (addSections.length) {
      actionList.push(`Yeni bölüm ekle: ${addSections.slice(0, 3).map(q => `"${q.query}"`).join(', ')}`);
    }
    if (problems.internalLinkGap) actionList.push('İç link eksikliği kontrol edilmeli');

    res.json({
      pageUrl,
      performance: { clicks, impressions, ctr, position: parseFloat(position.toFixed(1)) },
      seo: { title, metaDescription, h1: h1List },
      verdict: { decision, score, worthRevising: score >= 30 },
      problems,
      queryAnalysis: {
        total: queries.length,
        keepQueries: keepQueries.slice(0, 20),
        addSections: addSections.slice(0, 10),
        dropQueries: dropQueries.slice(0, 10),
      },
      actionList,
    });
  } catch (e) { handleError(res, e, 'REVISION-ANALYSIS'); }
});

// ─────────────────────────────────────────────
// 404 HANDLER
// ─────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint bulunamadı.',
    path: req.path,
    method: req.method,
    hint: 'Mevcut endpointler için GET /routes isteği gönder.',
  });
});

// ─────────────────────────────────────────────
// SERVER
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SEO API v2.0 çalışıyor → port ${PORT}`);
  console.log(`İzinli domainler: ${getAllowedDomains().join(', ')}`);
});
