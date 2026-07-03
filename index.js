'use strict';

/**
 * ═══════════════════════════════════════════════════════════════
 *  Multi-Site SEO API  v2.0
 *  Render üzerinde çalışır — Node.js 18+
 * ═══════════════════════════════════════════════════════════════
 *
 *  Kurulum:
 *    npm install
 *
 *  Zorunlu ENV (Render → Environment):
 *    GOOGLE_CREDENTIALS   → Service account JSON tek satır string
 *    GA4_PROPERTY_ID      → Varsayılan GA4 property ID (opsiyonel)
 *    ALLOWED_DOMAINS      → turkishdishes.net,saglikliturkiye.net
 *    PORT                 → Render otomatik set eder
 *
 *  Endpointler:
 *  GET  /  /health  /routes
 *  POST /gsc-data  /gsc-pages  /gsc-query-pages
 *  POST /gsc-pages-zero-clicks  /gsc-top-pages  /gsc-page-queries
 *  POST /gsc-pages-low-ctr  /gsc-pages-position-5-20
 *  POST /ga4-pages  /ga4-traffic
 *  POST /sitemap-urls  /internal-link-suggestions
 *  POST /page-seo-audit  /page-deep-analysis
 *  POST /site-summary  /content-plan  /revision-analysis
 * ═══════════════════════════════════════════════════════════════
 */

const express    = require('express');
const { google } = require('googleapis');
const axios      = require('axios');
const { parseStringPromise } = require('xml2js');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const cheerio    = require('cheerio');
const cors       = require('cors');
const { getMemory, addMemoryEntry, getSummary } = require("./project-memory-store");
const app = express();          // önce app oluştur
app.use(cors());                 // sonra cors
app.use(express.json({ limit: '2mb' }));

// ──────────────────────────────────────────────────────────────
// SABITLER
// ──────────────────────────────────────────────────────────────

const CACHE_TTL_MS     = 30 * 60 * 1000;
const GSC_MAX_ROWS     = 5000;
const GA4_MAX_ROWS     = 1000;
const SITEMAP_MAX_URLS = 5000;
const DEFAULT_DOMAINS  = ['turkishdishes.net', 'saglikliturkiye.net'];

// ──────────────────────────────────────────────────────────────
// CACHE
// ──────────────────────────────────────────────────────────────

const _cache = new Map();
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { _cache.set(key, { ts: Date.now(), data }); }

// ──────────────────────────────────────────────────────────────
// DOMAIN DOĞRULAMA
// ──────────────────────────────────────────────────────────────

function normDomain(s = '') {
  return String(s).toLowerCase().trim()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}
function getAllowedDomains() {
  const env = process.env.ALLOWED_DOMAINS;
  if (!env) return DEFAULT_DOMAINS;
  return env.split(',').map(normDomain).filter(Boolean);
}
function domainFromUrl(url = '') {
  const s = String(url).trim();
  if (s.startsWith('sc-domain:')) return normDomain(s.replace('sc-domain:', ''));
  try { return normDomain(new URL(s).hostname); } catch { return ''; }
}
function isAllowed(url = '') { return getAllowedDomains().includes(domainFromUrl(url)); }
function requireAllowed(url, field = 'url') {
  if (!url) throw new Error(`${field} zorunludur.`);
  if (!isAllowed(url))
    throw new Error(`${field} için izinsiz domain. İzinliler: ${getAllowedDomains().join(', ')}`);
}

// ──────────────────────────────────────────────────────────────
// GOOGLE AUTH (lazy)
// ──────────────────────────────────────────────────────────────

let _creds = null;
let _ga4   = null;

function getCreds() {
  if (_creds) return _creds;
  if (!process.env.GOOGLE_CREDENTIALS) throw new Error('GOOGLE_CREDENTIALS env eksik.');
  try { _creds = JSON.parse(process.env.GOOGLE_CREDENTIALS); return _creds; }
  catch (e) { throw new Error('GOOGLE_CREDENTIALS geçersiz JSON: ' + e.message); }
}
function gscAuth() {
  return new google.auth.GoogleAuth({
    credentials: getCreds(),
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  });
}
function ga4Client() {
  if (!_ga4) _ga4 = new BetaAnalyticsDataClient({ credentials: getCreds() });
  return _ga4;
}
function resolvePropertyId(id) {
  const pid = id || process.env.GA4_PROPERTY_ID;
  if (!pid) throw new Error('propertyId zorunlu veya GA4_PROPERTY_ID env set edilmeli.');
  return String(pid).replace(/^properties\//, '').trim();
}

// ──────────────────────────────────────────────────────────────
// YARDIMCILAR
// ──────────────────────────────────────────────────────────────

const toNum = v => { const n = Number(v); return isFinite(n) ? n : 0; };
function safeLimit(v, fallback, max) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}
function normUrl(u) { return String(u || '').trim().toLowerCase().replace(/\/$/, ''); }
function normText(s = '') {
  return String(s).toLowerCase()
    .replace(/ı/g,'i').replace(/ğ/g,'g').replace(/ü/g,'u')
    .replace(/ş/g,'s').replace(/ö/g,'o').replace(/ç/g,'c')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}
function isLowValue(url) {
  return ['/wp-','/wp-content/','/feed','/tag/','/author/',
          '/attachment/','/page/','/newsletter/','/privacy-policy',
          '/user-policy','/about-us']
    .some(p => url.includes(p)) || url.includes('?') || url.includes('#');
}
function slugToTitle(url) {
  try {
    const slug = new URL(url).pathname.replace(/^\/|\/$/g,'').split('/').pop() || '';
    if (!slug) return 'Homepage';
    return slug.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  } catch { return url; }
}
function toArr(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }
function defaultDates(start, end, days=90) {
  return { startDate: start || daysAgo(days), endDate: end || new Date().toISOString().slice(0,10) };
}
async function loadProjectContextSafe() {
  try {
    const summary = await getSummary();
    return {
      status: "available",
      summary
    };
  } catch (e) {
    return {
      status: "unavailable",
      error: e.message
    };
  }
}

// ──────────────────────────────────────────────────────────────
// GSC SERVİSİ
// ──────────────────────────────────────────────────────────────

async function gscQuery({ siteUrl, startDate, endDate, dimensions, rowLimit }) {
  requireAllowed(siteUrl, 'siteUrl');
  const auth   = gscAuth();
  const client = await auth.getClient();
  const sc     = google.searchconsole({ version: 'v1', auth: client });
  const body   = {
    startDate, endDate,
    dimensions: Array.isArray(dimensions) && dimensions.length ? dimensions : ['query'],
    rowLimit: safeLimit(rowLimit, 1000, GSC_MAX_ROWS),
  };
  const res = await sc.searchanalytics.query({ siteUrl, requestBody: body });
  return res.data.rows || [];
}
function mapRow(row, dims) {
  const o = {};
  (dims||[]).forEach((d,i) => { o[d] = row.keys?.[i] || ''; });
  o.clicks      = toNum(row.clicks);
  o.impressions = toNum(row.impressions);
  o.ctr         = toNum(row.ctr);
  o.position    = toNum(row.position);
  return o;
}

// ──────────────────────────────────────────────────────────────
// GA4 SERVİSİ
// ──────────────────────────────────────────────────────────────

