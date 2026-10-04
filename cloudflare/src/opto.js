import { Buffer } from "node:buffer";

const OPTO_BASE="https://opto.sic.pt";
const OPTO_HOME=OPTO_BASE+"/";
const OPTO_LOGO=OPTO_BASE+"/favicon.ico";
const CACHE_TTL_MS=15*60*1000;
const catalogCache=new Map();
const metaCache=new Map();

export const OPTO_VOD_CATALOGS=Object.freeze([
  {type:"series",id:"opto-vod-programas",name:"🇵🇹 OPTO • Programas",headings:["O Melhor da SIC","Episódios da Vida Real"]},
  {type:"series",id:"opto-vod-series",name:"🇵🇹 OPTO • Séries",headings:["Séries de Informação"]},
  {type:"series",id:"opto-vod-originais",name:"🇵🇹 OPTO • Originais",headings:["Originais OPTO"]},
  {type:"series",id:"opto-vod-crime",name:"🇵🇹 OPTO • Crime e Investigação",headings:["Crime e Investigação"]},
  {type:"series",id:"opto-vod-novelas",name:"🇵🇹 OPTO • Novelas",headings:["Novelas","Foste tu que pediste?"]},
  {type:"series",id:"opto-vod-informacao",name:"🇵🇹 OPTO • Informação",headings:["Informação","Portugal Criminal"]},
  {type:"series",id:"opto-vod-entretenimento",name:"🇵🇹 OPTO • Entretenimento",headings:["O Melhor da SIC","Entretenimento"]},
  {type:"podcast",id:"opto-podcasts",name:"🎙️ OPTO • Podcasts",headings:["Podcasts"]},
]);

