// PT•HUB 4.0 — Cloudflare Workers Free
// Edge-native foundation. Render implementation remains untouched.
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { Buffer } from "node:buffer";

const VERSION="4.0.0";
const CONFIG_TOKEN_PREFIX="c2_";
const CONFIG_STORE_MAX_BYTES=512*1024;
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"};
const json=(v,s=200,h={})=>new Response(JSON.stringify(v),{status:s,headers:{...CORS,"content-type":"application/json; charset=utf-8",...h}});
const noCache={"Cache-Control":"no-cache, no-store, must-revalidate"};
const isHttp=v=>{try{const u=new URL(v);return u.protocol==="http:"||u.protocol==="https:"}catch{return false}};
function encodeConfig(config){
 const raw=Buffer.from(JSON.stringify(config),"utf8");
 if(raw.byteLength>CONFIG_STORE_MAX_BYTES) throw new Error("Configuração demasiado grande.");
 return CONFIG_TOKEN_PREFIX+deflateRawSync(raw,{level:9}).toString("base64url");
}
function decodeConfig(token){
 try{
  const v=String(token||"");
  if(!v)return null;
  if(v.startsWith(CONFIG_TOKEN_PREFIX)) return JSON.parse(inflateRawSync(Buffer.from(v.slice(3),"base64url")).toString("utf8"));
  return JSON.parse(Buffer.from(v.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"));
 }catch{return null}
}
function manifest(){
 return {id:"pt.filipe.nuvio.tvhub",version:VERSION,name:"PT•HUB",description:"Hub de TV Portugal, IPTV M3U/Xtream Codes, filmes e séries.",logo:"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/addon/logo.png",resources:["catalog","meta","stream","addon_catalog","subtitles"],types:["channel","tv","movie","series"],catalogs:[{type:"movie",id:"movie-top",name:"🔥 Filmes Populares"},{type:"series",id:"series-top",name:"🔥 Séries Populares"},{type:"movie",id:"featured",name:"⭐ Filmes em Destaque"},{type:"series",id:"featured",name:"⭐ Séries em Destaque"},{type:"channel",id:"m3u",name:"Minha IPTV"},{type:"channel",id:"pt-services",name:"TV Portugal"}],addonCatalogs:[{type:"addon",id:"recommended",name:"Add-ons recomendados"}],idPrefixes:["pttv:","m3u:","xtream:","pthubptmeta:","rtpplay:","tt","tmdb:"],behaviorHints:{configurable:true,configurationRequired:false,p2p:true}};
}
async function hlsProxy(request,url,profile,target){
 if(!isHttp(target))return new Response("HLS target inválido.",{status:400,headers:CORS});
 const headers={"User-Agent":"Mozilla/5.0 (PT-HUB HLS Engine)"};
 if(profile==="rtp"){headers.Origin="https://www.rtp.pt";headers.Referer="https://www.rtp.pt/play/"}
 const range=request.headers.get("range"); if(range)headers.Range=range;
 const upstream=await fetch(target,{headers,redirect:"follow"});
 if(!upstream.ok)return new Response(`HLS upstream HTTP ${upstream.status}`,{status:upstream.status,headers:CORS});
 const ct=upstream.headers.get("content-type")||"";
 const playlist=ct.toLowerCase().includes("mpegurl")||/\.m3u8(?:$|[?#])/i.test(target);
 if(!playlist){
  const out=new Headers(CORS); if(ct)out.set("Content-Type",ct);
  for(const k of ["content-range","accept-ranges","content-length"]){const v=upstream.headers.get(k);if(v)out.set(k,v)}
  return new Response(upstream.body,{status:upstream.status,headers:out});
 }
 const base=upstream.url||target; const text=await upstream.text();
 const proxify=(ref)=>{try{const absolute=new URL(ref,base).toString();const enc=Buffer.from(absolute,"utf8").toString("base64url");return `${url.origin}/hls-proxy/${encodeURIComponent(profile)}/${enc}`}catch{return ref}};
 const rewritten=text.replace(/URI=(["'])(.*?)\1/gi,(m,q,u)=>`URI=${q}${proxify(u)}${q}`).split(/\r?\n/).map(l=>{const t=l.trim();return !t||t.startsWith("#")?l:proxify(t)}).join("\n");
 return new Response(rewritten,{headers:{...CORS,"content-type":"application/vnd.apple.mpegurl","Cache-Control":"no-store"}});
}


const SERVICES=[
{id:"pttv:vodafone",name:"Vodafone TV",description:"Acesso oficial à Vodafone TV para clientes Vodafone TV.",url:"https://www.vodafone.pt/pacotes/televisao/em-todos-ecras.html",logo:"https://www.vodafone.pt/content/dam/digital/vodafone/images/logos/vodafone-logo-red.svg"},
{id:"pttv:digi",name:"DIGI TV",description:"Acesso oficial à DIGI TV para clientes DIGI.",url:"https://www.digi.pt/tv/",logo:"https://www.digi.pt/favicon.ico"},
{id:"pttv:meogo",name:"MEO Go",description:"Acesso oficial ao MEO Go.",url:"https://tv.meo.pt/pt",logo:"https://www.meo.pt/favicon.ico"},
{id:"pttv:nos",name:"NOS TV",description:"Acesso oficial à NOS TV.",url:"https://www.nos.pt/tv/app-nos-tv",logo:"https://www.nos.pt/favicon.ico"}];
const ADDONS=[
{name:"Streaming Catalogs",status:"reference",url:"https://github.com/markflaisz/stremio-catalog"},
{name:"OpenSubtitles",status:"reference",url:"https://opensubtitles.strem.io/stremio/v1/manifest.json"},
{name:"Torrentio",status:"reference",url:"https://torrentio.strem.fun/manifest.json"},
{name:"TorrentsDB",status:"reference",url:"https://beta.stremio-addons.net/addons/torrentsdb/manifest.json"}];
const CINEMETA_BASE="https://v3-cinemeta.strem.io";
async function fetchJson(target){try{const r=await fetch(target,{headers:{Accept:"application/json","User-Agent":"PT-HUB/4.0.0"}});return r.ok?await r.json():null}catch{return null}}
function serviceMeta(s){return{id:s.id,type:"channel",name:s.name,description:s.description,poster:s.logo,logo:s.logo,links:[{name:"Abrir serviço",category:"external",url:s.url}],behaviorHints:{defaultVideoId:s.id}}}
async function catalog(type,id,extra=""){
 if(type==="channel"&&id==="pt-services")return SERVICES.map(serviceMeta);
 if((type==="movie"&&id==="movie-top")||(type==="series"&&id==="series-top")){const d=await fetchJson(`${CINEMETA_BASE}/catalog/${type}/top${extra?"/"+extra:""}.json`);return Array.isArray(d?.metas)?d.metas:[]}
 if((type==="movie"||type==="series")&&id==="featured"){const d=await fetchJson(`${CINEMETA_BASE}/catalog/${type}/top${extra?"/"+extra:""}.json`);return Array.isArray(d?.metas)?d.metas.slice(0,20):[]}
 return[];
}
async function meta(type,id){
 const service=SERVICES.find(x=>x.id===id);if(type==="channel"&&service)return serviceMeta(service);
 if(type==="movie"||type==="series"){const d=await fetchJson(`${CINEMETA_BASE}/meta/${type}/${encodeURIComponent(id)}.json`);if(d?.meta)return d.meta}
 return null;
}

const SUBSENSE_BASE_URL="https://subsense.nepiraw.com";
const SUBSENSE_INSTALL_PREFIX="bj6uhmdn-";
const SUBSENSE_MAX_SUBTITLES=10;
const SUBTITLE_LANGUAGES_BY_COUNTRY=Object.freeze({PT:["pt","pt-br","en"],BR:["pt-br","pt","en"],ES:["es","en"],FR:["fr","en"],DE:["de","en"],IT:["it","en"],GB:["en"],US:["en"],CA:["en","fr"]});
function subtitleLanguages(country){return [...new Set(SUBTITLE_LANGUAGES_BY_COUNTRY[String(country||"PT").toUpperCase()]||["en"])]}
function normalizeSubtitleLanguage(v){const l=String(v||"").trim().toLowerCase().replace(/_/g,"-");if(["pt-pt","por-pt","pt"].includes(l))return"pt";if(["pt-br","por-br","pob","por"].includes(l))return"pt-br";if(["eng","en-us","en-gb"].includes(l))return"en";if(["spa","es-es","es-mx"].includes(l))return"es";if(["fre","fra","fr-fr"].includes(l))return"fr";if(["ger","deu","de-de"].includes(l))return"de";if(["ita","it-it"].includes(l))return"it";return l}
async function getSubtitles(config,type,id,extra=""){
 if(config?.features?.subtitles===false)return[];
 const langs=subtitleLanguages(config?.catalogCountry||"PT");
 const seg=SUBSENSE_INSTALL_PREFIX+encodeURIComponent(JSON.stringify({languages:langs,maxSubtitles:SUBSENSE_MAX_SUBTITLES}));
 const base=`${SUBSENSE_BASE_URL}/${seg}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
 const target=extra?`${base}/${String(extra).replace(/^\\/+/,"")}`:`${base}.json`;
 try{
  const response=await fetch(target,{headers:{Accept:"application/json","User-Agent":"PT-HUB/4.0.0"}});
  if(!response.ok)return[];
  const data=await response.json(), seen=new Set(), out=[];
  for(const s of Array.isArray(data?.subtitles)?data.subtitles:[]){
   const lang=normalizeSubtitleLanguage(s?.lang), baseLang=lang.split("-")[0];
   if(!langs.some(x=>{const n=normalizeSubtitleLanguage(x);return n===lang||n.split("-")[0]===baseLang}))continue;
   const key=String(s?.url||`${s?.id||""}|${lang}`).toLowerCase(); if(seen.has(key))continue; seen.add(key); out.push(s);
  }
  return out.slice(0,SUBSENSE_MAX_SUBTITLES);
 }catch{return[]}
}
export default {async fetch(request,env){
 const url=new URL(request.url),p=url.pathname;
 if(request.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
 if(p==="/api/health")return json({ok:true,name:"PT•HUB",version:VERSION,runtime:"cloudflare-workers"});
 if(request.method==="POST"&&p==="/config-store"){
  try{const c=await request.json();if(!c||typeof c!=="object"||Array.isArray(c))return json({success:false,error:"Configuração inválida."},400);return json({success:true,token:encodeConfig(c),persistent:true})}
  catch(e){return json({success:false,error:e.message||"Não foi possível criar a configuração."},e.message==="Configuração demasiado grande."?413:500)}
 }
 if(request.method==="GET"&&p==="/manifest.json")return json(manifest(),200,noCache);
 let ac=p.match(/^\\/([^/]+)\\/catalog\\/addon\\/recommended(?:\\/([^/]+))?\\.json$/);
 if(request.method==="GET"&&ac)return json({addons:ADDONS});
 let cm=p.match(/^\\/([^/]+)\\/catalog\\/([^/]+)\\/([^/]+)(?:\\/([^/]+))?\\.json$/);
 if(request.method==="GET"&&cm)return json({metas:await catalog(decodeURIComponent(cm[2]),decodeURIComponent(cm[3]),cm[4]?decodeURIComponent(cm[4]):"")});
 let mm=p.match(/^\\/([^/]+)\\/meta\\/([^/]+)\\/([^/]+)\\.json$/);
 if(request.method==="GET"&&mm){const v=await meta(decodeURIComponent(mm[2]),decodeURIComponent(mm[3]));return json({meta:v||null});}
 let sm=p.match(/^\\/([^/]+)\\/subtitles\\/([^/]+)\\/([^/]+?)(?:\\/([^/]+))?\\.json$/);
 if(request.method==="GET"&&sm){const cfg=decodeConfig(sm[1]);return json({subtitles:await getSubtitles(cfg,decodeURIComponent(sm[2]),decodeURIComponent(sm[3]),sm[4]?decodeURIComponent(sm[4]):"")});}
 let m=p.match(/^\/([^/]+)\/manifest\.json$/); if(request.method==="GET"&&m){decodeConfig(m[1]);return json(manifest(),200,noCache)}
 m=p.match(/^\/hls-proxy\/([^/]+)\/([^/]+)$/); if(request.method==="GET"&&m){try{return await hlsProxy(request,url,decodeURIComponent(m[1]),Buffer.from(m[2],"base64url").toString("utf8"))}catch(e){return new Response("Falha no PT•HUB HLS Engine.",{status:502,headers:CORS})}}
 if(env.ASSETS&&(p==="/"||p==="/configure")){const target=new URL("/configure",url);return env.ASSETS.fetch(new Request(target,request))}
 return json({error:"PT•HUB Cloudflare migration endpoint pending",version:VERSION,path:p},501);
}};
