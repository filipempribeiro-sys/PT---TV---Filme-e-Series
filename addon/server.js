const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;
const BASE_DIR = __dirname;

const VERSION = "1.7.0";

const PT_HUB_LOGO =
  "https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/addon/logo.png";

const PT_HUB_BACKGROUND =
 "https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/addon/background.jpg";


const CINEMETA_BASE = "https://v3-cinemeta.strem.io";

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

/* =========================================================
   HELPERS
   ========================================================= */

function loadJSON(relativePath, fallback) {
  try {
    const filePath = path.join(BASE_DIR, relativePath);

    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`Erro ao carregar ${relativePath}:`, error.message);
    return fallback;
  }
}

const services = loadJSON("../data/services.json", []);
const addons = loadJSON("../data/addons.json", []);

const operators = loadJSON("../data/operators.json",[]);
const streamers = loadJSON("../data/streamers.json",[]);
const catalogs = loadJSON("../data/catalogs.json",[]);

const manifestTemplate = loadJSON(
  "./manifest.json",
  {
    id: "pt.filipe.nuvio.tvhub",
    version: VERSION,
    name: "PT•HUB"
  }
);

/* =========================================================
   BASE64URL CONFIG
   ========================================================= */

function encodeConfig(config) {
  return Buffer.from(
    JSON.stringify(config),
    "utf8"
  ).toString("base64url");
}

function decodeConfig(value) {
  try {
    if (!value) {
      return null;
    }
     return JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    );
  } catch (error) {
    console.error("Erro a descodificar configuração:", error.message);
    return null;
  }
}

/* =========================================================
   GENERAL HELPERS
   ========================================================= */

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

/* =========================================================
 FETCH WITH TIMEOUT
 ========================================================= */

async function fetchWithTimeout(
 url,
 options = {},
 timeoutMs = 15000
) {

 const controller =
 new AbortController();

 const timeout =
 setTimeout(
 () => controller.abort(),
 timeoutMs
 );

 try {

 const response =
 await fetch(url, {
 ...options,
 signal: controller.signal
 });
 
return response;

 } finally {

 clearTimeout(timeout);

 }

}

/* =========================================================
   M3U CACHE & PARSER
   ========================================================= */

const m3uCache = new Map();
const M3U_CACHE_TTL = 5 * 60 * 1000;

function parseM3U(content) {
  const lines = String(content || "")
    .replace(/\r/g, "")
    .split("\n");

  const channels = [];

  let currentInfo = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }
     if (line.startsWith("#EXTINF:")) {
      const commaIndex = line.indexOf(",");

      let attributes = "";
      let name = line;

      if (commaIndex >= 0) {
        attributes = line.slice(0, commaIndex);
        name = line.slice(commaIndex + 1).trim();
      }
       const tvgIdMatch = attributes.match(
        /tvg-id="([^"]*)"/i
      );
      const tvgNameMatch = attributes.match(
        /tvg-name="([^"]*)"/i
      );
      const tvgLogoMatch = attributes.match(
        /tvg-logo=["']([^"']*)["']/i
      );
      const groupMatch = attributes.match(
        /group-title="([^"]*)"/i
      );
       const groupMatchSingle = attributes.match(
        /group-title='([^']*)'/i
      );

      currentInfo = {
        name:
          tvgNameMatch?.[1] ||
          name ||
          "Canal IPTV",

        tvgId:
          tvgIdMatch?.[1] ||
          "",

        logo:
          tvgLogoMatch?.[1] ||
          "",

        group:
          groupMatch?.[1] ||
          groupMatchSingle?.[1] ||
          "TV"
      };
       continue;
    }
     if (
      !line.startsWith("#") &&
      isValidHttpUrl(line) &&
      currentInfo
    ) {
      const idHash = crypto
        .createHash("sha256")
        .update(line)
        .digest("hex")
        .slice(0, 24);

      channels.push({
        id: `m3u:${idHash}`,
        type: "channel",
        name: currentInfo.name,
        logo: currentInfo.logo,
        group: currentInfo.group,
        tvgId: currentInfo.tvgId,
        url: line
      });

      currentInfo = null;
    }
  }

  return channels;
}

async function fetchM3U(url) {

  if (!isValidHttpUrl(url)) {
    throw new Error(
      "URL M3U inválido."
    );
  }

  const cacheKey = url;

  const cached =
    m3uCache.get(cacheKey);

  const now =
    Date.now();

  if (
    cached &&
    (now - cached.timestamp) <
      M3U_CACHE_TTL
  ) {
    return cached.channels;
  }

  const response =
    await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent":
            `PT-HUB/${VERSION}`
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `Não foi possível obter a lista M3U. HTTP ${response.status}`
    );
  }

  const text =
    await response.text();

  if (!text.trim()) {
    throw new Error(
      "A lista M3U está vazia."
    );
  }

  const channels =
    parseM3U(text);

  m3uCache.set(
    cacheKey,
    {
      timestamp: now,
      channels
    }
  );

  return channels;
}

/* =========================================================
   XTREAM CACHE & API
   ========================================================= */

const xtreamCache = new Map();
const XTREAM_CACHE_TTL = 5 * 60 * 1000;

async function xtreamRequest(config, action) {

 const server =
 normalizeUrl(
 config.xtreamServer
 );

 if (!server) {
 throw new Error(
 "Servidor Xtream não definido."
 );
 }

 if (
 !config.username ||
 !config.password
 ) {
 throw new Error(
 "Username ou password Xtream em falta."
 );
 }

console.log(
  "XTREAM ACTION:",
  action
);

let url =
 `${server}/player_api.php` +
 `?username=${encodeURIComponent(config.username)}` +
 `&password=${encodeURIComponent(config.password)}`;

if (action) {

 url +=
 `&action=${encodeURIComponent(action)}`;

}

 const controller =
 new AbortController();

 const timeout =
 setTimeout(
 () => controller.abort(),
 15000
 );

 let response;

 try {

response =
 await fetch(url, {
 signal:
 controller.signal,

 redirect: "follow",

 headers: {
 "User-Agent":
 "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",

 "Accept":
 "application/json,*/*"
 }
 });

 clearTimeout(timeout);

 } catch (error) {

 clearTimeout(timeout);

 console.error(
 "XTREAM FETCH ERROR:",
 error
 );

 throw new Error(
 `Falha ao contactar servidor Xtream (${error.cause?.code || error.message})`
 );

 }

 if (!response.ok) {

 throw new Error(
 `Xtream respondeu HTTP ${response.status}`
 );

 }

 return await response.json();

}

async function getXtreamChannels(config) {

const cacheKey =
 JSON.stringify({
 server: config.xtreamServer,
 username: config.username,
 password: config.password
 });

  const cached =
    xtreamCache.get(cacheKey);

  const now =
    Date.now();

  if (
    cached &&
    (now - cached.timestamp) <
      XTREAM_CACHE_TTL
  ) {
    return cached.channels;
  }

  const data =
    await xtreamRequest(
      config,
      "get_live_streams"
    );

  if (!Array.isArray(data)) {
    return [];
  }

  const server =
    normalizeUrl(
      config.xtreamServer
    );

  const channels =
    data.map((item) => {

      const streamId =
        String(
          item.stream_id ||
          item.id ||
          ""
        );

      return {
        id:
          `xtream:${streamId}`,

        type:
          "channel",

        name:
          item.name ||
          item.stream_display_name ||
          "Canal Xtream",

        logo:
          item.stream_icon ||
          item.logo ||
          "",

        group:
          item.category_name ||
          "TV",

        tvgId:
          item.epg_channel_id ||
          "",

        url:
          `${server}/live/` +
          `${encodeURIComponent(config.username)}/` +
          `${encodeURIComponent(config.password)}/` +
          `${encodeURIComponent(streamId)}.ts`
      };
    });

  xtreamCache.set(
    cacheKey,
    {
      timestamp: now,
      channels
    }
  );

  return channels;
}

/* =========================================================
 IPTV-ORG
 ========================================================= */

