const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 7000;
const BASE = __dirname;

// ============================================================
// CORS
// ============================================================

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// ============================================================
// HELPERS
// ============================================================

function loadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Erro ao carregar ${file}:`, error.message);
    return [];
  }
}

const services = loadJSON(
  path.join(BASE, "..", "data", "services.json")
);

const addons = loadJSON(
  path.join(BASE, "..", "data", "addons.json")
);

const manifest = require("./manifest.json");

// ============================================================
// M3U
// ============================================================

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      const attrs = {};
      const regex = /([\w-]+)="([^"]*)"/g;
      let match;

      while ((match = regex.exec(line)) !== null) {
        attrs[match[1]] = match[2];
      }

      const comma = line.indexOf(",");

      const title =
        comma >= 0
          ? line.slice(comma + 1).trim()
          : attrs["tvg-name"] || "Canal";

      current = {
        title,
        group: attrs["group-title"] || "IPTV",
        logo: attrs["tvg-logo"] || "",
        tvgId: attrs["tvg-id"] || ""
      };

      continue;
    }

    if (!line.startsWith("#") && current) {
      current.url = line;

      current.id =
        "m3u:" +
        Buffer.from(line)
          .toString("base64url")
          .slice(0, 24);

      channels.push(current);
      current = null;
    }
  }

  return channels;
}

// ============================================================
// M3U URL
// ============================================================

async function fetchM3U(url) {
  if (!url) return [];

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return parseM3U(await response.text());

  } catch (error) {
    console.error("Erro M3U:", error.message);
    return [];
  }
}

// ============================================================
// XTREAM
// ============================================================

function cleanXtreamUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

async function xtreamRequest(config, action = "") {

  const server = cleanXtreamUrl(config.xtream_url);
  const username = config.xtream_username || "";
  const password = config.xtream_password || "";

  if (!server || !username || !password) {
    return null;
  }

  const url =
    `${server}/player_api.php` +
    `?username=${encodeURIComponent(username)}` +
    `&password=${encodeURIComponent(password)}` +
    (action
      ? `&action=${encodeURIComponent(action)}`
      : "");

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();

  } catch (error) {
    console.error("Erro Xtream:", error.message);
    return null;
  }
}

async function getXtreamChannels(config) {

  const data = await xtreamRequest(
    config,
    "get_live_streams"
  );

  if (!Array.isArray(data)) {
    return [];
  }

  const server =
    cleanXtreamUrl(config.xtream_url);

  const username =
    config.xtream_username;

  const password =
    config.xtream_password;

  return data.map(channel => {

    const extension =
      channel.container_extension || "ts";

    return {
      id: `xtream:${channel.stream_id}`,

      title:
        channel.name ||
        `Canal ${channel.stream_id}`,

      group:
        channel.category_name ||
        "TV",

      logo:
        channel.stream_icon || "",

      tvgId:
        channel.epg_channel_id || "",

      url:
        `${server}/live/` +
        `${encodeURIComponent(username)}/` +
        `${encodeURIComponent(password)}/` +
        `${channel.stream_id}.${extension}`
    };
  });
}

// ============================================================
// IPTV
// ============================================================

async function getIPTVChannels(config) {

  if (!config) return [];

  if (config.iptv_type === "M3U URL") {
    return fetchM3U(config.m3u_url);
  }

  if (config.iptv_type === "Xtream Codes") {
    return getXtreamChannels(config);
  }

  return [];
}

// ============================================================
// MANIFEST
// ============================================================

app.get("/manifest.json", (req, res) => {
  res.json(manifest);
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>PT TV Hub</title>
      </head>
      <body style="font-family:Arial;max-width:800px;margin:40px auto">
        <h1>📺 PT TV Hub</h1>
        <p>Servidor online.</p>
        <p>Versão: ${manifest.version}</p>
        <p>
          <a href="/manifest.json">
            Abrir manifest.json
          </a>
        </p>
      </body>
    </html>
  `);
});

// ============================================================
// CATALOG — TV PORTUGAL
// ============================================================

app.get(
  "/catalog/channel/pt-services.json",
  (req, res) => {

    res.json({
      metas: services.map(service => ({
        id: service.id,
        type: "channel",
        name: service.name,
        poster: service.logo || "",
        description:
          service.description ||
          "Serviço oficial.",
        posterShape: "square"
      }))
    });
  }
);

// ============================================================
// CATALOG — IPTV
// ============================================================

