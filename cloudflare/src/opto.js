import { Buffer } from "node:buffer";

const OPTO_BASE = "https://opto.sic.pt";
const OPTO_HOME = OPTO_BASE + "/";
const OPTO_LOGO = "https://opto.sic.pt/favicon.ico";
const CACHE_TTL_MS = 15 * 60 * 1000;
const catalogCache = new Map();
const metaCache = new Map();

export const OPTO_VOD_CATALOGS = Object.freeze([
  { type: "series", id: "opto-vod-programas", name: "🇵🇹 OPTO • Programas", headings: ["O Melhor da SIC", "Episódios da Vida Real"] },
  { type: "series", id: "opto-vod-series", name: "🇵🇹 OPTO • Séries", headings: ["Originais OPTO", "Séries de Informação", "Crime e Investigação"] },
  { type: "series", id: "opto-vod-novelas", name: "🇵🇹 OPTO • Novelas", headings: ["Novelas", "Foste tu que pediste?"] },
]);

function decodeHtml(value = "") {
  const named = { amp:"&", quot:'"', apos:"'", lt:"<", gt:">", nbsp:" ", aacute:"á", eacute:"é", iacute:"í", oacute:"ó", uacute:"ú", atilde:"ã", otilde:"õ", ccedil:"ç", ecirc:"ê", ocirc:"ô" };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_,x)=>String.fromCodePoint(parseInt(x,16)))
    .replace(/&#(\d+);/g,(_,x)=>String.fromCodePoint(parseInt(x,10)))
    .replace(/&([a-z]+);/gi,(m,k)=>named[k.toLowerCase()]??m);
}
function stripTags(value=""){return decodeHtml(String(value).replace(/<script\b[\s\S]*?<\/script>/gi," ").replace(/<style\b[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim()}
function attrValue(attrs="",name){const safe=String(name).replace(/[.*+?^$()|[\]\\]/g,"\\$&");const m=String(attrs).match(new RegExp("(?:^|\\s)"+safe+"\\s*=\\s*([\"'])(.*?)\\1","i"));return m?decodeHtml(m[2]).trim():""}
function absoluteHttp(value=""){try{const u=new URL(decodeHtml(value),OPTO_BASE);return u.protocol==="https:"||u.protocol==="http:"?u.toString():""}catch{return""}}
function optoPath(value=""){try{const u=new URL(value,OPTO_BASE);if(u.hostname!=="opto.sic.pt")return"";const m=u.pathname.match(/^\/content\/([0-9a-f-]{36})\/?$/i);return m?"/content/"+m[1]:""}catch{return""}}
function encodeId(path){return"optovod:"+Buffer.from(path,"utf8").toString("base64url")}
function decodeId(id=""){if(!String(id).startsWith("optovod:"))return"";try{return optoPath(Buffer.from(String(id).slice(8),"base64url").toString("utf8"))}catch{return""}}
async function fetchHtml(target){const c=new AbortController(),t=setTimeout(()=>c.abort(),12000);try{const r=await fetch(target,{signal:c.signal,redirect:"follow",headers:{Accept:"text/html,application/xhtml+xml","User-Agent":"PT-HUB/3.2 OPTO-Public-Catalog"}});if(!r.ok)throw new Error("OPTO HTTP "+r.status);return await r.text()}finally{clearTimeout(t)}}
function metaTag(html,property){const safe=String(property).replace(/[.*+?^$()|[\]\\]/g,"\\$&");for(const re of [new RegExp("<meta[^>]+(?:property|name)=[\"']"+safe+"[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>","i"),new RegExp("<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']"+safe+"[\"'][^>]*>","i")]){const m=html.match(re);if(m)return decodeHtml(m[1]).trim()}return""}
function cleanTitle(v=""){return stripTags(v).replace(/^(?:ver|abrir|aceder a)\s*:?\s*/i,"").trim()}
function normalize(v=""){return stripTags(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()}

function parseHome(html){
  const entries=[];
  let heading="";
  const token=/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>|<a\b([^>]*?)href\s*=\s*(["'])(\/content\/[0-9a-f-]{36}\/?)\3([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  const seen=new Set();
  while((m=token.exec(html))){
    if(m[1]!=null){heading=cleanTitle(m[1]);continue}
    const path=optoPath(m[4]);
    if(!path||seen.has(path))continue;
    const attrs=(m[2]||"")+" "+(m[5]||"");
    const body=m[6]||"";
    const img=body.match(/<img\b([^>]*)>/i)?.[1]||"";
    const srcset=attrValue(img,"srcset")||attrValue(img,"data-srcset");
    const srcsetFirst=srcset?srcset.split(",")[0].trim().split(/\s+/)[0]:"";
    const poster=absoluteHttp(attrValue(img,"src")||attrValue(img,"data-src")||attrValue(img,"data-lazy-src")||srcsetFirst);
    const title=cleanTitle(attrValue(attrs,"title")||attrValue(attrs,"aria-label")||attrValue(img,"alt")||body);
    if(!title||title.length>220)continue;
    seen.add(path);
    entries.push({path,heading,title,poster});
  }
  return entries;
}

export async function getOptoVodCatalog(type,id,search=""){
  if(type!=="series")return{metas:[]};
  const catalog=OPTO_VOD_CATALOGS.find(x=>x.id===id&&x.type===type);
  if(!catalog)return{metas:[]};
  let entries;
  const cached=catalogCache.get("home");
  if(cached&&Date.now()-cached.at<CACHE_TTL_MS)entries=cached.entries;
  else{entries=parseHome(await fetchHtml(OPTO_HOME));catalogCache.set("home",{at:Date.now(),entries})}
  const allowed=new Set(catalog.headings.map(normalize));
  let selected=entries.filter(x=>allowed.has(normalize(x.heading)));
  const q=normalize(search);
  if(q)selected=selected.filter(x=>normalize(x.title).includes(q));
  return{metas:selected.slice(0,100).map(x=>({
    id:encodeId(x.path),type:"series",name:x.title,
    ...(x.poster?{poster:x.poster,background:x.poster}:{poster:OPTO_LOGO}),
    description:"OPTO SIC",website:OPTO_BASE+x.path,
  }))};
}

export async function getOptoVodMeta(type,id){
  if(type!=="series")return null;
  const path=decodeId(id);if(!path)return null;
  const cached=metaCache.get(id);if(cached&&Date.now()-cached.at<CACHE_TTL_MS)return cached.meta;
  const html=await fetchHtml(OPTO_BASE+path);
  const title=cleanTitle(metaTag(html,"og:title"))||"OPTO";
  const description=cleanTitle(metaTag(html,"og:description")||metaTag(html,"description"))||"Conteúdo OPTO SIC";
  const poster=absoluteHttp(metaTag(html,"og:image"));
  const meta={id,type:"series",name:title,description,website:OPTO_BASE+path,...(poster?{poster,background:poster}:{poster:OPTO_LOGO})};
  metaCache.set(id,{at:Date.now(),meta});
  return meta;
}

// Playback is exposed only when a public, non-authenticated media URL is verified.
// We intentionally do not redirect to the OPTO website and do not bypass Premium/DRM.
export async function getOptoVodStreams(type,id){
  if(type!=="series"||!decodeId(id))return[];
  return[];
}