async function getIPTVOrgChannels(config) {

 try {

 const country =
 String(
 config?.iptvOrg?.country || ""
 )
 .trim()
 .toUpperCase();

 const category =
 String(
 config?.iptvOrg?.category || ""
 )
 .trim()
 .toLowerCase();

 const response =
 await fetchWithTimeout(
 "https://iptv-org.github.io/api/channels.json"
 );

 if (!response.ok) {
 throw new Error(
 `IPTV-org respondeu HTTP ${response.status}`
 );
 }

 let channels =
 await response.json();

 if (!Array.isArray(channels)) {
 return [];
 }

 if (country) {

 channels =
 channels.filter(channel =>
 String(channel.country || "")
 .toUpperCase() === country
 );

 }

 if (category) {

 channels =
 channels.filter(channel => {

 if (
 !Array.isArray(channel.categories)
 ) {
 return false;
 }

 return channel.categories.some(
 item =>
 String(item)
 .toLowerCase() === category
 );

 });

 }

 return channels
 .filter(channel =>
 isValidHttpUrl(channel.url)
 )
 .map(channel => {

 const idSource =
 channel.url;

 const channelId =
 crypto
 .createHash("sha256")
 .update(idSource)
 .digest("hex")
 .slice(0, 24);

 return {

 id:
 `iptvorg:${channelId}`,

 type:
 "channel",

 name:
 channel.name ||
 "Canal IPTV-org",

 logo:
 channel.logo ||
 "",

 group:
 Array.isArray(
 channel.categories
 )
 ? channel.categories.join(", ")
 : "TV",

 tvgId:
 channel.id ||
 "",

 url:
 channel.url

 };

 });

 } catch (error) {

 console.error(
 "Erro IPTV-org:",
 error.message
 );

 return [];

 }

}

/* =========================================================
 IPTV CHANNELS ENTRY POINT
 ========================================================= */

async function getIPTVChannels(config) {

 if (!config || !config.mode) {
 return [];
 }

 if (config.mode === "iptv-org") {
 return await getIPTVOrgChannels(config);
 }

 if (config.mode === "m3u") {

 if (
 config.m3uSource === "file" &&
 config.m3uFileData
 ) {
 return parseM3U(config.m3uFileData);
 }

 return await fetchM3U(config.m3uUrl);
 }

 if (config.mode === "xtream") {
 return await getXtreamChannels(config);
 }

 return [];
}

/* =========================================================
 CONFIG VALIDATION
 ========================================================= */

function validateConfig(config) {

 if (!config || typeof config !== "object") {
 return "Configuração inválida.";
 }

 if (
 config.features &&
 !config.features.iptv
 ) {
 return null;
 }

 if (
 !["m3u", "xtream", "iptv-org"].includes(
 config.mode
 )
 ) {
 return "Modo IPTV inválido.";
 }

 if (config.mode === "iptv-org") {
 return null;
 }

 if (config.mode === "m3u") {

 if (config.m3uSource === "file") {

 if (!config.m3uFileData) {
 return "Seleciona um ficheiro M3U.";
 }

 } else {

 if (!isValidHttpUrl(config.m3uUrl)) {
 return "Indica um URL M3U válido.";
 }

 }

 }

 if (config.mode === "xtream") {

 if (!isValidHttpUrl(config.xtreamServer)) {
 return "Indica um URL de servidor Xtream válido.";
 }

 if (!config.username) {
 return "Indica o username Xtream.";
 }

 if (!config.password) {
 return "Indica a password Xtream.";
 }

 }

 return null;
}

/* ========================================================
   CINEMETA
   ========================================================= */

async function cinemetaFetch(endpoint) {
  const url =
    `${CINEMETA_BASE}${endpoint}`;


const response =
 await fetchWithTimeout(
 url,
 {
 headers: {
 "User-Agent": `PT-HUB/${VERSION}`
 }
 }
 );

  if (!response.ok) {
    throw new Error(
      `Cinemeta respondeu HTTP ${response.status}`
    );
  }

  return await response.json();
}

async function getCinemetaCatalog(type) {
  if (type === "movie") {
    return await cinemetaFetch(
      "/catalog/movie/top.json"
    );
  }

  if (type === "series") {
    return await cinemetaFetch(
      "/catalog/series/top.json"
    );
  }

  return {
    metas: []
  };
}

async function getCinemetaMeta(type, id) {
  return await cinemetaFetch(
    `/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`
  );
}

/* =========================================================
   JUSTWATCH STREAMER CATALOGS
   ========================================================= */

const JUSTWATCH_URL =
  "https://apis.justwatch.com/graphql";

const JUSTWATCH_COUNTRY = "PT";

const streamerNames = {
  netflix: "Netflix",
  hbomax: "HBO Max",
  "prime-video": "Amazon Prime Video",
  "disney-plus": "Disney Plus",
  "apple-tv-plus": "Apple TV Plus"
};

async function justWatchRequest(
 query,
 variables
) {

 const response =
 await fetchWithTimeout(
 JUSTWATCH_URL,
 {
 method: "POST",

 headers: {
 "Content-Type":
 "application/json",

 "User-Agent":
 `PT-HUB/${VERSION}`,

 "Accept":
 "application/json"
 },

 body: JSON.stringify({
 operationName:
 "GetPopularTitles",

 variables,

 query
 })
 },
 15000
 );

 if (!response.ok) {

 throw new Error(
 `JustWatch respondeu HTTP ${response.status}`
 );

 }

 const data =
 await response.json();

 if (data.errors) {

 throw new Error(
 data.errors
 .map(error => error.message)
 .join("; ")
 );

 }

 return data.data;

}

let justWatchPackagesCache = null;
let justWatchPackagesCacheTime = 0;

async function getJustWatchPackages() {

const now = Date.now();

if (
justWatchPackagesCache &&
(now - justWatchPackagesCacheTime) <
(60 * 60 * 1000)
) {
 return justWatchPackagesCache;
 }

const query = `
query Packages(
$country: Country!
$platform: Platform!
) {
packages(
country: $country
platform: $platform
) {
id
clearName
shortName
}
}
`;

const response =
 await fetchWithTimeout(
 JUSTWATCH_URL,
 {
 method: "POST",

 headers: {
 "Content-Type": "application/json",
 "User-Agent": `PT-HUB/${VERSION}`
 },

 body: JSON.stringify({
 operationName: "Packages",

 variables: {
 country: JUSTWATCH_COUNTRY,
 platform: "WEB"
 },

 query
 })
 }
 );

if (!response.ok) {
throw new Error(
`JustWatch Packages respondeu HTTP ${response.status}`
);
}

const data = await response.json();

if (data.errors) {
throw new Error(
data.errors
.map((error) => error.message)
.join("; ")
);
}

justWatchPackagesCache =
data.data?.packages || [];

justWatchPackagesCacheTime =
Date.now();

return justWatchPackagesCache;

}

async function getStreamerPackage(streamerId) {
  const packages =
    await getJustWatchPackages();

  const target =
    streamerNames[streamerId];

  if (!target) {
    return null;
  }

  const normalizedTarget =
    target
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

  return (
    packages.find((item) => {
      const name =
        String(item.clearName || "")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");

      return (
        name === normalizedTarget ||
        name.includes(normalizedTarget) ||
        normalizedTarget.includes(name)
      );
    }) || null
  );
}

async function getJustWatchCatalog(
  type,
  streamerId
) {
  const packageInfo =
    await getStreamerPackage(streamerId);

  if (!packageInfo?.shortName) {
    console.error(
      `Streamer não encontrado no JustWatch: ${streamerId}`
    );

    return {
      metas: []
    };
  }

  const objectType =
    type === "movie"
      ? "MOVIE"
      : "SHOW";

  const query = `
    query GetPopularTitles(
      $country: Country!
      $filter: TitleFilter
      $first: Int!
      $sortBy: PopularTitlesSorting!
    ) {
      popularTitles(
        country: $country
        filter: $filter
        first: $first
        sortBy: $sortBy
      ) {
        edges {
          node {
            objectType

            content(
              country: $country
              language: pt
            ) {
              title

              posterUrl

              externalIds {
                imdbId
              }
            }
          }
        }
      }
    }
  `;

  const variables = {
    country: JUSTWATCH_COUNTRY,

    first: 100,

    sortBy: "POPULAR",

    filter: {
      packages: [
        packageInfo.shortName
      ],

      objectTypes: [
        objectType
      ],

      monetizationTypes: [
        "FLATRATE"
      ]
    }
  };

  const data =
    await justWatchRequest(
      query,
      variables
    );

  const edges =
    data?.popularTitles?.edges || [];

  const metas = [];

  for (const edge of edges) {
    const node = edge?.node;

    if (!node) {
      continue;
    }

    const content =
      node.content;

    const imdbId =
      content?.externalIds?.imdbId;

    if (!imdbId) {
      continue;
    }

    metas.push({
      id: imdbId,
      type,
      name: content.title || "Título",

      poster:
        `https://images.metahub.space/poster/medium/${imdbId}/img`,

      background:
        `https://images.metahub.space/background/medium/${imdbId}/img`
    });
  }

  return {
    metas
  };

}

async function getFeaturedCatalog(type) {

const streamersList = [
"netflix",
"hbomax",
"prime-video",
"disney-plus",
"apple-tv-plus"
];

const metas = [];
const ids = new Set();

for (const streamer of streamersList) {

try {

const data =
await getJustWatchCatalog(
type,
streamer
);

for (const meta of data.metas.slice(0, 10)) {

if (!ids.has(meta.id)) {

ids.add(meta.id);
metas.push(meta);

}

}

} catch (error) {

console.error(
`Erro no streamer ${streamer}:`,
error.message
);

}

}

return {
metas: metas.slice(0, 50)
};
}