app.get(
  "/catalog/channel/m3u.json",
  async (req, res) => {

    const config = req.query || {};

    const channels =
      await getIPTVChannels(config);

    res.json({
      metas: channels.map(channel => ({
        id: channel.id,
        type: "channel",
        name: channel.title,
        poster: channel.logo || "",
        description:
          channel.group || "IPTV",
        posterShape: "square"
      }))
    });
  }
);

// ============================================================
// META
// ============================================================

app.get(
  "/meta/channel/:id.json",
  async (req, res) => {

    const id =
      decodeURIComponent(req.params.id);

    const service =
      services.find(
        item => item.id === id
      );

    if (service) {

      return res.json({
        meta: {
          id: service.id,
          type: "channel",
          name: service.name,
          poster: service.logo || "",
          description:
            service.description ||
            "Serviço oficial.",
          posterShape: "square"
        }
      });
    }

    const config =
      req.query || {};

    const channels =
      await getIPTVChannels(config);

    const channel =
      channels.find(
        item => item.id === id
      );

    if (channel) {

      return res.json({
        meta: {
          id: channel.id,
          type: "channel",
          name: channel.title,
          poster: channel.logo || "",
          description:
            channel.group || "IPTV",
          posterShape: "square"
        }
      });
    }

    res.json({
      meta: null
    });
  }
);

// ============================================================
// STREAM
// ============================================================

app.get(
  "/stream/channel/:id.json",
  async (req, res) => {

    const id =
      decodeURIComponent(req.params.id);

    const service =
      services.find(
        item => item.id === id
      );

    if (service) {

      return res.json({
        streams: [
          {
            name: service.name,
            description:
              "Abrir serviço oficial. " +
              "O login e as permissões são tratados pelo operador.",
            externalUrl: service.url
          }
        ]
      });
    }

    const config =
      req.query || {};

    const channels =
      await getIPTVChannels(config);

    const channel =
      channels.find(
        item => item.id === id
      );

    if (channel) {

      return res.json({
        streams: [
          {
            name: channel.title,
            title: channel.group,
            description:
              "Fonte IPTV configurada pelo utilizador.",
            url: channel.url
          }
        ]
      });
    }

    res.json({
      streams: []
    });
  }
);

// ============================================================
// ADDONS
// ============================================================

app.get(
  "/catalog/addon/recommended.json",
  (req, res) => {

    res.json({
      metas: addons.map((addon, index) => ({
        id: `addon:${index}`,
        type: "addon",
        name: addon.name,
        description:
          "Recurso externo.",
        website: addon.url,
        posterShape: "square"
      }))
    });
  }
);

app.get(
  "/meta/addon/:id.json",
  (req, res) => {

    const index =
      Number(
        req.params.id.replace("addon:", "")
      );

    const addon = addons[index];

    if (!addon) {
      return res.json({
        meta: null
      });
    }

    res.json({
      meta: {
        id: `addon:${index}`,
        type: "addon",
        name: addon.name,
        description: addon.url,
        website: addon.url
      }
    });
  }
);

app.get(
  "/stream/addon/:id.json",
  (req, res) => {

    const index =
      Number(
        req.params.id.replace("addon:", "")
      );

    const addon = addons[index];

    res.json({
      streams: addon
        ? [
            {
              name: addon.name,
              externalUrl: addon.url
            }
          ]
        : []
    });
  }
);

// ============================================================
// CONFIGURAÇÃO
// ============================================================

app.get("/configure", (req, res) => {

  res.type("html").send(`
<!doctype html>

<html>

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>PT TV Hub</title>

<style>

body {
  font-family: Arial, sans-serif;
  max-width: 800px;
  margin: 40px auto;
  padding: 20px;
}

input,
select {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  margin: 6px 0 16px;
}

button {
  padding: 12px 20px;
  cursor: pointer;
}

.card {
  border: 1px solid #ddd;
  padding: 20px;
  margin-bottom: 20px;
  border-radius: 10px;
}

</style>

</head>

<body>

<h1>📺 PT TV Hub</h1>

<div class="card">

<h2>📡 IPTV</h2>

<p>
Esta página será utilizada para configurar
as fontes IPTV na próxima versão.
</p>

<p>
<strong>Tipos previstos:</strong>
</p>

<ul>
<li>M3U URL</li>
<li>Xtream Codes</li>
<li>EPG</li>
</ul>

</div>

</body>

</html>
  `);
});

// ============================================================
// 404
// ============================================================

app.use((req, res) => {

  res.status(404).json({
    error: "Endpoint não encontrado"
  });
});

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `PT TV Hub em 0.0.0.0:${PORT}`
    );

    console.log(
      `Manifest disponível em /manifest.json`
    );
  }
);
