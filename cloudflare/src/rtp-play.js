import { Buffer } from "node:buffer";

let nodePlaybackResolver = null;
export function setNodePlaybackResolver(resolver){ nodePlaybackResolver = resolver; }

const RTP_BASE = "https://www.rtp.pt";
const RTP_LOGO = "https://www.rtp.pt/favicon.ico";
const CACHE_TTL_MS = 15 * 60 * 1000;
const catalogCache = new Map();
const metaCache = new Map();

const PROGRAM_CATALOGS = [
  ["rtp-vod-programas","🇵🇹 RTP Play • Programas","https://www.rtp.pt/play/programas/tema/canal/a-z"],
  ["rtp-vod-informacao","🇵🇹 RTP Play • Informação","https://www.rtp.pt/play/programas/informacao/canal/a-z"],
  ["rtp-vod-cultura","🇵🇹 RTP Play • Cultura","https://www.rtp.pt/play/programas/cultura/canal/a-z"],
  ["rtp-vod-humor","🇵🇹 RTP Play • Humor","https://www.rtp.pt/play/programas/humor/canal/a-z"],
  ["rtp-vod-desporto-programas","🏅 RTP Play • Desporto • Programas","https://www.rtp.pt/play/programas/desporto/canal/a-z"],
  ["rtp-vod-ficcao","🇵🇹 RTP Play • Ficção","https://www.rtp.pt/play/programas/ficcao/canal/a-z"],
  ["rtp-vod-entretenimento","🇵🇹 RTP Play • Entretenimento","https://www.rtp.pt/play/programas/entretenimento/canal/a-z"],
  ["rtp-vod-ciencia","🇵🇹 RTP Play • Ciência e Natureza","https://www.rtp.pt/play/programas/ciencia-e-natureza/canal/a-z"],
  ["rtp-vod-entrevista","🇵🇹 RTP Play • Entrevista, Opinião e Debate","https://www.rtp.pt/play/programas/entrevista-opiniao-e-debate/canal/a-z"],
  ["rtp-vod-gastronomia","🇵🇹 RTP Play • Gastronomia","https://www.rtp.pt/play/programas/gastronomia/canal/a-z"],
  ["rtp-vod-artes","🇵🇹 RTP Play • Artes","https://www.rtp.pt/play/programas/artes/canal/a-z"],
  ["rtp-vod-saude","🇵🇹 RTP Play • Saúde","https://www.rtp.pt/play/programas/saude/canal/a-z"],
  ["rtp-vod-especiais","🇵🇹 RTP Play • Especiais","https://www.rtp.pt/play/programas/especiais/canal/a-z"],
].map(([id,name,url])=>({type:"series",id,name,url,programList:true}));