/*
=========================================================
STREAMER CATALOGS
=========================================================
*/
function getMovieCatalogs() {

const specialCatalogs =
catalogs.filter(
catalog =>
catalog.type === "movie"
);

const streamerCatalogs =
streamers.map(
streamer => ({
id: streamer.id,
name:
`🎬 ${streamer.name} Filmes`
})
);

return [
...specialCatalogs,
...streamerCatalogs
];
}

function getSeriesCatalogs() {

const specialCatalogs =
catalogs.filter(
catalog =>
catalog.type === "series"
);

const streamerCatalogs =
streamers.map(
streamer => ({
id: streamer.id,
name:
`📺 ${streamer.name} Séries`
})
);

return [
...specialCatalogs,
...streamerCatalogs
];
}

const movieCatalogs = getMovieCatalogs();
const seriesCatalogs = getSeriesCatalogs();

function getOperatorCatalogs() {

return operators.map(
operator => ({
type: "channel",
id: operator.id,
name: `📺 ${operator.name}`
})
);
}

/* =========================================================
   CONFIGURE PAGE
   ========================================================= */

function renderConfigurePage(config = {}) {

const mode =
 config.mode === "iptv-org"
 ? "iptv-org"
 : config.mode === "xtream"
 ? "xtream"
 : "m3u";

  const m3uUrl =
    config.m3uUrl || "";

  const xtreamServer =
    config.xtreamServer || "";

  const username =
    config.username || "";

  const epgUrl =
    config.epgUrl || "";

const features =
 config.features || {};

const enabledFeatured =
 features.featured !== false;

const enabledStreamers =
 features.streamers !== false;

const enabledOperators =
 features.operators !== false;

const enabledIPTV =
 features.iptv === true;

  return `
<!DOCTYPE html>
<html lang="pt-PT">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PT•HUB — Configuração</title>

<style>
:root {
  --pt-bg: #01050B;
  --pt-bg-secondary: #04111A;
  --pt-bg-card: #071C29;
  --pt-bg-tech: #062F46;

  --pt-gold: #DA921C;
  --pt-gold-light: #F2CA4F;
  --pt-bronze: #A7610C;

  --pt-green: #027C1C;
  --pt-green-light: #13D06C;

  --pt-red: #E51306;
  --pt-red-dark: #970200;

  --pt-text: #EEECCB;
  --pt-white: #FFFFFF;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
  background:
    radial-gradient(circle at top,
      var(--pt-bg-tech) 0%,
      var(--pt-bg-secondary) 35%,
      var(--pt-bg) 100%);
  color: var(--pt-text);
  font-family: Arial, Helvetica, sans-serif;
  min-height: 100vh;
}

.container {
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
  padding: 40px 20px 60px;
}

.logo {
  display: block;
  width: 150px;
  max-width: 70%;
  margin: 0 auto 25px;
}

.card {
  background: rgba(7,28,41,.95);
  border: 1px solid rgba(218,146,28,.30);
  border-radius: 18px;
  padding: 30px;
  box-shadow: 0 20px 60px rgba(0,0,0,.45);
}

h1 {
  text-align: center;
  margin: 0 0 8px;
  font-size: 30px;
}

.subtitle {
  text-align: center;
  color: var(--pt-gold-light);
  margin-bottom: 30px;
}

label.field-label {
  display: block;
  margin-top: 18px;
  margin-bottom: 8px;
  font-weight: 600;
}

input:not([type="checkbox"]),
select {
  width: 100%;
  padding: 13px 14px;
  border-radius: 10px;
  border: 1px solid rgba(218,146,28,.20);
  background: var(--pt-bg-card);
  color: var(--pt-text);
  font-size: 15px;
  outline: none;
}

input:focus,
select:focus {
  border-color: var(--pt-gold);
}

input[type="checkbox"] {
  accent-color: var(--pt-gold);
}

.features-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px;
  margin: 0;
  background: var(--pt-bg-card);
  border: 1px solid rgba(218,146,28,.20);
  border-radius: 10px;
  cursor: pointer;
  transition: .18s ease;
}

.feature-item:hover {
  border-color: var(--pt-gold-light);
  transform: translateY(-1px);
}

.feature-item:has(input:checked) {
  border-color: var(--pt-gold);
  background: rgba(218,146,28,.10);
  box-shadow: 0 0 18px rgba(218,146,28,.08);
}

.feature-item input {
  width: auto;
  margin: 0;
}

.config-panel {
  display: none;
  margin: 12px 0 0;
  padding: 20px;
  border-radius: 14px;
  background:
    linear-gradient(145deg, rgba(6,47,70,.95), rgba(7,28,41,.98));
  border: 1px solid rgba(218,146,28,.28);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
}

.config-panel.active {
  display: block;
  animation: panelIn .18s ease-out;
}

@keyframes panelIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.panel-title {
  margin: 0 0 6px;
  color: var(--pt-gold-light);
  font-size: 18px;
}

.panel-description {
  margin: 0 0 16px;
  color: #b9c0b7;
  font-size: 13px;
  line-height: 1.55;
}

.option-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.option-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 12px;
  border-radius: 9px;
  background: rgba(1,5,11,.34);
  border: 1px solid rgba(218,146,28,.15);
  cursor: pointer;
}

.option-item:hover {
  border-color: rgba(218,146,28,.40);
}

.option-item input {
  margin: 0;
  width: auto;
}

.subsection {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid rgba(218,146,28,.14);
}

.subsection-title {
  margin: 0 0 10px;
  color: var(--pt-white);
  font-size: 15px;
}

.help {
  color: #929b96;
  font-size: 12px;
  line-height: 1.45;
  margin-top: 7px;
}

.required {
  color: var(--pt-red);
}

.mode-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
  margin-bottom: 15px;
}

.mode-button {
  padding: 13px 10px;
  border-radius: 10px;
  border: 1px solid rgba(218,146,28,.20);
  background: var(--pt-bg-card);
  color: var(--pt-text);
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
}

.mode-button:hover {
  border-color: var(--pt-gold-light);
}

.mode-button.active {
  background: var(--pt-gold);
  color: var(--pt-bg);
  border-color: var(--pt-gold);
}

.section {
  display: none;
}

.section.active {
  display: block;
}

.source-toggle {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 10px 0 16px;
}

.source-option {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid rgba(218,146,28,.18);
  background: rgba(1,5,11,.28);
  cursor: pointer;
}

.source-option:has(input:checked) {
  border-color: var(--pt-gold);
  background: rgba(218,146,28,.08);
}

.source-option input {
  width: auto;
  margin: 0;
}

.public-playlists {
  margin-top: 18px;
  padding: 14px;
  border-radius: 10px;
  background: rgba(1,5,11,.28);
  border: 1px solid rgba(218,146,28,.12);
}

.public-title {
  color: var(--pt-gold-light);
  font-weight: 700;
  font-size: 13px;
  margin-bottom: 10px;
}

.public-link {
  display: block;
  padding: 7px 0;
  color: #c7cbc5;
  font-size: 13px;
}

.buttons {
 display: flex;
 gap: 12px;
 margin-top: 25px;
}
.buttons > * {
 flex: 1;
}

#testButtonContainer {
 display: flex;
}

#testButton {
 width: 100%;
}

.buttons button {
 width: 100%;
}

.buttons.single {
 justify-content:center;
}

.buttons.single .install {
 width:300px;
 max-width:100%;
}

button {
  border: 0;
  border-radius: 10px;
  padding: 14px 16px;
  cursor: pointer;
  font-size: 15px;
  font-weight: 700;
}

.test {
  background: var(--pt-green);
  color: var(--pt-white);
}

.install {
  background: var(--pt-gold);
  color: var(--pt-bg);
  font-weight: 700;
}

button:disabled {
  opacity: .5;
  cursor: not-allowed;
}

.status {
  margin-top: 20px;
  padding: 14px;
  border-radius: 10px;
  background: var(--pt-bg-card);
  border: 1px solid rgba(218,146,28,.20);
  color: var(--pt-text);
  white-space: pre-wrap;
  display: none;
}

.status.show {
  display: block;
}

.install-box {
  display: none;
  margin-top: 20px;
  padding: 18px;
  border-radius: 12px;
  background: var(--pt-bg-card);
  border: 1px solid rgba(218,146,28,.20);
}

.install-box.show {
  display: block;
}

.install-url {
  word-break: break-all;
  font-size: 13px;
  color: #aaa;
  margin: 10px 0 15px;
}

.install-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.copy {
  background: var(--pt-bg-tech);
  color: var(--pt-white);
}

.open {
  background: var(--pt-gold);
  color: var(--pt-bg);
}

.footer {
  text-align: center;
  color: var(--pt-bronze);
  margin-top: 25px;
  font-size: 12px;
}

@media (max-width: 600px) {

 .card {
 padding:22px;
 }

 .features-grid,
 .option-grid,
 .source-toggle,
 .mode-buttons,
 .install-actions {

 grid-template-columns:1fr;

 }

 .buttons {
 flex-direction:column;
 }
}

</style>
</head>

<body>

<div class="container">

  <img
    class="logo"
    src="${PT_HUB_LOGO}"
    alt="PT•HUB"
  >

  <div class="card">

    <h1>PT•HUB</h1>

    <div class="subtitle">
      Configuração PT•HUB
    </div>

    <label class="field-label">
      Conteúdo
    </label>

    <div class="features-grid">

      <label class="feature-item">
        <input
          type="checkbox"
          id="featuredEnabled"
          ${enabledFeatured ? "checked" : ""}
        >
        <span>Destaques</span>
      </label>

      <label class="feature-item">
        <input
          type="checkbox"
          id="streamersEnabled"
          ${enabledStreamers ? "checked" : ""}
        >
        <span>Streamers</span>
      </label>

      <label class="feature-item">
        <input
          type="checkbox"
          id="operatorsEnabled"
          ${enabledOperators ? "checked" : ""}
        >
        <span>Operadores PT</span>
      </label>

      <label class="feature-item">
        <input
          type="checkbox"
          id="iptvEnabled"
          ${enabledIPTV ? "checked" : ""}
        >
        <span>IPTV</span>
      </label>

    </div>

    <!-- DESTAQUES -->
    <div id="featuredContainer" class="config-panel">

      <h2 class="panel-title">Destaques</h2>

      <p class="panel-description">
        Escolhe o tipo de conteúdo de Destaques que queres disponibilizar.
        Podes selecionar filmes, séries ou ambos.
      </p>

      <div class="option-grid">

        <label class="option-item">
          <input
            type="checkbox"
            id="featuredMovies"
            checked
          >
          <span>Filmes</span>
        </label>

        <label class="option-item">
          <input
            type="checkbox"
            id="featuredSeries"
            checked
          >
          <span>Séries</span>
        </label>

      </div>

    </div>

    <!-- STREAMERS -->
    <div id="streamersContainer" class="config-panel">

      <h2 class="panel-title">Streamers</h2>

      <p class="panel-description">
        Seleciona um ou vários streamers. Cada seleção pode ser instalada
        individualmente ou em conjunto.
      </p>

      <div class="option-grid">

        <label class="option-item">
          <input type="checkbox" id="streamerNetflix" value="netflix">
          <span>Netflix</span>
        </label>

        <label class="option-item">
          <input type="checkbox" id="streamerMax" value="hbomax">
          <span>Max</span>
        </label>

        <label class="option-item">
          <input type="checkbox" id="streamerPrime" value="prime-video">
          <span>Prime Video</span>
        </label>

        <label class="option-item">
          <input type="checkbox" id="streamerDisney" value="disney-plus">
          <span>Disney+</span>
        </label>

        <label class="option-item">
          <input type="checkbox" id="streamerApple" value="apple-tv-plus">
          <span>Apple TV+</span>
        </label>

      </div>

    </div>

    <!-- OPERADORES -->
    <div id="operatorsContainer" class="config-panel">

      <h2 class="panel-title">Operadores PT</h2>

      <p class="panel-description">
        Seleciona os operadores que queres disponibilizar no addon.
        Podes escolher um ou vários.
      </p>

      <div class="option-grid">

        <label class="option-item">
          <input type="checkbox" id="operatorMEO" value="meo">
          <span>MEO</span>
        </label>

        <label class="option-item">
          <input type="checkbox" id="operatorNOS" value="nos">
          <span>NOS</span>
        </label>

        <label class="option-item">
          <input type="checkbox" id="operatorVodafone" value="vodafone">
          <span>Vodafone TV</span>
        </label>

        <label class="option-item">
          <input type="checkbox" id="operatorDIGI" value="digi">
          <span>DIGI TV</span>
        </label>

      </div>

    </div>

    <!-- IPTV -->
    <div id="iptvContainer" class="config-panel">

      <h2 class="panel-title">IPTV</h2>

      <p class="panel-description">
        Seleciona a fonte IPTV que queres utilizar. A configuração apresentada
        muda automaticamente de acordo com a fonte escolhida.
      </p>

      <div class="mode-buttons">

        <button
          type="button"
          id="iptvOrgButton"
          class="mode-button"
        >
          IPTV-org Free
        </button>

        <button
          type="button"
          id="xtreamButton"
          class="mode-button"
        >
          Xtream API
        </button>

        <button
          type="button"
          id="m3uButton"
          class="mode-button"
        >
          M3U / M3U+
        </button>

      </div>

      <!-- IPTV-ORG -->
      <div id="iptvOrgSection" class="section">

        <h3 class="panel-title">Filtro de Canais</h3>

        <p class="panel-description">
          Utiliza a base de dados IPTV-org com milhares
          de canais gratuitos de todo o mundo.
          
          Não são necessárias credenciais.
        </p>

        <label class="field-label" for="iptvOrgCountry">
          País
        </label>

        <input
          id="iptvOrgCountry"
          type="text"
          placeholder="Ex.: PT"
        >

        <div class="help">
          Deixa em branco para incluir todos os países.
        </div>

        <label class="field-label" for="iptvOrgCategory">
          Categoria
        </label>

        <input
          id="iptvOrgCategory"
          type="text"
          placeholder="Ex.: news, sports, movies"
        >

        <div class="help">
          Deixa em branco para incluir todas as categorias.
        </div>

        <div class="subsection">

          <h3 class="subsection-title">Apresentação</h3>

          <label class="field-label" for="iptvOrgCatalogName">
            Nome do Catálogo
          </label>

          <input
            id="iptvOrgCatalogName"
            type="text"
            placeholder="IPTV-org Free"
          >

          <div class="help">
            Nome apresentado na lista de canais do Stremio.
            Deixa em branco para utilizar o nome predefinido.
          </div>

        </div>

      </div>

      <!-- XTREAM API -->
      <div id="xtreamSection" class="section">

        <h3 class="panel-title">Credentials</h3>

        <label class="field-label" for="xtreamServer">
          Base URL <span class="required">*</span>
        </label>

        <input
          id="xtreamServer"
          type="url"
          placeholder="https://servidor.com:8080"
          value="${xtreamServer}"
        >

        <div class="help">
          Não incluir uma barra final.
        </div>

        <label class="field-label" for="username">
          Username <span class="required">*</span>
        </label>

        <input
          id="username"
          type="text"
          placeholder="Username"
          value="${username}"
        >

        <label class="field-label" for="password">
          Password <span class="required">*</span>
        </label>

        <input
          id="password"
          type="password"
          placeholder="Password"
        >

        <div class="subsection">

          <h3 class="subsection-title">Show</h3>

          <div class="option-grid">

            <label class="option-item">
              <input
                type="checkbox"
                id="xtreamShowLive"
                checked
              >
              <span>Live TV</span>
            </label>

          </div>

        </div>

        <div class="subsection">

          <h3 class="subsection-title">EPG Options</h3>

          <label class="field-label" for="xtreamEpgMode">
            EPG Source Mode
          </label>

          <select id="xtreamEpgMode">
            <option value="auto">Auto</option>
            <option value="url">URL personalizada</option>
            <option value="none">Desativado</option>
          </select>

          <label class="field-label" for="xtreamEpgOffset">
            EPG Offset (hours)
          </label>

          <input
            id="xtreamEpgOffset"
            type="number"
            step="1"
            value="0"
            placeholder="0"
          >

          <div id="xtreamEpgUrlWrap">

            <label class="field-label" for="xtreamEpgUrl">
              EPG URL
            </label>

            <input
              id="xtreamEpgUrl"
              type="url"
              placeholder="https://exemplo.com/epg.xml"
            >

          </div>

        </div>

        <div class="subsection">

          <h3 class="subsection-title">Display</h3>

          <label class="field-label" for="xtreamCatalogName">
            Catalog Name
          </label>

          <input
            id="xtreamCatalogName"
            type="text"
            placeholder="Xtream API"
          >

          <div class="help">
            Nome apresentado na lista de canais do Stremio.
            Deixa em branco para utilizar o nome predefinido.
          </div>

        </div>

      </div>

      <!-- M3U / M3U+ -->
      <div id="m3uSection" class="section">

        <h3 class="panel-title">Playlist</h3>

        <p class="panel-description">
          Cola qualquer URL de playlist <strong>M3U ou M3U+</strong>.
          Funciona com links Xtream Codes
          <code>type=m3u_plus</code> e playlists M3U standard.
          O URL de cada stream é extraído individualmente.
        </p>

        <div class="source-toggle">

          <label class="source-option">
            <input
              type="radio"
              name="m3uSource"
              id="m3uSourceUrl"
              value="url"
              checked
            >
            <span>Playlist por URL</span>
          </label>

          <label class="source-option">
            <input
              type="radio"
              name="m3uSource"
              id="m3uSourceFile"
              value="file"
            >
            <span>Ficheiro M3U / M3U8</span>
          </label>

        </div>

        <div id="m3uUrlSource">

          <label class="field-label" for="m3uUrl">
            Playlist URL <span class="required">*</span>
          </label>

          <input
            id="m3uUrl"
            type="url"
            placeholder="https://exemplo.com/lista.m3u"
            value="${m3uUrl}"
          >

        </div>

        <div id="m3uFileSource" class="section">

          <label class="field-label" for="m3uFile">
            Ficheiro M3U / M3U8 <span class="required">*</span>
          </label>

          <input
            id="m3uFile"
            type="file"
            accept=".m3u,.m3u8,audio/x-mpegurl,application/x-mpegURL"
          >

          <div id="m3uFileInfo" class="help">
            Seleciona um ficheiro M3U ou M3U8 do teu computador.
          </div>

        </div>

        <div class="public-playlists">

          <div class="public-title">
            Public Playlists — links de terceiros, não afiliados nem
            endossados por este addon.
          </div>

          <div class="public-link">
            <strong>CANAIS BR 1</strong> — Public Link
          </div>

          <div class="public-link">
            <strong>CANAIS BR 2</strong> — Public Link
          </div>

          <div class="public-link">
            <strong>CANAIS BR 3</strong> — Public Link
          </div>

          <div class="public-link">
            <strong>CANAIS BR 4</strong> — Public Link
          </div>

          <div class="public-link">
            <strong>CANAIS BR 5</strong> — Public Link
          </div>

          <div class="public-link">
            <strong>CANAIS BR 6</strong> — Public Link
          </div>

        </div>

        <div class="subsection">

          <h3 class="subsection-title">EPG Options</h3>

          <label class="field-label" for="m3uEpgMode">
            EPG Source Mode
          </label>

          <select id="m3uEpgMode">
            <option value="url">URL personalizada</option>
            <option value="playlist">Da playlist / provider</option>
            <option value="none">Desativado</option>
          </select>

          <label class="field-label" for="epgUrl">
            URL EPG
            <span style="color:#777;font-weight:normal;">
              (opcional)
            </span>
          </label>

          <input
            id="epgUrl"
            type="url"
            placeholder="https://exemplo.com/epg.xml"
            value="${epgUrl}"
          >

          <label class="field-label" for="m3uEpgOffset">
            EPG Offset (hours)
          </label>

          <input
            id="m3uEpgOffset"
            type="number"
            step="1"
            value="0"
            placeholder="0"
          >

        </div>

        <div class="subsection">

          <h3 class="subsection-title">Advanced</h3>

          <label class="field-label" for="globalUserAgent">
            Global User-Agent
          </label>

          <input
            id="globalUserAgent"
            type="text"
            placeholder="Deixa em branco salvo se o teu provider exigir um player específico"
          >

          <div class="option-grid" style="margin-top:10px;">

            <label class="option-item">
              <input
                type="radio"
                name="userAgentPreset"
                value=""
                checked
              >
              <span>Sem preset</span>
            </label>

            <label class="option-item">
              <input
                type="radio"
                name="userAgentPreset"
                value="TiviMate"
              >
              <span>TiviMate</span>
            </label>

            <label class="option-item">
              <input
                type="radio"
                name="userAgentPreset"
                value="IPTV Smarters Pro"
              >
              <span>IPTV Smarters Pro</span>
            </label>

            <label class="option-item">
              <input
                type="radio"
                name="userAgentPreset"
                value="GSE Smart IPTV"
              >
              <span>GSE Smart IPTV</span>
            </label>

            <label class="option-item">
              <input
                type="radio"
                name="userAgentPreset"
                value="VLC"
              >
              <span>VLC</span>
            </label>

            <label class="option-item">
              <input
                type="radio"
                name="userAgentPreset"
                value="Kodi"
              >
              <span>Kodi</span>
            </label>

            <label class="option-item">
              <input
                type="radio"
                name="userAgentPreset"
                value="Custom"
              >
              <span>Custom…</span>
            </label>

          </div>

          <div class="help">
            Canais que tenham o seu próprio User-Agent na playlist
            têm prioridade sobre esta definição.
          </div>

        </div>

        <div class="subsection">

          <h3 class="subsection-title">Display</h3>

          <label class="field-label" for="m3uCatalogName">
            Catalog Name
          </label>

          <input
            id="m3uCatalogName"
            type="text"
            placeholder="Minha IPTV"
          >

          <div class="help">
            Nome apresentado na lista de canais do Stremio.
            Deixa em branco para utilizar o nome predefinido.
          </div>

        </div>

      </div>

    </div>

    <!-- BOTÕES -->
    <div class="buttons">

      <div id="testButtonContainer">

        <button
          id="testButton"
          class="test"
          type="button"
        >
          Testar ligação
        </button>

      </div>

      <button
        id="installButton"
        class="install"
        type="button"
      >
        Instalar
      </button>

    </div>

    <div
      id="status"
      class="status"
    ></div>

    <div
      id="installBox"
      class="install-box"
    >

      <strong>
        URL do Add-on
      </strong>

      <div
        id="installUrl"
        class="install-url"
      ></div>

      <div class="install-actions">

        <button
          id="copyButton"
          class="copy"
          type="button"
        >
          Copiar URL
        </button>

        <button
          id="openButton"
          class="open"
          type="button"
        >
          Abrir no Stremio
        </button>

      </div>

    </div>

  </div>

  <div class="footer">
    PT•HUB ${VERSION}
  </div>

</div>

<script>
(function () {

  let currentMode = "${mode}";

  const featuredEnabled =
    document.getElementById("featuredEnabled");

  const streamersEnabled =
    document.getElementById("streamersEnabled");

  const operatorsEnabled =
    document.getElementById("operatorsEnabled");

  const iptvEnabled =
    document.getElementById("iptvEnabled");

  const featuredContainer =
    document.getElementById("featuredContainer");

  const streamersContainer =
    document.getElementById("streamersContainer");

  const operatorsContainer =
    document.getElementById("operatorsContainer");

  const iptvContainer =
    document.getElementById("iptvContainer");

  const featuredMovies =
    document.getElementById("featuredMovies");

  const featuredSeries =
    document.getElementById("featuredSeries");

  const streamerIds = [
    "streamerNetflix",
    "streamerMax",
    "streamerPrime",
    "streamerDisney",
    "streamerApple"
  ];

  const operatorIds = [
    "operatorMEO",
    "operatorNOS",
    "operatorVodafone",
    "operatorDIGI"
  ];

  const iptvOrgButton =
    document.getElementById("iptvOrgButton");

  const xtreamButton =
    document.getElementById("xtreamButton");

  const m3uButton =
    document.getElementById("m3uButton");

  const iptvOrgSection =
    document.getElementById("iptvOrgSection");

  const xtreamSection =
    document.getElementById("xtreamSection");

  const m3uSection =
    document.getElementById("m3uSection");

  const iptvOrgCountry =
    document.getElementById("iptvOrgCountry");

  const iptvOrgCategory =
    document.getElementById("iptvOrgCategory");

  const iptvOrgCatalogName =
    document.getElementById("iptvOrgCatalogName");

  const xtreamServer =
    document.getElementById("xtreamServer");

  const username =
    document.getElementById("username");

  const password =
    document.getElementById("password");

  const xtreamShowLive =
    document.getElementById("xtreamShowLive");

  const xtreamEpgMode =
    document.getElementById("xtreamEpgMode");

  const xtreamEpgOffset =
    document.getElementById("xtreamEpgOffset");

  const xtreamEpgUrl =
    document.getElementById("xtreamEpgUrl");

  const xtreamEpgUrlWrap =
    document.getElementById("xtreamEpgUrlWrap");

  const xtreamCatalogName =
    document.getElementById("xtreamCatalogName");

  const m3uUrl =
    document.getElementById("m3uUrl");

  const m3uFile =
    document.getElementById("m3uFile");

  const m3uFileInfo =
    document.getElementById("m3uFileInfo");

  const m3uSourceUrl =
    document.getElementById("m3uSourceUrl");

  const m3uSourceFile =
    document.getElementById("m3uSourceFile");

  const m3uUrlSource =
    document.getElementById("m3uUrlSource");

  const m3uFileSource =
    document.getElementById("m3uFileSource");

  const m3uEpgMode =
    document.getElementById("m3uEpgMode");

  const epgUrl =
    document.getElementById("epgUrl");

  const m3uEpgOffset =
    document.getElementById("m3uEpgOffset");

  const globalUserAgent =
    document.getElementById("globalUserAgent");

  const m3uCatalogName =
    document.getElementById("m3uCatalogName");

  const testButton =
    document.getElementById("testButton");

  const installButton =
    document.getElementById("installButton");

  const status =
    document.getElementById("status");

  const installBox =
    document.getElementById("installBox");

  const installUrl =
    document.getElementById("installUrl");

  const copyButton =
    document.getElementById("copyButton");

  const openButton =
    document.getElementById("openButton");

  const testButtonContainer =
    document.getElementById("testButtonContainer");

  const buttons =
    document.querySelector(".buttons");

  function showStatus(message) {
    status.textContent = message;
    status.classList.add("show");
  }

  function hideInstall() {
    installBox.classList.remove("show");
    installUrl.textContent = "";
  }

  function setPanelVisibility(panel, visible) {
    panel.classList.toggle("active", !!visible);
  }

function updateContentVisibility() {

 setPanelVisibility(
 featuredContainer,
 featuredEnabled.checked
 );

 setPanelVisibility(
 streamersContainer,
 streamersEnabled.checked
 );

 setPanelVisibility(
 operatorsContainer,
 operatorsEnabled.checked
 );

 setPanelVisibility(
 iptvContainer,
 iptvEnabled.checked
 );

 testButtonContainer.style.display =
 iptvEnabled.checked
 ? "block"
 : "none";

 if (iptvEnabled.checked) {

 buttons.classList.remove(
 "single"
 );

 } else {

 buttons.classList.add(
 "single"
 );

 }
}

  function setMode(mode) {

    currentMode = mode;

    iptvOrgButton.classList.remove("active");
    xtreamButton.classList.remove("active");
    m3uButton.classList.remove("active");

    iptvOrgSection.classList.remove("active");
    xtreamSection.classList.remove("active");
    m3uSection.classList.remove("active");

    if (mode === "iptv-org") {

      iptvOrgButton.classList.add("active");
      iptvOrgSection.classList.add("active");

    } else if (mode === "xtream") {

      xtreamButton.classList.add("active");
      xtreamSection.classList.add("active");

    } else {

      currentMode = "m3u";
      m3uButton.classList.add("active");
      m3uSection.classList.add("active");

    }

    updateXtreamEpgVisibility();
    updateM3USourceVisibility();
  }

  function updateXtreamEpgVisibility() {

    if (!xtreamEpgMode) {
      return;
    }

    xtreamEpgUrlWrap.style.display =
      xtreamEpgMode.value === "url"
        ? "block"
        : "none";
  }

  function updateM3USourceVisibility() {

    const source =
      document.querySelector(
        'input[name="m3uSource"]:checked'
      );

    const isFile =
      source && source.value === "file";

    m3uUrlSource.style.display =
      isFile ? "none" : "block";

    m3uFileSource.classList.toggle(
      "active",
      !!isFile
    );
  }

  function getCheckedValues(ids) {

    return ids
      .map(function (id) {
        const element =
          document.getElementById(id);

        return element && element.checked
          ? element.value
          : null;
      })
      .filter(Boolean);
  }

  let m3uFileData = "";

  m3uFile.addEventListener(
    "change",
    function () {

      const file =
        m3uFile.files &&
        m3uFile.files[0];

      if (!file) {

        m3uFileData = "";

        m3uFileInfo.textContent =
          "Seleciona um ficheiro M3U ou M3U8 do teu computador.";

        return;
      }

      const lowerName =
        file.name.toLowerCase();

      if (
        !lowerName.endsWith(".m3u") &&
        !lowerName.endsWith(".m3u8")
      ) {

        m3uFile.value = "";
        m3uFileData = "";

        m3uFileInfo.textContent =
          "Erro: seleciona um ficheiro .m3u ou .m3u8.";

        return;
      }

      const reader =
        new FileReader();

      reader.onload =
        function (event) {

          m3uFileData =
            event.target.result || "";

          m3uFileInfo.textContent =
            "Ficheiro selecionado: " +
            file.name +
            " (" +
            Math.round(file.size / 1024) +
            " KB)";
        };

      reader.onerror =
        function () {

          m3uFileData = "";

          m3uFileInfo.textContent =
            "Não foi possível ler o ficheiro.";
        };

      reader.readAsText(file);
    }
  );

  function getConfig() {

    const m3uSourceElement =
      document.querySelector(
        'input[name="m3uSource"]:checked'
      );

    const m3uSource =
      m3uSourceElement
        ? m3uSourceElement.value
        : "url";

    return {

      features: {

        featured:
          featuredEnabled.checked,

        featuredContent: {
          movies:
            featuredMovies.checked,
          series:
            featuredSeries.checked
        },

        streamers:
          streamersEnabled.checked,

        selectedStreamers:
          getCheckedValues(streamerIds),

        operators:
          operatorsEnabled.checked,

        selectedOperators:
          getCheckedValues(operatorIds),

        iptv:
          iptvEnabled.checked
      },

      mode:
        currentMode,

      iptvOrg: {

        country:
          iptvOrgCountry.value.trim(),

        category:
          iptvOrgCategory.value.trim(),

        catalogName:
          iptvOrgCatalogName.value.trim()
      },

      xtreamServer:
        xtreamServer.value.trim(),

      username:
        username.value.trim(),

      password:
        password.value,

      xtreamShow: {

        live:
          xtreamShowLive.checked
      },

      xtreamEpgMode:
        xtreamEpgMode.value,

      xtreamEpgOffset:
        Number(xtreamEpgOffset.value || 0),

      xtreamEpgUrl:
        xtreamEpgUrl.value.trim(),

      xtreamCatalogName:
        xtreamCatalogName.value.trim(),

      m3uSource:
        m3uSource,

      m3uUrl:
        m3uUrl.value.trim(),

      m3uFileData:
        m3uSource === "file"
          ? m3uFileData
          : "",

      epgUrl:
        epgUrl.value.trim(),

      m3uEpgMode:
        m3uEpgMode.value,

      m3uEpgOffset:
        Number(m3uEpgOffset.value || 0),

      globalUserAgent:
        globalUserAgent.value.trim(),

      m3uCatalogName:
        m3uCatalogName.value.trim()
    };
  }

  function encodeConfig(config) {

    const json =
      JSON.stringify(config);

    const bytes =
      new TextEncoder().encode(json);

    let binary = "";

    bytes.forEach(function (byte) {
      binary += String.fromCharCode(byte);
    });

    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  function getInstallUrl() {

    const config =
      getConfig();

    const encoded =
      encodeConfig(config);

    const manifestUrl =
      window.location.origin +
      "/" +
      encoded +
      "/manifest.json";

    return manifestUrl.replace(
      /^https?:\/\//i,
      "stremio://"
    );
  }

  featuredEnabled.addEventListener(
    "change",
    function () {

      updateContentVisibility();
      hideInstall();
    }
  );

  streamersEnabled.addEventListener(
    "change",
    function () {

      updateContentVisibility();
      hideInstall();
    }
  );

  operatorsEnabled.addEventListener(
    "change",
    function () {

      updateContentVisibility();
      hideInstall();
    }
  );

  iptvEnabled.addEventListener(
    "change",
    function () {

      updateContentVisibility();
      hideInstall();
    }
  );

  iptvOrgButton.addEventListener(
    "click",
    function () {

      setMode("iptv-org");
      hideInstall();
    }
  );

  xtreamButton.addEventListener(
    "click",
    function () {

      setMode("xtream");
      hideInstall();
    }
  );

  m3uButton.addEventListener(
    "click",
    function () {

      setMode("m3u");
      hideInstall();
    }
  );

  xtreamEpgMode.addEventListener(
    "change",
    updateXtreamEpgVisibility
  );

  document
    .querySelectorAll(
      'input[name="m3uSource"]'
    )
    .forEach(function (element) {

      element.addEventListener(
        "change",
        function () {

          updateM3USourceVisibility();
          hideInstall();
        }
      );

    });

  document
    .querySelectorAll(
      "input, select"
    )
    .forEach(function (element) {

      element.addEventListener(
        "change",
        hideInstall
      );

    });

  testButton.addEventListener(
    "click",
    async function () {

      hideInstall();

      testButton.disabled = true;

      showStatus(
        "A testar ligação..."
      );

      try {

        const response =
          await fetch(
            "/test-iptv",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify(
                  getConfig()
                )
            }
          );

        const data =
          await response.json();

        if (!response.ok) {

          throw new Error(
            data.error ||
            "Erro ao testar ligação."
          );
        }

        showStatus(
          data.message ||
          "Ligação efetuada com sucesso."
        );

      } catch (error) {

        showStatus(
          "Erro: " +
          error.message
        );

      } finally {

        testButton.disabled = false;

      }

    }
  );

  function validateM3U(config) {

    if (config.m3uSource === "file") {

      if (!config.m3uFileData) {

        showStatus(
          "Seleciona um ficheiro M3U ou M3U8."
        );

        return false;
      }

      return true;
    }

    if (
      !/^https?:\/\//i.test(
        config.m3uUrl
      )
    ) {

      showStatus(
        "Indica um URL M3U válido."
      );

      return false;
    }

    return true;
  }

  function validateIPTVOrg(config) {
    return true;
  }

  function validateXtream(config) {

    if (
      !/^https?:\/\//i.test(
        config.xtreamServer
      )
    ) {

      showStatus(
        "Indica um URL de servidor Xtream válido."
      );

      return false;
    }

    if (
      !config.username ||
      !config.password
    ) {

      showStatus(
        "Indica username e password Xtream."
      );

      return false;
    }

    return true;
  }

installButton.addEventListener(
 "click",
 function () {

 hideInstall();

 try {

 const config =
 getConfig();

 const hasContent =

 config.features.featured ||

 config.features.streamers ||

 config.features.operators ||

 config.features.iptv;

 if (!hasContent) {

 showStatus(
 "Add-on não instalado. Deve selecionar pelo menos um conteúdo."
 );

 return;
 }

 if (
 config.features.featured &&
 !config.features.featuredContent.movies &&
 !config.features.featuredContent.series
 ) {

 showStatus(
 "Em Destaques seleciona Filmes, Séries ou ambos."
 );

 return;
 }

 if (
 config.features.streamers &&
 config.features.selectedStreamers.length === 0
 ) {

 showStatus(
 "Em Streamers seleciona pelo menos um streamer."
 );

 return;
 }

 if (
 config.features.operators &&
 config.features.selectedOperators.length === 0
 ) {

 showStatus(
 "Em Operadores PT seleciona pelo menos um operador."
 );

 return;
 }

 if (config.features.iptv) {

 if (
 currentMode === "m3u" &&
 !validateM3U(config)
 ) {

 return;
 }

 if (
 currentMode === "xtream" &&
 !validateXtream(config)
 ) {

 return;
 }

 if (
 currentMode === "iptv-org" &&
 !validateIPTVOrg(config)
 ) {

 return;
 }

 }

 const url =
 getInstallUrl();

 installUrl.textContent =
 url;

 installBox.classList.add(
 "show"
 );

 showStatus(
 "URL de instalação gerada com sucesso."
 );

 setTimeout(() => {

 window.location.href =
 url;

 }, 400);

 } catch (error) {

 showStatus(
 "Erro: " +
 error.message
 );

 }

 }
);

  copyButton.addEventListener(
    "click",
    async function () {

      const url =
        installUrl.textContent;

      if (!url) {
        return;
      }

      try {

        await navigator.clipboard.writeText(
          url
        );

        showStatus(
          "URL copiado para a área de transferência."
        );

      } catch {

        showStatus(
          "Não foi possível copiar automaticamente. Copia o URL manualmente."
        );

      }

    }
  );

  openButton.addEventListener(
    "click",
    function () {

      const url =
        installUrl.textContent;

      if (!url) {
        return;
      }

      window.location.href =
        url;
    }
  );

  updateContentVisibility();

  if (
    currentMode !== "iptv-org" &&
    currentMode !== "xtream" &&
    currentMode !== "m3u"
  ) {

    currentMode = "iptv-org";
  }

  setMode(currentMode);

  updateXtreamEpgVisibility();
  updateM3USourceVisibility();

})();
</script>

</body>
</html>
`;
}


