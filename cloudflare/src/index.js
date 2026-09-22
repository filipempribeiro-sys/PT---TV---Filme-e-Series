// PT•HUB 4.0 — Cloudflare Workers Free
// Edge-native foundation. Render implementation remains untouched.
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { Buffer } from "node:buffer";

const VERSION="4.0.0";
const CONFIG_TOKEN_PREFIX="c2_";
const CONFIG_STORE_MAX_BYTES=512*1024;
const M3U_UPLOAD_MAX_BYTES=10*1024*1024;
const M3U_KV_TTL_SECONDS=60*60*24*30;
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


function normalizeUrl(v){return String(v||"").trim().replace(/\/+$/,"")}
async function hashId(v){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("").slice(0,24)}
async function parseM3U(content){
 const lines=String(content||"").replace(/\r/g,"").split("\n"),out=[];let info=null;
 for(const raw of lines){const line=raw.trim();if(!line)continue;
  if(line.startsWith("#EXTINF:")){const i=line.indexOf(","),a=i>=0?line.slice(0,i):"",name=i>=0?line.slice(i+1).trim():"Canal IPTV";const attr=n=>a.match(new RegExp(n+'=["\\\']([^"\\\']*)["\\\']',"i"))?.[1]||"";info={name:name||attr("tvg-name")||"Canal IPTV",tvgId:attr("tvg-id"),logo:attr("tvg-logo"),group:attr("group-title")||"TV"};continue}
  if(!line.startsWith("#")&&isHttp(line)&&info){out.push({id:"m3u:"+(await hashId(line)),type:"channel",name:info.name,logo:info.logo,group:info.group,tvgId:info.tvgId,url:line});info=null}
 }return out;
}
async function getM3UChannels(config){const r=await fetch(config.m3uUrl,{headers:{"User-Agent":"PT-HUB/4.0.0"}});if(!r.ok)throw new Error("M3U HTTP "+r.status);return parseM3U(await r.text())}
async function getXtreamChannels(config){
 const server=normalizeUrl(config.xtreamServer);if(!isHttp(server)||!config.username||!config.password)return[];
 const api=`${server}/player_api.php?username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}&action=get_live_streams`;
 const r=await fetch(api,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json,*/*"}});if(!r.ok)throw new Error("Xtream HTTP "+r.status);
 const data=await r.json();if(!Array.isArray(data))return[];
 return data.map(x=>{const id=String(x.stream_id||x.id||"");return{id:`xtream:${id}`,type:"channel",name:x.name||x.stream_display_name||"Canal Xtream",logo:x.stream_icon||x.logo||"",group:x.category_name||"TV",tvgId:x.epg_channel_id||"",url:`${server}/live/${encodeURIComponent(config.username)}/${encodeURIComponent(config.password)}/${encodeURIComponent(id)}.ts`}});
}

const IPTVORG_CHANNELS_URL="https://iptv-org.github.io/api/channels.json";
const IPTVORG_STREAMS_URL="https://iptv-org.github.io/api/streams.json";
const IPTVORG_LOGOS_URL="https://iptv-org.github.io/api/logos.json";
const COUNTRY_MAP={PORTUGAL:"PT",BRASIL:"BR",BRAZIL:"BR",ESPANHA:"ES",SPAIN:"ES","REINO UNIDO":"GB","UNITED KINGDOM":"GB",FRANCA:"FR","FRANÇA":"FR",FRANCE:"FR",ALEMANHA:"DE",GERMANY:"DE",ITALIA:"IT","ITÁLIA":"IT",ITALY:"IT","ESTADOS UNIDOS":"US",USA:"US","UNITED STATES":"US"};
function countryCode(v){const s=String(v||"").trim().toUpperCase();return s.length===2?s:(COUNTRY_MAP[s]||s)}
async function getIPTVOrgChannels(config){
 const opt=config?.iptvOrg||{}, rawCountry=String(opt.country||"").trim(), category=String(opt.category||"").trim().toLowerCase(), country=rawCountry||category?countryCode(rawCountry):"PT";
 const [cr,sr,lr]=await Promise.all([fetch(IPTVORG_CHANNELS_URL),fetch(IPTVORG_STREAMS_URL),fetch(IPTVORG_LOGOS_URL).catch(()=>null)]);
 if(!cr.ok||!sr.ok)throw new Error("IPTV-org indisponível");
 const channels=await cr.json(),streams=await sr.json(),logos=lr?.ok?await lr.json():[];
 const by=new Map(),logo=new Map();for(const s of streams){if(s.channel&&s.url){const a=by.get(s.channel)||[];a.push(s);by.set(s.channel,a)}}for(const x of logos)if(x.channel&&!logo.has(x.channel))logo.set(x.channel,x.url);
 const out=[];for(const ch of channels){if(country&&String(ch.country||"").toUpperCase()!==country)continue;if(category&&!(ch.categories||[]).map(x=>String(x).toLowerCase()).some(x=>x===category||x.includes(category)||category.includes(x)))continue;const ss=by.get(ch.id)||[];if(!ss.length)continue;out.push({id:`iptvorg:${ch.id}`,type:"channel",name:ch.name||ch.id,logo:ch.logo||logo.get(ch.id)||"",group:ch.categories?.[0]||"TV",tvgId:ch.id,url:ss[0].url})}return out;
}

async function getStoredM3UChannels(config,env){
 if(!config?.m3uFileId||!env?.PT_HUB_M3U)return[];
 const raw=await env.PT_HUB_M3U.get(`m3u:${config.m3uFileId}`);
 return raw?parseM3U(raw):[];
}
async function getIPTVChannels(config,env){
 if(!config||config?.features?.iptv===false)return[];
 if(config.mode==="m3u"&&config.m3uSource!=="file"&&isHttp(config.m3uUrl))return getM3UChannels(config);
 if(config.mode==="m3u"&&config.m3uFileId)return getStoredM3UChannels(config,env);
 if(config.mode==="m3u"&&config.m3uFileData)return parseM3U(config.m3uFileData);
 if(config.mode==="xtream")return getXtreamChannels(config);
 if(config.mode==="iptv-org")return getIPTVOrgChannels(config);
 return[];
}
function channelMeta(x){return{id:x.id,type:"channel",name:x.name,poster:x.logo||manifest().logo,logo:x.logo||manifest().logo,description:x.group||"TV"}}

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
 const target=extra?`${base}/${String(extra).replace(/^[/]+/,"")}`:`${base}.json`;
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
 if(request.method==="POST"&&p==="/upload-m3u"){
  if(!env.PT_HUB_M3U)return json({success:false,error:"Armazenamento M3U indisponível."},503);
  try{
   const ct=request.headers.get("content-type")||"";let raw="";
   if(ct.includes("multipart/form-data")){const form=await request.formData();const file=form.get("file");if(!file||typeof file==="string")return json({success:false,error:"Ficheiro M3U em falta."},400);if(file.size>M3U_UPLOAD_MAX_BYTES)return json({success:false,error:"Ficheiro M3U demasiado grande."},413);raw=await file.text()}
   else{const len=Number(request.headers.get("content-length")||0);if(len>M3U_UPLOAD_MAX_BYTES)return json({success:false,error:"Ficheiro M3U demasiado grande."},413);raw=await request.text();if(new TextEncoder().encode(raw).byteLength>M3U_UPLOAD_MAX_BYTES)return json({success:false,error:"Ficheiro M3U demasiado grande."},413)}
   if(!raw.includes("#EXTM3U")&&!raw.includes("#EXTINF:"))return json({success:false,error:"Conteúdo M3U inválido."},400);
   const id=await hashId(raw+":"+crypto.randomUUID());await env.PT_HUB_M3U.put(`m3u:${id}`,raw,{expirationTtl:M3U_KV_TTL_SECONDS});
   return json({success:true,m3uFileId:id,persistent:true,expiresInDays:30});
  }catch(e){return json({success:false,error:e?.message||"Não foi possível guardar a lista M3U."},500)}
 }
 if(request.method==="GET"&&p==="/api/storage-health"){
  if(!env.PT_HUB_M3U)return json({ok:false,storage:"kv",binding:"PT_HUB_M3U",error:"Binding indisponível."},503);
  try{const probe="health:"+crypto.randomUUID();await env.PT_HUB_M3U.put(probe,"ok",{expirationTtl:60});const value=await env.PT_HUB_M3U.get(probe);await env.PT_HUB_M3U.delete(probe);return json({ok:value==="ok",storage:"kv",binding:"PT_HUB_M3U",readWriteDelete:value==="ok"})}
  catch(e){return json({ok:false,storage:"kv",binding:"PT_HUB_M3U",error:e?.message||"Falha KV."},500)}
 }
 if(request.method==="GET"&&p==="/manifest.json")return json(manifest(),200,noCache);
 let ac=p.match(new RegExp("^/([^/]+)/catalog/addon/recommended(?:/([^/]+))?\\.json$"));
 if(request.method==="GET"&&ac)return json({addons:ADDONS});
 let cm=p.match(new RegExp("^/([^/]+)/catalog/([^/]+)/([^/]+)(?:/([^/]+))?\\.json$"));
 if(request.method==="GET"&&cm){const cfg=decodeConfig(cm[1]);const type=decodeURIComponent(cm[2]),id=decodeURIComponent(cm[3]);if(type==="channel"&&id==="m3u"){try{return json({metas:(await getIPTVChannels(cfg,env)).map(channelMeta)})}catch{return json({metas:[]})}}return json({metas:await catalog(type,id,cm[4]?decodeURIComponent(cm[4]):"")});}
 let st=p.match(new RegExp("^/([^/]+)/stream/([^/]+)/([^/]+)\\.json$"));
 if(request.method==="GET"&&st&&decodeURIComponent(st[2])==="channel"){try{const cfg=decodeConfig(st[1]),id=decodeURIComponent(st[3]),ch=(await getIPTVChannels(cfg,env)).find(x=>x.id===id);if(!ch)return json({streams:[]});const streamUrl=/\\.m3u8(?:$|[?#])/i.test(ch.url)?`${url.origin}/hls-proxy/generic/${Buffer.from(ch.url,"utf8").toString("base64url")}`:ch.url;return json({streams:[{name:"PT•HUB",title:ch.name,url:streamUrl,behaviorHints:{notWebReady:true}}]})}catch{return json({streams:[]})}}
 let mm=p.match(new RegExp("^/([^/]+)/meta/([^/]+)/([^/]+)\\.json$"));
 if(request.method==="GET"&&mm){const v=await meta(decodeURIComponent(mm[2]),decodeURIComponent(mm[3]));return json({meta:v||null});}
 let sm=p.match(new RegExp("^/([^/]+)/subtitles/([^/]+)/([^/]+?)(?:/([^/]+))?\\.json$"));
 if(request.method==="GET"&&sm){const cfg=decodeConfig(sm[1]);return json({subtitles:await getSubtitles(cfg,decodeURIComponent(sm[2]),decodeURIComponent(sm[3]),sm[4]?decodeURIComponent(sm[4]):"")});}
 let m=p.match(/^\/([^/]+)\/manifest\.json$/); if(request.method==="GET"&&m){decodeConfig(m[1]);return json(manifest(),200,noCache)}
 m=p.match(/^\/hls-proxy\/([^/]+)\/([^/]+)$/); if(request.method==="GET"&&m){try{return await hlsProxy(request,url,decodeURIComponent(m[1]),Buffer.from(m[2],"base64url").toString("utf8"))}catch(e){return new Response("Falha no PT•HUB HLS Engine.",{status:502,headers:CORS})}}
 if(env.ASSETS&&(p==="/"||p==="/configure")){const target=new URL("/configure",url);return env.ASSETS.fetch(new Request(target,request))}
 return json({error:"PT•HUB Cloudflare migration endpoint pending",version:VERSION,path:p},501);
}};