async function ga4Report({ propertyId, startDate, endDate, dimensions, metrics, orderBy, rowLimit }) {
  const pid    = resolvePropertyId(propertyId);
  const client = ga4Client();
  const [res]  = await client.runReport({
    property:   `properties/${pid}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: dimensions.map(n => ({ name: n })),
    metrics:    metrics.map(n => ({ name: n })),
    orderBys:   orderBy ? [{ metric: { metricName: orderBy }, desc: true }] : [],
    limit:      safeLimit(rowLimit, 100, GA4_MAX_ROWS),
  });
  return { propertyId: pid, rows: res.rows || [] };
}

// ──────────────────────────────────────────────────────────────
// SİTEMAP SERVİSİ
// ──────────────────────────────────────────────────────────────

async function fetchXml(url) {
  requireAllowed(url, 'sitemapUrl');
  const res = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'MultiSiteSEOAPI/2.0', Accept: 'application/xml,text/xml,*/*' },
  });
  return res.data;
}
async function parseSitemap(sitemapUrl, visited=new Set(), max=SITEMAP_MAX_URLS) {
  requireAllowed(sitemapUrl, 'sitemapUrl');
  if (visited.has(sitemapUrl)) return [];
  visited.add(sitemapUrl);
  const xml    = await fetchXml(sitemapUrl);
  const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true });
  let urls = [];
  if (parsed.sitemapindex?.sitemap) {
    for (const s of toArr(parsed.sitemapindex.sitemap)) {
      if (urls.length >= max) break;
      const child = s.loc;
      if (!child || !isAllowed(child)) continue;
      urls = urls.concat(await parseSitemap(child, visited, max-urls.length));
    }
  }
  if (parsed.urlset?.url) {
    for (const item of toArr(parsed.urlset.url)) {
      if (urls.length >= max) break;
      if (!item.loc || !isAllowed(item.loc)) continue;
      urls.push({ url: item.loc, lastmod: item.lastmod||null, titleFromSlug: slugToTitle(item.loc) });
    }
  }
  return urls;
}
async function getSitemap(sitemapUrl, max=SITEMAP_MAX_URLS) {
  requireAllowed(sitemapUrl, 'sitemapUrl');
  const key    = `sitemap:${sitemapUrl}:${max}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data   = await parseSitemap(sitemapUrl, new Set(), max);
  cacheSet(key, data);
  return data;
}

// ──────────────────────────────────────────────────────────────
// İÇ LİNK SCORING
// ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'recipe','authentic','traditional','turkish','easy','homemade',
  'how','make','with','and','the','for','from','tarifi','yemek','dish','food','health',
]);
function tokens(topic) {
  return [...new Set(
    normText(topic).split(/[^a-z0-9]+/i).map(t=>t.trim())
      .filter(t=>t.length>=3 && !STOPWORDS.has(t))
  )];
}
function scoreLink(item, topic, currentUrl='') {
  if (currentUrl && normUrl(item.url)===normUrl(currentUrl)) return -999;
  const s = normText(`${item.url} ${item.titleFromSlug}`);
  if (isLowValue(s)) return -999;
  const toks = tokens(topic);
  const nt   = normText(topic);
  let score  = 0;
  for (const t of toks) { if (s.includes(t)) score+=10; }
  const dessertW = ['dessert','sweet','baklava','kunefe','kadayif','halva','sutlac','pudding','cake'];
  const savoryW  = ['kebab','soup','corba','salad','chicken','lamb','beef','meat'];
  if (dessertW.some(w=>nt.includes(w))) {
    if (dessertW.some(w=>s.includes(w))) score+=5;
    if (savoryW.some(w=>s.includes(w)))  score-=8;
  }
  if (nt.includes('soup')  && s.includes('soup'))  score+=5;
  if (nt.includes('kebab') && s.includes('kebab')) score+=5;
  const hubs=['/desserts','/soups','/kebab','/breakfast','/dinner','/turkish','/category'];
  if (score>0 && hubs.some(h=>s.includes(h))) score+=2;
  return score;
}

// ──────────────────────────────────────────────────────────────
// HATA YÖNETİMİ
// ──────────────────────────────────────────────────────────────

function fail(res, err, label='ERROR') {
  const msg = err?.message || String(err);
  console.error(`[${label}]`, msg);
  res.status(500).json({ error: msg });
}

// ──────────────────────────────────────────────────────────────
// TEMEL ROTALAR
// ──────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.json({
  status:'ok', service:'multi-site-seo-api', version:'2.0.0',
  allowedDomains: getAllowedDomains(), time: new Date().toISOString(),
}));
app.get('/health', (_req, res) => res.json({
  status:'ok', uptime: Math.floor(process.uptime()),
  allowedDomains: getAllowedDomains(), time: new Date().toISOString(),
}));
app.get('/routes', (_req, res) => res.json({ routes:[
  'GET  /', 'GET  /health', 'GET  /routes',
  'POST /gsc-data', 'POST /gsc-pages', 'POST /gsc-query-pages',
  'POST /gsc-pages-zero-clicks', 'POST /gsc-top-pages', 'POST /gsc-page-queries',
  'POST /gsc-pages-low-ctr', 'POST /gsc-pages-position-5-20',
  'POST /ga4-pages', 'POST /ga4-traffic',
  "POST /project-memory",
  "POST /memory-add",
  "POST /memory-summary",
  "POST /project-context",
  "POST /project-log",
  'POST /article-engine',
  'POST /sitemap-urls', 'POST /internal-link-suggestions',
  'POST /page-seo-audit', 'POST /page-deep-analysis',
  'POST /site-summary', 'POST /content-plan', 'POST /revision-analysis',
]}));

// ──────────────────────────────────────────────────────────────
// GSC ENDPOİNTLERİ
// ──────────────────────────────────────────────────────────────

app.post('/gsc-data', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, dimensions, rowLimit } = req.body;
    if (!siteUrl||!startDate||!endDate)
      return res.status(400).json({ error:'siteUrl, startDate, endDate zorunlu.' });
    const dims = Array.isArray(dimensions)&&dimensions.length ? dimensions : ['query'];
    const rows = await gscQuery({ siteUrl, startDate, endDate, dimensions:dims, rowLimit });
    res.json({ siteUrl, startDate, endDate, dimensions:dims, count:rows.length,
      rows: rows.map(r=>mapRow(r,dims)) });
  } catch(e) { fail(res,e,'GSC-DATA'); }
});

app.post('/gsc-pages', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, rowLimit } = req.body;
    if (!siteUrl||!startDate||!endDate)
      return res.status(400).json({ error:'siteUrl, startDate, endDate zorunlu.' });
    const dims=['page'];
    const rows = await gscQuery({ siteUrl, startDate, endDate, dimensions:dims, rowLimit });
    res.json({ siteUrl, startDate, endDate, count:rows.length, rows:rows.map(r=>mapRow(r,dims)) });
  } catch(e) { fail(res,e,'GSC-PAGES'); }
});

app.post('/gsc-query-pages', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate, rowLimit } = req.body;
    if (!siteUrl||!startDate||!endDate)
      return res.status(400).json({ error:'siteUrl, startDate, endDate zorunlu.' });
    const dims=['query','page'];
    const rows = await gscQuery({ siteUrl, startDate, endDate, dimensions:dims, rowLimit });
    res.json({ siteUrl, startDate, endDate, count:rows.length, rows:rows.map(r=>mapRow(r,dims)) });
  } catch(e) { fail(res,e,'GSC-QUERY-PAGES'); }
});