/* =========================================================
   CONFIGURE ROUTES
   ========================================================= */

app.get("/configure", (req, res) => {
  res.send(
    renderConfigurePage({})
  );
});


app.get("/:config/configure", (req, res) => {

  const config =
    decodeConfig(req.params.config);

  res.send(
    renderConfigurePage(
      config || {}
    )
  );

});


/* =========================================================
   IPTV TEST
   ========================================================= */

app.post("/test-iptv", async (req, res) => {

  try {

    const config =
      req.body || {};

    const validation =
      validateConfig(config);

    if (validation) {
      return res.status(400).json({
        success: false,
        error: validation
      });
    }

if (config.mode === "iptv-org") {

 const channels =
 await getIPTVOrgChannels(config);

 return res.json({
 success: true,
 message:
 `IPTV-org configurado com sucesso. ${channels.length} canais encontrados.`,
 channels: channels.length
 });

}

if (config.mode === "m3u") {

 let channels;

 if (
 config.m3uSource === "file"
 ) {

 channels =
 parseM3U(config.m3uFileData);

 } else {

 channels =
 await fetchM3U(
 config.m3uUrl
 );

 }

 return res.json({
 success: true,
 message:
 `Ligação M3U efetuada com sucesso. ${channels.length} canais encontrados.`,
 channels: channels.length
 });

}

if (config.mode === "xtream") {

  const data =
    await xtreamRequest(
      config,
      ""
    );

  if (
    !data ||
    !data.user_info ||
    data.user_info.auth !== 1
  ) {

    return res.status(400).json({
      success: false,
      error:
        "Autenticação Xtream inválida."
    });

  }

  return res.json({
    success: true,
    message:
      "Ligação Xtream efetuada com sucesso."
  });

}

return res.status(400).json({
  success: false,
  error: "Modo IPTV inválido."
});

} catch (error) {

  console.error(
    "Erro no teste IPTV:",
    error.message
  );

  console.error(
    "Cause:",
    error.cause
  );

  console.error(
    error.stack
  );

  return res.status(500).json({
    success: false,
    error:
      error.message ||
      "Não foi possível testar a ligação."
  });

}

});

