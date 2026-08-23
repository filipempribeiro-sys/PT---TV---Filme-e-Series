const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;
const BASE_DIR = __dirname;

const VERSION = "1.4.6";

const PT_HUB_LOGO =
  "https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/addon/logo.png";

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


function getConfigHash(config) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex")
    .slice(0, 16);
}


/* =========================================================
   M3U
   ========================================================= */

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


/* =========================================================
   M3U FETCH
   ========================================================= */

async function fetchM3U(url) {
  if (!isValidHttpUrl(url)) {
    throw new Error("URL M3U inválido.");
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent": `PT-HUB/${VERSION}`
    }
  });

  if (!response.ok) {
    throw new Error(
      `Não foi possível obter a lista M3U. HTTP ${response.status}`
    );
  }

  const text = await response.text();

  if (!text.trim()) {
    throw new Error("A lista M3U está vazia.");
  }

  return parseM3U(text);
}


/* =========================================================
   XTREAM
   ========================================================= */

async function xtreamRequest(config, action) {
  const server = normalizeUrl(config.xtreamServer);

  if (!server) {
    throw new Error("Servidor Xtream não definido.");
  }

  if (!config.username || !config.password) {
    throw new Error("Username ou password Xtream em falta.");
  }

  const url =
    `${server}/player_api.php` +
    `?username=${encodeURIComponent(config.username)}` +
    `&password=${encodeURIComponent(config.password)}` +
    `&action=${encodeURIComponent(action)}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": `PT-HUB/${VERSION}`
    }
  });

  if (!response.ok) {
    throw new Error(
      `Xtream respondeu HTTP ${response.status}`
    );
  }

  return await response.json();
}


async function getXtreamChannels(config) {
  const data = await xtreamRequest(
    config,
    "get_live_streams"
  );

  if (!Array.isArray(data)) {
    return [];
  }

  const server = normalizeUrl(config.xtreamServer);

  return data.map((item) => {
    const streamId = String(
      item.stream_id || item.id || ""
    );

    return {
      id: `xtream:${streamId}`,
      type: "channel",
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
}


/* =========================================================
   IPTV CHANNELS
   ========================================================= */

async function getIPTVChannels(config) {
  if (!config || !config.mode) {
    return [];
  }

  if (config.mode === "m3u") {
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

  if (!["m3u", "xtream"].includes(config.mode)) {
    return "Seleciona M3U ou Xtream Codes.";
  }

  if (config.mode === "m3u") {
    if (!isValidHttpUrl(config.m3uUrl)) {
      return "Indica um URL M3U válido.";
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

  if (
    config.epgUrl &&
    !isValidHttpUrl(config.epgUrl)
  ) {
    return "O URL EPG não é válido.";
  }

  return null;
}


/* =========================================================
   CINEMETA
   ========================================================= */

async function cinemetaFetch(endpoint) {
  const url =
    `${CINEMETA_BASE}${endpoint}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": `PT-HUB/${VERSION}`
    }
  });

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
   JUSTWATCH STREAMER CATALOGS - 1.4.3
   ========================================================= */

const JUSTWATCH_URL =
  "https://apis.justwatch.com/graphql";

const JUSTWATCH_COUNTRY = "PT";
const JUSTWATCH_LANGUAGE = "pt";

const STREAMER_CATALOG_BASE =
  "https://v3-cinemeta.strem.io/catalog";

const streamerNames = {
  netflix: "Netflix",
  max: "HBO Max",
  "prime-video": "Amazon Prime Video",
  "disney-plus": "Disney Plus",
  "apple-tv-plus": "Apple TV Plus"
};