app.post('/gsc-pages-zero-clicks', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate,
      rowLimit=5000, minImpressions=1, postsOnly=true } = req.body;
    if (!siteUrl||!startDate||!endDate)
      return res.status(400).json({ error:'siteUrl, startDate, endDate zorunlu.' });
    const dims=['page'];
    const raw  = await gscQuery({ siteUrl, startDate, endDate, dimensions:dims, rowLimit });
    const rows = raw.map(r=>mapRow(r,dims))
      .filter(r=>r.clicks===0 && r.impressions>=Number(minImpressions))
      .filter(r=>!postsOnly||!isLowValue(r.page))
      .sort((a,b)=>b.impressions-a.impressions);
    res.json({ siteUrl, startDate, endDate, minImpressions:Number(minImpressions),
      postsOnly:Boolean(postsOnly), count:rows.length, rows });
  } catch(e) { fail(res,e,'GSC-ZERO-CLICKS'); }
});

app.post('/gsc-top-pages', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate,
      rowLimit=100, minClicks=1, postsOnly=true } = req.body;
    if (!siteUrl||!startDate||!endDate)
      return res.status(400).json({ error:'siteUrl, startDate, endDate zorunlu.' });
    const dims=['page'];
    const raw  = await gscQuery({ siteUrl, startDate, endDate, dimensions:dims, rowLimit });
    const rows = raw.map(r=>mapRow(r,dims))
      .filter(r=>r.clicks>=Number(minClicks))
      .filter(r=>!postsOnly||!isLowValue(r.page))
      .sort((a,b)=>b.clicks-a.clicks);
    res.json({ siteUrl, startDate, endDate, minClicks:Number(minClicks),
      postsOnly:Boolean(postsOnly), count:rows.length, rows });
  } catch(e) { fail(res,e,'GSC-TOP-PAGES'); }
});

app.post('/gsc-page-queries', async (req, res) => {
  try {
    const { siteUrl, pageUrl, startDate, endDate, rowLimit=5000 } = req.body;
    if (!siteUrl||!pageUrl||!startDate||!endDate)
      return res.status(400).json({ error:'siteUrl, pageUrl, startDate, endDate zorunlu.' });
    requireAllowed(pageUrl,'pageUrl');
    const dims=['query','page'];
    const raw    = await gscQuery({ siteUrl, startDate, endDate, dimensions:dims, rowLimit });
    const target = normUrl(pageUrl);
    const rows   = raw.map(r=>mapRow(r,dims))
      .filter(r=>normUrl(r.page)===target)
      .sort((a,b)=>b.impressions-a.impressions);
    res.json({ siteUrl, pageUrl, startDate, endDate, count:rows.length, rows });
  } catch(e) { fail(res,e,'GSC-PAGE-QUERIES'); }
});

app.post('/gsc-pages-low-ctr', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate,
      maxCtr=0.03, minImpressions=100, rowLimit=5000, postsOnly=true } = req.body;
    if (!siteUrl||!startDate||!endDate)
      return res.status(400).json({ error:'siteUrl, startDate, endDate zorunlu.' });
    const dims=['page'];
    const raw  = await gscQuery({ siteUrl, startDate, endDate, dimensions:dims, rowLimit });
    const rows = raw.map(r=>mapRow(r,dims))
      .filter(r=>r.ctr<=Number(maxCtr) && r.impressions>=Number(minImpressions) && r.clicks>0)
      .filter(r=>!postsOnly||!isLowValue(r.page))
      .sort((a,b)=>b.impressions-a.impressions)
      .map(r=>({ ...r, ctrPercent:(r.ctr*100).toFixed(2)+'%' }));
    res.json({ siteUrl, startDate, endDate, maxCtr:Number(maxCtr),
      minImpressions:Number(minImpressions), count:rows.length, rows });
  } catch(e) { fail(res,e,'GSC-LOW-CTR'); }
});

app.post('/gsc-pages-position-5-20', async (req, res) => {
  try {
    const { siteUrl, startDate, endDate,
      minPosition=5, maxPosition=20, minImpressions=50,
      rowLimit=5000, postsOnly=true } = req.body;
    if (!siteUrl||!startDate||!endDate)
      return res.status(400).json({ error:'siteUrl, startDate, endDate zorunlu.' });
    const dims=['page'];
    const raw  = await gscQuery({ siteUrl, startDate, endDate, dimensions:dims, rowLimit });
    const rows = raw.map(r=>mapRow(r,dims))
      .filter(r=>r.position>=Number(minPosition) && r.position<=Number(maxPosition)
              && r.impressions>=Number(minImpressions))
      .filter(r=>!postsOnly||!isLowValue(r.page))
      .sort((a,b)=>a.position-b.position);
    res.json({ siteUrl, startDate, endDate,
      minPosition:Number(minPosition), maxPosition:Number(maxPosition),
      minImpressions:Number(minImpressions), label:'opportunity_pages',
      count:rows.length, rows });
  } catch(e) { fail(res,e,'GSC-POSITION-5-20'); }
});