/* =========================================================
   MANIFEST
   ========================================================= */

function buildManifest(config) {

 const features =
 config?.features || {};

 const showOperators =
 features.operators !== false;

 const showIPTV =
 features.iptv === true;

const showFeatured =
 features.featured !== false;

const selectedStreamers =
 features.selectedStreamers || [];

const selectedOperators =
 features.selectedOperators || [];

const featuredContent =
 features.featuredContent || {};

const catalogName =
 config?.iptvOrg?.catalogName ||
 config?.xtreamCatalogName ||
 config?.m3uCatalogName ||
 "📡 Minha IPTV";

const showFeaturedMovies =
 features.featured !== false &&
 featuredContent.movies !== false;

const showFeaturedSeries =
 features.featured !== false &&
 featuredContent.series !== false;


const filteredMovieCatalogs =
 movieCatalogs.filter(catalog => {

 if (selectedStreamers.length === 0) {
 return true;
 }
 const isStreamer =
 streamers.some(
 streamer =>
 streamer.id === catalog.id
 );
 if (!isStreamer) {
 return true;
 }
 return selectedStreamers.includes(
 catalog.id
 );
 });

const filteredSeriesCatalogs =
 seriesCatalogs.filter(catalog => {

 if (selectedStreamers.length === 0) {
 return true;
 }
 const isStreamer =
 streamers.some(
 streamer =>
 streamer.id === catalog.id
 );
 if (!isStreamer) {
 return true;
 }
 return selectedStreamers.includes(
 catalog.id
 );
 });

 const manifest = {
    ...manifestTemplate,

    version: VERSION,

    name: "PT•HUB",

    description:
      "Hub de TV Portugal, IPTV M3U/Xtream Codes, filmes e séries.",

logo: PT_HUB_LOGO,
background: PT_HUB_BACKGROUND,
 
adult: false,
   
    resources: [
      "catalog",
      "meta",
      "stream",
      "addon_catalog"
    ],

    types: [
      "channel",
      "movie",
      "series"
    ],

 catalogs: [

...(showFeatured
 ? filteredMovieCatalogs
 .filter(catalog => {
 if (
 catalog.id === "featured" &&
 !showFeaturedMovies
 ) {
 return false;
 }
 return true;
 })
 .map(catalog => ({
 type: "movie",
 id: catalog.id,
 name: catalog.name
 }))
 : []),

...(showFeatured
 ? filteredSeriesCatalogs
 .filter(catalog => {
 if (
 catalog.id === "featured" &&
 !showFeaturedSeries
 ) {
 return false;
 }
 return true;
 })
 .map(catalog => ({
 type: "series",
 id: catalog.id,
 name: catalog.name
 }))
 : []),

...(showIPTV
 ? [
 {
 type: "channel",
 id: "iptv",
 name: catalogName
 }
 ]
 : []),

...(showOperators
 ? getOperatorCatalogs().filter(
 operator =>
 selectedOperators.length === 0 ||
 selectedOperators.includes(operator.id)
 )
 : [])

],

    addonCatalogs: [
      {
        type: "addon",
        id: "recommended",
        name: "Add-ons recomendados"
      }
    ],

idPrefixes: [
 "pttv:",
 "m3u:",
 "xtream:",
 "iptvorg:",
 "tt",
 "tmdb:"
],

    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      p2p: false
    }
  };

  return manifest;
}


