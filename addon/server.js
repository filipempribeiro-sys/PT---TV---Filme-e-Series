const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns");
const zlib = require("zlib");

/*
 * Alguns servidores Xtream/IPTV rejeitam ou "resetam" ligações
 * feitas via IPv6 (comum em plataformas como o Render). Forçar
 * a resolução DNS a preferir IPv4 evita falhas ECONNRESET.
 */
try {
  dns.setDefaultResultOrder("ipv4first");
} catch (error) {
  console.error(
    "Não foi possível definir preferência DNS IPv4:",
    error.message
  );
}

const app = express();

const PORT = process.env.PORT || 10000;
const BASE_DIR = __dirname;

const VERSION = "2.1.3";

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
   ARMAZENAMENTO TEMPORÁRIO DE FICHEIROS M3U
   =========================================================
   Guardar o conteúdo do ficheiro M3U diretamente no URL de
   instalação (stremio://...) produz um link demasiado grande,
   que o Stremio/Nuvio rejeitam ao tentar abrir a app. Em vez
   disso, o ficheiro é enviado para o servidor (/upload-m3u),
   guardado aqui, e o URL de instalação passa a conter apenas
   um ID curto (m3uFileId).
   ========================================================= */

const M3U_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const M3U_FILE_MAX_BYTES = 8 * 1024 * 1024;

const m3uFileStore = new Map();

function cleanupM3UFileStore() {
  const now = Date.now();

  for (const [id, entry] of m3uFileStore) {
    if (now - entry.createdAt > M3U_FILE_TTL_MS) {
      m3uFileStore.delete(id);
    }
  }
}

setInterval(cleanupM3UFileStore, 60 * 60 * 1000);

app.post(
  "/upload-m3u",
  express.text({
    limit: "8mb",
    type: () => true
  }),
  (req, res) => {

    const content =
      typeof req.body === "string" ? req.body : "";

    if (!content.trim()) {
      return res.status(400).json({
        error: "Ficheiro M3U vazio ou inválido."
      });
    }

    if (Buffer.byteLength(content, "utf8") > M3U_FILE_MAX_BYTES) {
      return res.status(400).json({
        error: "Ficheiro demasiado grande (máximo 8MB)."
      });
    }

    const id = crypto.randomBytes(12).toString("hex");

    m3uFileStore.set(id, {
      content,
      createdAt: Date.now()
    });

    res.json({ id });

  }
);

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
const channelLogos = loadJSON("../data/channel-logos.json", []);

function normalizeLogoMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const channelLogosIndex =
  channelLogos.map((entry) => ({
    logo: entry.logo,
    keywords:
      (Array.isArray(entry.match) ? entry.match : [entry.match])
        .filter(Boolean)
        .map(normalizeLogoMatchText)
  }));

function findChannelLogo(channelName) {

  const normalizedName =
    normalizeLogoMatchText(channelName);

  if (!normalizedName) {
    return "";
  }

  for (const entry of channelLogosIndex) {

    const matched =
      entry.keywords.some((keyword) =>
        keyword && normalizedName.includes(keyword)
      );

    if (matched && entry.logo) {
      return entry.logo;
    }

  }

  return "";
}

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

    const buffer =
      Buffer.from(value, "base64url");

    /*
     * Formato novo (comprimido com pako/deflateRaw no browser,
     * para links de instalação mais curtos). Se falhar, tenta o
     * formato antigo (JSON simples em base64url) para não quebrar
     * links de instalação já existentes.
     */
    try {

      const inflated =
        zlib.inflateRawSync(buffer);

      return JSON.parse(
        inflated.toString("utf8")
      );

    } catch (inflateError) {

      return JSON.parse(
        buffer.toString("utf8")
      );

    }

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
        /tvg-id=["']([^"']*)["']/i
      );
      const tvgNameMatch = attributes.match(
        /tvg-name=["']([^"']*)["']/i
      );
      const tvgLogoMatch = attributes.match(
        /tvg-logo=["']([^"']*)["']/i
      );
      const groupMatch = attributes.match(
        /group-title=["']([^"']*)["']/i
      );

      currentInfo = {
        name:
          name ||
          tvgNameMatch?.[1] ||
          "Canal IPTV",

        tvgId:
          tvgIdMatch?.[1] ||
          "",

        logo:
          tvgLogoMatch?.[1] ||
          "",

        group:
          groupMatch?.[1] ||
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
        logo: currentInfo.logo || findChannelLogo(currentInfo.name),
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

  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": `PT-HUB/${VERSION}`
        }
      });

      clearTimeout(timeout);

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

    } catch (error) {

      clearTimeout(timeout);
      lastError = error;

      console.error(
        `Erro ao obter M3U (tentativa ${attempt}/${maxAttempts}):`,
        error.message
      );

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

    }

  }

  throw lastError;
}

/* =========================================================
   XTREAM
   ========================================================= */


const https = require("https");
const http = require("http");

