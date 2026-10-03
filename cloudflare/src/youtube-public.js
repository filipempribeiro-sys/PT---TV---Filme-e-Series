const YT_API="https://www.googleapis.com/youtube/v3";
const CACHE_TTL_MS=10*60*1000;
const cache=new Map();

export const YOUTUBE_PUBLIC_CATALOGS=Object.freeze([
  {type:"music",id:"youtube-music",name:"▶ YouTube • Música",kind:"music"},
  {type:"podcast",id:"youtube-podcasts",name:"🎙️ YouTube • Podcasts",kind:"podcast"},
]);

function apiKey(env){return String(env?.YOUTUBE_API_KEY||"").trim()}
function videoId(id=""){const m=String(id).match(/^youtube:([A-Za-z0-9_-]{6,})$/);return m?m[1]:""}
async function fetchJson(url){const c=new AbortController(),t=setTimeout(()=>c.abort(),12000);try{const r=await fetch(url,{signal:c.signal,headers:{Accept:"application/json","User-Agent":"PT-HUB/4.0 YouTube-Public"}});if(!r.ok)return null;return await r.json()}finally{clearTimeout(t)}}
function thumb(snippet={}){return snippet?.thumbnails?.maxres?.url||snippet?.thumbnails?.high?.url||snippet?.thumbnails?.medium?.url||snippet?.thumbnails?.default?.url||""}
function mapSearchItem(item,type){const vid=item?.id?.videoId;if(!vid)return null;const s=item.snippet||{},poster=thumb(s);return{id:"youtube:"+vid,type,name:s.title||"YouTube",poster:poster||undefined,background:poster||undefined,description:[s.channelTitle,s.description].filter(Boolean).join("\n"),released:s.publishedAt||undefined,website:"https://www.youtube.com/watch?v="+vid,_ptHub:{source:"youtube",channel:s.channelTitle||""}}}
export async function getYouTubeCatalog(env,type,id,search=""){
  const key=apiKey(env);if(!key)return{metas:[]};const catalog=YOUTUBE_PUBLIC_CATALOGS.find(x=>x.type===type&&x.id===id);if(!catalog)return{metas:[]};const cacheKey=id+"|"+String(search||"").trim().toLowerCase(),cached=cache.get(cacheKey);if(cached&&Date.now()-cached.at<CACHE_TTL_MS)return cached.value;
  const u=new URL(YT_API+"/search");u.searchParams.set("key",key);u.searchParams.set("part","snippet");u.searchParams.set("type","video");u.searchParams.set("maxResults","40");u.searchParams.set("regionCode","PT");u.searchParams.set("safeSearch","moderate");
  if(String(search||"").trim())u.searchParams.set("q",String(search).trim());
  else if(catalog.kind==="music"){u.searchParams.set("videoCategoryId","10");u.searchParams.set("order","viewCount")}
  else{u.searchParams.set("q","podcast");u.searchParams.set("videoDuration","long");u.searchParams.set("order","date")}
  const body=await fetchJson(u.toString());const metas=(Array.isArray(body?.items)?body.items:[]).map(x=>mapSearchItem(x,type)).filter(Boolean),value={metas};cache.set(cacheKey,{at:Date.now(),value});return value
}
export async function getYouTubeMeta(env,type,id){const key=apiKey(env),vid=videoId(id);if(!key||!vid||!["music","podcast"].includes(type))return null;const u=new URL(YT_API+"/videos");u.searchParams.set("key",key);u.searchParams.set("part","snippet,contentDetails");u.searchParams.set("id",vid);const body=await fetchJson(u.toString()),item=Array.isArray(body?.items)?body.items[0]:null;if(!item)return null;const s=item.snippet||{},poster=thumb(s);return{id,type,name:s.title||"YouTube",poster:poster||undefined,background:poster||undefined,description:[s.channelTitle,s.description].filter(Boolean).join("\n"),released:s.publishedAt||undefined,website:"https://www.youtube.com/watch?v="+vid,_ptHub:{source:"youtube",channel:s.channelTitle||"",duration:item?.contentDetails?.duration||""}}}
export async function getYouTubeStreams(env,type,id){const vid=videoId(id);if(!vid||!["music","podcast"].includes(type))return[];return[{name:"PT•HUB • YouTube",title:"Abrir no YouTube",externalUrl:"https://www.youtube.com/watch?v="+vid}]}