/* =========================================================
   MANIFEST ROUTES
   ========================================================= */

app.get("/manifest.json", (req, res) => {

  res.json(
    buildManifest(null)
  );

});


app.get("/:config/manifest.json", (req, res) => {

  const config =
    decodeConfig(req.params.config);

  res.json(
    buildManifest(config)
  );

});


/* =========================================================
   RECOMMENDED ADDONS
   ========================================================= */

app.get(
  "/:config/catalog/addon/recommended.json",
  (req, res) => {

    res.json({
      metas: addons.map((addon, index) => {

        const id =
          addon.id ||
          `addon:${index}`;

        return {
          id,
          type: "addon",
          name:
            addon.name ||
            "Add-on",

          poster:
            addon.logo ||
            addon.poster ||
            PT_HUB_LOGO,

          description:
            addon.description ||
            "",

          website:
            addon.url ||
            addon.website ||
            ""
        };

      })
    });

  }
);


/* =========================================================
   CATALOG - TV SERVICES / IPTV
   ========================================================= */

app.get(
  "/:config/catalog/channel/:id.json",
  async (req, res) => {

    try {

      const config =
        decodeConfig(
          req.params.config
        );

      const catalogId =
        req.params.id;


      if (
        catalogId === "pt-services"
      ) {

        const metas =
          services.map(
            (service, index) => {

              return {
                id:
                  service.id ||
                  `pttv:${index}`,

                type: "channel",

                name:
                  service.name ||
                  "Serviço TV",

                poster:
                  service.logo ||
                  service.poster ||
                  PT_HUB_LOGO,

                logo:
                  service.logo ||
                  service.poster ||
                  PT_HUB_LOGO,

                description:
                  service.description ||
                  ""
              };

            }
          );

        return res.json({
          metas
        });

      }


      if (
        catalogId === "iptv"
      ) {

        if (!config) {
          return res.json({
            metas: []
          });
        }

        const channels =
          await getIPTVChannels(
            config
          );

        return res.json({
          metas: channels.map(
            (channel) => {

              return {
                id:
                  channel.id,

                type: "channel",

                name:
                  channel.name,

                poster:
                  channel.logo ||
                  PT_HUB_LOGO,

                logo:
                  channel.logo ||
                  PT_HUB_LOGO,

                description:
                  channel.group
                    ? `Grupo: ${channel.group}`
                    : ""
              };

            }
          )
        });

      }


      return res.json({
        metas: []
      });

    } catch (error) {

      console.error(
        "Erro no catálogo channel:",
        error
      );

      return res.json({
        metas: []
      });

    }

  }
);