function legacyHttpRequest(targetUrl, timeoutMs) {

  return new Promise((resolve, reject) => {

    let parsed;

    try {
      parsed = new URL(targetUrl);
    } catch (error) {
      return reject(error);
    }

    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const requestOptions = {
      hostname: parsed.hostname,
      port:
        parsed.port ||
        (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      family: 4,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json,*/*",
        "Connection": "close"
      },
      ...(isHttps
        ? {
            minVersion: "TLSv1",
            ciphers: "DEFAULT@SECLEVEL=1",
            rejectUnauthorized: false
          }
        : {})
    };

    const req = lib.request(requestOptions, (res) => {

      const chunks = [];

      res.on("data", (chunk) => chunks.push(chunk));

      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });

    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error("Tempo limite excedido ao contactar o servidor Xtream.")
      );
    });

    req.on("error", reject);

    req.end();

  });

}

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
  "XTREAM SERVER:",
  server
);

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

 console.log(
 "XTREAM URL:",
 url
 );

 const maxAttempts = 2;
 let lastError = null;

 /*
  * 1ª fase: fetch() nativo (undici), com repetição em caso
  * de erro de rede transitório.
  */
 for (
 let attempt = 1;
 attempt <= maxAttempts;
 attempt++
 ) {

 const controller =
 new AbortController();

 const timeout =
 setTimeout(
 () => controller.abort(),
 15000
 );

 try {

 const response =
 await fetch(url, {
 signal:
 controller.signal,

 redirect: "follow",

 headers: {
 "User-Agent":
 "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",

 "Accept":
 "application/json,*/*",

 "Connection": "close"
 }
 });

 clearTimeout(timeout);

 if (!response.ok) {
 throw new Error(
 `Xtream respondeu HTTP ${response.status}`
 );
 }

 return await response.json();

 } catch (error) {

 clearTimeout(timeout);

 lastError = error;

 console.error(
 `XTREAM FETCH ERROR (tentativa ${attempt}/${maxAttempts}):`,
 error
 );

 const isNetworkError =
 error.cause?.code ||
 error.name === "AbortError";

 if (
 attempt < maxAttempts &&
 isNetworkError
 ) {

 await new Promise(
 (resolve) =>
 setTimeout(resolve, 1000 * attempt)
 );

 continue;

 }

 }

 }

 /*
  * 2ª fase: fetch() falhou de forma consistente (típico de
  * bloqueio de IP ou TLS incompatível). Tenta com o módulo
  * https/http nativo, com configuração mais tolerante —
  * resolve o caso de servidores Xtream antigos/mal configurados.
  */
 try {

 console.error(
 "XTREAM: a tentar via https nativo (fallback)..."
 );

 const result =
 await legacyHttpRequest(url, 15000);

 if (result.statusCode < 200 || result.statusCode >= 300) {
 throw new Error(
 `Xtream respondeu HTTP ${result.statusCode}`
 );
 }

 return JSON.parse(result.body);

 } catch (fallbackError) {

 console.error(
 "XTREAM FALLBACK ERROR:",
 fallbackError
 );

 const originalCode =
 lastError?.cause?.code ||
 lastError?.message;

 throw new Error(
 `Falha ao contactar servidor Xtream (${originalCode}). O servidor pode estar a bloquear ligações a partir do Render — confirma com o teu fornecedor de IPTV se há bloqueio de IPs de hosting/cloud.`
 );

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
        findChannelLogo(
          item.name || item.stream_display_name || ""
        ),

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
   IPTV-ORG
   ========================================================= */

const IPTVORG_CHANNELS_URL =
  "https://iptv-org.github.io/api/channels.json";

const IPTVORG_STREAMS_URL =
  "https://iptv-org.github.io/api/streams.json";

const IPTVORG_LOGOS_URL =
  "https://iptv-org.github.io/api/logos.json";

let iptvOrgCache = null;
let iptvOrgCacheTime = 0;

async function getIPTVOrgData() {

  const now = Date.now();

  if (
    iptvOrgCache &&
    (now - iptvOrgCacheTime) < (6 * 60 * 60 * 1000)
  ) {
    return iptvOrgCache;
  }

  const [
    channelsResponse,
    streamsResponse,
    logosResponse
  ] = await Promise.all([
    fetch(IPTVORG_CHANNELS_URL, {
      headers: { "User-Agent": `PT-HUB/${VERSION}` }
    }),
    fetch(IPTVORG_STREAMS_URL, {
      headers: { "User-Agent": `PT-HUB/${VERSION}` }
    }),
    fetch(IPTVORG_LOGOS_URL, {
      headers: { "User-Agent": `PT-HUB/${VERSION}` }
    }).catch(() => null)
  ]);

  if (!channelsResponse.ok || !streamsResponse.ok) {
    throw new Error(
      "Não foi possível obter a base de dados IPTV-org."
    );
  }

  const channels = await channelsResponse.json();
  const streams = await streamsResponse.json();

  let logos = [];

  try {
    if (logosResponse && logosResponse.ok) {
      logos = await logosResponse.json();
    }
  } catch (error) {
    logos = [];
  }

  const streamsByChannel = {};

  for (const stream of streams) {
    if (!stream.channel || !stream.url) {
      continue;
    }

    if (!streamsByChannel[stream.channel]) {
      streamsByChannel[stream.channel] = [];
    }

    streamsByChannel[stream.channel].push(stream);
  }

  const logoByChannel = {};

  for (const logo of logos) {
    if (
      logo.channel &&
      !logoByChannel[logo.channel]
    ) {
      logoByChannel[logo.channel] = logo.url;
    }
  }

  iptvOrgCache = {
    channels,
    streamsByChannel,
    logoByChannel
  };

  iptvOrgCacheTime = now;

  return iptvOrgCache;
}

const IPTVORG_COUNTRY_NAME_MAP = {
  PORTUGAL: "PT",
  BRASIL: "BR",
  BRAZIL: "BR",
  ESPANHA: "ES",
  SPAIN: "ES",
  "REINO UNIDO": "GB",
  "UNITED KINGDOM": "GB",
  FRANCA: "FR",
  FRANÇA: "FR",
  FRANCE: "FR",
  ALEMANHA: "DE",
  GERMANY: "DE",
  ITALIA: "IT",
  ITÁLIA: "IT",
  ITALY: "IT",
  "ESTADOS UNIDOS": "US",
  USA: "US",
  "UNITED STATES": "US"
};

function normalizeIPTVOrgCountry(value) {

  const raw =
    String(value || "").trim().toUpperCase();

  if (!raw) {
    return "";
  }

  if (raw.length === 2) {
    return raw;
  }

  return IPTVORG_COUNTRY_NAME_MAP[raw] || raw;
}

async function getIPTVOrgChannels(config) {

  const iptvOrg = config.iptvOrg || {};

  const rawCountry =
    String(iptvOrg.country || "").trim();

  const rawCategory =
    String(iptvOrg.category || "").trim().toLowerCase();

  /*
   * Se nada for indicado, assume Portugal por defeito
   * (addon orientado a conteúdo português).
   */
  const country =
    rawCountry || rawCategory
      ? normalizeIPTVOrgCountry(rawCountry)
      : "PT";

  const category = rawCategory;

  const data = await getIPTVOrgData();

  const results = [];

  for (const channel of data.channels) {

    if (
      country &&
      String(channel.country || "").toUpperCase() !== country
    ) {
      continue;
    }

    if (
      category &&
      !(channel.categories || [])
        .map((item) => String(item).toLowerCase())
        .some(
          (item) =>
            item === category ||
            item.includes(category) ||
            category.includes(item)
        )
    ) {
      continue;
    }

    const streams =
      data.streamsByChannel[channel.id] || [];

    if (!streams.length) {
      continue;
    }

    results.push({
      id: `iptvorg:${channel.id}`,
      type: "channel",
      name: channel.name || channel.id,
      logo:
        channel.logo ||
        data.logoByChannel[channel.id] ||
        findChannelLogo(channel.name || channel.id),
      group:
        (channel.categories && channel.categories[0]) || "TV",
      tvgId: channel.id,
      url: streams[0].url
    });

  }

  return results;
}

/* =========================================================
   IPTV CHANNELS
   ========================================================= */

async function getIPTVChannels(config) {
  if (!config || !config.mode) {
    return [];
  }

  if (config.mode === "m3u") {

    if (config.m3uSource === "file") {

      if (config.m3uFileId) {

        const stored = m3uFileStore.get(config.m3uFileId);

        if (!stored) {
          throw new Error(
            "O ficheiro M3U expirou ou não foi encontrado. Volta a carregar o ficheiro na página de configuração e gera um novo link de instalação."
          );
        }

        return parseM3U(stored.content);

      }

      if (config.m3uFileData) {
        return parseM3U(config.m3uFileData);
      }

      throw new Error(
        "Nenhum ficheiro M3U associado a esta configuração."
      );

    }

    return await fetchM3U(config.m3uUrl);
  }

  if (config.mode === "xtream") {
    return await getXtreamChannels(config);
  }

  if (config.mode === "iptv-org") {
    return await getIPTVOrgChannels(config);
  }

  return [];
}


/* =========================================================
 CONFIG VALIDATION
 ========================================================= */

function validateConfig(config) {

 if (
 config.features &&
 !config.features.iptv
 ) {
 return null;
 }

 if (
 !config ||
 typeof config !== "object"
 ) {
 return "Configuração inválida.";
 }

 if (
 !["m3u", "xtream", "iptv-org"].includes(
 config.mode
 )
 ) {
 return "Seleciona IPTV-org, M3U ou Xtream Codes.";
 }

 if (config.mode === "m3u") {

 if (config.m3uSource === "file") {

 if (!config.m3uFileId && !config.m3uFileData) {
 return "Seleciona um ficheiro M3U ou M3U8.";
 }

 } else if (
 !isValidHttpUrl(
 config.m3uUrl
 )
 ) {
 return "Indica um URL M3U válido.";
 }

 }

 if (config.mode === "xtream") {

 if (
 !isValidHttpUrl(
 config.xtreamServer
 )
 ) {
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
 !isValidHttpUrl(
 config.epgUrl
 )
 ) {
 return "O URL EPG não é válido.";
 }

 return null;

}

/* ========================================================
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

async function getCinemetaCatalog(type, search) {

  if (search) {

    const endpoint =
      `/catalog/${type}/top/search=${encodeURIComponent(search)}.json`;

    return await cinemetaFetch(endpoint);

  }

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
  const data = await cinemetaFetch(
    `/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`
  );

  // O cliente Stremio/Nuvio decide se mostra trailer/preview, mas o PT•HUB
  // garante sempre os visuais necessários para uma página de detalhe rica.
  if (data?.meta && /^tt\d+$/.test(String(id || ""))) {
    data.meta.poster =
      data.meta.poster ||
      `https://images.metahub.space/poster/medium/${id}/img`;

    data.meta.background =
      data.meta.background ||
      `https://images.metahub.space/background/medium/${id}/img`;

    data.meta.logo =
      data.meta.logo ||
      `https://images.metahub.space/logo/medium/${id}/img`;
  }

  return data;
}

/* =========================================================
   NOVIDADES / ESTREIAS - JUSTWATCH + CINEMETA/METAHUB
   ========================================================= */

const discoveryCatalogCache = new Map();
const DISCOVERY_CATALOG_CACHE_MS = 30 * 60 * 1000;

function normalizeDiscoveryMeta(type, content) {
  const imdbId = content?.externalIds?.imdbId;

  if (!imdbId) {
    return null;
  }

  return {
    id: imdbId,
    type,
    name: content?.title || "Título",
    poster:
      `https://images.metahub.space/poster/medium/${imdbId}/img`,
    background:
      `https://images.metahub.space/background/medium/${imdbId}/img`,
    releaseInfo:
      content?.originalReleaseYear
        ? String(content.originalReleaseYear)
        : undefined
  };
}

async function getDiscoveryCatalog(type, mode, country) {
  const countryCode = normalizeCountryCode(country);
  const cacheKey = `${mode}:${type}:${countryCode}`;
  const now = Date.now();
  const cached = discoveryCatalogCache.get(cacheKey);

  if (cached && (now - cached.time) < DISCOVERY_CATALOG_CACHE_MS) {
    return cached.data;
  }

  const objectType = type === "movie" ? "MOVIE" : "SHOW";

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
            content(country: $country, language: pt) {
              title
              originalReleaseYear
              externalIds { imdbId }
            }
          }
        }
      }
    }
  `;

  const filter = {
    objectTypes: [objectType]
  };

  // JustWatch expõe CINEMA como tipo de monetização. Isto permite uma
  // linha de estreias em sala independente dos streamers configurados.
  if (mode === "cinema") {
    filter.monetizationTypes = ["CINEMA"];
  }

  const variables = {
    country: countryCode,
    first: 100,
    sortBy: mode === "popular" ? "POPULAR" : "TRENDING",
    filter
  };

  const data = await justWatchRequest(query, variables);
  const edges = data?.popularTitles?.edges || [];
  const currentYear = new Date().getUTCFullYear();
  const ids = new Set();
  const metas = [];

  for (const edge of edges) {
    const content = edge?.node?.content;

    if (!content) {
      continue;
    }

    if (mode === "new") {
      const year = Number(content.originalReleaseYear || 0);

      // Mantém a montra concentrada em obras recentes. Inclui o ano
      // anterior para evitar uma linha vazia nos primeiros meses do ano.
      if (!year || year < (currentYear - 1)) {
        continue;
      }
    }

    const meta = normalizeDiscoveryMeta(type, content);

    if (!meta || ids.has(meta.id)) {
      continue;
    }

    ids.add(meta.id);
    metas.push(meta);
  }

  if (mode === "new") {
    metas.sort((a, b) =>
      Number(b.releaseInfo || 0) - Number(a.releaseInfo || 0)
    );
  }

  const result = { metas: metas.slice(0, 100) };
  discoveryCatalogCache.set(cacheKey, { data: result, time: Date.now() });

  return result;
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
  hbomax: "HBO Max",
  "prime-video": "Amazon Prime Video",
  "disney-plus": "Disney Plus",
  "apple-tv-plus": "Apple TV Plus"
};

/*
 * Fila global simples: nunca mais do que 1 pedido ao JustWatch
 * de cada vez, com um pequeno intervalo entre pedidos. Isto
 * evita o "cache stampede" (várias catálogos em simultâneo a
 * disparar pedidos ao mesmo tempo) que estava a causar HTTP 429.
 */
let justWatchQueue = Promise.resolve();

function queueJustWatchRequest(task) {

  const run = () =>
    task().finally(
      () => new Promise((resolve) => setTimeout(resolve, 350))
    );

  const result =
    justWatchQueue.then(run, run);

  justWatchQueue =
    result.catch(() => {});

  return result;

}

async function fetchWithRetry429(doFetch, maxAttempts) {

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    try {

      return await doFetch();

    } catch (error) {

      lastError = error;

      const is429 =
        String(error.message || "").includes("429");

      if (!is429 || attempt === maxAttempts) {
        throw error;
      }

      const waitMs =
        1500 * attempt;

      console.error(
        `JustWatch 429 - a aguardar ${waitMs}ms antes de repetir (tentativa ${attempt}/${maxAttempts})`
      );

      await new Promise((resolve) => setTimeout(resolve, waitMs));

    }

  }

  throw lastError;

}

async function justWatchRequest(query, variables) {

  return queueJustWatchRequest(() =>
    fetchWithRetry429(async () => {

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

    }, 4)
  );

}

function normalizeCountryCode(value) {

  const code =
    String(value || "")
      .trim()
      .toUpperCase();

  return /^[A-Z]{2}$/.test(code)
    ? code
    : JUSTWATCH_COUNTRY;

}

const justWatchPackagesCacheByCountry = new Map();
const justWatchPackagesInFlight = new Map();

async function getJustWatchPackages(country) {

const countryCode =
  normalizeCountryCode(country);

const now = Date.now();

const cached =
  justWatchPackagesCacheByCountry.get(countryCode);

if (
cached &&
(now - cached.time) <
(60 * 60 * 1000)
) {
 return cached.packages;
 }

if (justWatchPackagesInFlight.has(countryCode)) {
  return justWatchPackagesInFlight.get(countryCode);
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

const requestPromise = queueJustWatchRequest(() =>
  fetchWithRetry429(async () => {

    const response = await fetch(JUSTWATCH_URL, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "User-Agent": `PT-HUB/${VERSION}`
      },

      body: JSON.stringify({
        operationName: "Packages",
        variables: {
          country: countryCode,
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

  }, 4)
)
  .then((packages) => {

    justWatchPackagesCacheByCountry.set(countryCode, {
      packages,
      time: Date.now()
    });

    justWatchPackagesInFlight.delete(countryCode);

    return packages;

  })
  .catch((error) => {
    justWatchPackagesInFlight.delete(countryCode);
    throw error;
  });

justWatchPackagesInFlight.set(countryCode, requestPromise);

return requestPromise;

}

async function getStreamerPackage(streamerId, country) {
  const packages =
    await getJustWatchPackages(country);

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


const justWatchCatalogCache = new Map();
const justWatchCatalogInFlight = new Map();
const JUSTWATCH_CATALOG_CACHE_MS = 30 * 60 * 1000;

async function getJustWatchCatalog(
  type,
  streamerId,
  country
) {
  const countryCode =
    normalizeCountryCode(country);

  const cacheKey =
    `${type}:${streamerId}:${countryCode}`;

  const now = Date.now();

  const cached =
    justWatchCatalogCache.get(cacheKey);

  if (
    cached &&
    (now - cached.time) < JUSTWATCH_CATALOG_CACHE_MS
  ) {
    return cached.data;
  }

  if (justWatchCatalogInFlight.has(cacheKey)) {
    return justWatchCatalogInFlight.get(cacheKey);
  }

  const requestPromise =
    fetchJustWatchCatalogUncached(type, streamerId, countryCode)
      .then((data) => {
        justWatchCatalogCache.set(cacheKey, { data, time: Date.now() });
        justWatchCatalogInFlight.delete(cacheKey);
        return data;
      })
      .catch((error) => {
        justWatchCatalogInFlight.delete(cacheKey);
        throw error;
      });

  justWatchCatalogInFlight.set(cacheKey, requestPromise);

  return requestPromise;
}

async function fetchJustWatchCatalogUncached(
  type,
  streamerId,
  countryCode
) {
  const packageInfo =
    await getStreamerPackage(streamerId, countryCode);

  if (!packageInfo?.shortName) {
    console.error(
      `Streamer não encontrado no JustWatch: ${streamerId} (${countryCode})`
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
    country: countryCode,

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

async function getFeaturedCatalog(type, country) {

const streamers = [
"netflix",
"hbomax",
"prime-video",
"disney-plus",
"apple-tv-plus"
];

const metas = [];
const ids = new Set();

for (const streamer of streamers) {

try {

const data =
await getJustWatchCatalog(
type,
streamer,
country
);

for (const meta of data.metas.slice(0, 20)) {

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
metas: metas.slice(0, 100)
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

const discoveryCatalogs = [
  { id: "cinema-new", name: "🎬 Estreias no Cinema" },
  { id: "movie-new", name: "🆕 Novos Filmes" }
];

const streamerCatalogs =
streamers.map(
streamer => ({
id: streamer.id,
name:
`🎬 ${streamer.name} Filmes`
})
);

return [
...discoveryCatalogs,
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

const discoveryCatalogs = [
  { id: "series-new", name: "🆕 Novas Séries" }
];

const streamerCatalogs =
streamers.map(
streamer => ({
id: streamer.id,
name:
`📺 ${streamer.name} Séries`
})
);

return [
...discoveryCatalogs,
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

function getOperatorById(operatorId) {
  return operators.find(
    (operator) => operator.id === operatorId
  ) || null;
}


/* =========================================================
   CONTEÚDO PORTUGUÊS — FONTES EXTERNAS STREMIO
   =========================================================
   Duas famílias totalmente independentes:
   - ptpt: filmes/séries com áudio/conteúdo em Português de Portugal
   - portuguese: filmes/séries/novelas de produção portuguesa

   O PT•HUB não inclui URLs de terceiros nem conhece providers à partida.
   O utilizador adiciona os URLs na configuração e o addon lê apenas a
   interface Stremio pública declarada no respetivo manifest.json.
   ========================================================= */

const PT_SOURCE_GROUPS = {
  ptpt: {
    key: "ptpt",
    label: "Filmes e Séries em PT-PT",
    prefix: "🇵🇹"
  },
  portuguese: {
    key: "portuguese",
    label: "Filmes, Séries e Novelas Portuguesas",
    prefix: "🇵🇹"
  },
  adult: {
    key: "adult",
    label: "Adultos",
    prefix: "🔞"
  }
};

/*
 * Fontes conhecidas do PT•HUB. O utilizador seleciona-as por checkbox;
 * os URLs ficam centralizados no código. URLs personalizados continuam
 * disponíveis como opção avançada.
 */
const PT_PREDEFINED_SOURCES = {
  ptpt: [
    {
      id: "cotonet",
      name: "Cotonet",
      manifestUrl: "https://cotonetnet-cotonet.hf.space/manifest.json"
    }
  ],
  portuguese: [
    {
      id: "filmes-series-novelas-portuguesas",
      name: "Filmes, Séries e Novelas Portuguesas",
      manifestUrl: "https://filme-series-e-novelas-portuguesas.vercel.app/manifest.json"
    }
  ],
  adult: [
    { id: "dirty-pink", name: "Dirty Pink", manifestUrl: "https://dirty-pink.ers.pw/manifest.json" },
    { id: "tpb-adult", name: "TPB Adult", manifestUrl: "https://tpb-adult-addon.click/manifest.json" },
    { id: "jaxxx-v2", name: "JAXXX V2", manifestUrl: "https://07b88951aaab-jaxxx-v2.baby-beamup.club/manifest.json" },
    { id: "xclub", name: "XClub", manifestUrl: "https://xclub-stremio.vercel.app/manifest.json" },
    { id: "hianime", name: "HiAnime", manifestUrl: "https://streamio-hianime.onrender.com/manifest.json" },
    { id: "asa", name: "ASA", manifestUrl: "https://asa.00696900.xyz/manifest.json" },
    { id: "hentaistream", name: "HentaiStream", manifestUrl: "https://hentaistream-addon.keypop3750.workers.dev/manifest.json" },
    { id: "hanime", name: "HAnime", manifestUrl: "https://hanime-stremio.fly.dev/manifest.json" },
    { id: "xclub-rd", name: "XClub RD", manifestUrl: "https://xclub-rd-bov3.vercel.app/manifest.json" },
    { id: "adult-video", name: "Adult Video", manifestUrl: "https://av.sudolocal.qzz.io/manifest.json" }
  ]
};

function getPredefinedPtSource(group, sourceId) {
  const sources = Array.isArray(PT_PREDEFINED_SOURCES[group])
    ? PT_PREDEFINED_SOURCES[group]
    : [];

  return sources.find((source) => source.id === sourceId) || null;
}

const ptSourceManifestCache = new Map();
const ptSourceManifestInFlight = new Map();
const PT_SOURCE_MANIFEST_CACHE_MS = 60 * 60 * 1000;
const PT_SOURCE_CATALOG_TIMEOUT_MS = 12000;
const PT_SOURCE_META_TIMEOUT_MS = 10000;
const PT_SOURCE_STREAM_TIMEOUT_MS = 12000;

function normalizeAddonBaseUrl(value) {
  const normalized = normalizeUrl(value);
  return normalized.replace(/\/manifest\.json$/i, "");
}

function getPtSourceUrls(config, group) {
  /*
   * Adultos: uma única opção na configuração ativa automaticamente
   * todos os providers predefinidos. Não existem checkboxes individuais.
   * Mantemos suporte silencioso a URLs personalizados de configurações
   * antigas para não quebrar links já gerados.
   */
  if (group === "adult") {
    if (config?.features?.adultContent !== true) {
      return [];
    }

    const predefinedUrls = (PT_PREDEFINED_SOURCES.adult || [])
      .map((source) => source.manifestUrl);

    const legacyCustom = Array.isArray(config?.adultContentExternalSources)
      ? config.adultContentExternalSources
      : [];

    return [...new Set(
      [...predefinedUrls, ...legacyCustom]
        .map(normalizeAddonBaseUrl)
        .filter(isValidHttpUrl)
    )];
  }

  const selected = config?.ptContentSelectedSources || {};
  const selectedIds = Array.isArray(selected[group]) ? selected[group] : [];

  const predefinedUrls = selectedIds
    .map((sourceId) => getPredefinedPtSource(group, sourceId))
    .filter(Boolean)
    .map((source) => source.manifestUrl);

  const custom = config?.ptContentExternalSources || {};
  const customUrls = Array.isArray(custom[group]) ? custom[group] : [];

  return [...new Set(
    [...predefinedUrls, ...customUrls]
      .map(normalizeAddonBaseUrl)
      .filter(isValidHttpUrl)
  )];
}

function getPtSourceHash(baseUrl) {
  return crypto
    .createHash("sha256")
    .update(normalizeAddonBaseUrl(baseUrl))
    .digest("hex")
    .slice(0, 12);
}

function encodePtToken(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

function decodePtToken(value) {
  try {
    return Buffer.from(String(value || ""), "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function makePtCatalogId(group, baseUrl, originalCatalogId) {
  return [
    "pthubpt",
    group,
    getPtSourceHash(baseUrl),
    encodePtToken(originalCatalogId)
  ].join(":");
}

function parsePtCatalogId(value) {
  const parts = String(value || "").split(":");

  if (parts.length !== 4 || parts[0] !== "pthubpt") {
    return null;
  }

  const [, group, sourceHash, catalogToken] = parts;

  if (!PT_SOURCE_GROUPS[group]) {
    return null;
  }

  const originalCatalogId = decodePtToken(catalogToken);

  if (!sourceHash || !originalCatalogId) {
    return null;
  }

  return { group, sourceHash, originalCatalogId };
}

function makePtMetaId(group, baseUrl, originalId) {
  return [
    "pthubptmeta",
    group,
    getPtSourceHash(baseUrl),
    encodePtToken(originalId)
  ].join(":");
}

function parsePtMetaId(value) {
  const parts = String(value || "").split(":");

  if (parts.length !== 4 || parts[0] !== "pthubptmeta") {
    return null;
  }

  const [, group, sourceHash, idToken] = parts;

  if (!PT_SOURCE_GROUPS[group]) {
    return null;
  }

  const originalId = decodePtToken(idToken);

  if (!sourceHash || !originalId) {
    return null;
  }

  return { group, sourceHash, originalId };
}

function findPtSourceUrl(config, group, sourceHash) {
  return (
    getPtSourceUrls(config, group)
      .find((url) => getPtSourceHash(url) === sourceHash) ||
    null
  );
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": `PT-HUB/${VERSION}`,
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getPtSourceManifest(baseUrl) {
  const normalizedBase = normalizeAddonBaseUrl(baseUrl);

  if (!isValidHttpUrl(normalizedBase)) {
    return null;
  }

  const cached = ptSourceManifestCache.get(normalizedBase);

  if (
    cached &&
    (Date.now() - cached.time) < PT_SOURCE_MANIFEST_CACHE_MS
  ) {
    return cached.manifest;
  }

  if (ptSourceManifestInFlight.has(normalizedBase)) {
    return ptSourceManifestInFlight.get(normalizedBase);
  }

  const request =
    fetchJsonWithTimeout(
      `${normalizedBase}/manifest.json`,
      10000
    )
      .then((manifest) => {
        const valid =
          manifest &&
          typeof manifest === "object" &&
          Array.isArray(manifest.resources) &&
          Array.isArray(manifest.catalogs);

        const result = valid ? manifest : null;

        ptSourceManifestCache.set(normalizedBase, {
          manifest: result,
          time: Date.now()
        });

        ptSourceManifestInFlight.delete(normalizedBase);
        return result;
      })
      .catch((error) => {
        console.error(
          `Erro ao ler manifest da fonte PT ${normalizedBase}:`,
          error.message
        );

        ptSourceManifestCache.set(normalizedBase, {
          manifest: null,
          time: Date.now()
        });

        ptSourceManifestInFlight.delete(normalizedBase);
        return null;
      });

  ptSourceManifestInFlight.set(normalizedBase, request);
  return request;
}

function sourceSupportsResource(manifest, resource) {
  return Array.isArray(manifest?.resources) &&
    manifest.resources.some((item) => {
      if (typeof item === "string") {
        return item === resource;
      }

      return item?.name === resource;
    });
}

function normalizeCatalogExtra(catalog) {
  if (Array.isArray(catalog?.extra)) {
    return catalog.extra;
  }

  if (Array.isArray(catalog?.extraSupported)) {
    return catalog.extraSupported.map((name) => ({
      name,
      isRequired: false
    }));
  }

  return [];
}

function getPtCatalogDisplayName(group, sourceName, catalogName, catalogId, type) {
  const text = normalizeSearchText(
    `${catalogId || ""} ${catalogName || ""}`
  );

  if (group === "ptpt") {
    const base = type === "series"
      ? "🇵🇹 Séries em PT-PT"
      : "🇵🇹 Filmes em PT-PT";

    if (/\b(todos?|all|principal|main|default)\b/.test(text)) {
      return base;
    }

    if (/\b(a-z|az|alfabetico|alfabetica)\b/.test(text)) {
      return `${base} • A-Z`;
    }

    if (/\b(recentes?|recent|new|novos?)\b/.test(text)) {
      return `${base} • Recentes`;
    }

    if (/\b(antigos?|old|classicos?)\b/.test(text)) {
      return `${base} • Antigos`;
    }

    if (/\b(rating|avaliacao|melhor)\b/.test(text)) {
      return `${base} • Melhor Avaliação`;
    }

    const suffix = String(catalogName || "").trim();
    return suffix ? `${base} • ${suffix}` : base;
  }

  if (group === "portuguese") {
    if (/novela/.test(text)) {
      return "🇵🇹 Novelas Portuguesas";
    }

    if (type === "movie") {
      return "🇵🇹 Filmes Portugueses";
    }

    if (type === "series") {
      return "🇵🇹 Séries Portuguesas";
    }

    return "🇵🇹 Conteúdo Português";
  }

  if (group === "adult") {
    const suffix = String(catalogName || "").trim();
    return suffix ? `🔞 Adultos • ${suffix}` : "🔞 Adultos";
  }

  return `${PT_SOURCE_GROUPS[group]?.prefix || ""} ${String(catalogName || sourceName || "Conteúdo").trim()}`.trim();
}


/* =========================================================
   CATÁLOGOS PORTUGUÊS — ESTRUTURA FIXA PT•HUB
   =========================================================
   Os addons de origem funcionam apenas como providers. O manifesto do
   PT•HUB não replica os nomes/organização declarados por esses addons.
   Assim, a interface no Stremio/Nuvio mantém sempre a mesma estrutura,
   mesmo que um provider altere os seus nomes de catálogo.
   ========================================================= */

const PT_HUB_AGGREGATE_CATALOGS = {
  ptptMovies: {
    type: "movie",
    id: "pthub-ptpt-movies",
    name: "🇵🇹 Filmes em PT-PT",
    group: "ptpt",
    kind: "movies"
  },
  ptptSeries: {
    type: "series",
    id: "pthub-ptpt-series",
    name: "🇵🇹 Séries em PT-PT",
    group: "ptpt",
    kind: "series"
  },
  portugueseMovies: {
    type: "movie",
    id: "pthub-portuguese-movies",
    name: "🇵🇹 Filmes Portugueses",
    group: "portuguese",
    kind: "movies"
  },
  portugueseSeries: {
    type: "series",
    id: "pthub-portuguese-series",
    name: "🇵🇹 Séries Portuguesas",
    group: "portuguese",
    kind: "series"
  },
  portugueseNovelas: {
    type: "series",
    id: "pthub-portuguese-novelas",
    name: "🇵🇹 Novelas Portuguesas",
    group: "portuguese",
    kind: "novelas"
  }
};

function getPtHubAggregateCatalogById(id, type) {
  return (
    Object.values(PT_HUB_AGGREGATE_CATALOGS).find(
      (catalog) => catalog.id === id && (!type || catalog.type === type)
    ) || null
  );
}

function getPtHubManifestCatalogs(config) {
  if (!config?.features?.ptContent) {
    return [];
  }

  const ptSources = config.features.ptContentSources || {};
  const result = [];
  const searchExtra = [{ name: "search", isRequired: false }];

  if (ptSources.ptPt === true && getPtSourceUrls(config, "ptpt").length) {
    result.push(
      {
        type: PT_HUB_AGGREGATE_CATALOGS.ptptMovies.type,
        id: PT_HUB_AGGREGATE_CATALOGS.ptptMovies.id,
        name: PT_HUB_AGGREGATE_CATALOGS.ptptMovies.name,
        extra: searchExtra
      },
      {
        type: PT_HUB_AGGREGATE_CATALOGS.ptptSeries.type,
        id: PT_HUB_AGGREGATE_CATALOGS.ptptSeries.id,
        name: PT_HUB_AGGREGATE_CATALOGS.ptptSeries.name,
        extra: searchExtra
      }
    );
  }

  if (
    ptSources.portugueseProduction === true &&
    getPtSourceUrls(config, "portuguese").length
  ) {
    result.push(
      {
        type: PT_HUB_AGGREGATE_CATALOGS.portugueseMovies.type,
        id: PT_HUB_AGGREGATE_CATALOGS.portugueseMovies.id,
        name: PT_HUB_AGGREGATE_CATALOGS.portugueseMovies.name,
        extra: searchExtra
      },
      {
        type: PT_HUB_AGGREGATE_CATALOGS.portugueseSeries.type,
        id: PT_HUB_AGGREGATE_CATALOGS.portugueseSeries.id,
        name: PT_HUB_AGGREGATE_CATALOGS.portugueseSeries.name,
        extra: searchExtra
      },
      {
        type: PT_HUB_AGGREGATE_CATALOGS.portugueseNovelas.type,
        id: PT_HUB_AGGREGATE_CATALOGS.portugueseNovelas.id,
        name: PT_HUB_AGGREGATE_CATALOGS.portugueseNovelas.name,
        extra: searchExtra
      }
    );
  }

  return result;
}

function isPtNovelaCatalog(catalog) {
  const text = normalizeSearchText(
    `${catalog?.id || ""} ${catalog?.name || ""}`
  );

  return /novela/.test(text);
}

function scorePtPrimaryCatalog(catalog) {
  const text = normalizeSearchText(
    `${catalog?.id || ""} ${catalog?.name || ""}`
  );

  let score = 0;

  if (/\b(todos?|all|principal|main|default|catalogo)\b/.test(text)) {
    score += 100;
  }

  if (/\b(recentes?|new|rating|avaliacao|antigos?|old|a-z|az)\b/.test(text)) {
    score -= 30;
  }

  return score;
}

function selectPtSourceCatalog(manifest, aggregateCatalog) {
  if (!manifest || !aggregateCatalog) {
    return null;
  }

  let candidates = (manifest.catalogs || []).filter(
    (catalog) =>
      catalog?.id &&
      catalog?.type === aggregateCatalog.type
  );

  if (aggregateCatalog.group === "portuguese" && aggregateCatalog.type === "series") {
    if (aggregateCatalog.kind === "novelas") {
      candidates = candidates.filter(isPtNovelaCatalog);
    } else {
      candidates = candidates.filter((catalog) => !isPtNovelaCatalog(catalog));
    }
  }

  if (!candidates.length) {
    return null;
  }

  return candidates
    .map((catalog, index) => ({
      catalog,
      index,
      score: scorePtPrimaryCatalog(catalog)
    }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))[0]
    .catalog;
}

function ptCatalogSupportsExtra(catalog, extraName) {
  return normalizeCatalogExtra(catalog).some(
    (extra) => extra?.name === extraName
  );
}

function getPtAggregateDedupKey(meta) {
  const parsed = parsePtMetaId(meta?.id);
  const originalId = parsed?.originalId || "";

  if (/^tt\d+$/i.test(originalId)) {
    return `imdb:${originalId.toLowerCase()}`;
  }

  const imdbId =
    meta?.imdb_id ||
    meta?.imdbId ||
    meta?.externalIds?.imdbId;

  if (imdbId) {
    return `imdb:${String(imdbId).toLowerCase()}`;
  }

  const title = normalizeSearchText(meta?.name || meta?.title || "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();

  const year = String(
    meta?.year ||
    meta?.releaseInfo ||
    meta?.released ||
    ""
  ).match(/\b(19|20)\d{2}\b/)?.[0] || "";

  return title
    ? `title:${title}:${year}`
    : `id:${String(meta?.id || "")}`;
}

async function fetchPtAggregateSourceCatalog(
  baseUrl,
  aggregateCatalog,
  extra
) {
  const manifest = await getPtSourceManifest(baseUrl);

  if (!manifest || !sourceSupportsResource(manifest, "catalog")) {
    return [];
  }

  const sourceCatalog =
    selectPtSourceCatalog(manifest, aggregateCatalog);

  if (!sourceCatalog) {
    return [];
  }

  const sourceExtra = {};
  const requestedSearch = String(extra?.search || "").trim();

  if (requestedSearch && ptCatalogSupportsExtra(sourceCatalog, "search")) {
    sourceExtra.search = requestedSearch;
  }

  const extraPath = buildExternalCatalogExtraPath(sourceExtra);
  const url =
    `${baseUrl}/catalog/${encodeURIComponent(aggregateCatalog.type)}/` +
    `${encodeURIComponent(sourceCatalog.id)}${extraPath}.json`;

  try {
    const data = await fetchJsonWithTimeout(
      url,
      PT_SOURCE_CATALOG_TIMEOUT_MS
    );

    let metas = Array.isArray(data?.metas) ? data.metas : [];

    if (requestedSearch && !ptCatalogSupportsExtra(sourceCatalog, "search")) {
      metas = filterMetasBySearch(metas, requestedSearch);
    }

    return metas
      .map((meta) =>
        normalizeExternalMeta(
          meta,
          aggregateCatalog.group,
          baseUrl,
          aggregateCatalog.type
        )
      )
      .filter(Boolean);
  } catch (error) {
    console.error(
      `Erro no catálogo agregado PT•HUB ${aggregateCatalog.id} via ${baseUrl}:`,
      error.message
    );

    return [];
  }
}

async function getPtHubAggregateCatalog(config, type, catalogId, extra = {}) {
  const aggregateCatalog =
    getPtHubAggregateCatalogById(catalogId, type);

  if (!aggregateCatalog) {
    return null;
  }

  if (!config?.features?.ptContent) {
    return { metas: [] };
  }

  const ptSources = config.features.ptContentSources || {};

  if (
    aggregateCatalog.group === "ptpt" &&
    ptSources.ptPt !== true
  ) {
    return { metas: [] };
  }

  if (
    aggregateCatalog.group === "portuguese" &&
    ptSources.portugueseProduction !== true
  ) {
    return { metas: [] };
  }

  const sourceUrls =
    getPtSourceUrls(config, aggregateCatalog.group);

  if (!sourceUrls.length) {
    return { metas: [] };
  }

  const results = await Promise.all(
    sourceUrls.map((baseUrl) =>
      fetchPtAggregateSourceCatalog(
        baseUrl,
        aggregateCatalog,
        extra
      )
    )
  );

  const metas = [];
  const seen = new Set();

  for (const sourceMetas of results) {
    for (const meta of sourceMetas) {
      const dedupKey = getPtAggregateDedupKey(meta);

      if (seen.has(dedupKey)) {
        continue;
      }

      seen.add(dedupKey);
      metas.push(meta);
    }
  }

  const skip = Math.max(0, Number.parseInt(extra?.skip, 10) || 0);
  return {
    metas: metas.slice(skip, skip + 100)
  };
}

async function getPtExternalManifestCatalogs(config) {
  const ptSources = config?.features?.ptContentSources || {};

  function groupEnabled(group) {
    if (group === "ptpt") {
      return config?.features?.ptContent === true && ptSources.ptPt === true;
    }

    if (group === "portuguese") {
      return config?.features?.ptContent === true &&
        ptSources.portugueseProduction === true;
    }

    if (group === "adult") {
      return config?.features?.adultContent === true;
    }

    return false;
  }

  const jobs = [];

  for (const group of Object.keys(PT_SOURCE_GROUPS)) {
    if (!groupEnabled(group)) {
      continue;
    }

    for (const baseUrl of getPtSourceUrls(config, group)) {
      jobs.push(
        getPtSourceManifest(baseUrl)
          .then((manifest) => ({
            group,
            baseUrl,
            manifest
          }))
      );
    }
  }

  const sources = await Promise.all(jobs);
  const result = [];

  for (const source of sources) {
    const { group, baseUrl, manifest } = source;

    if (!manifest || !sourceSupportsResource(manifest, "catalog")) {
      continue;
    }

    for (const catalog of manifest.catalogs || []) {
      if (!["movie", "series"].includes(catalog?.type)) {
        continue;
      }

      if (!catalog?.id) {
        continue;
      }

      result.push({
        type: catalog.type,
        id: makePtCatalogId(group, baseUrl, catalog.id),
        name: getPtCatalogDisplayName(
          group,
          manifest.name,
          catalog.name,
          catalog.id,
          catalog.type
        ),
        extra: normalizeCatalogExtra(catalog)
      });
    }
  }

  return result;
}

function buildExternalCatalogExtraPath(extraObject) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(extraObject || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    params.set(key, String(value));
  }

  const value = params.toString();
  return value ? `/${value}` : "";
}

function normalizeExternalMeta(meta, group, baseUrl, fallbackType) {
  if (!meta || typeof meta !== "object" || !meta.id) {
    return null;
  }

  const originalId = String(meta.id);

  const normalized = {
    ...meta,
    id: makePtMetaId(group, baseUrl, originalId),
    type: meta.type || fallbackType,
    name: meta.name || meta.title || "Título",
    poster: meta.poster || meta.logo || PT_HUB_LOGO,
    background: meta.background || meta.poster || PT_HUB_BACKGROUND
  };

  if (Array.isArray(meta.videos)) {
    normalized.videos =
      meta.videos.map((video) => {
        if (!video || !video.id) {
          return video;
        }

        return {
          ...video,
          id: makePtMetaId(
            group,
            baseUrl,
            String(video.id)
          )
        };
      });
  }

  return normalized;
}

async function getPtExternalCatalog(config, type, catalogId, extra) {
  const parsed = parsePtCatalogId(catalogId);

  if (!parsed) {
    return null;
  }

  const baseUrl =
    findPtSourceUrl(
      config,
      parsed.group,
      parsed.sourceHash
    );

  if (!baseUrl) {
    return { metas: [] };
  }

  const manifest = await getPtSourceManifest(baseUrl);

  if (!manifest || !sourceSupportsResource(manifest, "catalog")) {
    return { metas: [] };
  }

  const declaredCatalog =
    (manifest.catalogs || []).find(
      (catalog) =>
        catalog?.id === parsed.originalCatalogId &&
        catalog?.type === type
    );

  if (!declaredCatalog) {
    return { metas: [] };
  }

  const extraPath =
    buildExternalCatalogExtraPath(extra);

  const url =
    `${baseUrl}/catalog/${encodeURIComponent(type)}/` +
    `${encodeURIComponent(parsed.originalCatalogId)}` +
    `${extraPath}.json`;

  try {
    const data =
      await fetchJsonWithTimeout(
        url,
        PT_SOURCE_CATALOG_TIMEOUT_MS
      );

    const metas =
      Array.isArray(data?.metas)
        ? data.metas
        : [];

    return {
      metas: metas
        .map((meta) =>
          normalizeExternalMeta(
            meta,
            parsed.group,
            baseUrl,
            type
          )
        )
        .filter(Boolean)
    };
  } catch (error) {
    console.error(
      `Erro no catálogo PT externo ${baseUrl}:`,
      error.message
    );

    return { metas: [] };
  }
}

async function getPtExternalMeta(config, type, wrappedId) {
  const parsed = parsePtMetaId(wrappedId);

  if (!parsed) {
    return null;
  }

  const baseUrl =
    findPtSourceUrl(
      config,
      parsed.group,
      parsed.sourceHash
    );

  if (!baseUrl) {
    return { meta: null };
  }

  const manifest = await getPtSourceManifest(baseUrl);

  if (!manifest || !sourceSupportsResource(manifest, "meta")) {
    return { meta: null };
  }

  try {
    const data =
      await fetchJsonWithTimeout(
        `${baseUrl}/meta/${encodeURIComponent(type)}/${encodeURIComponent(parsed.originalId)}.json`,
        PT_SOURCE_META_TIMEOUT_MS
      );

    const sourceMeta = data?.meta;

    if (!sourceMeta) {
      return { meta: null };
    }

    let mergedMeta = { ...sourceMeta };

    const imdbId =
      sourceMeta.imdb_id ||
      sourceMeta.imdbId ||
      sourceMeta?.externalIds?.imdbId ||
      (/^tt\d+$/i.test(parsed.originalId)
        ? parsed.originalId
        : null);

    if (imdbId && ["movie", "series"].includes(type)) {
      try {
        const cinemeta =
          await getCinemetaMeta(type, imdbId);

        if (cinemeta?.meta) {
          mergedMeta = {
            ...cinemeta.meta,
            ...sourceMeta,
            id: sourceMeta.id || parsed.originalId,
            name:
              sourceMeta.name ||
              sourceMeta.title ||
              cinemeta.meta.name
          };
        }
      } catch (error) {
        console.error(
          `Fallback Cinemeta PT-PT falhou para ${imdbId}:`,
          error.message
        );
      }
    }

    const normalized =
      normalizeExternalMeta(
        mergedMeta,
        parsed.group,
        baseUrl,
        type
      );

    return normalized
      ? { meta: normalized }
      : { meta: null };
  } catch (error) {
    console.error(
      `Erro metadata PT externo ${baseUrl}:`,
      error.message
    );

    return { meta: null };
  }
}

async function getPtExternalStreams(config, type, wrappedId) {
  const parsed = parsePtMetaId(wrappedId);

  if (!parsed) {
    return null;
  }

  const baseUrl =
    findPtSourceUrl(
      config,
      parsed.group,
      parsed.sourceHash
    );

  if (!baseUrl) {
    return [];
  }

  const manifest = await getPtSourceManifest(baseUrl);

  if (!manifest || !sourceSupportsResource(manifest, "stream")) {
    return [];
  }

  const sourceName =
    String(manifest.name || "Fonte externa").trim();

  try {
    const data =
      await fetchJsonWithTimeout(
        `${baseUrl}/stream/${encodeURIComponent(type)}/${encodeURIComponent(parsed.originalId)}.json`,
        PT_SOURCE_STREAM_TIMEOUT_MS
      );

    const streams =
      Array.isArray(data?.streams)
        ? data.streams
        : [];

    const groupLabel =
      parsed.group === "ptpt"
        ? "PT-PT"
        : parsed.group === "adult"
          ? "Adultos"
          : "Produção Portuguesa";

    return streams.map((stream) => ({
      ...stream,
      name:
        `PT•HUB • ${groupLabel}` +
        (stream.name ? `\n${stream.name}` : ""),
      title:
        stream.title || `Fonte: ${sourceName}`
    }));
  } catch (error) {
    console.error(
      `Erro streams PT externos ${baseUrl}:`,
      error.message
    );

    return [];
  }
}

/* =========================================================
   RTP PLAY
   =========================================================
   Ainda sem integração de dados: a RTP não disponibiliza uma
   API pública documentada (só existem APIs não-oficiais de
   terceiros, feitas por engenharia reversa da app móvel, que
   optámos por não usar). Esta função existe para já a estrutura
   ficar pronta — assim que houver uma fonte pública confirmada
   (feed RSS, API oficial, etc.), implementa-se aqui.
   ========================================================= */

async function getRtpPlayChannels() {
  return [];
}

function getOperatorChannels(operator) {

  if (!operator) {
    return [];
  }

  if (Array.isArray(operator.channels)) {

    return operator.channels.map((channel, index) => ({
      id: `operator:${operator.id}:${channel.id || index}`,
      type: "channel",
      name: channel.name || operator.name,
      logo: channel.logo || operator.logo || findChannelLogo(channel.name || operator.name) || PT_HUB_LOGO,
      group: operator.name,
      tvgId: channel.tvgId || "",
      url: channel.url
    }));

  }

  return [];
}

/*
=========================================================
   CONFIGURE PAGE
   ========================================================= */

function renderConfigurePage(config = {}) {
  const initialConfigJson = JSON.stringify(config || {})
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  return "<!doctype html>\n<html lang=\"pt-PT\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>PT•HUB — Botões Outline</title>\n<style>\n:root{\n  --pt-bg:#01050B;\n  --pt-bg-secondary:#04111A;\n  --pt-bg-card:#071C29;\n  --pt-bg-tech:#062F46;\n  --pt-gold:#DA921C;\n  --pt-gold-light:#F2CA4F;\n  --pt-bronze:#A7610C;\n  --pt-green:#027C1C;\n  --pt-green-light:#13D06C;\n  --pt-red:#E51306;\n  --pt-red-dark:#970200;\n  --pt-text:#EEECCB;\n  --pt-white:#FFFFFF;\n\n  --bg:var(--pt-bg);\n  --bg2:var(--pt-bg-secondary);\n  --card:rgba(7,28,41,.88);\n  --card2:rgba(6,47,70,.72);\n  --line:rgba(218,146,28,.23);\n  --gold:var(--pt-gold);\n  --gold2:var(--pt-gold-light);\n  --text:var(--pt-text);\n  --muted:#91A2B8;\n  --white:var(--pt-white);\n}\n*{box-sizing:border-box}\nbody{\n  margin:0;\n  background:\n    radial-gradient(circle at 50% 0%,rgba(11,53,77,.35),transparent 34%),\n    linear-gradient(180deg,#05090f,#03070c);\n  color:var(--text);\n  font-family:Inter,Segoe UI,Arial,sans-serif;\n}\n.header{padding:34px 20px 22px;display:flex;justify-content:center}\n.logo{\n  width:170px;height:82px;border-radius:20px;\n  display:grid;place-items:center;\n  background:linear-gradient(145deg,#071824,#0a2130);\n  border:1px solid rgba(216,146,24,.38);\n  box-shadow:0 16px 45px rgba(0,0,0,.38);\n  font-size:30px;font-weight:900;letter-spacing:1px\n}\n.logo span{color:var(--gold2)}\n.logo img{max-width:150px;max-height:70px;width:auto;height:auto;object-fit:contain;display:block}\n.wrap{\n  max-width:1180px;margin:0 auto;padding:0 18px 60px;\n  display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:22px\n}\n.card{\n  background:linear-gradient(180deg,rgba(11,20,34,.98),rgba(8,16,28,.98));\n  border:1px solid #1e2c40;border-radius:18px;\n  box-shadow:0 18px 55px rgba(0,0,0,.32)\n}\n.main{padding:22px}\n.about{padding:22px;align-self:start;position:sticky;top:22px}\n.kicker{font-size:9px;text-transform:uppercase;letter-spacing:1.4px;color:#6981a2;margin-bottom:16px}\n.tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid #1d2a3d;margin-bottom:19px}\n.tab{padding:10px 12px;font-size:12px;color:#7ea1c6;border-radius:5px 5px 0 0;cursor:pointer;user-select:none}\n.tab.active{color:#fff;border:1px solid #fff;border-bottom-color:transparent;background:#0e1725;margin-bottom:-1px}\n.tab.hidden{display:none}\n.panel{display:none}.panel.active{display:block}\n.sectionTitle{\n  font-size:9px;text-transform:uppercase;letter-spacing:1.5px;\n  color:var(--gold2);font-weight:800;margin-bottom:11px\n}\n.help{\n  border:1px solid rgba(216,146,24,.35);\n  background:rgba(216,146,24,.07);\n  color:#e5c875;padding:11px 12px;border-radius:7px;\n  font-size:11px;line-height:1.5;margin-bottom:14px\n}\n.choiceGrid{\n  display:grid;\n  grid-template-columns:repeat(auto-fit,minmax(170px,1fr));\n  gap:10px\n}\n.choice{\n  min-height:64px;\n  display:flex;\n  flex-direction:column;\n  justify-content:center;\n  align-items:flex-start;\n  gap:3px;\n  padding:10px 12px;\n  border-radius:10px;\n  border:2px solid rgba(255,255,255,.85);\n  background:#08111c;\n  color:#fff;\n  cursor:pointer;\n  transition:.15s ease;\n  box-shadow:0 6px 16px rgba(0,0,0,.12)\n}\n.choice:hover{\n  transform:translateY(-1px);\n  border-color:#fff;\n  background:#0a1522\n}\n.choice .title{\n  font-size:12px;\n  font-weight:800;\n  letter-spacing:.1px;\n  color:#fff\n}\n.choice .sub{\n  font-size:10px;\n  color:#6f93bd\n}\n.choice.active{\n  border-color:var(--gold2);\n  background:rgba(216,146,24,.16);\n  box-shadow:0 0 0 1px rgba(216,146,24,.18),0 8px 20px rgba(216,146,24,.10)\n}\n.choice.active .title{color:var(--gold2)}\n.choice.active .sub{color:#d6a84d}\n\nlabel.field{display:block;color:#86a6c7;font-size:11px;margin:13px 0 6px}\nselect,input[type=text],input[type=url],input[type=password],textarea{\n  width:100%;background:#07101a;border:1px solid #1d2a3e;\n  border-radius:7px;color:#d9e4ef;padding:10px 11px;outline:none\n}\nselect:focus,input:focus,textarea:focus{border-color:var(--gold)}\n.iptvTabs{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px}\n.iptvTab{\n  min-width:130px;min-height:52px;\n  border:2px solid rgba(255,255,255,.85);\n  border-radius:10px;background:#08111c;color:#fff;\n  display:flex;flex-direction:column;justify-content:center;\n  align-items:flex-start;padding:8px 10px;cursor:pointer\n}\n.iptvTab .t{font-size:11px;font-weight:800}\n.iptvTab .s{font-size:9px;color:#6f93bd;margin-top:2px}\n.iptvTab.active{\n  border-color:var(--gold2);\n  background:rgba(216,146,24,.16)\n}\n.iptvTab.active .t{color:var(--gold2)}\n.iptvTab.active .s{color:#d6a84d}\n.iptvPane{display:none}.iptvPane.active{display:block}\n.columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}\n.actions{\n  display:flex;gap:9px;flex-wrap:wrap;\n  margin-top:22px;padding-top:18px;border-top:1px solid #182539\n}\n.btn{\n  border-radius:8px;padding:11px 15px;\n  font-size:11px;font-weight:800;cursor:pointer\n}\n.btn.primary{\n  border:1px solid var(--gold2);\n  background:linear-gradient(135deg,var(--gold2),var(--gold));\n  color:#08111a\n}\n.btn.secondary{\n  border:1px solid #fff;\n  background:#08111c;\n  color:#fff\n}\n.btn.hidden{display:none}\n.about h3{\n  margin:0 0 14px;color:#6d85a5;font-size:9px;\n  letter-spacing:1.4px;text-transform:uppercase\n}\n.about p{\n  color:#89a5c4;font-size:11px;line-height:1.55\n}\n.about strong{color:#d9e7f6}\n.about .arrow{color:var(--gold2);font-weight:900}\n.about .box{\n  margin-top:14px;padding:12px;\n  border:1px solid rgba(216,146,24,.28);\n  background:rgba(216,146,24,.06);\n  border-radius:8px\n}\n.brandline{color:var(--gold2);font-weight:800}\n\n.freeBadge{\n  display:inline-block;\n  margin-left:5px;\n  padding:2px 5px;\n  border-radius:999px;\n  background:rgba(216,146,24,.18);\n  color:var(--gold2);\n  border:1px solid var(--gold);\n  font-size:8px;\n  font-weight:900;\n  line-height:1;\n  vertical-align:1px;\n}\n.switchRow{\n  display:flex;\n  align-items:center;\n  gap:9px;\n  margin:12px 0;\n  font-size:12px;\n  color:#dce7f3;\n}\n.switchRow input{\n  accent-color:var(--gold);\n  width:15px;\n  height:15px;\n}\n.conditional{\n  display:none;\n  margin-top:10px;\n  padding-top:10px;\n  border-top:1px solid #182539;\n}\n.conditional.show{display:block}\n.radioRow{\n  display:flex;\n  flex-direction:column;\n  gap:9px;\n  margin-top:9px;\n}\n.radioOpt{\n  display:flex;\n  align-items:center;\n  gap:8px;\n  font-size:11px;\n  color:#d7e2ef;\n}\n.radioOpt input{accent-color:var(--gold)}\n\n\n.choice{\n  position:relative;\n  padding-left:54px;\n}\n.choiceLogo{\n  position:absolute;\n  left:12px;\n  top:50%;\n  transform:translateY(-50%);\n  width:30px;\n  height:30px;\n  display:grid;\n  place-items:center;\n  border-radius:7px;\n  overflow:hidden;\n  flex:0 0 auto;\n}\n.choiceLogo img{\n  max-width:34px;\n  max-height:34px;\n  object-fit:contain;\n  display:block;\n}\n.choiceLogo svg{\n  width:27px;\n  height:27px;\n}\n.choiceLogo.textLogo{\n  font-weight:900;\n  font-size:10px;\n  letter-spacing:.2px;\n  color:var(--text);\n}\n.choice.active .choiceLogo.textLogo{\n  color:var(--gold2);\n}\n.logoPortuguese{\n  background:linear-gradient(135deg,#075229 0 48%,#8a1519 48% 100%);\n  border:1px solid rgba(240,194,76,.35);\n}\n.logoPtpt{\n  background:#0d1827;\n  border:1px solid rgba(240,194,76,.35);\n  color:var(--gold2)!important;\n}\n.logoAdult{\n  border:2px solid #fff;\n  border-radius:50%;\n  width:28px;\n  height:28px;\n}\n.logoAdult:after{\n  content:\"\";\n  width:26px;\n  height:3px;\n  background:#fff;\n  transform:rotate(-45deg);\n  border-radius:2px;\n}\n.choice.active .logoAdult{\n  border-color:var(--gold2);\n}\n.choice.active .logoAdult:after{\n  background:var(--gold2);\n}\n.logoIptv{\n  background:#091823;\n  border:1px solid rgba(240,194,76,.35);\n  color:var(--gold2)!important;\n  font-size:8px!important;\n}\n.logoOperators{\n  display:grid;\n  grid-template-columns:1fr 1fr;\n  gap:2px;\n  background:#fff;\n  padding:2px;\n}\n.logoOperators span{\n  display:grid;\n  place-items:center;\n  font-size:5px;\n  font-weight:900;\n  color:#111;\n  line-height:1;\n}\n\n\n.statusBox{\n  display:none;\n  margin-top:14px;\n  padding:11px 12px;\n  border-radius:8px;\n  font-size:11px;\n  line-height:1.5;\n}\n.statusBox.show{display:block}\n.statusBox.error{\n  border:1px solid rgba(212,76,76,.45);\n  background:rgba(212,76,76,.08);\n  color:#ff9a9a;\n}\n.statusBox.ok{\n  border:1px solid rgba(216,146,24,.45);\n  background:rgba(216,146,24,.08);\n  color:#f0c24c;\n}\n\n\nhtml {\n  min-height:100%;\n  background:#01050B;\n}\n\nbody {\n  min-height:100vh;\n  background:\n    linear-gradient(180deg, rgba(1,5,11,.42) 0%, rgba(1,5,11,.62) 45%, rgba(1,5,11,.78) 100%),\n    radial-gradient(circle at 50% 8%, rgba(218,146,28,.10), transparent 38%),\n    url(\"__PT_HUB_BACKGROUND__\") center top / cover fixed no-repeat;\n  color:var(--pt-text);\n}\n\nbody::before {\n  content:\"\";\n  position:fixed;\n  inset:0;\n  pointer-events:none;\n  z-index:-1;\n  background:\n    linear-gradient(90deg, rgba(1,5,11,.18), rgba(4,17,26,.08), rgba(1,5,11,.18));\n}\n\n.card {\n  background:\n    linear-gradient(180deg, rgba(7,28,41,.92), rgba(4,17,26,.88));\n  border-color:rgba(218,146,28,.34);\n  box-shadow:\n    0 18px 45px rgba(0,0,0,.34),\n    inset 0 1px 0 rgba(242,202,79,.04);\n  backdrop-filter:blur(12px);\n  -webkit-backdrop-filter:blur(12px);\n}\n\n.choice,\n.providerBox,\n.configBox,\n.iptvPane,\n.panel .box {\n  background:rgba(4,17,26,.68);\n  border-color:rgba(218,146,28,.22);\n  backdrop-filter:blur(7px);\n  -webkit-backdrop-filter:blur(7px);\n}\n\n.choice:hover,\n.iptvTab:hover {\n  background:rgba(6,47,70,.72);\n}\n\n.choice.active,\n.iptvTab.active {\n  background:rgba(218,146,28,.17);\n  border-color:var(--pt-gold);\n  box-shadow:inset 0 0 0 1px rgba(242,202,79,.10);\n}\n\ninput,\nselect,\ntextarea {\n  background:rgba(1,5,11,.68)!important;\n  border-color:rgba(145,162,184,.22)!important;\n  color:var(--pt-text)!important;\n}\n\ninput:focus,\nselect:focus,\ntextarea:focus {\n  border-color:var(--pt-gold)!important;\n  box-shadow:0 0 0 2px rgba(218,146,28,.12);\n}\n\n.tabs {\n  background:rgba(4,17,26,.50);\n  backdrop-filter:blur(9px);\n  -webkit-backdrop-filter:blur(9px);\n}\n\n.freeBadge {\n  background:rgba(218,146,28,.18)!important;\n  color:var(--pt-gold-light)!important;\n  border:1px solid var(--pt-gold)!important;\n}\n\n.btn.primary {\n  background:linear-gradient(135deg,var(--pt-gold),var(--pt-bronze));\n  color:#071019;\n  border-color:var(--pt-gold-light);\n}\n\n.btn.secondary {\n  background:rgba(4,17,26,.76);\n  border-color:var(--pt-gold);\n  color:var(--pt-gold-light);\n}\n\n@media(max-width:930px){.wrap{grid-template-columns:1fr}.about{position:static}}\n@media(max-width:640px){.columns{grid-template-columns:1fr}.main,.about{padding:17px}}\n</style>\n</head>\n<body>\n\n<div class=\"header\">\n  <div class=\"logo\"><img src=\"__PT_HUB_LOGO__\" alt=\"PT•HUB\"></div>\n</div>\n\n<div class=\"wrap\">\n  <main class=\"card main\">\n    <div class=\"kicker\">Configuração</div>\n\n    <div class=\"tabs\">\n      <div class=\"tab active\" data-panel=\"conteudo\">Conteúdo</div>\n      <div class=\"tab hidden\" data-panel=\"destaques\" data-feature=\"destaques\">Destaques</div>\n      <div class=\"tab hidden\" data-panel=\"streamers\" data-feature=\"streamers\">Streamers</div>\n      <div class=\"tab hidden\" data-panel=\"portugues\" data-feature=\"portugues\">Português</div>\n      <div class=\"tab hidden\" data-panel=\"adultos\" data-feature=\"adultos\">Adultos</div>\n      <div class=\"tab hidden\" data-panel=\"iptv\" data-feature=\"iptv\">IPTV</div>\n      <div class=\"tab hidden\" data-panel=\"operadores\" data-feature=\"operadores\">Operadores PT</div>\n      <div class=\"tab hidden\" data-panel=\"externas\" data-feature=\"externas\">Fontes Externas</div>\n    </div>\n\n    <section class=\"panel active\" id=\"conteudo\">\n      <div class=\"sectionTitle\">Conteúdo</div>\n      <div class=\"help\">◉ Deves selecionar pelo menos um conteúdo a instalar. Cada conteúdo selecionado cria uma aba própria para configuração.</div>\n\n      <div class=\"choiceGrid\">\n        <button class=\"choice\" data-feature-toggle=\"destaques\">\n          <span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/destaques-poster.png\" alt=\"Destaques\"></span>\n          <span class=\"title\">Destaques</span><span class=\"sub\">Estreias • Novidades • Populares</span>\n        </button>\n        <button class=\"choice\" data-feature-toggle=\"streamers\">\n          <span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/streamers-logo.png\" alt=\"Streamers\"></span>\n          <span class=\"title\">Streamers</span><span class=\"sub\">Netflix • HBO Max • Prime • Disney+</span>\n        </button>\n        <button class=\"choice\" data-feature-toggle=\"portugues\">\n          <span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/conteudoportugues-poster.png\" alt=\"Conteúdo Português\"></span>\n          <span class=\"title\">Português</span><span class=\"sub\">Produções nacionais • PT-PT</span>\n        </button>\n        <button class=\"choice\" data-feature-toggle=\"adultos\">\n          <span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/adultos-poster.png\" alt=\"Adultos\"></span>\n          <span class=\"title\">Adultos</span><span class=\"sub\">Conteúdo +18</span>\n        </button>\n        <button class=\"choice\" data-feature-toggle=\"iptv\">\n          <span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/iptv-poster.png\" alt=\"IPTV\"></span>\n          <span class=\"title\">IPTV</span><span class=\"sub\">M3U • Xtream • IPTV-org</span>\n        </button>\n        <button class=\"choice\" data-feature-toggle=\"operadores\">\n          <span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/operators-logo.png\" alt=\"Operadores PT\"></span>\n          <span class=\"title\">Operadores PT</span><span class=\"sub\">MEO • NOS • Vodafone • DIGI</span>\n        </button>\n        <button class=\"choice\" data-feature-toggle=\"externas\">\n          <span class=\"choiceLogo textLogo\">↗</span>\n          <span class=\"title\">Fontes Externas</span><span class=\"sub\">Addons compatíveis</span>\n        </button>\n      </div>\n    </section>\n\n    <section class=\"panel\" id=\"destaques\">\n      <div class=\"sectionTitle\">Destaques</div>\n      <div class=\"choiceGrid\">\n        <button class=\"choice\" data-config-choice=\"destaques-filmes\"><span class=\"choiceLogo textLogo\">🎬</span><span class=\"title\">Filmes</span><span class=\"sub\">Estreias • Novos • Populares</span></button>\n        <button class=\"choice\" data-config-choice=\"destaques-series\"><span class=\"choiceLogo textLogo\">📺</span><span class=\"title\">Séries</span><span class=\"sub\">Novas • Populares • Destaques</span></button>\n      </div>\n    </section>\n\n    <section class=\"panel\" id=\"streamers\">\n      <div class=\"sectionTitle\">Streamers</div>\n      <div class=\"help\">◉ Seleciona os serviços a incluir. Rebordo branco = não selecionado. Rebordo dourado = selecionado.</div>\n\n      <div class=\"choiceGrid\">\n        <button class=\"choice\" data-streamer=\"netflix\"><span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/netflix-poster.png\" alt=\"\"></span><span class=\"title\">Netflix</span><span class=\"sub\">Filmes e Séries</span></button>\n        <button class=\"choice\" data-streamer=\"hbomax\"><span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/hbomax-poster.png\" alt=\"\"></span><span class=\"title\">HBO Max</span><span class=\"sub\">Filmes e Séries</span></button>\n        <button class=\"choice\" data-streamer=\"prime\"><span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/primevideo-poster.png\" alt=\"\"></span><span class=\"title\">Prime Video</span><span class=\"sub\">Filmes e Séries</span></button>\n        <button class=\"choice\" data-streamer=\"disney\"><span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/disneyplus-poster.png\" alt=\"\"></span><span class=\"title\">Disney+</span><span class=\"sub\">Filmes e Séries</span></button>\n        <button class=\"choice\" data-streamer=\"apple\"><span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/appletv-poster.png\" alt=\"\"></span><span class=\"title\">Apple TV</span><span class=\"sub\">Filmes e Séries</span></button>\n      </div>\n\n      <label class=\"field\">País do catálogo</label>\n      <select id=\"catalogCountryPreview\">\n        <option value=\"\" selected>Selecionar país…</option>\n        <option value=\"PT\">Portugal (PT)</option>\n        <option value=\"ES\">Espanha (ES)</option>\n        <option value=\"FR\">França (FR)</option>\n        <option value=\"GB\">Reino Unido (GB)</option>\n        <option value=\"US\">Estados Unidos (US)</option>\n        <option value=\"BR\">Brasil (BR)</option>\n      </select>\n    </section>\n\n    <section class=\"panel\" id=\"portugues\">\n      <div class=\"sectionTitle\">Português</div>\n      <div class=\"choiceGrid\">\n        <button class=\"choice\" data-config-choice=\"ptpt\"><span class=\"choiceLogo textLogo logoPtpt\">PT•PT</span><span class=\"title\">PT-PT</span><span class=\"sub\">Conteúdo falado/dobrado em PT-PT</span></button>\n        <button class=\"choice\" data-config-choice=\"producao-portuguesa\"><span class=\"choiceLogo logoPortuguese\">\n<svg viewBox=\"0 0 100 100\" aria-hidden=\"true\"><path d=\"M50 84C29 68 17 51 20 35c3-15 20-20 30-7 10-13 27-8 30 7 3 16-9 33-30 49Z\" fill=\"none\" stroke=\"#f0c24c\" stroke-width=\"6\"/><path d=\"M47 40l19 11-19 11Z\" fill=\"#f0c24c\"/></svg>\n</span><span class=\"title\">Produções Portuguesas</span><span class=\"sub\">Filmes • Séries • Novelas</span></button>\n      </div>\n    </section>\n\n    <section class=\"panel\" id=\"adultos\">\n      <div class=\"sectionTitle\">Adultos</div>\n      <div class=\"choiceGrid\">\n        <button class=\"choice\" id=\"adultAutoPreview\"><span class=\"title\">Ativar fontes automáticas</span><span class=\"sub\">Fontes +18 predefinidas</span></button>\n      </div>\n    </section>\n\n    <section class=\"panel\" id=\"iptv\">\n      <div class=\"sectionTitle\">IPTV</div>\n      <div class=\"help\">\n        ◉ Seleciona a fonte IPTV que queres utilizar. A configuração apresentada muda automaticamente de acordo com a fonte escolhida.\n      </div>\n\n      <div class=\"iptvTabs\">\n        <div class=\"iptvTab active\" data-iptv=\"org\" data-iptv-method=\"org\">\n          <span class=\"t\">IPTV-org <span class=\"freeBadge\">FREE</span></span>\n          <span class=\"s\">Canais públicos</span>\n        </div>\n        <div class=\"iptvTab\" data-iptv=\"xtream\" data-iptv-method=\"xtream\">\n          <span class=\"t\">Xtream API</span>\n          <span class=\"s\">Painel / API</span>\n        </div>\n        <div class=\"iptvTab\" data-iptv=\"m3u\" data-iptv-method=\"m3u\">\n          <span class=\"t\">M3U / M3U+</span>\n          <span class=\"s\">Playlist URL / ficheiro</span>\n        </div>\n      </div>\n\n      <!-- IPTV-ORG -->\n      <div class=\"iptvPane active\" id=\"iptv-org\">\n        <div class=\"providerBox\">\n          <div class=\"providerHead\">\n            <strong>Filtro de canais</strong>\n            <span>IPTV-org</span>\n          </div>\n\n          <p class=\"hint\" style=\"margin:0 0 12px\">\n            Utiliza a base de dados IPTV-org com milhares de canais gratuitos de todo o mundo. Não são necessárias credenciais.\n          </p>\n\n          <label class=\"field\">País</label>\n          <input id=\"iptvOrgCountryPreview\" type=\"text\" placeholder=\"Ex.: PT\">\n          <div class=\"hint\" style=\"margin-top:6px\">Deixa em branco para incluir todos os países.</div>\n\n          <label class=\"field\">Categoria</label>\n          <input id=\"iptvOrgCategoryPreview\" type=\"text\" placeholder=\"Ex.: news, sports, movies\">\n          <div class=\"hint\" style=\"margin-top:6px\">Deixa em branco para incluir todas as categorias.</div>\n\n          <label class=\"field\">Nome do catálogo</label>\n          <input id=\"iptvOrgCatalogPreview\" type=\"text\" placeholder=\"IPTV-org Free\">\n          <div class=\"hint\" style=\"margin-top:6px\">Deixa em branco para utilizar o nome predefinido.</div>\n        </div>\n      </div>\n\n      <!-- XTREAM -->\n      <div class=\"iptvPane\" id=\"iptv-xtream\">\n        <div class=\"providerBox\">\n          <div class=\"providerHead\">\n            <strong>Credenciais</strong>\n            <span>Xtream API</span>\n          </div>\n\n          <label class=\"field\">URL base *</label>\n          <input id=\"xtreamServerPreview\" type=\"url\" placeholder=\"https://servidor.com:8080\">\n          <div class=\"hint\" style=\"margin-top:6px\">Não incluir uma barra final.</div>\n\n          <div class=\"columns\">\n            <div>\n              <label class=\"field\">Utilizador *</label>\n              <input id=\"xtreamUserPreview\" type=\"text\" placeholder=\"Utilizador\">\n            </div>\n            <div>\n              <label class=\"field\">Palavra-passe *</label>\n              <input id=\"xtreamPassPreview\" type=\"password\" placeholder=\"Palavra-passe\">\n            </div>\n          </div>\n        </div>\n\n        <div class=\"providerBox\">\n          <div class=\"providerHead\">\n            <strong>Mostrar</strong>\n            <span>Conteúdo Xtream</span>\n          </div>\n          <div class=\"choiceGrid\">\n            <button class=\"choice\" id=\"xtreamLivePreview\">\n              <span class=\"title\">TV em Direto</span>\n              <span class=\"sub\">Canais Live TV</span>\n            </button>\n          </div>\n        </div>\n\n        <div class=\"providerBox\">\n          <div class=\"providerHead\">\n            <strong>Opções EPG</strong>\n            <span>Guia de programação</span>\n          </div>\n\n          <label class=\"switchRow\">\n            <input type=\"checkbox\" id=\"xtreamEpgEnabledPreview\">\n            <strong>Ativar EPG</strong>\n          </label>\n\n          <div id=\"xtreamEpgOptionsPreview\" class=\"conditional\">\n            <label class=\"field\">Origem do EPG</label>\n\n            <div class=\"radioRow\">\n              <label class=\"radioOpt\">\n                <input type=\"radio\" name=\"xtreamEpgSourcePreview\" value=\"panel\">\n                <span>XMLTV do painel / provider</span>\n              </label>\n              <label class=\"radioOpt\">\n                <input type=\"radio\" name=\"xtreamEpgSourcePreview\" value=\"url\">\n                <span>URL EPG personalizada</span>\n              </label>\n            </div>\n\n            <div id=\"xtreamCustomEpgUrlPreview\" style=\"display:none\">\n              <label class=\"field\">URL do EPG</label>\n              <input id=\"xtreamEpgUrlFieldPreview\" type=\"url\" placeholder=\"https://exemplo.com/epg.xml\">\n            </div>\n\n            <label class=\"switchRow\" style=\"margin-top:14px\">\n              <input type=\"checkbox\">\n              <span><strong>Reformatar logos</strong> <span class=\"hint\">(pode tornar o carregamento mais lento)</span></span>\n            </label>\n\n            <div class=\"hint\" style=\"margin-top:8px\">\n              O desvio horário do EPG será tratado automaticamente pelo PT•HUB através de uma definição genérica.\n            </div>\n          </div>\n        </div>\n\n        <div class=\"providerBox\">\n          <div class=\"providerHead\">\n            <strong>Apresentação</strong>\n            <span>Stremio / Nuvio</span>\n          </div>\n          <label class=\"field\">Nome do catálogo</label>\n          <input id=\"xtreamCatalogPreview\" type=\"text\" placeholder=\"Xtream API\">\n          <div class=\"hint\" style=\"margin-top:6px\">Deixa em branco para utilizar o nome predefinido.</div>\n        </div>\n      </div>\n\n      <!-- M3U / M3U+ -->\n      <div class=\"iptvPane\" id=\"iptv-m3u\">\n        <div class=\"providerBox\">\n          <div class=\"providerHead\">\n            <strong>Playlist</strong>\n            <span>M3U / M3U+</span>\n          </div>\n\n          <p class=\"hint\" style=\"margin:0 0 12px\">\n            Aceita playlists M3U/M3U+ normais e links Xtream Codes com <code>type=m3u_plus</code>. O URL de cada canal é extraído individualmente.\n          </p>\n\n          <div class=\"choiceGrid\" style=\"grid-template-columns:repeat(2,minmax(160px,1fr))\">\n            <button class=\"choice m3uSourcePreview\" data-source=\"url\">\n              <span class=\"title\">Playlist por URL</span>\n              <span class=\"sub\">M3U / M3U+</span>\n            </button>\n            <button class=\"choice m3uSourcePreview\" data-source=\"file\">\n              <span class=\"title\">Ficheiro M3U / M3U8</span>\n              <span class=\"sub\">Upload local</span>\n            </button>\n          </div>\n\n          <div id=\"m3uUrlPreview\">\n            <label class=\"field\">URL da playlist *</label>\n            <input id=\"m3uUrlFieldPreview\" type=\"url\" placeholder=\"https://exemplo.com/lista.m3u\">\n          </div>\n\n          <div id=\"m3uFilePreview\" style=\"display:none\">\n            <label class=\"field\">Ficheiro M3U / M3U8 *</label>\n            <input id=\"m3uFileFieldPreview\" type=\"file\" accept=\".m3u,.m3u8,audio/x-mpegurl,application/x-mpegURL\">\n            <div class=\"hint\" style=\"margin-top:6px\">Seleciona um ficheiro M3U ou M3U8 do teu computador.</div>\n          </div>\n        </div>\n\n        <div class=\"providerBox\">\n          <div class=\"providerHead\">\n            <strong>Playlists públicas</strong>\n            <span>Links de terceiros</span>\n          </div>\n          <p class=\"hint\" style=\"margin:0 0 10px\">Links públicos não afiliados nem endossados pelo PT•HUB.</p>\n\n          <div class=\"choiceGrid\" style=\"grid-template-columns:repeat(auto-fit,minmax(135px,1fr))\">\n            <button class=\"choice\"><span class=\"title\">CANAIS BR 1</span><span class=\"sub\">Public Link</span></button>\n            <button class=\"choice\"><span class=\"title\">CANAIS BR 2</span><span class=\"sub\">Public Link</span></button>\n            <button class=\"choice\"><span class=\"title\">CANAIS BR 3</span><span class=\"sub\">Public Link</span></button>\n            <button class=\"choice\"><span class=\"title\">CANAIS BR 4</span><span class=\"sub\">Public Link</span></button>\n            <button class=\"choice\"><span class=\"title\">CANAIS BR 5</span><span class=\"sub\">Public Link</span></button>\n            <button class=\"choice\"><span class=\"title\">CANAIS BR 6</span><span class=\"sub\">Public Link</span></button>\n          </div>\n        </div>\n\n        <div class=\"providerBox\">\n          <div class=\"providerHead\">\n            <strong>Opções EPG</strong>\n            <span>Guia de programação</span>\n          </div>\n\n          <label class=\"switchRow\">\n            <input type=\"checkbox\" id=\"m3uEpgEnabledPreview\">\n            <strong>Ativar EPG</strong>\n          </label>\n\n          <div id=\"m3uEpgOptionsPreview\" class=\"conditional\">\n            <div class=\"radioRow\">\n              <label class=\"radioOpt\">\n                <input type=\"radio\" name=\"m3uEpgSourcePreview\" value=\"playlist\">\n                <span>EPG da playlist / provider</span>\n              </label>\n              <label class=\"radioOpt\">\n                <input type=\"radio\" name=\"m3uEpgSourcePreview\" value=\"url\">\n                <span>URL EPG personalizada</span>\n              </label>\n            </div>\n\n            <div id=\"m3uCustomEpgUrlPreview\" style=\"display:none\">\n              <label class=\"field\">URL do EPG</label>\n              <input id=\"m3uEpgUrlFieldPreview\" type=\"url\" placeholder=\"https://exemplo.com/epg.xml\">\n            </div>\n\n            <label class=\"switchRow\" style=\"margin-top:14px\">\n              <input type=\"checkbox\">\n              <span><strong>Reformatar logos</strong> <span class=\"hint\">(pode tornar o carregamento mais lento)</span></span>\n            </label>\n\n            <div class=\"hint\" style=\"margin-top:8px\">\n              O desvio horário do EPG será tratado automaticamente pelo PT•HUB através de uma definição genérica.\n            </div>\n          </div>\n        </div>\n\n        <div class=\"providerBox\">\n          <div class=\"providerHead\">\n            <strong>Avançado</strong>\n            <span>User-Agent global</span>\n          </div>\n\n          <label class=\"field\">User-Agent global</label>\n          <input id=\"uaPreview\" type=\"text\" placeholder=\"Deixa em branco salvo se o teu provider exigir um player específico\">\n\n          <div class=\"choiceGrid\" style=\"grid-template-columns:repeat(auto-fit,minmax(120px,1fr));margin-top:10px\">\n            <button class=\"choice uaChoice\" data-ua=\"\">\n              <span class=\"title\">Sem preset</span><span class=\"sub\">Predefinido</span>\n            </button>\n            <button class=\"choice uaChoice\" data-ua=\"TiviMate\">\n              <span class=\"title\">TiviMate</span><span class=\"sub\">User-Agent</span>\n            </button>\n            <button class=\"choice uaChoice\" data-ua=\"IPTV Smarters Pro\">\n              <span class=\"title\">IPTV Smarters Pro</span><span class=\"sub\">User-Agent</span>\n            </button>\n            <button class=\"choice uaChoice\" data-ua=\"GSE Smart IPTV\">\n              <span class=\"title\">GSE Smart IPTV</span><span class=\"sub\">User-Agent</span>\n            </button>\n            <button class=\"choice uaChoice\" data-ua=\"VLC\">\n              <span class=\"title\">VLC</span><span class=\"sub\">User-Agent</span>\n            </button>\n            <button class=\"choice uaChoice\" data-ua=\"Kodi\">\n              <span class=\"title\">Kodi</span><span class=\"sub\">User-Agent</span>\n            </button>\n            <button class=\"choice uaChoice\" data-ua=\"CUSTOM\">\n              <span class=\"title\">Personalizado…</span><span class=\"sub\">Manual</span>\n            </button>\n          </div>\n\n          <div class=\"hint\" style=\"margin-top:8px\">\n            Canais que tenham o seu próprio User-Agent na playlist têm prioridade sobre esta definição.\n          </div>\n        </div>\n\n        <div class=\"providerBox\">\n          <div class=\"providerHead\">\n            <strong>Apresentação</strong>\n            <span>Stremio / Nuvio</span>\n          </div>\n\n          <label class=\"field\">Nome do catálogo</label>\n          <input id=\"m3uCatalogPreview\" type=\"text\" placeholder=\"Minha IPTV\">\n          <div class=\"hint\" style=\"margin-top:6px\">Deixa em branco para utilizar o nome predefinido.</div>\n        </div>\n      </div>\n    </section>\n\n    <section class=\"panel\" id=\"operadores\">\n      <div class=\"sectionTitle\">Operadores PT</div>\n      <div class=\"choiceGrid\">\n        <button class=\"choice\" data-operator=\"meo\"><span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/meo-poster.png\" alt=\"MEO\"></span><span class=\"title\">MEO</span><span class=\"sub\">Operador PT</span></button>\n        <button class=\"choice\" data-operator=\"nos\"><span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/nos-poster.png\" alt=\"NOS\"></span><span class=\"title\">NOS</span><span class=\"sub\">Operador PT</span></button>\n        <button class=\"choice\" data-operator=\"vodafone\"><span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/vodafone-poster.png\" alt=\"Vodafone\"></span><span class=\"title\">Vodafone</span><span class=\"sub\">Operador PT</span></button>\n        <button class=\"choice\" data-operator=\"digi\"><span class=\"choiceLogo\"><img src=\"https://raw.githubusercontent.com/filipempribeiro-sys/PT---TV---Filme-e-Series/main/assets/operators/digi-poster.png\" alt=\"DIGI\"></span><span class=\"title\">DIGI</span><span class=\"sub\">Operador PT</span></button>\n      </div>\n    </section>\n\n    <section class=\"panel\" id=\"externas\">\n      <div class=\"sectionTitle\">Fontes Externas — Extras</div>\n      <div class=\"help\">O PT•HUB já inclui fontes automáticas. Usa esta área apenas para adicionar addons extra.</div>\n      <label class=\"field\">Manifests / Addons adicionais</label>\n      <textarea id=\"externalSourcesPreview\" rows=\"4\" placeholder=\"Um URL de manifest por linha\"></textarea>\n      <label class=\"field\">Máximo de resultados por qualidade</label>\n      <input id=\"externalMaxPreview\" type=\"number\" min=\"1\" max=\"10\" value=\"2\">\n    </section>\n\n    <div class=\"actions\">\n      <button class=\"btn secondary hidden\" id=\"testBtn\">Testar ligação</button>\n      <button class=\"btn primary\" id=\"installBtn\">Instalar PT•HUB →</button>\n    </div>\n    <div id=\"statusBox\" class=\"statusBox\"></div>\n    <div id=\"installResult\" class=\"providerBox\" style=\"display:none;margin-top:14px\">\n      <div class=\"providerHead\"><strong>URL do Add-on</strong><span>PT•HUB</span></div>\n      <input id=\"installUrlPreview\" type=\"text\" readonly>\n      <div class=\"actions\" style=\"margin-top:10px\">\n        <button class=\"btn secondary\" id=\"copyInstallPreview\" type=\"button\">Copiar URL</button>\n        <button class=\"btn primary\" id=\"installStremioPreview\" type=\"button\">Instalar no Stremio →</button>\n        <button class=\"btn secondary\" id=\"installNuvioPreview\" type=\"button\">Instalar no Nuvio →</button>\n      </div>\n    </div>\n  </main>\n\n  <aside class=\"card about\">\n    <h3>Sobre</h3>\n\n    <p>\n      O <span class=\"brandline\">PT•HUB</span> reúne num único addon televisão, IPTV,\n      filmes, séries, conteúdos portugueses, streamers, operadores nacionais,\n      OpenSubtitles, fontes integradas e fontes externas opcionais.\n    </p>\n\n    <div id=\"aboutBase\">\n      <p><span class=\"arrow\">→</span> Seleciona um ou mais conteúdos na aba <strong>Conteúdo</strong>. À medida que ativares cada área, a respetiva informação será apresentada aqui.</p>\n    </div>\n\n    <div id=\"aboutDynamic\"></div>\n\n    <div class=\"box\">\n      <strong>Legendas</strong>\n      <p style=\"margin-bottom:0\">\n        O PT•HUB já incorpora o OpenSubtitles para escolha de legendas.\n      </p>\n    </div>\n\n    <div class=\"box\">\n      <strong>Português de Portugal</strong>\n      <p style=\"margin-bottom:0\">\n        A interface, os nomes dos catálogos e os metadados textuais são apresentados em PT-PT sempre que exista localização disponível.\n      </p>\n    </div>\n\n    <div class=\"badges\">\n      <span class=\"badge\">Stremio</span>\n      <span class=\"badge\">Nuvio</span>\n      <span class=\"badge\">IPTV</span>\n      <span class=\"badge\">PT-PT</span>\n    </div>\n  </aside>\n</div>\n\n<script>\nconst tabs=[...document.querySelectorAll(\".tab\")];\nconst panels=[...document.querySelectorAll(\".panel\")];\n\nfunction activatePanel(name){\n  tabs.forEach(t=>t.classList.toggle(\"active\",t.dataset.panel===name));\n  panels.forEach(p=>p.classList.toggle(\"active\",p.id===name));\n}\ntabs.forEach(tab=>tab.addEventListener(\"click\",()=>{\n  if(!tab.classList.contains(\"hidden\")) activatePanel(tab.dataset.panel);\n}));\n\nconst aboutDescriptions = {\n  destaques: '<p><span class=\"arrow\">→</span> <strong>Destaques</strong> — estreias no cinema, novos filmes, novas séries, populares e conteúdos em destaque.</p>',\n  streamers: '<p><span class=\"arrow\">→</span> <strong>Streamers</strong> — escolhe os serviços pretendidos e o país do catálogo.</p>',\n  portugues: '<p><span class=\"arrow\">→</span> <strong>Português</strong> — conteúdos em PT-PT e produções portuguesas permanecem em áreas distintas.</p>',\n  adultos: '<p><span class=\"arrow\">→</span> <strong>Adultos</strong> — área opcional com fontes predefinidas, ativada apenas quando selecionada.</p>',\n  iptv: '<p><span class=\"arrow\">→</span> <strong>IPTV</strong> — IPTV-org, Xtream API ou M3U/M3U+, configurados apenas depois de escolheres o método.</p>',\n  operadores: '<p><span class=\"arrow\">→</span> <strong>Operadores PT</strong> — seleciona apenas os operadores nacionais que pretendes incluir.</p>',\n  externas: '<p><span class=\"arrow\">→</span> <strong>Fontes Externas</strong> — adiciona addons compatíveis para agregação de streams.</p>'\n};\n\nfunction updateAbout(){\n  const selected = [...document.querySelectorAll(\"[data-feature-toggle].active\")]\n    .map(btn => btn.dataset.featureToggle);\n\n  const base = document.getElementById(\"aboutBase\");\n  const dynamic = document.getElementById(\"aboutDynamic\");\n\n  if(base) base.style.display = selected.length ? \"none\" : \"block\";\n  if(dynamic){\n    dynamic.innerHTML = selected\n      .map(feature => aboutDescriptions[feature] || \"\")\n      .join(\"\");\n  }\n}\n\ndocument.querySelectorAll(\"[data-feature-toggle]\").forEach(btn=>{\n  const feature=btn.dataset.featureToggle;\n\n  const sync=()=>{\n    const on=btn.classList.contains(\"active\");\n    const tab=document.querySelector(`.tab[data-feature=\"${feature}\"]`);\n    if(tab) tab.classList.toggle(\"hidden\",!on);\n\n    if(feature===\"iptv\" && !on){\n      document.getElementById(\"testBtn\")?.classList.add(\"hidden\");\n    }\n\n    const panel=document.getElementById(feature);\n    if(panel && !on && panel.classList.contains(\"active\")){\n      activatePanel(\"conteudo\");\n    }\n\n    updateAbout();\n\ndocument.querySelectorAll(\".tab\").forEach(tab=>{\n  tab.addEventListener(\"click\",()=>{\n    const iptvSelected =\n      document.querySelector('[data-feature-toggle=\"iptv\"]')?.classList.contains(\"active\");\n    document.getElementById(\"testBtn\")?.classList.toggle(\n      \"hidden\",\n      !(tab.dataset.panel === \"iptv\" && iptvSelected)\n    );\n  });\n});\n\n  };\n\n  sync();\n\n  btn.addEventListener(\"click\",()=>{\n    btn.classList.toggle(\"active\");\n    sync();\n  });\n});\n\nupdateAbout();\n\ndocument.querySelectorAll(\".choice:not([data-feature-toggle])\").forEach(btn=>{\n  btn.addEventListener(\"click\",()=>btn.classList.toggle(\"active\"));\n});\n\ndocument.querySelectorAll(\".iptvTab\").forEach(tab=>{\n  tab.addEventListener(\"click\",()=>{\n    document.querySelectorAll(\".iptvTab\").forEach(t=>t.classList.remove(\"active\"));\n    document.querySelectorAll(\".iptvPane\").forEach(p=>p.classList.remove(\"active\"));\n    tab.classList.add(\"active\");\n    document.getElementById(\"iptv-\"+tab.dataset.iptv).classList.add(\"active\");\n  });\n});\n\ndocument.querySelectorAll(\".m3uSourcePreview\").forEach(btn=>{\n  btn.addEventListener(\"click\",()=>{\n    document.querySelectorAll(\".m3uSourcePreview\").forEach(b=>b.classList.remove(\"active\"));\n    btn.classList.add(\"active\");\n    const isFile=btn.dataset.source===\"file\";\n    document.getElementById(\"m3uUrlPreview\").style.display=isFile?\"none\":\"block\";\n    document.getElementById(\"m3uFilePreview\").style.display=isFile?\"block\":\"none\";\n  });\n});\n\n\nfunction bindEpgToggle(enabledId, optionsId, radioName, customUrlId){\n  const enabled=document.getElementById(enabledId);\n  const options=document.getElementById(optionsId);\n  const custom=document.getElementById(customUrlId);\n\n  const syncEnabled=()=>{\n    options?.classList.toggle(\"show\", !!enabled?.checked);\n  };\n\n  enabled?.addEventListener(\"change\",syncEnabled);\n  syncEnabled();\n\n  document.querySelectorAll(`input[name=\"${radioName}\"]`).forEach(radio=>{\n    radio.addEventListener(\"change\",()=>{\n      const value=document.querySelector(`input[name=\"${radioName}\"]:checked`)?.value || \"\";\n      if(custom) custom.style.display=value===\"url\"?\"block\":\"none\";\n    });\n  });\n}\n\nbindEpgToggle(\n  \"xtreamEpgEnabledPreview\",\n  \"xtreamEpgOptionsPreview\",\n  \"xtreamEpgSourcePreview\",\n  \"xtreamCustomEpgUrlPreview\"\n);\n\nbindEpgToggle(\n  \"m3uEpgEnabledPreview\",\n  \"m3uEpgOptionsPreview\",\n  \"m3uEpgSourcePreview\",\n  \"m3uCustomEpgUrlPreview\"\n);\n\ndocument.querySelectorAll(\".uaChoice\").forEach(btn=>{\n  btn.addEventListener(\"click\",()=>{\n    document.querySelectorAll(\".uaChoice\").forEach(b=>b.classList.remove(\"active\"));\n    btn.classList.add(\"active\");\n    const ua=document.getElementById(\"uaPreview\");\n    if(btn.dataset.ua===\"CUSTOM\"){\n      ua.value=\"\";\n      ua.focus();\n    }else{\n      ua.value=btn.dataset.ua||\"\";\n    }\n  });\n});\n\n\nconst installBtn=document.getElementById(\"installBtn\");\nconst testBtn=document.getElementById(\"testBtn\");\nconst statusBox=document.getElementById(\"statusBox\");\nconst initialConfig=__INITIAL_CONFIG__;\n\nfunction showStatus(message,type=\"error\"){\n  if(!statusBox)return;\n  statusBox.textContent=message;\n  statusBox.className=\"statusBox show \"+type;\n}\nfunction clearStatus(){\n  if(!statusBox)return;\n  statusBox.textContent=\"\";\n  statusBox.className=\"statusBox\";\n}\nfunction active(selector){return !!document.querySelector(selector+\".active\");}\nfunction activeValues(selector,attr){\n  return [...document.querySelectorAll(selector+\".active\")].map(el=>el.dataset[attr]).filter(Boolean);\n}\nfunction lines(value){\n  return String(value||\"\").split(/\\r?\\n/).map(v=>v.trim()).filter(Boolean);\n}\nfunction b64urlUtf8(text){\n  const bytes=new TextEncoder().encode(text);\n  let binary=\"\";\n  bytes.forEach(b=>binary+=String.fromCharCode(b));\n  return btoa(binary).replace(/\\+/g,\"-\").replace(/\\//g,\"_\").replace(/=+$/,\"\");\n}\nfunction selectedIptvMode(){\n  const mode=document.querySelector(\".iptvTab.active\")?.dataset.iptv;\n  return mode===\"org\"?\"iptv-org\":(mode||\"iptv-org\");\n}\nfunction getRealConfig(){\n  const selectedFeatures=activeValues(\"[data-feature-toggle]\",\"featureToggle\");\n  const streamers=activeValues(\"#streamers [data-streamer]\",\"streamer\");\n  const streamerMap={\n    netflix:\"netflix\",\n    hbomax:\"hbomax\",\n    prime:\"prime-video\",\n    disney:\"disney-plus\",\n    apple:\"apple-tv-plus\"\n  };\n  const streamerIds=streamers.map(v=>streamerMap[v]).filter(Boolean);\n  const ptPt=active('#portugues [data-config-choice=\"ptpt\"]');\n  const portuguese=active('#portugues [data-config-choice=\"producao-portuguesa\"]');\n  const epgXtreamEnabled=document.getElementById(\"xtreamEpgEnabledPreview\")?.checked===true;\n  const epgXtreamSource=document.querySelector('input[name=\"xtreamEpgSourcePreview\"]:checked')?.value||\"\";\n  const epgM3uEnabled=document.getElementById(\"m3uEpgEnabledPreview\")?.checked===true;\n  const epgM3uSource=document.querySelector('input[name=\"m3uEpgSourcePreview\"]:checked')?.value||\"\";\n  const m3uSource=document.querySelector(\".m3uSourcePreview.active\")?.dataset.source||\"\";\n  const mode=selectedIptvMode();\n\n  return {\n    catalogCountry:(document.getElementById(\"catalogCountryPreview\")?.value||\"\").trim().toUpperCase(),\n    features:{\n      featured:selectedFeatures.includes(\"destaques\"),\n      featuredContent:{\n        movies:active('#destaques [data-config-choice=\"destaques-filmes\"]'),\n        series:active('#destaques [data-config-choice=\"destaques-series\"]')\n      },\n      streamers:selectedFeatures.includes(\"streamers\"),\n      selectedStreamerMovies:streamerIds,\n      selectedStreamerSeries:streamerIds,\n      operators:selectedFeatures.includes(\"operadores\"),\n      selectedOperators:activeValues(\"#operadores [data-operator]\",\"operator\"),\n      iptv:selectedFeatures.includes(\"iptv\"),\n      ptContent:selectedFeatures.includes(\"portugues\"),\n      ptContentSources:{\n        ptPt,\n        portugueseProduction:portuguese,\n        rtpPlay:false\n      },\n      adultContent:selectedFeatures.includes(\"adultos\") && active(\"#adultAutoPreview\"),\n      subtitles:true,\n      externalSources:selectedFeatures.includes(\"externas\")\n    },\n    ptContentSelectedSources:{\n      ptpt:ptPt?[\"cotonet\"]:[],\n      portuguese:portuguese?[\"portuguese-productions\"]:[]\n    },\n    ptContentExternalSources:{ptpt:[],portuguese:[]},\n    externalStreamSources:selectedFeatures.includes(\"externas\")\n      ?lines(document.getElementById(\"externalSourcesPreview\")?.value):[],\n    externalStreamMaxPerQuality:Number(document.getElementById(\"externalMaxPreview\")?.value||2),\n    mode,\n    iptvOrg:{\n      country:(document.getElementById(\"iptvOrgCountryPreview\")?.value||\"\").trim(),\n      category:(document.getElementById(\"iptvOrgCategoryPreview\")?.value||\"\").trim(),\n      catalogName:(document.getElementById(\"iptvOrgCatalogPreview\")?.value||\"\").trim()\n    },\n    xtreamServer:(document.getElementById(\"xtreamServerPreview\")?.value||\"\").trim(),\n    username:(document.getElementById(\"xtreamUserPreview\")?.value||\"\").trim(),\n    password:document.getElementById(\"xtreamPassPreview\")?.value||\"\",\n    xtreamShow:{live:active(\"#xtreamLivePreview\")},\n    xtreamEpgMode:epgXtreamEnabled?(epgXtreamSource===\"url\"?\"url\":\"auto\"):\"none\",\n    xtreamEpgOffset:0,\n    xtreamEpgUrl:(document.getElementById(\"xtreamEpgUrlFieldPreview\")?.value||\"\").trim(),\n    xtreamCatalogName:(document.getElementById(\"xtreamCatalogPreview\")?.value||\"\").trim(),\n    m3uSource:m3uSource||\"url\",\n    m3uUrl:(document.getElementById(\"m3uUrlFieldPreview\")?.value||\"\").trim(),\n    m3uFileId:window.__pthubM3uFileId||\"\",\n    m3uEpgMode:epgM3uEnabled?(epgM3uSource===\"url\"?\"url\":\"playlist\"):\"none\",\n    m3uEpgOffset:0,\n    epgUrl:(document.getElementById(\"m3uEpgUrlFieldPreview\")?.value||\"\").trim(),\n    globalUserAgent:(document.getElementById(\"uaPreview\")?.value||\"\").trim(),\n    m3uCatalogName:(document.getElementById(\"m3uCatalogPreview\")?.value||\"\").trim()\n  };\n}\nfunction validateRealConfig(config,forTest=false){\n  const f=config.features;\n  if(!(f.featured||f.streamers||f.operators||f.iptv||f.ptContent||f.adultContent||f.externalSources))\n    return \"Deves selecionar e configurar pelo menos um conteúdo a instalar.\";\n  if(f.featured&&!f.featuredContent.movies&&!f.featuredContent.series)\n    return \"Selecionaste Destaques, mas ainda não escolheste Filmes, Séries ou ambos.\";\n  if(f.streamers&&f.selectedStreamerMovies.length===0)\n    return \"Selecionaste Streamers, mas ainda não escolheste nenhum serviço.\";\n  if(f.streamers&&!config.catalogCountry)\n    return \"Selecionaste Streamers, mas ainda não escolheste o país do catálogo.\";\n  if(f.ptContent&&!f.ptContentSources.ptPt&&!f.ptContentSources.portugueseProduction)\n    return \"Selecionaste Português, mas ainda não escolheste PT-PT nem Produções Portuguesas.\";\n  if(document.querySelector('[data-feature-toggle=\"adultos\"]')?.classList.contains(\"active\")&&!f.adultContent)\n    return \"Selecionaste Adultos, mas ainda não ativaste as fontes automáticas.\";\n  if(f.operators&&f.selectedOperators.length===0)\n    return \"Selecionaste Operadores PT, mas ainda não escolheste nenhum operador.\";\n  if(f.externalSources&&config.externalStreamSources.length===0)\n    return \"Selecionaste Fontes Externas, mas ainda não adicionaste nenhum addon.\";\n  if(f.iptv){\n    if(config.mode===\"xtream\"){\n      if(!config.xtreamServer||!config.username||!config.password)\n        return \"Selecionaste Xtream API, mas faltam servidor, utilizador ou palavra-passe.\";\n      if(!config.xtreamShow.live)\n        return \"Selecionaste Xtream API, mas ainda não escolheste TV em Direto.\";\n      if(config.xtreamEpgMode===\"url\"&&!config.xtreamEpgUrl)\n        return \"Selecionaste URL EPG personalizada no Xtream, mas não indicaste o URL.\";\n    }\n    if(config.mode===\"m3u\"){\n      const source=document.querySelector(\".m3uSourcePreview.active\")?.dataset.source;\n      if(!source)return \"Selecionaste M3U / M3U+, mas ainda não escolheste URL ou ficheiro.\";\n      if(source===\"url\"&&!config.m3uUrl)return \"Selecionaste Playlist por URL, mas ainda não indicaste o URL M3U/M3U+.\";\n      if(source===\"file\"&&!config.m3uFileId)return \"Selecionaste Ficheiro M3U/M3U8, mas ainda não escolheste nenhum ficheiro.\";\n      if(config.m3uEpgMode===\"url\"&&!config.epgUrl)\n        return \"Selecionaste URL EPG personalizada no M3U, mas não indicaste o URL.\";\n    }\n  }\n  if(forTest&&!f.iptv)return \"O teste de ligação só está disponível na configuração IPTV.\";\n  return \"\";\n}\nfunction getInstallUrl(config){\n  const encoded=b64urlUtf8(JSON.stringify(config));\n  return location.origin+\"/\"+encoded+\"/manifest.json\";\n}\nasync function uploadM3UIfNeeded(config){\n  if(!config.features.iptv||config.mode!==\"m3u\")return;\n  const source=document.querySelector(\".m3uSourcePreview.active\")?.dataset.source;\n  const input=document.getElementById(\"m3uFileFieldPreview\");\n  if(source!==\"file\"||!input?.files?.length)return;\n  const text=await input.files[0].text();\n  const response=await fetch(\"/upload-m3u\",{method:\"POST\",headers:{\"Content-Type\":\"text/plain;charset=UTF-8\"},body:text});\n  if(!response.ok)throw new Error(\"Não foi possível enviar o ficheiro M3U.\");\n  const data=await response.json();\n  window.__pthubM3uFileId=data.id||data.fileId||data.m3uFileId||\"\";\n  if(!window.__pthubM3uFileId)throw new Error(\"O servidor não devolveu o identificador do ficheiro M3U.\");\n}\ninstallBtn?.addEventListener(\"click\",async event=>{\n  event.preventDefault();\n  clearStatus();\n  try{\n    let config=getRealConfig();\n    let error=validateRealConfig(config,false);\n    if(error){showStatus(error,\"error\");return;}\n    await uploadM3UIfNeeded(config);\n    config=getRealConfig();\n    error=validateRealConfig(config,false);\n    if(error){showStatus(error,\"error\");return;}\n    const url=getInstallUrl(config);\n    document.getElementById(\"installUrlPreview\").value=url;\n    document.getElementById(\"installResult\").style.display=\"block\";\n    showStatus(\"Configuração válida. Escolhe Instalar no Stremio ou Instalar no Nuvio.\",\"ok\");\n  }catch(error){showStatus(\"Erro: \"+error.message,\"error\");}\n});\ntestBtn?.addEventListener(\"click\",async event=>{\n  event.preventDefault();\n  clearStatus();\n  try{\n    let config=getRealConfig();\n    let error=validateRealConfig(config,true);\n    if(error){showStatus(error,\"error\");return;}\n    await uploadM3UIfNeeded(config);\n    config=getRealConfig();\n    const response=await fetch(\"/test-iptv\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify(config)});\n    const data=await response.json().catch(()=>({}));\n    if(!response.ok||data.success===false)throw new Error(data.message||data.error||\"Falha no teste de ligação.\");\n    showStatus(data.message||(\"Ligação validada\"+(data.channels?\" — \"+data.channels+\" canais encontrados.\":\".\")),\"ok\");\n  }catch(error){showStatus(\"Erro: \"+error.message,\"error\");}\n});\ndocument.getElementById(\"copyInstallPreview\")?.addEventListener(\"click\",async()=>{\n  const url=document.getElementById(\"installUrlPreview\")?.value;\n  if(url)await navigator.clipboard.writeText(url);\n});\nfunction toStremioInstallUrl(url){\n  return String(url||\"\").replace(/^https?:\\/\\//i,\"stremio://\");\n}\nfunction toNuvioInstallUrl(url){\n  return \"nuvio://install?manifest=\"+encodeURIComponent(String(url||\"\"));\n}\ndocument.getElementById(\"installStremioPreview\")?.addEventListener(\"click\",()=>{\n  const url=document.getElementById(\"installUrlPreview\")?.value;\n  if(url)window.location.href=toStremioInstallUrl(url);\n});\ndocument.getElementById(\"installNuvioPreview\")?.addEventListener(\"click\",()=>{\n  const url=document.getElementById(\"installUrlPreview\")?.value;\n  if(url)window.location.href=toNuvioInstallUrl(url);\n});\n\n/* Restauração simples quando se abre /:config/configure */\n(function restoreConfig(){\n  const c=initialConfig||{};\n  const f=c.features||{};\n  const activateFeature=(name,on)=>{\n    const b=document.querySelector('[data-feature-toggle=\"'+name+'\"]');\n    if(on&&!b?.classList.contains(\"active\"))b?.click();\n  };\n  activateFeature(\"destaques\",f.featured===true);\n  activateFeature(\"streamers\",f.streamers===true);\n  activateFeature(\"portugues\",f.ptContent===true);\n  activateFeature(\"adultos\",f.adultContent===true);\n  activateFeature(\"iptv\",f.iptv===true);\n  activateFeature(\"operadores\",f.operators===true);\n  activateFeature(\"externas\",f.externalSources===true);\n})();\n\n</script>\n\n</body>\n</html>"
    .replace("__PT_HUB_BACKGROUND__", `${PT_HUB_BACKGROUND}?v=${VERSION}`)
    .replace("__PT_HUB_LOGO__", `${PT_HUB_LOGO}?v=${VERSION}`)
    .replace("__INITIAL_CONFIG__", initialConfigJson);
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
        await getIPTVChannels(config);

      return res.json({
        success: true,
        message:
          `Ligação M3U efetuada com sucesso. ${channels.length} canais encontrados.`,
        channels: channels.length
      });

    }
if (config.mode === "iptv-org") {

  const channels =
    await getIPTVOrgChannels(config);

  return res.json({
    success: true,
    message:
      `Ligação IPTV-org efetuada com sucesso. ${channels.length} canais encontrados.`,
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


async function buildManifest(config) {

 const features =
 config?.features || {};

 const hasConfig =
 !!config;

 const showFeatured =
 features.featured === true;

 const featuredContent =
 features.featuredContent || {
 movies: true,
 series: true
 };

 const showStreamers =
 features.streamers === true;

 const selectedStreamerMovies =
 Array.isArray(features.selectedStreamerMovies)
 ? features.selectedStreamerMovies
 : (Array.isArray(features.selectedStreamers)
 ? features.selectedStreamers
 : null);

 const selectedStreamerSeries =
 Array.isArray(features.selectedStreamerSeries)
 ? features.selectedStreamerSeries
 : (Array.isArray(features.selectedStreamers)
 ? features.selectedStreamers
 : null);

 const showOperators =
 features.operators === true;

 const selectedOperators =
 Array.isArray(features.selectedOperators)
 ? features.selectedOperators
 : null;

 const showIPTV =
 features.iptv === true;

 const showPtContent =
 features.ptContent === true;

 const showRtpPlay =
 showPtContent &&
 features.ptContentSources?.rtpPlay === true;

 const externalIdentityCatalogs =
   (showPtContent || features.adultContent === true)
     ? await getPtExternalManifestCatalogs(config)
     : [];

 function isSpecialCatalog(id) {
 return (
 id === "featured" ||
 id === "movie-top" ||
 id === "series-top" ||
 id === "cinema-new" ||
 id === "movie-new" ||
 id === "series-new"
 );
 }

 /*
  * "Destaques" e "TOP" (movie-top/series-top) são
  * ambos catálogos globais (não pertencem a nenhum streamer
  * específico) e ficam sob controlo do toggle "Destaques".
  */
 function filterSpecialCatalogs(list, type) {

 return list.filter((catalog) => {

 if (!isSpecialCatalog(catalog.id)) {
 return true;
 }

 if (!hasConfig) {
 return true;
 }

 if (!showFeatured) {
 return false;
 }

 if (type === "movie") {
 return featuredContent.movies === true;
 }

 if (type === "series") {
 return featuredContent.series === true;
 }

 return true;

 });

 }

 function filterStreamerCatalogs(list, selected) {

 if (!hasConfig) {
 return list;
 }

 if (!showStreamers) {

 return list.filter(
 (catalog) => isSpecialCatalog(catalog.id)
 );

 }

 if (!selected || !selected.length) {

 return list.filter(
 (catalog) => isSpecialCatalog(catalog.id)
 );

 }

 return list.filter((catalog) =>
 isSpecialCatalog(catalog.id) ||
 selected.includes(catalog.id)
 );

 }

 const filteredMovieCatalogs =
 filterStreamerCatalogs(
 filterSpecialCatalogs(movieCatalogs, "movie"),
 selectedStreamerMovies
 );

 const filteredSeriesCatalogs =
 filterStreamerCatalogs(
 filterSpecialCatalogs(seriesCatalogs, "series"),
 selectedStreamerSeries
 );

 const filteredOperatorCatalogs =
 (() => {

 const all = getOperatorCatalogs();

 if (!hasConfig) {
 return all;
 }

 if (!selectedOperators || !selectedOperators.length) {
 return [];
 }

 return all.filter((catalog) =>
 selectedOperators.includes(catalog.id)
 );

 })();

 const iptvCatalogName =
 config?.mode === "xtream"
 ? (config?.xtreamCatalogName || "📡 Xtream API")
 : config?.mode === "iptv-org"
 ? (config?.iptvOrg?.catalogName || "📡 IPTV-org Free")
 : (config?.m3uCatalogName || "📡 Minha IPTV");

 /*
  * Ordena os catálogos de filmes/séries por STREAMER em vez
  * de por tipo — isto controla a ordem das linhas no ecrã
  * "Board" do Stremio. Fica: Populares, Destaques, e depois
  * cada streamer com Filmes+Séries lado a lado.
  */
 function findCatalog(list, id) {
 return list.find((catalog) => catalog.id === id);
 }

 const searchExtra = [{ name: "search", isRequired: false }];

 const orderedMovieSeriesCatalogs = [];

 // Ordem PT•HUB 2.1.3:
 // Estreias no Cinema -> TOP Filmes -> TOP Séries -> Novos Filmes -> Novas Séries.
 const cinemaNew = findCatalog(filteredMovieCatalogs, "cinema-new");
 const movieNew = findCatalog(filteredMovieCatalogs, "movie-new");
 const seriesNew = findCatalog(filteredSeriesCatalogs, "series-new");
 const popularMovie = findCatalog(filteredMovieCatalogs, "movie-top");
 const popularSeries = findCatalog(filteredSeriesCatalogs, "series-top");

 if (cinemaNew) {
   orderedMovieSeriesCatalogs.push({
     type: "movie", id: cinemaNew.id, name: cinemaNew.name, extra: searchExtra
   });
 }
 if (popularMovie) {
   orderedMovieSeriesCatalogs.push({
     type: "movie", id: popularMovie.id, name: popularMovie.name, extra: searchExtra
   });
 }
 if (popularSeries) {
   orderedMovieSeriesCatalogs.push({
     type: "series", id: popularSeries.id, name: popularSeries.name, extra: searchExtra
   });
 }
 if (movieNew) {
   orderedMovieSeriesCatalogs.push({
     type: "movie", id: movieNew.id, name: movieNew.name, extra: searchExtra
   });
 }
 if (seriesNew) {
   orderedMovieSeriesCatalogs.push({
     type: "series", id: seriesNew.id, name: seriesNew.name, extra: searchExtra
   });
 }

 const featuredMovie = findCatalog(filteredMovieCatalogs, "featured");
 const featuredSeriesCat = findCatalog(filteredSeriesCatalogs, "featured");

 if (featuredMovie) {
 orderedMovieSeriesCatalogs.push({
 type: "movie", id: featuredMovie.id, name: featuredMovie.name, extra: searchExtra
 });
 }
 if (featuredSeriesCat) {
 orderedMovieSeriesCatalogs.push({
 type: "series", id: featuredSeriesCat.id, name: featuredSeriesCat.name, extra: searchExtra
 });
 }

 for (const streamer of streamers) {

 const movieCat = findCatalog(filteredMovieCatalogs, streamer.id);
 const seriesCat = findCatalog(filteredSeriesCatalogs, streamer.id);

 if (movieCat) {
 orderedMovieSeriesCatalogs.push({
 type: "movie", id: movieCat.id, name: movieCat.name, extra: searchExtra
 });
 }

 if (seriesCat) {
 orderedMovieSeriesCatalogs.push({
 type: "series", id: seriesCat.id, name: seriesCat.name, extra: searchExtra
 });
 }

 }

 const manifest = {
    ...manifestTemplate,

    version: VERSION,

    name: "PT•HUB",

    description:
      "Hub de TV Portugal, IPTV M3U/Xtream Codes, filmes e séries.",

    logo: `${PT_HUB_LOGO}?v=${VERSION}`,

    background: `${PT_HUB_BACKGROUND}?v=${VERSION}`,

    resources: [
      "catalog",
      "meta",
      "stream",
      "addon_catalog",
      ...(features.subtitles === true
        ? ["subtitles"]
        : [])
    ],

    types: [
      "channel",
      "tv",
      "movie",
      "series"
    ],

 catalogs: [

...orderedMovieSeriesCatalogs,

...externalIdentityCatalogs,

...(showIPTV
 ? [
 {
 type: "channel",
 id: "m3u",
 name: iptvCatalogName,
 extra: [{ name: "search", isRequired: false }]
 }
 ]
 : []),

...(showOperators
 ? filteredOperatorCatalogs.map((catalog) => ({
 ...catalog,
 extra: [{ name: "search", isRequired: false }]
 }))
 : []),

...(showRtpPlay
 ? [
 {
 type: "channel",
 id: "rtp-play",
 name: "🇵🇹 RTP Play",
 extra: [{ name: "search", isRequired: false }]
 }
 ]
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
      "pthubptmeta:",
      "tt",
      "tmdb:"
    ],

    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      p2p: true,
      adult: features.adultContent === true
    }
  };


  return manifest;
}


/* =========================================================
   MANIFEST ROUTES
   ========================================================= */

app.get("/manifest.json", async (req, res) => {

  res.set(
    "Cache-Control",
    "no-cache, no-store, must-revalidate"
  );

  res.json(
    await buildManifest(null)
  );

});


app.get("/:config/manifest.json", async (req, res) => {

  const config =
    decodeConfig(req.params.config);

  res.set(
    "Cache-Control",
    "no-cache, no-store, must-revalidate"
  );

  res.json(
    await buildManifest(config)
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
   PESQUISA (extra=search)
   ========================================================= */

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function filterMetasBySearch(metas, search) {
  if (!search) {
    return metas;
  }

  const needle = normalizeSearchText(search);

  return metas.filter((meta) =>
    normalizeSearchText(meta.name || meta.title || "").includes(needle)
  );
}

function parseExtra(extraParam) {
  const result = {};

  if (!extraParam) {
    return result;
  }

  try {

    const decoded =
      decodeURIComponent(extraParam);

    const params =
      new URLSearchParams(decoded);

    for (const [key, value] of params) {
      result[key] = value;
    }

  } catch (error) {
    // parâmetros extra inválidos são ignorados
  }

  return result;
}

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


      if (catalogId === "rtp-play") {

        /*
         * RTP Play: estrutura preparada, mas ainda sem fonte de
         * dados pública confirmada — devolve vazio até existir
         * uma integração legítima (ver getRtpPlayChannels()).
         */

        const channels =
          await getRtpPlayChannels();

        return res.json({
          metas: channels.map((channel) => ({
            id: channel.id,
            type: "channel",
            name: channel.name,
            poster: channel.logo || PT_HUB_LOGO,
            logo: channel.logo || PT_HUB_LOGO,
            description: channel.group || "RTP Play"
          }))
        });

      }


      const operator =
        getOperatorById(catalogId);

      if (operator) {

        const channels =
          getOperatorChannels(operator);

        return res.json({
          metas: channels.map((channel) => ({
            id: channel.id,
            type: "channel",
            name: channel.name,
            poster: channel.logo || PT_HUB_LOGO,
            logo: channel.logo || PT_HUB_LOGO,
            description:
              channel.group
                ? `Operador: ${channel.group}`
                : ""
          }))
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


app.get(
  "/:config/catalog/channel/:id/:extra.json",
  async (req, res) => {

    try {

      const config =
        decodeConfig(req.params.config);

      const catalogId =
        req.params.id;

      const { search } =
        parseExtra(req.params.extra);

      let metas = [];

      if (catalogId === "pt-services") {

        metas = services.map(
          (service, index) => ({
            id: service.id || `pttv:${index}`,
            type: "channel",
            name: service.name || "Serviço TV",
            poster: service.logo || service.poster || PT_HUB_LOGO,
            logo: service.logo || service.poster || PT_HUB_LOGO,
            description: service.description || ""
          })
        );

      } else if (catalogId === "m3u") {

        if (config) {

          const channels =
            await getIPTVChannels(config);

          metas = channels.map((channel) => ({
            id: channel.id,
            type: "channel",
            name: channel.name,
            poster: channel.logo || PT_HUB_LOGO,
            logo: channel.logo || PT_HUB_LOGO,
            description:
              channel.group ? `Grupo: ${channel.group}` : ""
          }));

        }

      } else {

        const operator =
          getOperatorById(catalogId);

        if (operator) {

          const channels =
            getOperatorChannels(operator);

          metas = channels.map((channel) => ({
            id: channel.id,
            type: "channel",
            name: channel.name,
            poster: channel.logo || PT_HUB_LOGO,
            logo: channel.logo || PT_HUB_LOGO,
            description:
              channel.group ? `Operador: ${channel.group}` : ""
          }));

        }

      }

      return res.json({
        metas: filterMetasBySearch(metas, search)
      });

    } catch (error) {

      console.error(
        "Erro na pesquisa de canais:",
        error.message
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

/*=========================================================
   CATALOG - PLATAFORMAS
   ========================================================= */

app.get(
  "/:config/catalog/movie/:id.json",
  async (req, res) => {

    try {

      const id =
        req.params.id;

      const config =
        decodeConfig(req.params.config);

      const country =
        config?.catalogCountry;

      const ptHubCatalog =
        await getPtHubAggregateCatalog(
          config,
          "movie",
          id,
          {}
        );

      if (ptHubCatalog) {
        return res.json(ptHubCatalog);
      }

      // Compatibilidade com links antigos que ainda usem IDs dinâmicos.
      const ptExternalCatalog =
        await getPtExternalCatalog(
          config,
          "movie",
          id,
          {}
        );

      if (ptExternalCatalog) {
        return res.json(ptExternalCatalog);
      }

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

if (id === "cinema-new") {

return res.json(
await getDiscoveryCatalog(
"movie",
"cinema",
country
)
);

}

if (id === "movie-new") {

return res.json(
await getDiscoveryCatalog(
"movie",
"new",
country
)
);

}

if (id === "featured") {

return res.json(
await getFeaturedCatalog(
"movie",
country
)
);

}

if (id === "movie-top") {

return res.json(
await getDiscoveryCatalog(
"movie",
"popular",
country
)
);

}

return res.json(
await getJustWatchCatalog(
"movie",
id,
country
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
  "/:config/catalog/movie/:id/:extra.json",
  async (req, res) => {

    try {

      const id = req.params.id;

      const config =
        decodeConfig(req.params.config);

      const country =
        config?.catalogCountry;

      const extra =
        parseExtra(req.params.extra);

      const { search } = extra;

      const ptHubCatalog =
        await getPtHubAggregateCatalog(
          config,
          "movie",
          id,
          extra
        );

      if (ptHubCatalog) {
        return res.json(ptHubCatalog);
      }

      // Compatibilidade com links antigos que ainda usem IDs dinâmicos.
      const ptExternalCatalog =
        await getPtExternalCatalog(
          config,
          "movie",
          id,
          extra
        );

      if (ptExternalCatalog) {
        return res.json(ptExternalCatalog);
      }

      const validCatalog =
        movieCatalogs.some(
          (catalog) => catalog.id === id
        );

      if (!validCatalog) {
        return res.json({ metas: [] });
      }

      let data;
      let alreadyFiltered = false;

      if (id === "cinema-new") {
        data = await getDiscoveryCatalog("movie", "cinema", country);
      } else if (id === "movie-new") {
        data = await getDiscoveryCatalog("movie", "new", country);
      } else if (id === "featured") {
        data = await getFeaturedCatalog("movie", country);
      } else if (id === "movie-top") {
        data = await getDiscoveryCatalog("movie", "popular", country);
      } else {
        data = await getJustWatchCatalog("movie", id, country);
      }

      return res.json({
        metas:
          alreadyFiltered
            ? (data.metas || [])
            : filterMetasBySearch(data.metas || [], search)
      });

    } catch (error) {

      console.error(
        "Erro na pesquisa de filmes:",
        error.message
      );

      return res.json({ metas: [] });

    }

  }
);


app.get(
  "/:config/catalog/series/:id.json",
  async (req, res) => {

    try {

      const id =
        req.params.id;

      const config =
        decodeConfig(req.params.config);

      const country =
        config?.catalogCountry;

      const ptHubCatalog =
        await getPtHubAggregateCatalog(
          config,
          "series",
          id,
          {}
        );

      if (ptHubCatalog) {
        return res.json(ptHubCatalog);
      }

      // Compatibilidade com links antigos que ainda usem IDs dinâmicos.
      const ptExternalCatalog =
        await getPtExternalCatalog(
          config,
          "series",
          id,
          {}
        );

      if (ptExternalCatalog) {
        return res.json(ptExternalCatalog);
      }

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

if (id === "series-new") {

return res.json(
await getDiscoveryCatalog(
"series",
"new",
country
)
);

}

if (id === "featured") {

return res.json(
await getFeaturedCatalog(
"series",
country
)
);

}

if (id === "series-top") {

return res.json(
await getDiscoveryCatalog(
"series",
"popular",
country
)
);

}

return res.json(
await getJustWatchCatalog(
"series",
id,
country
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


app.get(
  "/:config/catalog/series/:id/:extra.json",
  async (req, res) => {

    try {

      const id = req.params.id;

      const config =
        decodeConfig(req.params.config);

      const country =
        config?.catalogCountry;

      const extra =
        parseExtra(req.params.extra);

      const { search } = extra;

      const ptHubCatalog =
        await getPtHubAggregateCatalog(
          config,
          "series",
          id,
          extra
        );

      if (ptHubCatalog) {
        return res.json(ptHubCatalog);
      }

      // Compatibilidade com links antigos que ainda usem IDs dinâmicos.
      const ptExternalCatalog =
        await getPtExternalCatalog(
          config,
          "series",
          id,
          extra
        );

      if (ptExternalCatalog) {
        return res.json(ptExternalCatalog);
      }

      const validCatalog =
        seriesCatalogs.some(
          (catalog) => catalog.id === id
        );

      if (!validCatalog) {
        return res.json({ metas: [] });
      }

      let data;
      let alreadyFiltered = false;

      if (id === "series-new") {
        data = await getDiscoveryCatalog("series", "new", country);
      } else if (id === "featured") {
        data = await getFeaturedCatalog("series", country);
      } else if (id === "series-top") {
        data = await getDiscoveryCatalog("series", "popular", country);
      } else {
        data = await getJustWatchCatalog("series", id, country);
      }

      return res.json({
        metas:
          alreadyFiltered
            ? (data.metas || [])
            : filterMetasBySearch(data.metas || [], search)
      });

    } catch (error) {

      console.error(
        "Erro na pesquisa de séries:",
        error.message
      );

      return res.json({ metas: [] });

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

        if (id.startsWith("pthubptmeta:")) {
          const data =
            await getPtExternalMeta(
              config,
              type,
              id
            );

          return res.json(
            data || { meta: null }
          );
        }

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

        if (id.startsWith("operator:")) {

          const operatorId = id.split(":")[1];
          const operator = getOperatorById(operatorId);
          const channels = getOperatorChannels(operator);
          const channel = channels.find((item) => item.id === id);

          if (!channel) {
            return res.json({ meta: null });
          }

          return res.json({
            meta: {
              id: channel.id,
              type: "channel",
              name: channel.name,
              poster: channel.logo || PT_HUB_LOGO,
              logo: channel.logo || PT_HUB_LOGO,
              description:
                channel.group
                  ? `Operador: ${channel.group}`
                  : ""
            }
          });

        }

        if (
          id.startsWith("m3u:") ||
          id.startsWith("xtream:") ||
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
   FONTES EXTERNAS DE STREAMS (ex: Torrentio e semelhantes)
   ========================================================= 
   Agrega resultados de qualquer addon Stremio compatível que
   o utilizador indique na configuração, e limita a quantidade
   de resultados apresentados por qualidade de vídeo.
   ========================================================= */

function detectStreamQuality(stream) {

  const text =
    `${stream.name || ""} ${stream.title || stream.description || ""}`
      .toLowerCase();

  if (/\b(2160p|4k|uhd)\b/.test(text)) {
    return "4K";
  }

  if (/\b1080p\b/.test(text)) {
    return "1080p";
  }

  if (/\b720p\b/.test(text)) {
    return "720p";
  }

  if (/\b(480p|sd)\b/.test(text)) {
    return "480p";
  }

  return "Outra";

}

function detectStreamSeeds(stream) {

  const direct =
    Number(
      stream?.seeds ??
      stream?.seeders ??
      stream?.behaviorHints?.seeders ??
      0
    );

  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const text =
    `${stream.name || ""} ${stream.title || stream.description || ""}`;

  const match =
    text.match(/(?:👤|👥)\D{0,5}(\d+)/) ||
    text.match(/(?:seeders?|seeds?|s:)\s*[:=]?\s*(\d+)/i) ||
    text.match(/(\d+)\s*(?:seeders?|seeds?)/i);

  return match ? parseInt(match[1], 10) : 0;

}

const externalSourceNameCache = new Map();

async function getExternalSourceName(normalizedBase) {

  const cached =
    externalSourceNameCache.get(normalizedBase);

  if (
    cached &&
    (Date.now() - cached.time) < (24 * 60 * 60 * 1000)
  ) {
    return cached.name;
  }

  try {

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response =
      await fetch(`${normalizedBase}/manifest.json`, {
        signal: controller.signal,
        headers: { "User-Agent": `PT-HUB/${VERSION}` }
      });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const manifest = await response.json();

    const name =
      String(manifest?.name || "").trim() || null;

    externalSourceNameCache.set(normalizedBase, {
      name,
      time: Date.now()
    });

    return name;

  } catch (error) {

    externalSourceNameCache.set(normalizedBase, {
      name: null,
      time: Date.now()
    });

    return null;

  }

}

async function fetchExternalStreamSource(baseUrl, type, id) {

  const normalizedBase =
    normalizeUrl(baseUrl).replace(/\/manifest\.json$/i, "");

  if (!isValidHttpUrl(normalizedBase)) {
    return [];
  }

  const url =
    `${normalizedBase}/stream/${encodeURIComponent(type)}/${id}.json`;

  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => controller.abort(), 12000);

  try {

    const [response, sourceName] =
      await Promise.all([
        fetch(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": `PT-HUB/${VERSION}`,
            "Accept": "application/json"
          }
        }),
        getExternalSourceName(normalizedBase)
      ]);

    clearTimeout(timeout);

    if (!response.ok) {
      return [];
    }

    const data =
      await response.json();

    const streams =
      Array.isArray(data?.streams)
        ? data.streams
        : [];

    if (!sourceName) {
      return streams;
    }

    return streams.map((stream) => ({
      ...stream,
      name:
        `🔗 ${sourceName}` +
        (stream.name ? `\n${stream.name}` : "")
    }));

  } catch (error) {

    clearTimeout(timeout);

    console.error(
      `Erro ao obter streams externos de ${normalizedBase}:`,
      error.message
    );

    return [];

  }

}


/* =========================================================
   FONTES INTEGRADAS PT•HUB — 2.1.3
   =========================================================
   Estes manifests passam a fazer parte do PT•HUB. As fontes
   que fornecem "stream" entram automaticamente na agregação.
   As restantes ficam registadas para catálogo/meta/legendas e
   para evolução da arquitetura 3.0.
   ========================================================= */

const PT_BUILTIN_ADDONS = [
  {
    id: "opensubtitles-official",
    name: "OpenSubtitles Official",
    manifestUrl: "https://opensubtitles.strem.io/stremio/v3/official/manifest.json",
    resources: ["subtitles"]
  },
  {
    id: "watchhub",
    name: "WatchHub",
    manifestUrl: "https://watchhub-us.strem.io/manifest.json",
    resources: ["stream"]
  },
  {
    id: "cinemeta-rpdb",
    name: "Cinemeta RPDB",
    manifestUrl: "https://cinemeta.ratingposterdb.com/manifest.json",
    resources: ["catalog", "meta", "addon_catalog"]
  },
  {
    id: "streaming-catalogs",
    name: "Streaming Catalogs",
    manifestUrl: "https://7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club/manifest.json",
    resources: ["catalog"]
  },
  {
    id: "torrentio",
    name: "Torrentio",
    manifestUrl: "https://torrentio.strem.fun/manifest.json",
    resources: ["stream"]
  },
  {
    id: "torrentsdb",
    name: "TorrentsDB",
    manifestUrl: "https://torrentsdb.com/manifest.json",
    resources: ["stream"]
  },
  {
    id: "ytztvio",
    name: "Ytztvio",
    manifestUrl: "https://ytztvio.galacticcapsule.workers.dev/manifest.json",
    resources: ["stream"]
  },
  {
    id: "torrent-catalogs",
    name: "Torrent Catalogs",
    manifestUrl: "https://torrent-catalogs.strem.fun/manifest.json",
    resources: ["catalog"]
  },
  {
    id: "thepiratebay-plus",
    name: "ThePirateBay+",
    manifestUrl: "https://thepiratebay-plus.strem.fun/manifest.json",
    resources: ["stream"]
  },
  {
    id: "marvel",
    name: "Marvel",
    manifestUrl: "https://addon-marvel.gonp.deno.net/manifest.json",
    resources: ["catalog", "meta"]
  },
  {
    id: "tmdb",
    name: "The Movie Database Addon",
    manifestUrl: "https://94c8cb9f702d-tmdb-addon.baby-beamup.club/manifest.json",
    resources: ["catalog", "meta"]
  }
];

function getBuiltinStreamSources() {
  return PT_BUILTIN_ADDONS
    .filter((addon) => Array.isArray(addon.resources) && addon.resources.includes("stream"))
    .map((addon) => addon.manifestUrl);
}

function getExternalStreamUniqueKey(stream) {
  const infoHash = String(stream?.infoHash || "").trim().toLowerCase();
  if (infoHash) {
    const fileIdx = Number.isFinite(stream?.fileIdx) ? stream.fileIdx : "";
    return `hash:${infoHash}:${fileIdx}`;
  }

  const url = String(
    stream?.url ||
    stream?.externalUrl ||
    stream?.ytId ||
    stream?.title ||
    ""
  ).trim();

  return url ? `url:${url}` : "";
}

async function getExternalStreams(config, type, id) {

  const customSources =
    Array.isArray(config?.externalStreamSources)
      ? config.externalStreamSources.filter(Boolean)
      : [];

  // Fontes integradas funcionam sempre. "Fontes Externas" é agora
  // apenas uma forma de acrescentar providers extra escolhidos pelo utilizador.
  const sources = [...new Set(
    [...getBuiltinStreamSources(), ...customSources]
      .map((source) => normalizeUrl(source))
      .filter(isValidHttpUrl)
  )];

  if (!sources.length) {
    return [];
  }

  const maxPerQuality =
    Number.isFinite(config?.externalStreamMaxPerQuality) &&
    config.externalStreamMaxPerQuality > 0
      ? config.externalStreamMaxPerQuality
      : 2;

  const results =
    await Promise.all(
      sources.map((source) =>
        fetchExternalStreamSource(source, type, id)
      )
    );

  const allStreams =
    results.flat();

  // Evita que o mesmo torrent/stream apareça repetido por providers diferentes.
  const dedupedStreams = [];
  const seenStreamKeys = new Set();

  for (const stream of allStreams) {
    const key = getExternalStreamUniqueKey(stream);

    if (key && seenStreamKeys.has(key)) {
      continue;
    }

    if (key) {
      seenStreamKeys.add(key);
    }

    dedupedStreams.push(stream);
  }

  const byQuality = new Map();

  for (const stream of dedupedStreams) {

    const quality =
      detectStreamQuality(stream);

    if (!byQuality.has(quality)) {
      byQuality.set(quality, []);
    }

    byQuality.get(quality).push({
      ...stream,
      _seeds: detectStreamSeeds(stream)
    });

  }

  const limited = [];

  const qualityOrder =
    ["4K", "1080p", "720p", "480p", "Outra"];

  for (const quality of qualityOrder) {

    const group =
      byQuality.get(quality);

    if (!group) {
      continue;
    }

    group.sort((a, b) => b._seeds - a._seeds);

    for (const stream of group.slice(0, maxPerQuality)) {
      const { _seeds, ...clean } = stream;
      limited.push(clean);
    }

  }

  return limited;

}


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

        if (id.startsWith("operator:")) {

          const operatorId = id.split(":")[1];
          const operator = getOperatorById(operatorId);
          const channels = getOperatorChannels(operator);
          const channel = channels.find((item) => item.id === id);

          if (!channel) {
            return res.json({ streams: [] });
          }

          return res.json({
            streams: [
              {
                name: "PT•HUB",
                title: channel.name,
                url: channel.url,
                behaviorHints: { notWebReady: true }
              }
            ]
          });

        }

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
                notWebReady: true
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

        if (id.startsWith("pthubptmeta:")) {
          const sourceStreams =
            await getPtExternalStreams(
              config,
              type,
              id
            );

          return res.json({
            streams:
              Array.isArray(sourceStreams)
                ? sourceStreams
                : []
          });
        }

        const streams =
          await getExternalStreams(
            config,
            type,
            id
          );

        return res.json({
          streams
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
   SUBTITLES (OpenSubtitles)
   ========================================================= */

const OPENSUBTITLES_BASE =
  "https://opensubtitles.strem.io/stremio/v3/official";

app.get(
  "/:config/subtitles/:type/:id.json",
  async (req, res) => {

    try {

      const config =
        decodeConfig(req.params.config);

      if (config?.features?.subtitles === false) {
        return res.json({ subtitles: [] });
      }

      const url =
        `${OPENSUBTITLES_BASE}/subtitles/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}.json`;

      const response =
        await fetch(url, {
          headers: { "User-Agent": `PT-HUB/${VERSION}` }
        });

      if (!response.ok) {
        return res.json({ subtitles: [] });
      }

      const data = await response.json();

      return res.json({
        subtitles: Array.isArray(data?.subtitles) ? data.subtitles : []
      });

    } catch (error) {

      console.error(
        "Erro subtitles:",
        error.message
      );

      return res.json({ subtitles: [] });

    }

  }
);


app.get(
  "/:config/subtitles/:type/:id/:extra.json",
  async (req, res) => {

    try {

      const config =
        decodeConfig(req.params.config);

      if (config?.features?.subtitles === false) {
        return res.json({ subtitles: [] });
      }

      const url =
        `${OPENSUBTITLES_BASE}/subtitles/${encodeURIComponent(req.params.type)}/${encodeURIComponent(req.params.id)}/${req.params.extra}`;

      const response =
        await fetch(url, {
          headers: { "User-Agent": `PT-HUB/${VERSION}` }
        });

      if (!response.ok) {
        return res.json({ subtitles: [] });
      }

      const data = await response.json();

      return res.json({
        subtitles: Array.isArray(data?.subtitles) ? data.subtitles : []
      });

    } catch (error) {

      console.error(
        "Erro subtitles (extra):",
        error.message
      );

      return res.json({ subtitles: [] });

    }

  }
);


/* =========================================================
   HOME
   ========================================================= */

app.get("/", (req, res) => {

  res.redirect(302, "/configure");

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