export const RTP_VOD_CATALOGS = Object.freeze([
  ...PROGRAM_CATALOGS,
  { type: "series", id: "rtp-vod-series", name: "🇵🇹 RTP Play • Séries", url: RTP_BASE + "/play/hub/series" },
  { type: "series", id: "rtp-vod-docs", name: "🇵🇹 RTP Play • DOCS", url: RTP_BASE + "/play/hub/documentarios" },
  { type: "series", id: "rtp-vod-originais", name: "🇵🇹 RTP Play • Originais", url: RTP_BASE + "/play/programas/tema/originaisrtpplay", programList:true },
  { type: "series", id: "rtp-vod-sports", name: "🏅 RTP Play • Desporto", url: RTP_BASE + "/play/hub/rtpdesporto" },
  { type: "series", id: "rtp-sports-fit-em-casa", name: "🏋️ RTP Desporto • Fit em Casa", staticItems: [
    { path: "/play/p7179/fit-em-casa-treino-funcional", name: "Fit em Casa: Treino Funcional" },
    { path: "/play/p7180/fit-em-casa-treino-de-mobilidade", name: "Fit em Casa: Treino de Mobilidade" },
    { path: "/play/p7302/fit-em-casa-danca", name: "Fit em Casa: Dança" },
    { path: "/play/p7181/fit-em-casa-pilates", name: "Fit em Casa: Pilates" },
    { path: "/play/p7184/fit-em-casa-treino-funcional-para-crianca", name: "Fit em Casa: Treino Funcional para Crianças" },
    { path: "/play/p7182/fit-em-casa-yoga", name: "Fit em Casa: Yoga" },
    { path: "/play/p7183/fit-em-casa-nutricao", name: "Fit em Casa: Nutrição" },
  ] },
  { type: "series", id: "rtp-zigzag-programas", name: "🧒 RTP ZigZag • Programas", url: RTP_BASE + "/play/zigzag/programas/all", zigzagOnly: true },
  { type: "podcast", id: "rtp-podcasts", name: "🎙️ RTP Play • Podcasts", url: RTP_BASE + "/play/podcasts", podcastOnly: true },
  { type: "music", id: "rtp-vod-concerts", name: "🎵 RTP Palco • Concertos", url: RTP_BASE + "/play/palco/colecao/concertos", palcoOnly: true },
  { type: "music", id: "rtp-palco-musica", name: "🎵 RTP Palco • Música", url: RTP_BASE + "/play/palco/espetaculos/musica/todos/a-z", palcoOnly: true, palcoList:true },
  { type: "music", id: "rtp-palco-danca", name: "🎭 RTP Palco • Dança", url: RTP_BASE + "/play/palco/espetaculos/danca/todos/a-z", palcoOnly: true, palcoList:true },
  { type: "music", id: "rtp-palco-opera", name: "🎭 RTP Palco • Ópera", url: RTP_BASE + "/play/palco/espetaculos/opera/todos/a-z", palcoOnly: true, palcoList:true },
  { type: "music", id: "rtp-palco-performance", name: "🎭 RTP Palco • Performance", url: RTP_BASE + "/play/palco/espetaculos/performance/todos/a-z", palcoOnly: true, palcoList:true },
  { type: "music", id: "rtp-palco-teatro", name: "🎭 RTP Palco • Teatro", url: RTP_BASE + "/play/palco/espetaculos/teatro/todos/a-z", palcoOnly: true, palcoList:true },
  { type: "music", id: "rtp-palco-documentarios", name: "🎵 RTP Palco • Documentários", url: RTP_BASE + "/play/palco/espetaculos/documentarios/todos/a-z", palcoOnly: true, palcoList:true },
]);