async function justWatchRequest(query, variables) {
  const response = await fetch(JUSTWATCH_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "User-Agent": `PT-HUB/${VERSION}`
    },

    body: JSON.stringify({
      operationName: "GetPopularTitles",
      variables,
      query
    })
  });

  if (!response.ok) {
    throw new Error(
      `JustWatch respondeu HTTP ${response.status}`
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

  return data.data;
}


async function getJustWatchPackages() {
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

  const response = await fetch(JUSTWATCH_URL, {
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
  });

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

  return data.data?.packages || [];
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

/*
=========================================================
STREAMER CATALOGS
=========================================================
*/

const movieCatalogs = [
{
  id: "movie-top",
  name: "🔥 Filmes Populares",
  description:
   "Filmes mais populares"
},  
{
    id: "netflix",
    name: "🎬 Netflix Filmes",
    description:
      "Filmes Netflix"
  },
  {
    id: "hbomax",
    name: "🎬 HBO Max Filmes",
    description:
      "Filmes HBO Max"
  },
  {
    id: "prime-video",
    name: "🎬 Prime Video Filmes",
    description:
      "Filmes Prime Video"
  },
  {
    id: "disney-plus",
    name:"🎬 Disney+ Filmes",
    description:
      "Filmes Disney+"
  },
  {
    id: "apple-tv-plus",
    name: "🎬 Apple TV+ Filmes",
    description:
      "Filmes Apple TV+"
  }
];

const seriesCatalogs = [
 {
  id: "series-top",
  name: "🔥 Séries Populares",
  description:
   "Séries mais populares"
}, 
{
    id: "netflix",
    name: "📺 Netflix Séries",
    description:
      "Séries Netflix"
  },
  {
    id: "hbomax",
    name: "📺 HBO Max Séries",
    description:
      "Séries HBO Max"
  },
  {
    id: "prime-video",
    name: "📺 Prime Video Séries",
    description:
      "Séries Prime Video"
  },
  {
    id: "disney-plus",
    name: "📺 Disney+ Séries",
    description:
      "Séries Disney+"
  },
  {
    id: "apple-tv-plus",
    name: "📺 Apple TV+ Séries",
    description:
      "Séries Apple TV+"
  }
];

/* 
=========================================================
   CONFIGURE PAGE
   ========================================================= */

function renderConfigurePage(config = {}) {
  const mode =
    config.mode === "xtream"
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

  return `
<!DOCTYPE html>
<html lang="pt-PT">
<head>
<meta charset="UTF-8">
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
/>

<title>PT•HUB — Configuração</title>

<style>
  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    padding: 0;
    background:
      radial-gradient(
        circle at top,
        #202020 0%,
        #101010 45%,
        #080808 100%
      );
    color: #ffffff;
    font-family:
      Arial,
      Helvetica,
      sans-serif;
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
    background: rgba(25, 25, 25, 0.96);
    border: 1px solid #333;
    border-radius: 18px;
    padding: 30px;
    box-shadow:
      0 20px 60px rgba(0, 0, 0, 0.45);
  }

  h1 {
    text-align: center;
    margin: 0 0 8px;
    font-size: 30px;
  }

  .subtitle {
    text-align: center;
    color: #aaa;
    margin-bottom: 30px;
  }

  label {
    display: block;
    margin-top: 18px;
    margin-bottom: 8px;
    font-weight: 600;
  }

  input,
  select {
    width: 100%;
    padding: 13px 14px;
    border-radius: 10px;
    border: 1px solid #444;
    background: #111;
    color: #fff;
    font-size: 15px;
    outline: none;
  }

  input:focus,
  select:focus {
    border-color: #777;
  }

  .mode-buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-bottom: 15px;
  }

  .mode-button {
    padding: 14px;
    border-radius: 10px;
    border: 1px solid #444;
    background: #151515;
    color: #ddd;
    cursor: pointer;
    font-size: 15px;
  }

  .mode-button.active {
    background: #ffffff;
    color: #000000;
    border-color: #ffffff;
  }

  .section {
    display: none;
  }

  .section.active {
    display: block;
  }

  .buttons {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 25px;
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
    background: #333;
    color: #fff;
  }

  .install {
    background: #fff;
    color: #000;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .status {
    margin-top: 20px;
    padding: 14px;
    border-radius: 10px;
    background: #111;
    border: 1px solid #333;
    color: #bbb;
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
    background: #101010;
    border: 1px solid #333;
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
    background: #333;
    color: #fff;
  }

  .open {
    background: #fff;
    color: #000;
  }

  .footer {
    text-align: center;
    color: #666;
    margin-top: 25px;
    font-size: 12px;
  }

  @media (max-width: 600px) {
    .card {
      padding: 22px;
    }

    .buttons,
    .install-actions {
      grid-template-columns: 1fr;
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
      Configuração IPTV
    </div>

    <div class="mode-buttons">

      <button
        type="button"
        id="m3uButton"
        class="mode-button ${
          mode === "m3u"
            ? "active"
            : ""
        }"
      >
        M3U URL
      </button>

      <button
        type="button"
        id="xtreamButton"
        class="mode-button ${
          mode === "xtream"
            ? "active"
            : ""
        }"
      >
        Xtream Codes
      </button>

    </div>


    <div
      id="m3uSection"
      class="section ${
        mode === "m3u"
          ? "active"
          : ""
      }"
    >

      <label for="m3uUrl">
        URL da lista M3U
      </label>

      <input
        id="m3uUrl"
        type="url"
        placeholder="https://exemplo.com/lista.m3u"
        value="${escapeHtml(m3uUrl)}"
      >

    </div>


    <div
      id="xtreamSection"
      class="section ${
        mode === "xtream"
          ? "active"
          : ""
      }"
    >

      <label for="xtreamServer">
        Servidor Xtream
      </label>

      <input
        id="xtreamServer"
        type="url"
        placeholder="https://servidor.com:8080"
        value="${escapeHtml(xtreamServer)}"
      >


      <label for="username">
        Username
      </label>

      <input
        id="username"
        type="text"
        placeholder="Username"
        value="${escapeHtml(username)}"
      >


      <label for="password">
        Password
      </label>

      <input
        id="password"
        type="password"
        placeholder="Password"
      >

    </div>


    <label for="epgUrl">
      URL EPG
      <span style="color:#777;font-weight:normal;">
        (opcional)
      </span>
    </label>

    <input
      id="epgUrl"
      type="url"
      placeholder="https://exemplo.com/epg.xml"
      value="${escapeHtml(epgUrl)}"
    >


    <div class="buttons">

      <button
        id="testButton"
        class="test"
        type="button"
      >
        Testar ligação
      </button>

      <button
        id="installButton"
        class="install"
        type="button"
      >
        Gerar instalação
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

  const m3uButton =
    document.getElementById("m3uButton");

  const xtreamButton =
    document.getElementById("xtreamButton");

  const m3uSection =
    document.getElementById("m3uSection");

  const xtreamSection =
    document.getElementById("xtreamSection");

  const m3uUrl =
    document.getElementById("m3uUrl");

  const xtreamServer =
    document.getElementById("xtreamServer");

  const username =
    document.getElementById("username");

  const password =
    document.getElementById("password");

  const epgUrl =
    document.getElementById("epgUrl");

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


  function setMode(mode) {

    currentMode = mode;

    if (mode === "m3u") {

      m3uButton.classList.add("active");
      xtreamButton.classList.remove("active");

      m3uSection.classList.add("active");
      xtreamSection.classList.remove("active");

    } else {

      m3uButton.classList.remove("active");
      xtreamButton.classList.add("active");

      m3uSection.classList.remove("active");
      xtreamSection.classList.add("active");

    }

  }


  function showStatus(message) {

    status.textContent = message;
    status.classList.add("show");

  }


  function hideInstall() {

    installBox.classList.remove("show");
    installUrl.textContent = "";

  }


  function getConfig() {

    return {
      mode: currentMode,

      m3uUrl:
        m3uUrl.value.trim(),

      xtreamServer:
        xtreamServer.value.trim(),

      username:
        username.value.trim(),

      password:
        password.value,

      epgUrl:
        epgUrl.value.trim()
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
      .replace(/\\+/g, "-")
      .replace(/\\//g, "_")
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
      /^https?:\\/\\//i,
      "stremio://"
    );

  }


  m3uButton.addEventListener(
    "click",
    function () {
      setMode("m3u");
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


  installButton.addEventListener(
    "click",
    function () {

      hideInstall();

      try {

        const config =
          getConfig();

        if (
          currentMode === "m3u" &&
          !/^https?:\\/\\//i.test(
            config.m3uUrl
          )
        ) {

          showStatus(
            "Indica um URL M3U válido."
          );

          return;
        }


        if (
          currentMode === "xtream" &&
          !/^https?:\\/\\//i.test(
            config.xtreamServer
          )
        ) {

          showStatus(
            "Indica um URL de servidor Xtream válido."
          );

          return;
        }


        if (
          currentMode === "xtream" &&
          (
            !config.username ||
            !config.password
          )
        ) {

          showStatus(
            "Indica username e password Xtream."
          );

          return;
        }


        const url =
          getInstallUrl();

        installUrl.textContent =
          url;

        installBox.classList.add(
          "show"
        );

        showStatus(
          "URL de instalação gerado com sucesso."
        );

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


  setMode(currentMode);

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


    if (config.mode === "m3u") {

      const channels =
        await fetchM3U(
          config.m3uUrl
        );

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
          "get_live_streams"
        );

      if (!Array.isArray(data)) {

        return res.status(400).json({
          success: false,
          error:
            "O servidor Xtream não devolveu uma lista válida de canais."
        });

      }

      return res.json({
        success: true,
        message:
          `Ligação Xtream efetuada com sucesso. ${data.length} canais encontrados.`,
        channels: data.length
      });

    }


    return res.status(400).json({
      success: false,
      error: "Modo IPTV inválido."
    });

  } catch (error) {

    console.error(
      "Erro no teste IPTV:",
      error
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

  const manifest = {
    ...manifestTemplate,

    version: VERSION,

    name: "PT•HUB",

    description:
      "Hub de TV Portugal, IPTV M3U/Xtream Codes, filmes e séries.",

    logo: PT_HUB_LOGO,

    resources: [
      "catalog",
      "meta",
      "stream",
      "addon_catalog"
    ],

    types: [
      "channel",
      "tv",
      "movie",
      "series"
    ],

    

catalogs: [

 ...movieCatalogs.map(
 (catalog) => ({
 type: "movie",
 id: catalog.id,
 name: catalog.name
 })
 ),

 ...seriesCatalogs.map(
 (catalog) => ({
 type: "series",
 id: catalog.id,
 name: catalog.name
 })
 ),

 {
 type: "channel",
 id: "m3u",
 name: "📡 Minha IPTV"
 },

 {
 type: "channel",
 id: "pt-services",
 name: "📺 Operadores"
 }
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
        catalogId === "m3u"
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


/* =========================================================
   CATALOG - FILMES
   ========================================================= */

app.get(
  "/:config/catalog/movie/filmes.json",
  async (req, res) => {

    try {

      const data =
        await getCinemetaCatalog(
          "movie"
        );

      return res.json(data);

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


/* =========================================================
   CATALOG - SERIES
   ========================================================= */

app.get(
  "/:config/catalog/series/series.json",
  async (req, res) => {

    try {

      const data =
        await getCinemetaCatalog(
          "series"
        );

      return res.json(data);

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

/*
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

      

if (id === "movie-top") {

 const data =
 await getCinemetaCatalog(
 "movie"
 );

 return res.json(data);

}

const data =
 await getJustWatchCatalog(
 "movie",
 id
 );

return res.json(data);

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
if (id === "series-top") {

 const data =
 await getCinemetaCatalog(
 "series"
 );

 return res.json(data);

}

const data =
 await getJustWatchCatalog(
 "series",
 id
 );

return res.json(data);
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
   GENERIC CATALOG
   ========================================================= */

app.get(
  "/:config/catalog/:type/:id.json",
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
        type === "movie" &&
        id === "filmes"
      ) {

        const data =
          await getCinemetaCatalog(
            "movie"
          );

        return res.json(data);

      }


      if (
        type === "series" &&
        id === "series"
      ) {

        const data =
          await getCinemetaCatalog(
            "series"
          );

        return res.json(data);

      }


      if (
        type === "channel" &&
        (
          id === "m3u" ||
          id === "pt-services"
        )
      ) {

        if (id === "pt-services") {

          return res.json({
            metas:
              services.map(
                (service, index) => ({
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
                    PT_HUB_LOGO
                })
              )
          });

        }


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
          metas:
            channels.map(
              (channel) => ({
                id:
                  channel.id,

                type: "channel",

                name:
                  channel.name,

                poster:
                  channel.logo ||
                  PT_HUB_LOGO
              })
            )
        });

      }


      return res.json({
        metas: []
      });

    } catch (error) {

      console.error(
        "Erro catálogo:",
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


      /* -----------------------------------------------------
         FILMES / SÉRIES
         ----------------------------------------------------- */

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


      /* -----------------------------------------------------
         IPTV
         ----------------------------------------------------- */

      if (
        type === "channel"
      ) {

        if (
          id.startsWith("m3u:") ||
          id.startsWith("xtream:")
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


      /* -----------------------------------------------------
         IPTV
         ----------------------------------------------------- */

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

        return res.json({
          streams: [
            {
              name: "PT•HUB",

              title:
                channel.name,

              url:
                channel.url,

              behaviorHints: {
                notWebReady: false
              }
            }
          ]
        });

      }


      /* -----------------------------------------------------
         FILMES / SÉRIES
         ----------------------------------------------------- */

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
   HOME
   ========================================================= */

app.get("/", (req, res) => {

  res.send(`
<!DOCTYPE html>
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