/*=========================================================
   CATALOG - PLATAFORMAS
   ========================================================= */

app.get(
  "/:config/catalog/movie/:id.json",
  async (req, res) => {

    try {

      const id =
        req.params.id;

      const validCatalog =
        movieCatalogs.some(
          (catalog) =>
            catalog.id === id
        );

      if (!validCatalog) {
        return res.json({
          metas: []
        });
      }

if (id === "featured") {

return res.json(
await getFeaturedCatalog(
"movie"
)
);

}

if (id === "movie-top") {

return res.json(
await getCinemetaCatalog(
"movie"
)
);

}

return res.json(
await getJustWatchCatalog(
"movie",
id
)
);

    } catch (error) {

      console.error(
        "Erro no catálogo de filmes:",
        error.message
      );

      return res.json({
        metas: []
      });

    }

  }
);


app.get(
  "/:config/catalog/series/:id.json",
  async (req, res) => {

    try {

      const id =
        req.params.id;

      const validCatalog =
        seriesCatalogs.some(
          (catalog) =>
            catalog.id === id
        );

      if (!validCatalog) {
        return res.json({
          metas: []
        });
      }

if (id === "featured") {

return res.json(
await getFeaturedCatalog(
"series"
)
);

}

if (id === "series-top") {

return res.json(
await getCinemetaCatalog(
"series"
)
);

}

return res.json(
await getJustWatchCatalog(
"series",
id
)
);
    } catch (error) {

      console.error(
        "Erro no catálogo de séries:",
        error.message
      );

      return res.json({
        metas: []
      });

    }

  }
);

