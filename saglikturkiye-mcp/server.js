import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

// This is an independent, read-only service for saglikliturkiye.net.
// Never import TurkishDishes bridge files or write to WordPress / upstream APIs.
const PORT = Number(process.env.PORT || 3000);
const SITE = 'https://saglikliturkiye.net/';
const API = 'https://saglik-seo-api-1.onrender.com';
const ISSUER = 'https://dev-r38bhp2ua51avnhr.us.auth0.com/';
const RESOURCE = process.env.MCP_RESOURCE_URL || 'https://saglikturkiye-seo-mcp.onrender.com';
const ALLOWED_SUB = process.env.AUTH0_ALLOWED_SUB || '';
const JWKS = createRemoteJWKSet(new URL(ISSUER + '.well-known/jwks.json'));
const MAX_URLS = 5000;
const MAX_XML_DOCS = 40;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
const hostAllowed = h => h === 'saglikliturkiye.net' || h === 'www.saglikliturkiye.net';
function permitted(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !hostAllowed(u.hostname) || u.username || u.password || u.port) throw Error('Only HTTPS saglikliturkiye.net URLs allowed');
  return u.href;
}
const metadata = { resource: RESOURCE, authorization_servers: [ISSUER.replace(/\/$/,'')], scopes_supported: ['read:seo'], bearer_methods_supported: ['header'] };
app.get('/.well-known/oauth-protected-resource', (_q,r)=>r.json(metadata));
app.get('/.well-known/oauth-protected-resource/mcp', (_q,r)=>r.json(metadata));
app.get('/health', (_q,r)=>r.json({ok:true,service:'saglikturkiye-mcp',site:SITE,authConfigured:!!ALLOWED_SUB}));
async function auth(req,res,next) {
  if (!ALLOWED_SUB) return res.status(503).json({error:'AUTH0_ALLOWED_SUB not configured; fail closed'});
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return res.status(401).set('WWW-Authenticate','Bearer resource_metadata="'+RESOURCE+'/.well-known/oauth-protected-resource/mcp"').json({error:'Bearer token required'});
  try {
    const {payload} = await jwtVerify(header.slice(7),JWKS,{issuer:ISSUER,audience:RESOURCE,algorithms:['RS256'],clockTolerance:30});
    if (payload.sub !== ALLOWED_SUB || !String(payload.scope||'').split(/\s+/).includes('read:seo')) return res.status(403).json({error:'Forbidden'});
    next();
  } catch { return res.status(401).json({error:'Invalid OAuth token'}); }
}
async function fetchText(url, accept='text/html') {
  permitted(url);
  const response=await fetch(url,{redirect:'manual',headers:{accept},signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw Error('Website HTTP '+response.status);
  const size=Number(response.headers.get('content-length')||0);
  if(size>6000000) throw Error('Response exceeds safe size');
  const text=await response.text();
  if(text.length>6000000) throw Error('Response too large');
  return text;
}
const sitemapCache={value:null,at:0};
function xmlLocs(xml) { return [...xml.matchAll(/<loc(?:\s[^>]*)?>([^<]+)<\/loc>/gi)].map(m=>m[1].trim().replaceAll('&amp;','&')); }
async function siteMap(limit=MAX_URLS) {
  if(sitemapCache.value && Date.now()-sitemapCache.at < 600000) return {...sitemapCache.value, urls:sitemapCache.value.urls.slice(0,limit),count:Math.min(limit,sitemapCache.value.urls.length),cacheStatus:'fresh_cache'};
  let source='direct_site_xml', urls=[],warning=null;
  try {
    const r=await fetch(API+'/sitemap-urls',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sitemapUrl:SITE+'sitemap_index.xml',maxUrls:MAX_URLS}),signal:AbortSignal.timeout(25000)});
    if(!r.ok) throw Error('Main SEO API HTTP '+r.status);
    const data=await r.json();
    if(!Array.isArray(data.urls)) throw Error('Unexpected SEO API response');
    urls=[...new Set(data.urls.map(x=>x.url).filter(x=>{try{return !!permitted(x)}catch{return false}}))];
    if(!urls.length) throw Error('SEO API returned no URLs');
    source='main_seo_api';
  } catch(e) {
    warning='Main SEO API unavailable: '+String(e.message).slice(0,120);
    const queue=[SITE+'sitemap_index.xml',SITE+'wp-sitemap.xml']; const visited=new Set(), found=new Set();
    while(queue.length && visited.size<MAX_XML_DOCS && found.size<MAX_URLS) {
      const url=queue.shift(); if(visited.has(url)) continue; visited.add(url);
      let xml; try {xml=await fetchText(url,'application/xml,text/xml')} catch {continue}
      const isIndex=/<(?:\w+:)?sitemapindex\b/i.test(xml);
      if(!isIndex && !/<(?:\w+:)?urlset\b/i.test(xml)) continue;
      for(const loc of xmlLocs(xml)) {
        let valid; try {valid=permitted(loc)} catch {continue}
        if(isIndex) {if(valid.toLowerCase().endsWith('.xml')&&!visited.has(valid)) queue.push(valid)}
        else {found.add(valid);if(found.size>=MAX_URLS)break}
      }
    }
    urls=[...found];
    if(!urls.length) throw Error('Unable to verify live health-site sitemap. '+warning);
  }
  sitemapCache.value={sitemapUrl:SITE+'sitemap_index.xml',domain:'saglikliturkiye.net',count:urls.length,urls:urls.map(url=>({url})),verificationSource:source,verifiedAt:new Date().toISOString(),warning};
  sitemapCache.at=Date.now();
  return {...sitemapCache.value,urls:sitemapCache.value.urls.slice(0,limit),count:Math.min(limit,urls.length),cacheStatus:'live'};
}
function clean(s){return String(s).normalize('NFD').toLowerCase().replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i').replace(/[^a-z0-9]+/g,' ').trim();}
function titleFromUrl(url){return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop()||'').replace(/-/g,' ')}
async function inspect(url) {
  url=permitted(url); const html=await fetchText(url);
  const title=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g,'').trim()||'';
  const canonical=html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)/i)?.[1]||null;
  const h1=html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim()||null;
  return {url,title,h1,canonical,verifiedAt:new Date().toISOString()};
}
function serverFactory(){
 const m=new McpServer({name:'saglikturkiye-seo',version:'1.0.0'});
 const add=(name,desc,schema,fn)=>m.tool(name,desc,schema,async a=>{try{return {content:[{type:'text',text:JSON.stringify(await fn(a))}]}}catch(e){return {isError:true,content:[{type:'text',text:String(e.message||e)}]}}});
 add('get_sitemap_urls','Retrieve VERIFIED saglikliturkiye.net sitemap URLs. Read-only.',{maxUrls:z.number().int().min(1).max(MAX_URLS).optional()},a=>siteMap(a.maxUrls||MAX_URLS));
 add('verify_page','Fetch the real health-site HTML and verify its title, H1 and canonical. Read-only.',{url:z.string().url()},a=>inspect(a.url));
 add('suggest_internal_links','Suggest candidate links from live sitemap, verify actual HTML title for each. Editorial relevance must still be checked.',{topic:z.string().min(2).max(200),currentUrl:z.string().url().optional(),limit:z.number().int().min(1).max(10).optional()},async a=>{
  const sm=await siteMap(); const q=clean(a.topic).split(/\s+/).filter(x=>x.length>2);
  const candidates=sm.urls.filter(x=>!a.currentUrl||x.url.replace(/\/$/,'')!==permitted(a.currentUrl).replace(/\/$/,''))
    .map(x=>({url:x.url,score:q.filter(t=>clean(titleFromUrl(x.url)).includes(t)).length}))
    .filter(x=>x.score>0).sort((x,y)=>y.score-x.score).slice(0,a.limit||6);
  const links=[];for(const c of candidates){try{links.push({...await inspect(c.url),score:c.score})}catch(e){links.push({url:c.url,verified:false,error:String(e.message)})}}
  return {topic:a.topic,sitemapStatus:sm.cacheStatus,verificationSource:sm.verificationSource,links,note:'Suggestions are not an editorial approval; check semantic fit before linking.'};
 });
 return m;
}
app.get('/mcp',auth,(_q,r)=>r.status(405).set('Allow','POST').end());
app.post('/mcp',auth,async(req,res)=>{
 const server=serverFactory(),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
 res.on('close',()=>{transport.close().catch(()=>{});server.close().catch(()=>{})});
 try{await server.connect(transport);await transport.handleRequest(req,res,req.body)}
 catch(e){console.error('mcp_error',e.message);if(!res.headersSent)res.status(500).json({error:'MCP transport failure'})}
});
app.listen(PORT,'0.0.0.0',()=>console.info('Health-site MCP started; auth fail-closed if not configured'));