function decodeHtml(value=""){const named={amp:"&",quot:'"',apos:"'",lt:"<",gt:">",nbsp:" ",aacute:"á",eacute:"é",iacute:"í",oacute:"ó",uacute:"ú",atilde:"ã",otilde:"õ",ccedil:"ç",ecirc:"ê",ocirc:"ô"};return String(value).replace(/&#x([0-9a-f]+);/gi,(_,x)=>String.fromCodePoint(parseInt(x,16))).replace(/&#(\d+);/g,(_,x)=>String.fromCodePoint(parseInt(x,10))).replace(/&([a-z]+);/gi,(m,k)=>named[k.toLowerCase()]??m)}
function stripTags(value=""){return decodeHtml(String(value).replace(/<script\b[\s\S]*?<\/script>/gi," ").replace(/<style\b[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim()}
function attrValue(attrs="",name){const safe=String(name).replace(/[.*+?^$()|[\]\\]/g,"\\$&");const m=String(attrs).match(new RegExp("(?:^|\\s)"+safe+"\\s*=\\s*([\"'])(.*?)\\1","i"));return m?decodeHtml(m[2]).trim():""}
function absoluteHttp(value=""){try{const u=new URL(decodeHtml(value),OPTO_BASE);return /^https?:$/.test(u.protocol)?u.toString():""}catch{return""}}
function optoPath(value=""){try{const u=new URL(value,OPTO_BASE);if(u.hostname!=="opto.sic.pt")return"";const path=u.pathname.replace(/\/+/g,"/").replace(/\/$/,"");if(/^\/content\/[0-9a-f-]{36}$/i.test(path))return path;if(/^\/(?:movie|series|serie|show|programa)\/[^/]+\/[0-9a-f-]{36}$/i.test(path))return path;return""}catch{return""}}
function encodeId(path){return"optovod:"+Buffer.from(path,"utf8").toString("base64url")}
function decodeId(id=""){if(!String(id).startsWith("optovod:"))return"";try{return optoPath(Buffer.from(String(id).slice(8),"base64url").toString("utf8"))}catch{return""}}
async function fetchHtml(target){const c=new AbortController(),t=setTimeout(()=>c.abort(),12000);try{const r=await fetch(target,{signal:c.signal,redirect:"follow",headers:{Accept:"text/html,application/xhtml+xml","User-Agent":"PT-HUB/4.0 OPTO-Public-Catalog"}});if(!r.ok)throw new Error("OPTO HTTP "+r.status);return await r.text()}finally{clearTimeout(t)}}
function metaTag(html,property){const safe=String(property).replace(/[.*+?^$()|[\]\\]/g,"\\$&");for(const re of [new RegExp("<meta[^>]+(?:property|name)=[\"']"+safe+"[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>","i"),new RegExp("<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']"+safe+"[\"'][^>]*>","i")]){const m=html.match(re);if(m)return decodeHtml(m[1]).trim()}return""}
function cleanTitle(v=""){return stripTags(v).replace(/^(?:ver|abrir|aceder a)\s*:?\s*/i,"").trim()}
function normalize(v=""){return stripTags(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase()}
function imageFromBody(body=""){const img=body.match(/<img\b([^>]*)>/i)?.[1]||"",srcset=attrValue(img,"srcset")||attrValue(img,"data-srcset"),first=srcset?srcset.split(",")[0].trim().split(/\s+/)[0]:"";return absoluteHttp(attrValue(img,"src")||attrValue(img,"data-src")||attrValue(img,"data-lazy-src")||attrValue(img,"data-original")||first)}

function parseHome(html){
  const entries=[],seen=new Set();let heading="";
  const token=/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>|<a\b([^>]*?)href\s*=\s*([\"'])(.*?)\3([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=token.exec(html))){
    if(m[1]!=null){heading=cleanTitle(m[1]);continue}
    const path=optoPath(m[4]);if(!path||seen.has(path))continue;
    const attrs=(m[2]||"")+" "+(m[5]||""),body=m[6]||"",img=body.match(/<img\b([^>]*)>/i)?.[1]||"";
    const title=cleanTitle(attrValue(attrs,"title")||attrValue(attrs,"aria-label")||attrValue(img,"alt")||body);
    if(!title||title.length>220)continue;
    seen.add(path);entries.push({path,heading,title,poster:imageFromBody(body)});
  }
  return entries;
}
function cachedHome(){return catalogCache.get("home")}
async function homeEntries(){const cached=cachedHome();if(cached&&Date.now()-cached.at<CACHE_TTL_MS)return cached.entries;const entries=parseHome(await fetchHtml(OPTO_HOME));catalogCache.set("home",{at:Date.now(),entries});return entries}
function pageIsPremium(html=""){return /ver\s+como\s+premium|subscriptionRequired|isPremium\s*[:=]\s*true|premiumOnly\s*[:=]\s*true/i.test(String(html))}
function unescapeMediaUrl(value=""){return decodeHtml(String(value)).replace(/\\u0026/gi,"&").replace(/\\\//g,"/").replace(/\\\\/g,"\\")}
function extractPublicMediaUrl(html=""){const candidates=[];for(const re of [/https?:\\?\/\\?\/[^"'<>\\\s]+?\.m3u8(?:\?[^"'<>\\\s]*)?/gi,/https?:\\?\/\\?\/[^"'<>\\\s]+?\.mpd(?:\?[^"'<>\\\s]*)?/gi,/[\"'](?:file|src|url|streamUrl|playbackUrl|hls|dash)[\"']\s*:\s*[\"'](https?:\\?\/\\?\/[^\"']+)[\"']/gi])for(const m of String(html).matchAll(re))candidates.push(m[1]||m[0]);for(const raw of candidates){const value=unescapeMediaUrl(raw);try{const u=new URL(value);if(/^https?:$/.test(u.protocol)&&(/\.m3u8(?:$|[?#])/i.test(u.toString())||/\.mpd(?:$|[?#])/i.test(u.toString())))return u.toString()}catch{}}return""}

export async function getOptoVodCatalog(type,id,search=""){
  const catalog=OPTO_VOD_CATALOGS.find(x=>x.id===id&&x.type===type);if(!catalog)return{metas:[]};
  const allowed=new Set(catalog.headings.map(normalize));let selected=(await homeEntries()).filter(x=>allowed.has(normalize(x.heading)));
  const q=normalize(search);if(q)selected=selected.filter(x=>normalize(x.title).includes(q));
  return{metas:selected.slice(0,140).map(x=>({id:encodeId(x.path),type,name:x.title,...(x.poster?{poster:x.poster,background:x.poster}:{poster:OPTO_LOGO}),description:catalog.name,website:OPTO_BASE+x.path}))}
}
export async function getOptoVodMeta(type,id){if(!["series","movie","podcast"].includes(type))return null;const path=decodeId(id);if(!path)return null;const key=type+":"+id,cached=metaCache.get(key);if(cached&&Date.now()-cached.at<CACHE_TTL_MS)return cached.meta;const html=await fetchHtml(OPTO_BASE+path),title=cleanTitle(metaTag(html,"og:title"))||"OPTO",description=cleanTitle(metaTag(html,"og:description")||metaTag(html,"description"))||"Conteúdo OPTO SIC",poster=absoluteHttp(metaTag(html,"og:image")),premium=pageIsPremium(html),meta={id,type,name:title,description,website:OPTO_BASE+path,...(poster?{poster,background:poster}:{poster:OPTO_LOGO}),behaviorHints:{...(!premium?{}:{subscriptionRequired:true})}};metaCache.set(key,{at:Date.now(),meta});return meta}
export async function getOptoVodStreams(type,id){if(!["series","movie","podcast"].includes(type))return[];const path=decodeId(id);if(!path)return[];return[{name:"PT•HUB • OPTO",title:"Abrir na OPTO",externalUrl:OPTO_BASE+path}]}