app.post("/project-memory", async (req, res) => {
  try {
    const memory = await getMemory();

    res.json({
      status: "ok",
      memory
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/memory-add", async (req, res) => {
  try {
    const entry = await addMemoryEntry(req.body);

    res.json({
      status: "ok",
      saved: entry
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/memory-summary", async (req, res) => {
  try {
    const summary = await getSummary();

    res.json({
      status: "ok",
      summary
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/project-context", async (req, res) => {
  try {
    const memory = await getMemory();
    const summary = await getSummary();

    res.json({
      status: "ok",
      context: {
        memory,
        summary,
        instruction:
          "Use this project context before writing, revising, auditing, linking, or making TurkishDishes editorial decisions."
      }
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/project-log", async (req, res) => {
  try {
    const entry = await addMemoryEntry(req.body);

    res.json({
      status: "ok",
      saved: entry,
      instruction:
        "This project log entry has been saved and should be considered active project memory."
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

// ──────────────────────────────────────────────────────────────
// GA4 ENDPOİNTLERİ
// ──────────────────────────────────────────────────────────────

app.post('/ga4-pages', async (req, res) => {
  try {
    const { propertyId, startDate, endDate, rowLimit=100 } = req.body;
    if (!startDate||!endDate)
      return res.status(400).json({ error:'startDate, endDate zorunlu.' });
    const r = await ga4Report({
      propertyId, startDate, endDate, rowLimit,
      dimensions:['landingPagePlusQueryString','pageTitle'],
      metrics:['screenPageViews','sessions','activeUsers','engagedSessions',
               'engagementRate','averageSessionDuration','bounceRate'],
      orderBy:'sessions',
    });
    const rows = r.rows.map(row=>({
      landingPage:        row.dimensionValues?.[0]?.value||'',
      pageTitle:          row.dimensionValues?.[1]?.value||'',
      views:              toNum(row.metricValues?.[0]?.value),
      sessions:           toNum(row.metricValues?.[1]?.value),
      activeUsers:        toNum(row.metricValues?.[2]?.value),
      engagedSessions:    toNum(row.metricValues?.[3]?.value),
      engagementRate:     toNum(row.metricValues?.[4]?.value),
      avgSessionDuration: toNum(row.metricValues?.[5]?.value),
      bounceRate:         toNum(row.metricValues?.[6]?.value),
    }));
    res.json({ propertyId:r.propertyId, startDate, endDate, count:rows.length, rows });
  } catch(e) { fail(res,e,'GA4-PAGES'); }
});

app.post('/ga4-traffic', async (req, res) => {
  try {
    const { propertyId, startDate, endDate, rowLimit=100 } = req.body;
    if (!startDate||!endDate)
      return res.status(400).json({ error:'startDate, endDate zorunlu.' });
    const r = await ga4Report({
      propertyId, startDate, endDate, rowLimit,
      dimensions:['sessionDefaultChannelGroup','sessionSourceMedium'],
      metrics:['sessions','activeUsers','engagedSessions','engagementRate'],
      orderBy:'sessions',
    });
    const rows = r.rows.map(row=>({
      channelGroup:    row.dimensionValues?.[0]?.value||'',
      sourceMedium:    row.dimensionValues?.[1]?.value||'',
      sessions:        toNum(row.metricValues?.[0]?.value),
      activeUsers:     toNum(row.metricValues?.[1]?.value),
      engagedSessions: toNum(row.metricValues?.[2]?.value),
      engagementRate:  toNum(row.metricValues?.[3]?.value),
    }));
    res.json({ propertyId:r.propertyId, startDate, endDate, count:rows.length, rows });
  } catch(e) { fail(res,e,'GA4-TRAFFIC'); }
});

// ──────────────────────────────────────────────────────────────
// SİTEMAP
// ──────────────────────────────────────────────────────────────

app.post('/sitemap-urls', async (req, res) => {
  try {
    const { sitemapUrl, maxUrls } = req.body;
    if (!sitemapUrl) return res.status(400).json({ error:'sitemapUrl zorunlu.' });
    const urls = await getSitemap(sitemapUrl, maxUrls||SITEMAP_MAX_URLS);
    res.json({ sitemapUrl, domain:domainFromUrl(sitemapUrl), count:urls.length, urls });
  } catch(e) { fail(res,e,'SITEMAP-URLS'); }
});

// ──────────────────────────────────────────────────────────────
// İÇ LİNK
// ──────────────────────────────────────────────────────────────

async function handleInternalLinks(req, res) {
  try {
    const { topic, currentUrl, sitemapUrl, limit=8, maxUrls=SITEMAP_MAX_URLS } = req.body;
    if (!topic)      return res.status(400).json({ error:'topic zorunlu.' });
    if (!sitemapUrl) return res.status(400).json({ error:'sitemapUrl zorunlu.' });
    if (currentUrl)  requireAllowed(currentUrl,'currentUrl');
    const urls        = await getSitemap(sitemapUrl, maxUrls);
    const suggestions = urls
      .map(item=>({ ...item, score:scoreLink(item,topic,currentUrl) }))
      .filter(item=>item.score>0)
      .sort((a,b)=>b.score-a.score)
      .slice(0,limit)
      .map(({ url, lastmod, titleFromSlug, score })=>
        ({ url, lastmod, titleFromSlug, anchorSuggestion:titleFromSlug, score }));
    res.json({ topic, sitemapUrl, count:suggestions.length, suggestions });
  } catch(e) { fail(res,e,'INTERNAL-LINKS'); }
}
app.post('/internal-link-suggestions',    handleInternalLinks);
app.post('/internal-link-suggestions-v2', handleInternalLinks);

// ──────────────────────────────────────────────────────────────
// SAYFA SEO AUDIT
// ──────────────────────────────────────────────────────────────

app.post('/page-seo-audit', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error:'url zorunlu.' });
    requireAllowed(url,'url');
    const html = (await axios.get(url,{
      timeout:15000, headers:{'User-Agent':'Mozilla/5.0 (compatible; SEOAuditBot/2.0)'},
    })).data;
    const $      = cheerio.load(html);
    const title  = $('title').first().text().trim();
    const meta   = $('meta[name="description"]').attr('content')?.trim()||'';
    const canon  = $('link[rel="canonical"]').attr('href')?.trim()||'';
    const robots = $('meta[name="robots"]').attr('content')?.trim()||'';
    const h1     = $('h1').map((_,el)=>$(el).text().trim()).get();
    const h2     = $('h2').map((_,el)=>$(el).text().trim()).get();
    const issues=[];
    if (!title)              issues.push('title eksik');
    else if (title.length<30) issues.push('title çok kısa (<30)');
    else if (title.length>65) issues.push('title çok uzun (>65)');
    if (!meta)               issues.push('meta description eksik');
    else if (meta.length<80)  issues.push('meta description kısa (<80)');
    else if (meta.length>165) issues.push('meta description uzun (>165)');
    if (!canon)              issues.push('canonical tag eksik');
    if (h1.length===0)       issues.push('H1 eksik');
    if (h1.length>1)         issues.push(`Birden fazla H1 (${h1.length} adet)`);
    res.json({ url, seo:{
      title, titleLength:title.length,
      metaDescription:meta, metaDescriptionLength:meta.length,
      canonical:canon, robots, h1, h1Count:h1.length, h2, h2Count:h2.length,
    }, issues, issueCount:issues.length });
  } catch(e) { fail(res,e,'PAGE-SEO-AUDIT'); }
});

// ──────────────────────────────────────────────────────────────
// SAYFA DERİN ANALİZ
// ──────────────────────────────────────────────────────────────

app.post('/page-deep-analysis', async (req, res) => {
  try {
    const { siteUrl, sitemapUrl, pageUrl, startDate, endDate, rowLimit=5000 } = req.body;
    if (!siteUrl||!pageUrl||!startDate||!endDate)
      return res.status(400).json({ error:'siteUrl, pageUrl, startDate, endDate zorunlu.' });
    requireAllowed(pageUrl,'pageUrl');

    const topic = slugToTitle(pageUrl).toLowerCase();
    const [gscPages, gscQP, auditRes, sitemapUrls] = await Promise.all([
      gscQuery({ siteUrl, startDate, endDate, dimensions:['page'], rowLimit:5000 }),
      gscQuery({ siteUrl, startDate, endDate, dimensions:['query','page'], rowLimit }),
      axios.get(pageUrl,{ timeout:15000, headers:{'User-Agent':'Mozilla/5.0 (compatible; SEOAuditBot/2.0)'} }),
      sitemapUrl ? getSitemap(sitemapUrl,SITEMAP_MAX_URLS) : Promise.resolve([]),
    ]);

    const target  = normUrl(pageUrl);
    const pageMet = gscPages.map(r=>mapRow(r,['page'])).find(r=>normUrl(r.page)===target)||{};
    const queries = gscQP.map(r=>mapRow(r,['query','page']))
      .filter(r=>normUrl(r.page)===target).sort((a,b)=>b.impressions-a.impressions);

    const $      = cheerio.load(auditRes.data);
    const title  = $('title').first().text().trim();
    const meta   = $('meta[name="description"]').attr('content')?.trim()||'';
    const canon  = $('link[rel="canonical"]').attr('href')?.trim()||'';
    const robots = $('meta[name="robots"]').attr('content')?.trim()||'';
    const h1     = $('h1').map((_,el)=>$(el).text().trim()).get();
    const h2     = $('h2').map((_,el)=>$(el).text().trim()).get();

    const primaryTarget      = queries.filter(q=>q.position<=5 && q.clicks>0);
    const h2Candidates       = queries.filter(q=>q.position>5 && q.position<=20 && q.impressions>=50);
    const faqCandidates      = queries.filter(q=>/^(how|what|can|is|why|when|does)/i.test(q.query)||q.query.includes('?'));
    const titleOpportunities = queries.filter(q=>q.impressions>=200 && q.ctr<0.03);

    const internalLinks = sitemapUrls
      .map(item=>({ ...item, score:scoreLink(item,topic,pageUrl) }))
      .filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,8)
      .map(({ url, titleFromSlug, score })=>({ url, titleFromSlug, score }));

    const actions=[];
    if (title.length<30||title.length>65) actions.push('Title uzunluğunu 40–65 karakter arasına getir');
    if (titleOpportunities.length)        actions.push(`Title fırsatı: "${titleOpportunities[0].query}"`);
    if (faqCandidates.length)             actions.push(`FAQ ekle: ${faqCandidates.slice(0,3).map(q=>`"${q.query}"`).join(', ')}`);
    if (h2Candidates.length)              actions.push(`H2 ekle: ${h2Candidates.slice(0,2).map(q=>`"${q.query}"`).join(', ')}`);
    if (internalLinks.length)             actions.push(`${internalLinks.length} iç link ekle`);
    if (meta.length<80)                   actions.push('Meta description yeniden yaz (min 80 karakter)');

    const projectContext = await loadProjectContextSafe();

res.json({
  projectContext,
  pageUrl,
  performance:{ clicks:pageMet.clicks||0, impressions:pageMet.impressions||0,
                    ctr:pageMet.ctr||0, avgPosition:pageMet.position||0 },
      seo:{ title, titleLength:title.length, metaDescription:meta,
            metaDescriptionLength:meta.length, canonical:canon, robots,
            h1, h1Count:h1.length, h2, h2Count:h2.length },
      queries:{ total:queries.length, all:queries,
                primaryTarget, h2Candidates, faqCandidates, titleOpportunities },
      internalLinks,
      actionPlan:actions,
    });
  } catch(e) { fail(res,e,'PAGE-DEEP-ANALYSIS'); }
});

// ──────────────────────────────────────────────────────────────
// SİTE ÖZETİ
// ──────────────────────────────────────────────────────────────

app.post('/site-summary', async (req, res) => {
  try {
    const { siteUrl, sitemapUrl, propertyId, startDate, endDate } = req.body;
    if (!siteUrl) return res.status(400).json({ error:'siteUrl zorunlu.' });

    const dates  = defaultDates(startDate, endDate, 90);
    const hasGA4 = !!(propertyId||process.env.GA4_PROPERTY_ID);

    const [gscRaw, ga4Result, sitemapUrls] = await Promise.all([
      gscQuery({ siteUrl, startDate:dates.startDate, endDate:dates.endDate,
                 dimensions:['page'], rowLimit:5000 }),
      hasGA4 ? ga4Report({ propertyId, startDate:dates.startDate, endDate:dates.endDate,
        dimensions:['landingPagePlusQueryString'], metrics:['sessions','activeUsers'],
        orderBy:'sessions', rowLimit:500 }) : Promise.resolve(null),
      sitemapUrl ? getSitemap(sitemapUrl,SITEMAP_MAX_URLS) : Promise.resolve([]),
    ]);

    const pages   = gscRaw.map(r=>mapRow(r,['page']));
    const content = pages.filter(r=>!isLowValue(r.page));

    const totalClicks      = content.reduce((s,r)=>s+r.clicks,0);
    const totalImpressions = content.reduce((s,r)=>s+r.impressions,0);
    const avgCtr           = totalImpressions>0 ? totalClicks/totalImpressions : 0;
    const avgPosition      = content.length>0 ? content.reduce((s,r)=>s+r.position,0)/content.length : 0;

    const winners = content.filter(r=>r.clicks>50&&r.ctr>0.05&&r.position<10)
      .sort((a,b)=>b.clicks-a.clicks).slice(0,10);
    const lowCtr  = content.filter(r=>r.impressions>=100&&r.ctr<0.03&&r.clicks>0)
      .sort((a,b)=>b.impressions-a.impressions).slice(0,20);
    const opps    = content.filter(r=>r.position>=5&&r.position<=20&&r.impressions>=50)
      .sort((a,b)=>a.position-b.position).slice(0,20);
    const zero    = content.filter(r=>r.clicks===0&&r.impressions>=10)
      .sort((a,b)=>b.impressions-a.impressions).slice(0,20);

    const gscUrls = new Set(pages.map(r=>normUrl(r.page)));
    const dead    = sitemapUrls
      .filter(s=>!isLowValue(s.url)&&!gscUrls.has(normUrl(s.url))).slice(0,20);

    let gscOnly=[];
    if (ga4Result) {
      const ga4Urls = new Set(ga4Result.rows
        .map(r=>normUrl(r.dimensionValues?.[0]?.value||'')).filter(Boolean));
      gscOnly = content.filter(r=>r.clicks>10&&!ga4Urls.has(normUrl(r.page)))
        .slice(0,10).map(r=>({ ...r, note:'GSC tıklaması var ama GA4 oturumu yok' }));
    }

    const projectContext = await loadProjectContextSafe();

res.json({
  projectContext,
  siteUrl,
      period:{ startDate:dates.startDate, endDate:dates.endDate },
      overview:{
        totalClicks, totalImpressions,
        avgCtr:parseFloat(avgCtr.toFixed(4)),
        avgPosition:parseFloat(avgPosition.toFixed(1)),
        indexedPageCount:content.length, sitemapUrlCount:sitemapUrls.length,
      },
      segments:{ winners, lowCtrPages:lowCtr, opportunityPages:opps,
                 zeroClickPages:zero, deadPages:dead, gscOnlyPages:gscOnly },
    });
  } catch(e) { fail(res,e,'SITE-SUMMARY'); }
});

// ──────────────────────────────────────────────────────────────
// İÇERİK PLANI
// ──────────────────────────────────────────────────────────────

app.post('/content-plan', async (req, res) => {
  try {
    const { siteUrl, sitemapUrl, topic, startDate, endDate } = req.body;

    if (!siteUrl || !topic) {
      return res.status(400).json({ error: 'siteUrl ve topic zorunlu.' });
    }

    if (sitemapUrl) requireAllowed(sitemapUrl, 'sitemapUrl');

    const dates = defaultDates(startDate, endDate, 90);
    const topicText = String(topic).trim();
    const topicNorm = normText(topicText);
    const toks = tokens(topicText);

    const [projectContext, gscRaw, sitemapUrls] = await Promise.all([
      loadProjectContextSafe(),
      gscQuery({
        siteUrl,
        startDate: dates.startDate,
        endDate: dates.endDate,
        dimensions: ['query'],
        rowLimit: 5000
      }),
      sitemapUrl ? getSitemap(sitemapUrl, SITEMAP_MAX_URLS) : Promise.resolve([])
    ]);

    const gscRows = gscRaw.map(r => mapRow(r, ['query']));

    const exactSlug = topicNorm
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    const topicTokenSet = new Set(toks);

    function relevanceScore(text) {
      const n = normText(text || '');
      let score = 0;

      if (!n) return score;
      if (n.includes(topicNorm)) score += 100;
      if (exactSlug && n.includes(exactSlug)) score += 80;

      for (const t of topicTokenSet) {
        if (n.includes(t)) score += 15;
      }

      const words = n.split(/[^a-z0-9]+/).filter(Boolean);
      for (const t of topicTokenSet) {
        if (words.includes(t)) score += 10;
      }

      return score;
    }

    const existingPages = sitemapUrls
      .filter(s => !isLowValue(s.url))
      .map(s => ({
        url: s.url,
        title: s.titleFromSlug,
        lastmod: s.lastmod || null,
        relevanceScore: relevanceScore(`${s.url} ${s.titleFromSlug}`)
      }))
      .filter(s => s.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 12);

    const exactExistingPages = existingPages.filter(p => p.relevanceScore >= 100);
    const closeExistingPages = existingPages.filter(p => p.relevanceScore >= 40 && p.relevanceScore < 100);

    const relatedQueries = gscRows
      .map(q => ({
        ...q,
        relevanceScore: relevanceScore(q.query)
      }))
      .filter(q => q.relevanceScore >= 30)
      .sort((a, b) => {
        if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
        return b.impressions - a.impressions;
      })
      .slice(0, 30);

    const strongQueries = relatedQueries.filter(q => q.impressions >= 10 || q.clicks > 0);
    const questionQueries = relatedQueries
      .filter(q => /^(how|what|can|is|are|why|when|does|do|which)\b/i.test(q.query) || q.query.includes('?'))
      .slice(0, 10);

    const titleCase = s => String(s)
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    const cleanTitle = titleCase(topicText.replace(/\brecipe\b/i, '').trim() || topicText);
    const primaryKeyword = strongQueries.length ? strongQueries[0].query : topicText;

    const duplicateRisk =
      exactExistingPages.length > 0 ? 'high' :
      closeExistingPages.length > 1 ? 'medium' :
      closeExistingPages.length === 1 ? 'low' :
      'none';

    const cannibalizationRisk =
      relatedQueries.filter(q => q.impressions >= 50).length > 3 && existingPages.length > 0 ? 'medium' :
      exactExistingPages.length > 0 ? 'high' :
      'low';

    let action = 'write_new';
    let confidence = 90;
    let reason = 'Sitemap içinde aynı konuya ait güçlü bir mevcut sayfa bulunmadı. Yeni içerik yazılabilir.';

    if (exactExistingPages.length > 0) {
      action = 'revise_existing';
      confidence = 95;
      reason = 'Sitemap içinde aynı veya çok yakın konuda mevcut sayfa bulundu. Yeni sayfa açmak yerine mevcut sayfa revize edilmeli.';
    } else if (closeExistingPages.length >= 2) {
      action = 'merge_or_write_new';
      confidence = 75;
      reason = 'Sitemap içinde konuya yakın birden fazla sayfa bulundu. Yeni makale açmadan önce içerik çakışması kontrol edilmeli.';
    } else if (closeExistingPages.length === 1) {
      action = 'write_new_with_caution';
      confidence = 80;
      reason = 'Sitemap içinde konuya yakın bir sayfa bulundu. Yeni içerik yazılabilir fakat iç link ve kapsam ayrımı dikkatli yapılmalı.';
    }

    const internalLinks = sitemapUrls
      .map(item => ({ ...item, score: scoreLink(item, topicText, '') }))
      .filter(item => item.score > 0)
      .filter(item => !exactExistingPages.some(p => normUrl(p.url) === normUrl(item.url)))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ url, lastmod, titleFromSlug, score }) => ({
        url,
        titleFromSlug,
        lastmod: lastmod || null,
        anchorSuggestion: titleFromSlug,
        score
      }));

    const suggestedSlug = exactSlug || topicNorm.replace(/\s+/g, '-');

    const faqSuggestions = questionQueries.length
      ? questionQueries.map(q => q.query)
      : [
          `What is ${cleanTitle}?`,
          `How do you make ${cleanTitle} at home?`,
          `What ingredients are used in ${cleanTitle}?`,
          `Can ${cleanTitle} be made ahead?`,
          `How do you store ${cleanTitle}?`,
          `What are common mistakes when making ${cleanTitle}?`,
          `What do you serve with ${cleanTitle}?`,
          `Is ${cleanTitle} authentic Turkish food?`
        ];

    const sections = [
      `What Is ${cleanTitle}?`,
      `Why You'll Love This Recipe`,
      `Ingredients`,
      `Ingredient Notes & International Substitutions`,
      `Equipment`,
      `Step-by-Step Instructions`,
      `Expert Tips`,
      `Regional Variations`,
      `Common Mistakes`,
      `Serving Suggestions`,
      `Storage & Reheating`,
      `FAQ`,
      `Conclusion`
    ];

    const nextSteps = [];

    if (action === 'write_new' || action === 'write_new_with_caution') {
      nextSteps.push('Write a new publish-ready article only after sitemap-verified internal links are selected.');
    }

    if (action === 'revise_existing') {
      nextSteps.push('Do not create a new URL. Run revision-analysis on the existing page first.');
    }

    if (action === 'merge_or_write_new') {
      nextSteps.push('Review similar existing pages before deciding whether to create, merge, or revise.');
    }

    if (!sitemapUrl) {
      nextSteps.push('Sitemap URL was not provided. Internal links are not validated.');
    }

    if (internalLinks.length === 0) {
      nextSteps.push('No strong internal links found. Do not force irrelevant internal links.');
    }

    res.json({
      projectContext,
      topic: topicText,
      period: dates,
      decision: {
        action,
        confidence,
        reason,
        duplicateRisk,
        cannibalizationRisk,
        existingPageCount: existingPages.length
      },
      existingPages: {
        exact: exactExistingPages,
        close: closeExistingPages,
        allRelevant: existingPages
      },
      gscEvidence: {
        primaryKeyword,
        relatedQueries,
        strongQueries,
        questionQueries,
        dataQuality:
          relatedQueries.length === 0 ? 'no_related_gsc_data' :
          strongQueries.length === 0 ? 'weak_related_gsc_data' :
          'usable_related_gsc_data'
      },
      keywordPlan: {
        primary: primaryKeyword,
        focusKeyword: topicText,
        secondaryKeywords: relatedQueries
          .map(q => q.query)
          .filter(q => q !== primaryKeyword)
          .slice(0, 12),
        semanticEntities: toks
      },
      structure: {
        suggestedSlug,
        h1: `${cleanTitle} Recipe`,
        seoTitle: `${cleanTitle} Recipe | Authentic Turkish Homemade Method`,
        metaDescription: `Learn how to make ${cleanTitle.toLowerCase()} with a clear step-by-step method, expert tips, serving ideas, storage advice and Turkish cooking notes.`,
        sections,
        faqSuggestions
      },
      internalLinks,
      editorialNotes: {
        introRule: 'Introduction must be maximum 100 words if this rule exists in project memory.',
        internalLinkRule: 'Use only sitemap-verified URLs. Never invent internal links.',
        contentRule: 'Do not write a new article if decision.action is revise_existing unless the user explicitly overrides after reviewing the evidence.'
      },
      nextSteps
    });

  } catch (e) {
    fail(res, e, 'CONTENT-PLAN-V2');
  }
});
app.post('/article-engine', async (req, res) => {
  try {
    const {
      topic,
      startDate,
      endDate,
      rowLimit = 5000
    } = req.body;

    const siteUrl = 'https://turkishdishes.net/';
    const sitemapUrl = 'https://turkishdishes.net/sitemap_index.xml';

    if (!topic) {
      return res.status(400).json({ error: 'topic zorunlu.' });
    }

    const dates = defaultDates(startDate, endDate, 90);

    const projectContext = await loadProjectContextSafe();

    const topicText = String(topic).trim();
    const topicNorm = normText(topicText);
    const toks = tokens(topicText);

    const [gscQueryRows, gscPageRows, sitemapUrls] = await Promise.all([
      gscQuery({
        siteUrl,
        startDate: dates.startDate,
        endDate: dates.endDate,
        dimensions: ['query'],
        rowLimit
      }),
      gscQuery({
        siteUrl,
        startDate: dates.startDate,
        endDate: dates.endDate,
        dimensions: ['page'],
        rowLimit
      }),
      getSitemap(sitemapUrl, SITEMAP_MAX_URLS)
    ]);

    const queryRows = gscQueryRows.map(r => mapRow(r, ['query']));
    const pageRows = gscPageRows.map(r => mapRow(r, ['page']));

    const exactSlug = topicNorm
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    function relevanceScore(text) {
      const n = normText(text || '');
      let score = 0;

      if (!n) return score;
      if (n.includes(topicNorm)) score += 100;
      if (exactSlug && n.includes(exactSlug)) score += 80;

      for (const t of toks) {
        if (n.includes(t)) score += 15;
      }

      const words = n.split(/[^a-z0-9]+/).filter(Boolean);
      for (const t of toks) {
        if (words.includes(t)) score += 10;
      }

      return score;
    }

    const existingPages = sitemapUrls
      .filter(s => !isLowValue(s.url))
      .map(s => ({
        url: s.url,
        title: s.titleFromSlug,
        lastmod: s.lastmod || null,
        relevanceScore: relevanceScore(`${s.url} ${s.titleFromSlug}`)
      }))
      .filter(s => s.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 15);

    const exactExistingPages = existingPages.filter(p => p.relevanceScore >= 100);
    const closeExistingPages = existingPages.filter(p => p.relevanceScore >= 40 && p.relevanceScore < 100);

    const relatedQueries = queryRows
      .map(q => ({
        ...q,
        relevanceScore: relevanceScore(q.query)
      }))
      .filter(q => q.relevanceScore >= 30)
      .sort((a, b) => {
        if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
        return b.impressions - a.impressions;
      })
      .slice(0, 40);

    const strongQueries = relatedQueries.filter(q => q.impressions >= 10 || q.clicks > 0);
    const questionQueries = relatedQueries
      .filter(q => /^(how|what|can|is|are|why|when|does|do|which)\b/i.test(q.query) || q.query.includes('?'))
      .slice(0, 12);

    const pageEvidence = pageRows
      .map(p => ({
        ...p,
        relevanceScore: relevanceScore(p.page)
      }))
      .filter(p => p.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore || b.impressions - a.impressions)
      .slice(0, 15);

    const titleCase = s => String(s)
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    const cleanTitle = titleCase(topicText.replace(/\brecipe\b/i, '').trim() || topicText);
    const primaryKeyword = strongQueries.length ? strongQueries[0].query : topicText;

    const duplicateRisk =
      exactExistingPages.length > 0 ? 'high' :
      closeExistingPages.length > 1 ? 'medium' :
      closeExistingPages.length === 1 ? 'low' :
      'none';

    const cannibalizationRisk =
      exactExistingPages.length > 0 ? 'high' :
      pageEvidence.length > 1 ? 'medium' :
      pageEvidence.length === 1 ? 'low' :
      'none';

    let action = 'write_new';
    let confidence = 92;
    let reason = 'Sitemap ve GSC verilerinde aynı konuya ait güçlü mevcut sayfa bulunmadı. Yeni içerik yazılabilir.';

    if (exactExistingPages.length > 0) {
      action = 'revise_existing';
      confidence = 96;
      reason = 'Sitemap içinde aynı veya çok yakın konuda mevcut sayfa bulundu. Yeni makale açmak yerine mevcut sayfa revize edilmeli.';
    } else if (closeExistingPages.length >= 2 || pageEvidence.length >= 2) {
      action = 'merge_or_write_new';
      confidence = 78;
      reason = 'Konuya yakın birden fazla sayfa veya GSC izi bulundu. Yeni içerik açmadan önce çakışma kontrolü yapılmalı.';
    } else if (closeExistingPages.length === 1 || pageEvidence.length === 1) {
      action = 'write_new_with_caution';
      confidence = 84;
      reason = 'Konuya yakın tek bir sayfa bulundu. Yeni içerik yazılabilir ancak kapsam ayrımı ve iç linkleme dikkatli yapılmalı.';
    }

    const internalLinks = sitemapUrls
      .map(item => ({ ...item, score: scoreLink(item, topicText, '') }))
      .filter(item => item.score > 0)
      .filter(item => !exactExistingPages.some(p => normUrl(p.url) === normUrl(item.url)))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ url, lastmod, titleFromSlug, score }) => ({
        url,
        titleFromSlug,
        lastmod: lastmod || null,
        anchorSuggestion: titleFromSlug,
        score
      }));

    const suggestedSlug = exactSlug || topicNorm.replace(/\s+/g, '-');

    const faqSuggestions = questionQueries.length
      ? questionQueries.map(q => q.query)
      : [
          `What is ${cleanTitle}?`,
          `How do you make ${cleanTitle} at home?`,
          `What ingredients are used in ${cleanTitle}?`,
          `Can ${cleanTitle} be made ahead?`,
          `How do you store ${cleanTitle}?`,
          `What are common mistakes when making ${cleanTitle}?`,
          `What do you serve with ${cleanTitle}?`,
          `Is ${cleanTitle} authentic Turkish food?`
        ];

    const sections = [
      `What Is ${cleanTitle}?`,
      `Why You'll Love This Recipe`,
      `Ingredients`,
      `Ingredient Notes & International Substitutions`,
      `Equipment`,
      `Step-by-Step Instructions`,
      `Expert Tips`,
      `Regional Variations`,
      `Common Mistakes`,
      `Serving Suggestions`,
      `Storage & Reheating`,
      `FAQ`,
      `Conclusion`
    ];

    const nextSteps = [];

    if (action === 'write_new' || action === 'write_new_with_caution') {
      nextSteps.push('Proceed with a new publish-ready article after selecting sitemap-verified internal links.');
    }

    if (action === 'revise_existing') {
      nextSteps.push('Do not create a new URL. Run revision-analysis on the existing page first.');
    }

    if (action === 'merge_or_write_new') {
      nextSteps.push('Review similar existing pages before deciding whether to create, merge, or revise.');
    }

    if (internalLinks.length === 0) {
      nextSteps.push('No strong internal links found. Do not force irrelevant links.');
    }

    res.json({
      projectContext,
      engine: 'article-engine-v1',
      site: {
        siteUrl,
        sitemapUrl
      },
      topic: topicText,
      period: dates,
      decision: {
        action,
        confidence,
        reason,
        duplicateRisk,
        cannibalizationRisk,
        existingPageCount: existingPages.length,
        gscPageEvidenceCount: pageEvidence.length
      },
      existingPages: {
        exact: exactExistingPages,
        close: closeExistingPages,
        allRelevant: existingPages
      },
      gscEvidence: {
        primaryKeyword,
        relatedQueries,
        strongQueries,
        questionQueries,
        pageEvidence,
        dataQuality:
          relatedQueries.length === 0 && pageEvidence.length === 0 ? 'no_related_gsc_data' :
          strongQueries.length === 0 ? 'weak_related_gsc_data' :
          'usable_related_gsc_data'
      },
      keywordPlan: {
        primary: primaryKeyword,
        focusKeyword: topicText,
        secondaryKeywords: relatedQueries
          .map(q => q.query)
          .filter(q => q !== primaryKeyword)
          .slice(0, 12),
        semanticEntities: toks
      },
      structure: {
        suggestedSlug,
        h1: `${cleanTitle} Recipe`,
        seoTitle: `${cleanTitle} Recipe | Authentic Turkish Homemade Method`,
        metaDescription: `Learn how to make ${cleanTitle.toLowerCase()} with a clear step-by-step method, expert tips, serving ideas, storage advice and Turkish cooking notes.`,
        sections,
        faqSuggestions
      },
      internalLinks,
      editorialNotes: {
        introRule: 'Apply current project memory rules if available.',
        internalLinkRule: 'Use only sitemap-verified URLs. Never invent internal links.',
        articleRule: 'Do not write a new article if decision.action is revise_existing unless the user explicitly overrides after reviewing the evidence.'
      },
      nextSteps
    });

  } catch (e) {
    fail(res, e, 'ARTICLE-ENGINE');
  }
});
// ──────────────────────────────────────────────────────────────
// REVİZYON ANALİZİ
// ──────────────────────────────────────────────────────────────

app.post('/revision-analysis', async (req, res) => {
  try {
    const { siteUrl, sitemapUrl, pageUrl, startDate, endDate } = req.body;
    if (!siteUrl||!pageUrl)
      return res.status(400).json({ error:'siteUrl ve pageUrl zorunlu.' });
    requireAllowed(pageUrl,'pageUrl');

    const dates = defaultDates(startDate, endDate, 90);
    const [gscPages, gscQP, auditRes, sitemapUrls] = await Promise.all([
      gscQuery({ siteUrl, startDate:dates.startDate, endDate:dates.endDate,
                 dimensions:['page'], rowLimit:5000 }),
      gscQuery({ siteUrl, startDate:dates.startDate, endDate:dates.endDate,
                 dimensions:['query','page'], rowLimit:5000 }),
      axios.get(pageUrl,{ timeout:15000, headers:{'User-Agent':'Mozilla/5.0 (compatible; SEOAuditBot/2.0)'} }),
      sitemapUrl ? getSitemap(sitemapUrl,SITEMAP_MAX_URLS) : Promise.resolve([]),
    ]);

    const target  = normUrl(pageUrl);
    const pageMet = gscPages.map(r=>mapRow(r,['page'])).find(r=>normUrl(r.page)===target)||{};
    const queries = gscQP.map(r=>mapRow(r,['query','page']))
      .filter(r=>normUrl(r.page)===target).sort((a,b)=>b.impressions-a.impressions);

    const $     = cheerio.load(auditRes.data);
    const title = $('title').first().text().trim();
    const meta  = $('meta[name="description"]').attr('content')?.trim()||'';
    const h1    = $('h1').map((_,el)=>$(el).text().trim()).get();

    const problems={
      titleIssue:   !title||title.length<30||title.length>65,
      metaIssue:    !meta||meta.length<80||meta.length>165,
      h1Issue:      h1.length!==1,
      contentGap:   queries.filter(q=>q.position>10&&q.impressions>50).length>3,
      internalLinkGap: sitemapUrls.length>0,
      intentMismatch: (()=>{
        if (!title||!queries.length) return false;
        const tN  = normText(title);
        const toks = normText(queries[0]?.query||'').split(' ').filter(t=>t.length>3);
        return toks.filter(t=>tN.includes(t)).length < Math.ceil(toks.length*0.4);
      })(),
    };

    const { clicks=0, impressions=0, ctr=0, position=0 } = pageMet;
    let score=0;
    if (clicks>50)       score+=20; else if (clicks>10)      score+=10;
    if (impressions>500) score+=20; else if (impressions>100) score+=10;
    if (position<=10)    score+=20; else if (position<=20)    score+=10;
    if (queries.length>5)      score+=20;
    if (!problems.titleIssue)  score+=10;
    if (!problems.metaIssue)   score+=10;

    const decision =
      score>=60 ? 'revise' :
      score>=30 ? 'rewrite' :
      (impressions<10&&clicks===0) ? 'delete' : 'merge_or_rewrite';

    const keepQueries = queries.filter(q=>q.clicks>0||q.position<=10);
    const addSections = queries.filter(q=>q.position>10&&q.impressions>30);
    const dropQueries = queries.filter(q=>q.impressions<5&&q.clicks===0);

    const actions=[];
    if (problems.titleIssue)     actions.push('Title yeniden yaz (40–65 karakter)');
    if (problems.metaIssue)      actions.push('Meta description güncelle (80–165 karakter)');
    if (problems.h1Issue)        actions.push(h1.length===0?'H1 ekle':'Birden fazla H1, birleştir');
    if (problems.intentMismatch) actions.push('Title, en çok gösterim alan sorguyla uyumsuz');
    if (addSections.length)      actions.push(`Yeni bölüm ekle: ${addSections.slice(0,3).map(q=>`"${q.query}"`).join(', ')}`);
    if (problems.internalLinkGap) actions.push('İç link eksikliği kontrol edilmeli');

    const projectContext = await loadProjectContextSafe();

res.json({
  projectContext,
  pageUrl,
  performance:{ clicks, impressions, ctr, position:parseFloat(position.toFixed(1)) },
      seo:{ title, metaDescription:meta, h1 },
      verdict:{ decision, score, worthRevising:score>=30 },
      problems,
      queryAnalysis:{
        total:queries.length,
        keepQueries:keepQueries.slice(0,20),
        addSections:addSections.slice(0,10),
        dropQueries:dropQueries.slice(0,10),
      },
      actionList:actions,
    });
  } catch(e) { fail(res,e,'REVISION-ANALYSIS'); }
});

// ──────────────────────────────────────────────────────────────
// 404
// ──────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error:'Endpoint bulunamadı.', path:req.path, method:req.method,
    hint:'GET /routes ile listeyi gör.',
  });
});

// ──────────────────────────────────────────────────────────────
// SERVER
// ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SEO API v2.0 → port ${PORT}`);
  console.log(`İzinli domainler: ${getAllowedDomains().join(', ')}`);
});
