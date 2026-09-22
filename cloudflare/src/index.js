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
export default {async fetch(request,env){
 const url=new URL(request.url),p=url.pathname;
 if(request.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
 if(p==="/api/health")return json({ok:true,name:"PT•HUB",version:VERSION,runtime:"cloudflare-workers"});
 if(request.method==="POST"&&p==="/config-store"){
  try{const c=await request.json();if(!c||typeof c!=="object"||Array.isArray(c))return json({success:false,error:"Configuração inválida."},400);return json({success:true,token:encodeConfig(c),persistent:true})}
  catch(e){return json({success:false,error:e.message||"Não foi possível criar a configuração."},e.message==="Configuração demasiado grande."?413:500)}
 }
 if(request.method==="GET"&&p==="/manifest.json")return json(manifest(),200,noCache);
 let m=p.match(/^\/([^/]+)\/manifest\.json$/); if(request.method==="GET"&&m){decodeConfig(m[1]);return json(manifest(),200,noCache)}
 m=p.match(/^\/hls-proxy\/([^/]+)\/([^/]+)$/); if(request.method==="GET"&&m){try{return await hlsProxy(request,url,decodeURIComponent(m[1]),Buffer.from(m[2],"base64url").toString("utf8"))}catch(e){return new Response("Falha no PT•HUB HLS Engine.",{status:502,headers:CORS})}}
 if(env.ASSETS&&(p==="/"||p==="/configure")){const target=new URL("/configure",url);return env.ASSETS.fetch(new Request(target,request))}
 return json({error:"PT•HUB Cloudflare migration endpoint pending",version:VERSION,path:p},501);
}};