function decodeHtml(value = "") {
  const named = { amp:"&",quot:'"',apos:"'",lt:"<",gt:">",nbsp:" ",ndash:"–",mdash:"—",hellip:"…",laquo:"«",raquo:"»",
    aacute:"á",eacute:"é",iacute:"í",oacute:"ó",uacute:"ú",agrave:"à",acirc:"â",ecirc:"ê",ocirc:"ô",atilde:"ã",otilde:"õ",ccedil:"ç",
    Aacute:"Á",Eacute:"É",Iacute:"Í",Oacute:"Ó",Uacute:"Ú",Agrave:"À",Acirc:"Â",Ecirc:"Ê",Ocirc:"Ô",Atilde:"Ã",Otilde:"Õ",Ccedil:"Ç" };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi,(_,hex)=>String.fromCodePoint(parseInt(hex,16)))
    .replace(/&#([0-9]+);/g,(_,dec)=>String.fromCodePoint(parseInt(dec,10)))
    .replace(/&([a-z]+);/gi,(m,key)=>named[key]??named[key.toLowerCase()]??m);
}
function stripTags(value=""){return decodeHtml(String(value).replace(/<script\b[\s\S]*?<\/script>/gi," ").replace(/<style\b[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim()}
function attrValue(attrs="",name){const escaped=name.replace(/[.*+?^$()|[\]\\]/g,"\\$&");const m=String(attrs).match(new RegExp("(?:^|\\s)"+escaped+"\\s*=\\s*([\"'])(.*?)\\1","i"));return m?decodeHtml(m[2]).trim():""}
function absoluteHttpUrl(value=""){try{const u=new URL(decodeHtml(value),RTP_BASE);return /^https?:$/.test(u.protocol)?u.toString():""}catch{return""}}
function absoluteRtpUrl(value=""){try{const u=new URL(decodeHtml(value),RTP_BASE);return u.hostname==="www.rtp.pt"||u.hostname.endsWith(".rtp.pt")?u.toString():""}catch{return""}}
function rtpPathFromUrl(value=""){try{const u=new URL(value,RTP_BASE);if(u.hostname!=="www.rtp.pt")return"";const path=u.pathname.replace(/\/+/g,"/");if(!/^\/play\/(?:palco\/|zigzag\/)?p\d+(?:\/|$)/i.test(path))return"";return path+(u.search||"")}catch{return""}}
function encodeId(path){return"rtpvod:"+Buffer.from(path,"utf8").toString("base64url")}
function decodeId(id=""){if(!String(id).startsWith("rtpvod:"))return"";try{return rtpPathFromUrl(Buffer.from(String(id).slice(7),"base64url").toString("utf8"))}catch{return""}}
async function fetchHtml(target){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{const response=await fetch(target,{signal:controller.signal,redirect:"follow",headers:{Accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Accept-Language":"pt-PT,pt;q=0.9,en;q=0.7","User-Agent":"Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36"}});if(!response.ok)throw new Error("RTP HTTP "+response.status);return await response.text()}finally{clearTimeout(timer)}}
function metaTag(html,property){const escaped=property.replace(/[.*+?^$()|[\]\\]/g,"\\$&");for(const p of [new RegExp("<meta[^>]+(?:property|name)=[\"']"+escaped+"[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>","i"),new RegExp("<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']"+escaped+"[\"'][^>]*>","i")]){const m=html.match(p);if(m)return decodeHtml(m[1]).trim()}return""}
function firstHeading(html){const m=html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);return m?stripTags(m[1]):""}
function slugTitle(path){const slug=String(path).split("/").filter(Boolean).at(-1)||"RTP Play";return decodeURIComponent(slug).replace(/[-_]+/g," ").replace(/\s+/g," ").replace(/\b\p{L}/gu,c=>c.toUpperCase())}
function cleanTitle(value=""){return stripTags(value).replace(/^Aceder\s+a:\s*/i,"").replace(/^Ver\s+(?:agora|detalhes):?\s*/i,"").trim()}
function anchorImage(body=""){const m=body.match(/<img\b([^>]*)>/i),attrs=m?.[1]||"",srcset=attrValue(attrs,"srcset")||attrValue(attrs,"data-srcset"),first=srcset?srcset.split(",")[0].trim().split(/\s+/)[0]:"";const raw=attrValue(attrs,"src")||attrValue(attrs,"data-src")||attrValue(attrs,"data-original")||attrValue(attrs,"data-lazy-src")||first;return absoluteHttpUrl(raw)}
function catalogAllowsPath(catalog,path){if(catalog?.palcoOnly)return /^\/play\/palco\/p\d+/i.test(path);if(catalog?.zigzagOnly)return /^\/play\/zigzag\/p\d+/i.test(path);if(catalog?.podcastOnly)return /^\/play\/p\d+/i.test(path);return /^\/play\/p\d+/i.test(path)}
function scopeProgramListHtml(html,catalog){if(!catalog?.programList&&!catalog?.palcoList)return String(html);const text=String(html);let start=-1;for(const re of [/ordem(?:\s|&nbsp;|<[^>]*>)*:?(?:\s|&nbsp;|<[^>]*>){0,20}(?:recentes|a-z)/gi,/(?:recentes|a-z)(?:\s|&nbsp;|<[^>]*>){0,20}\|(?:\s|&nbsp;|<[^>]*>){0,20}(?:recentes|a-z)/gi]){let m;while((m=re.exec(text)))start=Math.max(start,m.index)}if(start<0){const lower=text.toLowerCase();for(const marker of ["ordem:","ordem :","recentes |","recentes</","a-z</"]){const i=lower.lastIndexOf(marker);if(i>start)start=i}}if(start<0)return text;let scoped=text.slice(start);for(const endMarker of ["instale a aplicação rtp play","instale a aplica&ccedil;&atilde;o rtp play","<footer"]){const i=scoped.toLowerCase().indexOf(endMarker);if(i>0){scoped=scoped.slice(0,i);break}}return scoped}
function parseCatalog(html,type,catalog){html=scopeProgramListHtml(html,catalog);const metas=[],seen=new Set(),re=/<a\b([^>]*?)href\s*=\s*([\"'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;let m;while((m=re.exec(html))&&metas.length<160){const attrs=(m[1]||"")+" "+(m[4]||""),href=absoluteRtpUrl(m[3]),path=rtpPathFromUrl(href);if(!path||seen.has(path)||!catalogAllowsPath(catalog,path))continue;const body=m[5]||"",img=body.match(/<img\b([^>]*)>/i)?.[1]||"";const title=cleanTitle(attrValue(attrs,"title")||attrValue(attrs,"aria-label")||attrValue(img,"alt")||stripTags(body))||slugTitle(path);if(!title||title.length>220)continue;const poster=anchorImage(body);seen.add(path);metas.push({id:encodeId(path),type,name:title,...(poster?{poster,background:poster}:{poster:RTP_LOGO}),description:catalog?.name||"RTP Play",website:RTP_BASE+path})}return metas}
function parseEpisodes(html){const videos=[],seen=new Set(),re=/<a\b([^>]*?)href\s*=\s*([\"'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;let m;while((m=re.exec(html))&&videos.length<400){const href=absoluteRtpUrl(m[3]),path=rtpPathFromUrl(href);if(!path||!/\/e\d+\//i.test(path)||seen.has(path))continue;const attrs=(m[1]||"")+" "+(m[4]||""),body=m[5]||"",img=body.match(/<img\b([^>]*)>/i)?.[1]||"";const title=cleanTitle(attrValue(attrs,"title")||attrValue(attrs,"aria-label")||attrValue(img,"alt")||stripTags(body))||("Episódio "+(videos.length+1));const ep=path.match(/\/e(\d+)\//i)?.[1]||"",thumb=anchorImage(body);seen.add(path);videos.push({id:encodeId(path),title,season:1,episode:videos.length+1,...(ep?{episodeId:ep}:{}),...(thumb?{thumbnail:thumb}:{})})}return videos}
function unescapeMediaUrl(value=""){return decodeHtml(String(value)).replace(/\\u0026/gi,"&").replace(/\\\//g,"/").replace(/\\\\/g,"\\")}
function decodeRtpObfuscatedPlayers(html=""){
  return String(html).replace(
    /atob\s*\(\s*decodeURIComponent\s*\(\s*(\[[0-9A-Za-z%,'"\s]*\])\s*\.\s*join\(\s*(?:""|'')\s*\)\s*\)\s*\)/g,
    (match,arrayText)=>{
      try{
        const parts=JSON.parse(arrayText.replace(/'/g,'"'));
        const joined=parts.join("");
        const decoded=decodeURIComponent(joined);
        return JSON.stringify(Buffer.from(decoded,"base64").toString("latin1"));
      }catch{return match}
    }
  )
}
function normalizeRtpMediaUrl(raw=""){
  const value=unescapeMediaUrl(raw);
  try{
    const u=new URL(value);
    if(!/^https?:$/.test(u.protocol))return"";
    if(u.hostname==="streaming-ondemand.rtp.pt")return"";
    if(/\/drm-(?:fps|dash)\//i.test(u.pathname))return"";
    if(/\.m3u8(?:$|[?#])/i.test(u.toString())||/\.mpd(?:$|[?#])/i.test(u.toString()))return u.toString();
  }catch{}
  return""
}
function extractPublicMediaUrls(html=""){
  const source=decodeRtpObfuscatedPlayers(html),candidates=[];
  for(const pattern of [
    /https?:\\?\/\\?\/[^"'<>\\\s]+?\.m3u8(?:\?[^"'<>\\\s]*)?/gi,
    /https?:\\?\/\\?\/[^"'<>\\\s]+?\.mpd(?:\?[^"'<>\\\s]*)?/gi,
    /["'](?:file|src|url|hls_url|hls_url_new|dash_url|stream_url|url_hls|url_dash)["']\s*:\s*["'](https?:\\?\/\\?\/[^"']+)["']/gi
  ])for(const m of source.matchAll(pattern))candidates.push(m[1]||m[0]);
  const playerBlocks=[...source.matchAll(/(?:var\s+f\s*=|RTPPlayer\(\{[\s\S]{0,3000}?file\s*:)[\s\S]{0,3000}?(?:\}|\))/gi)].map(m=>m[0]);
  for(const block of playerBlocks){
    for(const m of block.matchAll(/https?:\\?\/\\?\/[^"'<>\\\s]+?\.(?:m3u8|mpd)(?:\?[^"'<>\\\s]*)?/gi))candidates.unshift(m[0]);
  }
  const out=[];
  for(const raw of candidates){
    const value=normalizeRtpMediaUrl(raw);
    if(value&&!out.includes(value))out.push(value);
  }
  return out
}
function extractPublicMediaUrl(html=""){
  const urls=extractPublicMediaUrls(html);
  return urls.find(u=>/\.m3u8(?:$|[?#])/i.test(u))||urls.find(u=>/\.mpd(?:$|[?#])/i.test(u))||""
}

function parseRtpProgramEpisode(path=""){
  const m=String(path).match(/^\/play\/(?:palco\/|zigzag\/)?(p\d+)(?:\/(e\d+))?/i);
  return m?{programId:m[1],episodeId:m[2]||""}:null
}
export async function resolveEpisodePath(path){
  const parsed=parseRtpProgramEpisode(path);
  if(!parsed)return{path,programId:"",episodeId:""};
  if(parsed.episodeId)return{path,programId:parsed.programId,episodeId:parsed.episodeId};
  try{
    const response=await fetch(RTP_BASE+path,{redirect:"follow",headers:{Accept:"text/html,application/xhtml+xml","Accept-Language":"pt-PT,pt;q=0.9","User-Agent":"Mozilla/5.0"}});
    if(response.ok){
      const finalPath=rtpPathFromUrl(response.url);
      const finalParsed=parseRtpProgramEpisode(finalPath);
      if(finalParsed?.episodeId)return{path:finalPath,programId:finalParsed.programId,episodeId:finalParsed.episodeId};
      const html=await response.text();
      const e=html.match(/\/play\/(?:palco\/|zigzag\/)?(p\d+)\/(e\d+)\//i);
      if(e)return{path:e[0].replace(/\/$/,""),programId:e[1],episodeId:e[2]};
    }
  }catch{}
  return{path,programId:parsed.programId,episodeId:""}
}
function collectAssetUrls(value,out=[]){
  if(value==null)return out;
  if(typeof value==="string"){
    const u=normalizeRtpMediaUrl(value);
    if(u&&!out.includes(u))out.push(u);
    return out
  }
  if(Array.isArray(value)){for(const item of value)collectAssetUrls(item,out);return out}
  if(typeof value==="object"){for(const item of Object.values(value))collectAssetUrls(item,out)}
  return out
}
async function getRtpEpisodePublicAssets(programId,episodeId){
  if(!/^p\d+$/i.test(programId)||!/^e\d+$/i.test(episodeId))return[];
  const url=RTP_BASE+"/play/api/1/get-episode/"+programId.slice(1)+"/"+episodeId.slice(1)+"?include_assets=true&include_webparams=true";
  try{
    const response=await fetch(url,{headers:{Accept:"application/json,text/plain,*/*","User-Agent":"Mozilla/5.0","Referer":RTP_BASE+"/play/"}});
    if(!response.ok)return[];
    const data=await response.json();
    const result=data?.result||data;
    return collectAssetUrls(result?.assets||result?.episode||result);
  }catch{return[]}
}

const playbackProbeCache=new Map();
function rtpPlaybackHeaders(){
  return {
    Accept:"*/*",
    "Accept-Language":"pt-PT,pt;q=0.9,en;q=0.7",
    "User-Agent":"Mozilla/5.0",
    Referer:RTP_BASE+"/play/",
    Origin:RTP_BASE
  }
}
async function fetchProbeText(target,limit=256*1024){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch(target,{headers:rtpPlaybackHeaders(),redirect:"follow",signal:controller.signal});
    if(!response.ok)return null;
    const text=await response.text();
    return {text:text.slice(0,limit),url:response.url||target,contentType:response.headers.get("content-type")||""}
  }catch{return null}finally{clearTimeout(timer)}
}
function firstHlsReference(text=""){
  for(const raw of String(text).replace(/\r/g,"").split("\n")){
    const line=raw.trim();
    if(line&&!line.startsWith("#"))return line
  }
  return""
}
function firstHlsMediaSegment(text=""){
  const lines=String(text).replace(/\r/g,"").split("\n");
  let sawMedia=false;
  for(const raw of lines){
    const line=raw.trim();
    if(line.startsWith("#EXTINF:")){sawMedia=true;continue}
    if(sawMedia&&line&&!line.startsWith("#"))return line
  }
  return""
}
async function probeRtpHls(url,depth=0){
  if(depth>2)return false;
  const fetched=await fetchProbeText(url);
  if(!fetched||!fetched.text.trimStart().startsWith("#EXTM3U"))return false;
  const text=fetched.text,base=fetched.url||url;
  const segment=firstHlsMediaSegment(text);
  if(segment){
    try{
      const mediaUrl=new URL(segment,base).toString(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
      try{
        const response=await fetch(mediaUrl,{headers:{...rtpPlaybackHeaders(),Range:"bytes=0-1"},redirect:"follow",signal:controller.signal});
        return response.ok||response.status===206
      }finally{clearTimeout(timer)}
    }catch{return false}
  }
  const child=firstHlsReference(text);
  if(!child)return false;
  try{return await probeRtpHls(new URL(child,base).toString(),depth+1)}catch{return false}
}
async function probeRtpDash(url){
  const fetched=await fetchProbeText(url);
  return !!fetched&&/<MPD\b/i.test(fetched.text)
}
async function probeRtpPlaybackUrl(url){
  const cached=playbackProbeCache.get(url);
  if(cached&&Date.now()-cached.at<5*60*1000)return cached.ok;
  const ok=/\.m3u8(?:$|[?#])/i.test(url)?await probeRtpHls(url):/\.mpd(?:$|[?#])/i.test(url)?await probeRtpDash(url):false;
  playbackProbeCache.set(url,{at:Date.now(),ok});
  return ok
}
async function resolveRtpPlaybackUrls(path){
  if(nodePlaybackResolver)return nodePlaybackResolver(path);
  const resolved=await resolveEpisodePath(path);
  const candidates=[];
  if(resolved.programId&&resolved.episodeId){
    for(const u of await getRtpEpisodePublicAssets(resolved.programId,resolved.episodeId)){
      if(!candidates.includes(u))candidates.push(u)
    }
  }
  try{
    const html=await fetchHtml(RTP_BASE+resolved.path);
    for(const u of extractPublicMediaUrls(html))if(!candidates.includes(u))candidates.push(u)
  }catch{}
  const urls=[];
  for(const u of candidates){
    if(await probeRtpPlaybackUrl(u))urls.push(u)
  }
  urls.sort((a,b)=>Number(/\.mpd(?:$|[?#])/i.test(a))-Number(/\.mpd(?:$|[?#])/i.test(b)));
  return{path:resolved.path,urls}
}
function findCatalog(type,id){return RTP_VOD_CATALOGS.find(x=>x.type===type&&x.id===id)||null}

export async function getRtpVodCatalog(type,id,search=""){
  const catalog=findCatalog(type,id);if(!catalog)return{metas:[]};
  const key=type+":"+id,cached=catalogCache.get(key);let metas;
  if(cached&&Date.now()-cached.at<CACHE_TTL_MS)metas=cached.metas;
  else if(Array.isArray(catalog.staticItems)){
    metas=(await Promise.all(catalog.staticItems.map(async item=>{
      try{
        const html=await fetchHtml(RTP_BASE+item.path),poster=absoluteHttpUrl(metaTag(html,"og:image")),description=cleanTitle(metaTag(html,"og:description")||metaTag(html,"description"))||catalog.name;
        return{id:encodeId(item.path),type,name:item.name,...(poster?{poster,background:poster}:{poster:RTP_LOGO}),description,website:RTP_BASE+item.path};
      }catch{return{id:encodeId(item.path),type,name:item.name,poster:RTP_LOGO,description:catalog.name,website:RTP_BASE+item.path}}
    })));catalogCache.set(key,{at:Date.now(),metas})
  }else{metas=parseCatalog(await fetchHtml(catalog.url),type,catalog);catalogCache.set(key,{at:Date.now(),metas})}
  const needle=stripTags(search).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
  if(needle)metas=metas.filter(x=>String(x.name||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().includes(needle));
  return{metas:metas.slice(0,160)}
}

export async function getRtpVodMeta(type,id){
  const path=decodeId(id);if(!path)return null;const key=type+":"+id,cached=metaCache.get(key);if(cached&&Date.now()-cached.at<CACHE_TTL_MS)return cached.meta;
  const resolved=await resolveEpisodePath(path),website=RTP_BASE+resolved.path,html=await fetchHtml(website),title=metaTag(html,"og:title")||firstHeading(html)||slugTitle(resolved.path),description=cleanTitle(metaTag(html,"og:description")||metaTag(html,"description"))||"Conteúdo RTP Play",poster=absoluteHttpUrl(metaTag(html,"og:image")),videos=parseEpisodes(html);
  const duration=stripTags(html.match(/Dura(?:ç|&ccedil;)ão:\s*([^<\n]+)/i)?.[1]||"");
  const meta={id,type,name:cleanTitle(title),description,website,...(videos.length?{videos}:{}),...(poster?{poster,background:poster}:{poster:RTP_LOGO}),...(duration?{runtime:duration}:{})};
  metaCache.set(key,{at:Date.now(),meta});return meta
}

export async function getRtpVodStreams(type,id){
  if(!["movie","series","music","podcast"].includes(type))return[];
  const path=decodeId(id);if(!path)return[];
  const resolved=await resolveRtpPlaybackUrls(path),website=RTP_BASE+resolved.path;
  const streams=[];
  for(const mediaUrl of resolved.urls){
    streams.push({name:"PT•HUB • RTP Play",title:/\.mpd(?:$|[?#])/i.test(mediaUrl)?"RTP Play • DASH":"RTP Play • HLS",url:mediaUrl,behaviorHints:{notWebReady:true}})
  }
  if(streams.length)return streams;
  return[{name:"PT•HUB • RTP Play",title:"Abrir na RTP Play",externalUrl:website}]
}
