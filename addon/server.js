const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 7000;
const BASE = __dirname;
const services = JSON.parse(fs.readFileSync(path.join(BASE, "..", "data", "services.json"), "utf8"));
const addons = JSON.parse(fs.readFileSync(path.join(BASE, "..", "data", "addons.json"), "utf8"));

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let current = null;
  for (const line0 of lines) {
    const line = line0.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const attrs = {};
      const attrRe = /([\w-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRe.exec(line))) attrs[m[1]] = m[2];
      const comma = line.indexOf(",");
      const title = comma >= 0 ? line.slice(comma + 1).trim() : (attrs["tvg-name"] || "Canal");
      current = { title, group: attrs["group-title"] || "IPTV", logo: attrs["tvg-logo"] || "" };
    } else if (!line.startsWith("#") && current) {
      current.url = line;
      current.id = "m3u:" + Buffer.from(line).toString("base64url").slice(0, 24);
      out.push(current);
      current = null;
    }
  }
  return out;
}

function loadUserM3U() {
  const file = path.join(BASE, "..", "data", "user.m3u");
  if (!fs.existsSync(file)) return [];
  try { return parseM3U(fs.readFileSync(file, "utf8")); } catch { return []; }
}

app.get("/manifest.json", (req, res) => {
  res.json(require("./manifest.json"));
});

app.get("/catalog/channel/pt-services.json", (req, res) => {
  res.json({ metas: services.map(s => ({
    id:s.id, type:"channel", name:s.name, poster:s.logo,
    description:s.description, posterShape:"square"
  }))});
});

app.get("/catalog/channel/m3u.json", (req, res) => {
  const channels = loadUserM3U();
  res.json({ metas: channels.map(c => ({
    id:c.id, type:"channel", name:c.title, poster:c.logo,
    description:c.group, posterShape:"square"
  }))});
});

app.get("/meta/channel/:id.json", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const s = services.find(x => x.id === id);
  if (s) return res.json({ meta:{
    id:s.id, type:"channel", name:s.name, poster:s.logo,
    description:s.description, posterShape:"square"
  }});
  const c = loadUserM3U().find(x => x.id === id);
  if (c) return res.json({ meta:{
    id:c.id, type:"channel", name:c.title, poster:c.logo,
    description:c.group, posterShape:"square"
  }});
  res.json({ meta:null });
});

app.get("/stream/channel/:id.json", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const s = services.find(x => x.id === id);
  if (s) return res.json({ streams:[{
    name:s.name,
    description:"Abrir serviço oficial. O login e as permissões são tratados pelo operador.",
    externalUrl:s.url
  }]});
  const c = loadUserM3U().find(x => x.id === id);
  if (c) return res.json({ streams:[{
    name:c.title,
    title:c.group,
    url:c.url
  }]});
  res.json({ streams:[] });
});

app.get("/catalog/addon/recommended.json", (req,res) => {
  res.json({ metas: addons.map((a,i)=>({
    id:"addon:"+i, type:"addon", name:a.name,
    description:"Manifest/recurso externo; instalação/configuração é feita pelo utilizador.",
    website:a.url, posterShape:"square"
  }))});
});

app.get("/meta/addon/:id.json", (req,res)=>{
  const i = Number(req.params.id.replace("addon:",""));
  const a = addons[i];
  if (!a) return res.json({meta:null});
  res.json({meta:{id:"addon:"+i,type:"addon",name:a.name,description:a.url,website:a.url}});
});

app.get("/stream/addon/:id.json", (req,res)=>{
  const i = Number(req.params.id.replace("addon:",""));
  const a = addons[i];
  res.json({streams:a ? [{name:a.name,externalUrl:a.url}] : []});
});

app.get("/configure", (req,res)=>{
  res.type("html").send(`<!doctype html><meta charset="utf-8">
  <title>PT TV Hub</title><style>body{font-family:sans-serif;max-width:760px;margin:40px auto;padding:0 16px}code{background:#eee;padding:2px 4px}</style>
  <h1>PT TV Hub</h1>
  <p>Para usar IPTV própria/legal, coloque uma lista M3U em <code>data/user.m3u</code> no servidor.</p>
  <p>O hub não recolhe nem guarda credenciais Vodafone, DIGI, MEO ou NOS e não contorna DRM.</p>`);
});

app.listen(PORT, ()=>console.log(`PT TV Hub em http://localhost:${PORT}`));