/* =========================================================
   META
   ========================================================= */

app.get(
  "/:config/meta/:type/:id.json",
  async (req, res) => {

    try {

      const config =
        decodeConfig(
          req.params.config
        );

      const type =
        req.params.type;

      const id =
        req.params.id;

      if (
        type === "movie" ||
        type === "series"
      ) {

        const data =
          await getCinemetaMeta(
            type,
            id
          );

        return res.json(data);

      }

      if (
        type === "channel"
      ) {

        if (
          id.startsWith("m3u:")||
          id.startsWith("xtream:")||
          id.startsWith("iptvorg:")
        ) {

          if (!config) {
            return res.json({
              meta: null
            });
          }

          const channels =
            await getIPTVChannels(
              config
            );

          const channel =
            channels.find(
              (item) =>
                item.id === id
            );

          if (!channel) {
            return res.json({
              meta: null
            });
          }

          return res.json({
            meta: {
              id:
                channel.id,

              type: "channel",

              name:
                channel.name,

              poster:
                channel.logo ||
                PT_HUB_LOGO,

              logo:
                channel.logo ||
                PT_HUB_LOGO,

              description:
                channel.group
                  ? `Grupo: ${channel.group}`
                  : ""
            }
          });

        }

      }

      return res.json({
        meta: null
      });

    } catch (error) {

      console.error(
        "Erro meta:",
        error.message
      );

      return res.json({
        meta: null
      });

    }

  }
);

/* =========================================================
   STREAM
   ========================================================= */

app.get(
  "/:config/stream/:type/:id.json",
  async (req, res) => {

    try {

      const config =
        decodeConfig(
          req.params.config
        );

      const type =
        req.params.type;

      const id =
        req.params.id;

      if (
        type === "channel"
      ) {

        if (!config) {
          return res.json({
            streams: []
          });
        }

        const channels =
          await getIPTVChannels(
            config
          );

        const channel =
          channels.find(
            (item) =>
              item.id === id
          );

        if (!channel) {
          return res.json({
            streams: []
          });
        }

        const behaviorHints = {
          notWebReady: false
        };

        if (
          config.globalUserAgent
        ) {

          behaviorHints.proxyHeaders = {
            request: {
              "User-Agent":
                config.globalUserAgent
            }
          };

        }

        return res.json({
          streams: [
            {
              name:
                "PT•HUB",

              title:
                channel.name,

              url:
                channel.url,

              behaviorHints
            }
          ]
        });

      }

      if (
        type === "movie" ||
        type === "series"
      ) {

        return res.json({
          streams: []
        });

      }

      return res.json({
        streams: []
      });

    } catch (error) {

      console.error(
        "Erro streams:",
        error.message
      );

      return res.json({
        streams: []
      });

    }

  }
);

/* =========================================================
   ROOT LANDING PAGE
   ========================================================= */

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-PT">
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
/>

<title>PT•HUB</title>

<style>

  body {
    margin: 0;
    min-height: 100vh;

    display: flex;
    align-items: center;
    justify-content: center;

    background:
      radial-gradient(
        circle at top,
        #202020,
        #090909
      );

    color: #fff;

    font-family:
      Arial,
      Helvetica,
      sans-serif;
  }

  .box {
    text-align: center;
    padding: 30px;
  }

  img {
    width: 170px;
    max-width: 70%;
    margin-bottom: 25px;
  }

  h1 {
    font-size: 34px;
    margin: 0 0 10px;
  }

  p {
    color: #999;
  }

  a {
    display: inline-block;
    margin-top: 20px;
    padding: 13px 22px;

    border-radius: 10px;

    background: #fff;
    color: #000;

    text-decoration: none;
    font-weight: 700;
  }

</style>

</head>

<body>

<div class="box">

  <img
    src="${PT_HUB_LOGO}"
    alt="PT•HUB"
  >

  <h1>PT•HUB</h1>

  <p>
    IPTV, Filmes e Séries para Stremio
  </p>

  <a href="/configure">
    Configurar IPTV
  </a>

</div>

</body>
</html>
`);
});

/* =========================================================
   404
   ========================================================= */

app.use(
  (req, res) => {

    res.status(404).json({
      error: "Not Found",
      version: VERSION
    });

  }
);

/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use(
  (error, req, res, next) => {

    console.error(
      "Erro interno:",
      error
    );

    res.status(500).json({
      error:
        error.message ||
        "Erro interno do servidor."
    });

  }
);

/* =========================================================
   SERVER
   ========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `PT•HUB ${VERSION} iniciado na porta ${PORT}`
    );

  }
);
