const JAMENDO_API="https://api.jamendo.com/v3.0";
const CACHE_TTL_MS=10*60*1000;
const cache=new Map();
const trackCache=new Map();

export const JAMENDO_CATALOGS=Object.freeze([
  {type:"music",id:"jamendo-popular",name:"🎵 Jamendo • Populares",order:"popularity_total"},
  {type:"music",id:"jamendo-new",name:"🆕 Jamendo • Novidades",order:"releasedate_desc"},
  {type:"music",id:"jamendo-rock",name:"🎸 Jamendo • Rock",order:"popularity_total",tags:"rock"},
  {type:"music",id:"jamendo-electronic",name:"🎛️ Jamendo • Eletrónica",order:"popularity_total",tags:"electronic"},
  {type:"music",id:"jamendo-jazz",name:"🎷 Jamendo • Jazz",order:"popularity_total",tags:"jazz"},
  {type:"music",id:"jamendo-classical",name:"🎻 Jamendo • Clássica",order:"popularity_total",tags:"classical"},
  {type:"music",id:"jamendo-hiphop",name:"🎤 Jamendo • Hip-Hop",order:"popularity_total",tags:"hiphop"},
  {type:"music",id:"jamendo-world",name:"🌍 Jamendo • World",order:"popularity_total",tags:"world"},
  {type:"music",id:"jamendo-relax",name:"🌙 Jamendo • Relax",order:"popularity_total",tags:"chillout"},
]);

function clientId(env){return String(env?.JAMENDO_CLIENT_ID||"").trim()}
function trackId(id=""){const m=String(id).match(/^jamendo:(\d+)$/);return m?m[1]:""}
function apiUrl(env,params={}){const id=clientId(env);if(!id)return"";const u=new URL(JAMENDO_API+"/tracks/");u.searchParams.set("client_id",id);u.searchParams.set("format","json");u.searchParams.set("limit",String(params.limit||60));u.searchParams.set("include","musicinfo");u.searchParams.set("audioformat","mp31");u.searchParams.set("imagesize","600");for(const [k,v] of Object.entries(params)){if(v!=null&&v!==""&&!["limit"].includes(k))u.searchParams.set(k,String(v))}return u.toString()}
async function fetchJson(url){if(!url)return null;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{const r=await fetch(url,{signal:controller.signal,headers:{Accept:"application/json","User-Agent":"PT-HUB/4.0 Jamendo"}});if(!r.ok)return null;return await r.json()}finally{clearTimeout(timer)}}
function mapTrack(t){if(!t?.id)return null;const id="jamendo:"+t.id,poster=t.image||t.album_image||"";trackCache.set(String(t.id),{at:Date.now(),track:t});return{id,type:"music",name:t.name||"Faixa",poster:poster||undefined,background:poster||undefined,description:[t.artist_name,t.album_name].filter(Boolean).join(" • "),releaseInfo:t.releasedate||undefined,website:t.shareurl||undefined,runtime:Number(t.duration)||undefined,_ptHub:{source:"jamendo",artist:t.artist_name||"",audio:t.audio||"",license:t.license_ccurl||"",downloadAllowed:t.audiodownload_allowed===true}}}

export async function getJamendoCatalog(env,type,id,search=""){
  if(type!=="music")return{metas:[]};const catalog=JAMENDO_CATALOGS.find(x=>x.id===id);if(!catalog)return{metas:[]};const key=id+"|"+String(search||"").trim().toLowerCase(),cached=cache.get(key);if(cached&&Date.now()-cached.at<CACHE_TTL_MS)return cached.value;
  const params={order:catalog.order,limit:80};if(catalog.tags)params.tags=catalog.tags;if(String(search||"").trim())params.search=String(search).trim();
  const body=await fetchJson(apiUrl(env,params));const metas=(Array.isArray(body?.results)?body.results:[]).map(mapTrack).filter(Boolean);const value={metas};cache.set(key,{at:Date.now(),value});return value
}
export async function getJamendoMeta(env,type,id){if(type!=="music")return null;const tid=trackId(id);if(!tid)return null;let t=trackCache.get(tid)?.track;if(!t){const body=await fetchJson(apiUrl(env,{id:tid,limit:1}));t=Array.isArray(body?.results)?body.results[0]:null}return t?mapTrack(t):null}
export async function getJamendoStreams(env,type,id){if(type!=="music")return[];const meta=await getJamendoMeta(env,type,id);const audio=meta?._ptHub?.audio;if(!audio)return[];return[{name:"PT•HUB • Jamendo",title:[meta._ptHub.artist,meta.name].filter(Boolean).join(" — "),url:audio,behaviorHints:{notWebReady:false}}]}
