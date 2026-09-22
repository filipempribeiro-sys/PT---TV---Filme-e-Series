// PT•HUB 4.0 — Cloudflare Free runtime entrypoint.
// Phase 1 provides the always-on edge shell while the existing endpoint logic is ported endpoint-by-endpoint.
const VERSION = "4.0.0";
const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,"content-type":"application/json; charset=utf-8"}});
export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if(request.method==="OPTIONS") return new Response(null,{status:204,headers:cors});
    if(url.pathname==="/api/health") return json({ok:true,name:"PT•HUB",version:VERSION,runtime:"cloudflare-workers"});
    // Static configure/logo/background files are served from addon/ by ASSETS.
    if(env.ASSETS && (url.pathname==="/" || url.pathname==="/configure")) {
      const target=new URL("/configure",url);
      return env.ASSETS.fetch(new Request(target,request));
    }
    return json({error:"PT•HUB Cloudflare migration endpoint pending",version:VERSION,path:url.pathname},501);
  }
};
