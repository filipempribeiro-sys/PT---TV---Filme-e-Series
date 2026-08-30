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

const VERSION = "2.1.0";

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
    prefix: "🗣️"
  },
  portuguese: {
    key: "portuguese",
    label: "Filmes, Séries e Novelas Portuguesas",
    prefix: "🇵🇹"
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

function getPtCatalogDisplayName(group, sourceName, catalogName) {
  const groupInfo = PT_SOURCE_GROUPS[group];
  const source = String(sourceName || "Fonte externa").trim();
  const catalog = String(catalogName || "Conteúdo").trim();

  return `${groupInfo.prefix} ${source} — ${catalog}`;
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
  if (!config?.features?.ptContent) {
    return [];
  }

  const jobs = [];

  for (const group of Object.keys(PT_SOURCE_GROUPS)) {
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
          catalog.name
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

  const mode =
    ["xtream", "iptv-org"].includes(config.mode)
      ? config.mode
      : "m3u";

  const m3uUrl = config.m3uUrl || "";
  const catalogCountry = config.catalogCountry || "";
  const m3uSource = config.m3uSource === "file" ? "file" : "url";
  const xtreamServer = config.xtreamServer || "";
  const username = config.username || "";
  const epgUrl = config.epgUrl || "";

  const features = config.features || {};

  const enabledFeatured = features.featured === true;
  const enabledStreamers = features.streamers === true;
  const enabledOperators = features.operators === true;
  const enabledIPTV = features.iptv === true;
  const enabledSubtitles = features.subtitles === true;
  const enabledPtContent = features.ptContent === true;
  const ptContent = features.ptContentSources || {};
  const rtpPlayChecked = ptContent.rtpPlay === true;

  const selectedPtContentSources = config.ptContentSelectedSources || {};

  const selectedPtPtSources =
    Array.isArray(selectedPtContentSources.ptpt)
      ? selectedPtContentSources.ptpt
      : [];

  const selectedPortugueseSources =
    Array.isArray(selectedPtContentSources.portuguese)
      ? selectedPtContentSources.portuguese
      : [];

  const ptPtEnabledChecked =
    ptContent.ptPt === true ||
    selectedPtPtSources.length > 0 ||
    (Array.isArray(config?.ptContentExternalSources?.ptpt) &&
      config.ptContentExternalSources.ptpt.length > 0);

  const portugueseProductionEnabledChecked =
    ptContent.portugueseProduction === true ||
    selectedPortugueseSources.length > 0 ||
    (Array.isArray(config?.ptContentExternalSources?.portuguese) &&
      config.ptContentExternalSources.portuguese.length > 0);

  const cotonetChecked =
    selectedPtPtSources.includes("cotonet") ? "checked" : "";

  const portugueseAddonChecked =
    selectedPortugueseSources.includes("filmes-series-novelas-portuguesas")
      ? "checked"
      : "";

  const ptPtSourcesText =
    Array.isArray(config?.ptContentExternalSources?.ptpt)
      ? config.ptContentExternalSources.ptpt.join("\n")
      : "";

  const portugueseSourcesText =
    Array.isArray(config?.ptContentExternalSources?.portuguese)
      ? config.ptContentExternalSources.portuguese.join("\n")
      : "";

  const enabledExternalSources = features.externalSources === true;

  const externalStreamSourcesText =
    Array.isArray(config.externalStreamSources)
      ? config.externalStreamSources.join("\n")
      : "";

  const externalStreamMaxPerQuality =
    Number.isFinite(config.externalStreamMaxPerQuality)
      ? config.externalStreamMaxPerQuality
      : 2;

  const featuredContent = features.featuredContent || {};
  const featuredMoviesChecked = featuredContent.movies === true;
  const featuredSeriesChecked = featuredContent.series === true;

  const selectedStreamerMovies =
    Array.isArray(features.selectedStreamerMovies)
      ? features.selectedStreamerMovies
      : (Array.isArray(features.selectedStreamers)
          ? features.selectedStreamers
          : []);

  const selectedStreamerSeries =
    Array.isArray(features.selectedStreamerSeries)
      ? features.selectedStreamerSeries
      : (Array.isArray(features.selectedStreamers)
          ? features.selectedStreamers
          : []);

  const selectedOperators =
    Array.isArray(features.selectedOperators)
      ? features.selectedOperators
      : [];

  const iptvOrg = config.iptvOrg || {};
  const iptvOrgCountry = iptvOrg.country || "";
  const iptvOrgCategory = iptvOrg.category || "";
  const iptvOrgCatalogName = iptvOrg.catalogName || "";

  const xtreamShow = config.xtreamShow || {};
  const xtreamShowLiveChecked = xtreamShow.live !== false;

  const xtreamEpgMode =
    ["url", "none"].includes(config.xtreamEpgMode)
      ? config.xtreamEpgMode
      : "auto";

  const xtreamEpgOffset =
    Number.isFinite(config.xtreamEpgOffset)
      ? config.xtreamEpgOffset
      : 0;

  const xtreamEpgUrl = config.xtreamEpgUrl || "";
  const xtreamCatalogName = config.xtreamCatalogName || "";

  const m3uEpgMode =
    ["playlist", "none"].includes(config.m3uEpgMode)
      ? config.m3uEpgMode
      : "url";

  const m3uEpgOffset =
    Number.isFinite(config.m3uEpgOffset)
      ? config.m3uEpgOffset
      : 0;

  const globalUserAgent = config.globalUserAgent || "";
  const m3uCatalogName = config.m3uCatalogName || "";

  function sanitizeId(value) {
    return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  const streamerCheckboxes = streamers.map(function (streamer) {

    const domId = "streamer_" + sanitizeId(streamer.id);

    const types =
      Array.isArray(streamer.type) && streamer.type.length
        ? streamer.type
        : ["movie", "series"];

    const moviesChecked =
      selectedStreamerMovies.includes(streamer.id) ? "checked" : "";

    const seriesChecked =
      selectedStreamerSeries.includes(streamer.id) ? "checked" : "";

    const movieOption =
      types.includes("movie")
        ? (
          '          <label class="option-item">\n' +
          '            <input type="checkbox" id="' + domId + '_movies" value="' + escapeHtml(streamer.id) + '" ' + moviesChecked + '>\n' +
          '            <span>Filmes</span>\n' +
          '          </label>\n'
        )
        : "";

    const seriesOption =
      types.includes("series")
        ? (
          '          <label class="option-item">\n' +
          '            <input type="checkbox" id="' + domId + '_series" value="' + escapeHtml(streamer.id) + '" ' + seriesChecked + '>\n' +
          '            <span>Séries</span>\n' +
          '          </label>\n'
        )
        : "";

    return (
      '        <div class="streamer-block">\n' +
      '          <div class="streamer-name">' + escapeHtml(streamer.name) + '</div>\n' +
      '          <div class="streamer-options">\n' +
      movieOption +
      seriesOption +
      '          </div>\n' +
      '        </div>\n'
    );
  }).join("");

  const operatorCheckboxes = operators.map(function (operator) {
    const domId = "operator_" + sanitizeId(operator.id);
    const checked = selectedOperators.includes(operator.id) ? "checked" : "";
    return (
      '        <label class="option-item">\n' +
      '          <input type="checkbox" id="' + domId + '" value="' + escapeHtml(operator.id) + '" ' + checked + '>\n' +
      '          <span>' + escapeHtml(operator.name) + '</span>\n' +
      '        </label>\n'
    );
  }).join("");

  const streamerMovieIdsJs =
    JSON.stringify(
      streamers
        .filter(function (streamer) {
          const types =
            Array.isArray(streamer.type) && streamer.type.length
              ? streamer.type
              : ["movie", "series"];
          return types.includes("movie");
        })
        .map(function (streamer) {
          return "streamer_" + sanitizeId(streamer.id) + "_movies";
        })
    );

  const streamerSeriesIdsJs =
    JSON.stringify(
      streamers
        .filter(function (streamer) {
          const types =
            Array.isArray(streamer.type) && streamer.type.length
              ? streamer.type
              : ["movie", "series"];
          return types.includes("series");
        })
        .map(function (streamer) {
          return "streamer_" + sanitizeId(streamer.id) + "_series";
        })
    );

  const operatorIdsJs =
    JSON.stringify(
      operators.map(function (operator) {
        return "operator_" + sanitizeId(operator.id);
      })
    );

  return `
<!DOCTYPE html>
<html lang="pt-PT">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PT•HUB — Configuração</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pako/2.2.0/pako.min.js"></script>

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
select,
textarea {
  width: 100%;
  padding: 13px 14px;
  border-radius: 10px;
  border: 1px solid rgba(218,146,28,.20);
  background: var(--pt-bg-card);
  color: var(--pt-text);
  font-size: 15px;
  outline: none;
  font-family: inherit;
  resize: vertical;
}

input:focus,
select:focus,
textarea:focus {
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

.streamer-block {
  padding: 12px 4px;
  border-bottom: 1px solid rgba(218,146,28,.10);
}

.streamer-block:last-child {
  border-bottom: none;
}

.streamer-name {
  font-weight: 600;
  margin-bottom: 8px;
  font-size: 14px;
}

.streamer-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
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
          id="ptContentEnabled"
          ${enabledPtContent ? "checked" : ""}
        >
        <span>Português</span>
      </label>

      <label class="feature-item">
        <input
          type="checkbox"
          id="iptvEnabled"
          ${enabledIPTV ? "checked" : ""}
        >
        <span>IPTV</span>
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
          id="subtitlesEnabled"
          ${enabledSubtitles ? "checked" : ""}
        >
        <span>Legendas</span>
      </label>

      <label class="feature-item">
        <input
          type="checkbox"
          id="externalSourcesEnabled"
          ${enabledExternalSources ? "checked" : ""}
        >
        <span>Fontes Externas</span>
      </label>

    </div>

    <!-- =========================================================
         DESTAQUES
         ========================================================= -->

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
            ${featuredMoviesChecked ? "checked" : ""}
          >
          <span>Filmes</span>
        </label>

        <label class="option-item">
          <input
            type="checkbox"
            id="featuredSeries"
            ${featuredSeriesChecked ? "checked" : ""}
          >
          <span>Séries</span>
        </label>

      </div>

    </div>

    <!-- =========================================================
         STREAMERS
         ========================================================= -->

    <div id="streamersContainer" class="config-panel">

      <h2 class="panel-title">Streamers</h2>

      <p class="panel-description">
        Seleciona um ou vários streamers. Para cada um, escolhe se queres
        Filmes, Séries ou ambos.
      </p>

      <label class="field-label" for="catalogCountry">
        País do Catálogo
      </label>

      <input
        id="catalogCountry"
        type="text"
        maxlength="2"
        placeholder="PT"
        value="${escapeHtml(catalogCountry)}"
      >

      <div class="help">
        Código de país de 2 letras (ex: PT, BR, ES). Define de que país vêm
        os catálogos de Streamers e Destaques. Deixa em branco para Portugal.
      </div>

      <div class="option-grid">
${streamerCheckboxes}
      </div>

    </div>

    <!-- =========================================================
         PORTUGUÊS
         ========================================================= -->

    <div id="ptContentContainer" class="config-panel">

      <h2 class="panel-title">🇵🇹 Português</h2>

      <p class="panel-description">
        Mantém separadas duas famílias diferentes: conteúdos internacionais
        disponíveis em Português de Portugal (PT-PT) e obras de produção
        portuguesa. Cada família tem as suas próprias fontes externas.
      </p>

      <div class="subsection" style="margin-top:0;padding-top:0;border-top:0;">

        <h3 class="subsection-title">🗣️ Filmes e Séries em PT-PT</h3>

        <label class="option-item">
          <input
            type="checkbox"
            id="ptPtEnabled"
            ${ptPtEnabledChecked ? "checked" : ""}
          >
          <span>Ativar Filmes e Séries em PT-PT</span>
        </label>

        <div class="subsection" style="margin-top:12px;">
          <h4 class="subsection-title">Fontes disponíveis</h4>

          <label class="option-item">
            <input
              type="checkbox"
              id="ptSourceCotonet"
              value="cotonet"
              ${cotonetChecked}
            >
            <span>Cotonet</span>
          </label>

          <div class="help">
            Filmes em Português de Portugal. O endereço do addon já está
            integrado no PT•HUB; basta selecionar esta fonte.
          </div>
        </div>

        <details class="subsection">
          <summary class="subsection-title" style="cursor:pointer;">
            Fonte personalizada (opcional)
          </summary>

          <label class="field-label" for="ptPtAddonSources">
            URLs adicionais de addons PT-PT
          </label>

          <textarea
            id="ptPtAddonSources"
            rows="3"
            placeholder="https://exemplo-addon.pt/manifest.json"
          >${escapeHtml(ptPtSourcesText)}</textarea>

          <div class="help">
            Opcional. Um URL por linha para acrescentar outras fontes
            Stremio compatíveis sem alterar o código do PT•HUB.
          </div>
        </details>

      </div>

      <div class="subsection">

        <h3 class="subsection-title">🇵🇹 Filmes, Séries e Novelas Portuguesas</h3>

        <label class="option-item">
          <input
            type="checkbox"
            id="portugueseProductionEnabled"
            ${portugueseProductionEnabledChecked ? "checked" : ""}
          >
          <span>Ativar Produção Portuguesa</span>
        </label>

        <div class="subsection" style="margin-top:12px;">
          <h4 class="subsection-title">Fontes disponíveis</h4>

          <label class="option-item">
            <input
              type="checkbox"
              id="ptSourcePortugueseProductions"
              value="filmes-series-novelas-portuguesas"
              ${portugueseAddonChecked}
            >
            <span>Filmes, Séries e Novelas Portuguesas</span>
          </label>

          <div class="help">
            Filmes, séries e novelas de produção portuguesa. O endereço
            do addon já está integrado no PT•HUB.
          </div>
        </div>

        <details class="subsection">
          <summary class="subsection-title" style="cursor:pointer;">
            Fonte personalizada (opcional)
          </summary>

          <label class="field-label" for="portugueseAddonSources">
            URLs adicionais de addons de produção portuguesa
          </label>

          <textarea
            id="portugueseAddonSources"
            rows="3"
            placeholder="https://exemplo-addon-portugues.pt/manifest.json"
          >${escapeHtml(portugueseSourcesText)}</textarea>

          <div class="help">
            Opcional. Esta lista continua independente da família PT-PT.
          </div>
        </details>

      </div>

      <div class="subsection">

        <h3 class="subsection-title">📡 RTP Play</h3>

        <label class="option-item">
          <input
            type="checkbox"
            id="rtpPlayEnabled"
            value="rtpPlay"
            ${rtpPlayChecked ? "checked" : ""}
          >
          <span>Ativar RTP Play</span>
        </label>

        <div class="help">
          Mantém-se preparado para integração através de interfaces
          públicas/oficiais da RTP, sem contornar autenticação, DRM ou
          proteções técnicas.
        </div>

      </div>

    </div>

    <!-- =========================================================
         IPTV
         ========================================================= -->

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

      <!-- =======================================================
           IPTV-ORG
           ======================================================= -->

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
        value="${escapeHtml(iptvOrgCountry)}"
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
        value="${escapeHtml(iptvOrgCategory)}"
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
          value="${escapeHtml(iptvOrgCatalogName)}"
          >

          <div class="help">
            Nome apresentado na lista de canais do Stremio.
            Deixa em branco para utilizar o nome predefinido.
          </div>

        </div>

      </div>

      <!-- =======================================================
           XTREAM API
           ======================================================= -->

      <div id="xtreamSection" class="section">

        <h3 class="panel-title">Credentials</h3>

        <label class="field-label" for="xtreamServer">
          Base URL <span class="required">*</span>
        </label>

        <input
          id="xtreamServer"
          type="url"
          placeholder="https://servidor.com:8080"
        value="${escapeHtml(xtreamServer)}"
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
        value="${escapeHtml(username)}"
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
                ${xtreamShowLiveChecked ? "checked" : ""}
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
            <option value="auto" ${xtreamEpgMode === "auto" ? "selected" : ""}>Auto</option>
            <option value="url" ${xtreamEpgMode === "url" ? "selected" : ""}>URL personalizada</option>
            <option value="none" ${xtreamEpgMode === "none" ? "selected" : ""}>Desativado</option>
          </select>

          <label class="field-label" for="xtreamEpgOffset">
            EPG Offset (hours)
          </label>

          <input
            id="xtreamEpgOffset"
            type="number"
            step="1"
            value="${xtreamEpgOffset}"
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
            value="${escapeHtml(xtreamEpgUrl)}"
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
          value="${escapeHtml(xtreamCatalogName)}"
          >

          <div class="help">
            Nome apresentado na lista de canais do Stremio.
            Deixa em branco para utilizar o nome predefinido.
          </div>

        </div>

      </div>

      <!-- =======================================================
           M3U / M3U+
           ======================================================= -->

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
              ${m3uSource === "url" ? "checked" : ""}
            >
            <span>Playlist por URL</span>
          </label>

          <label class="source-option">
            <input
              type="radio"
              name="m3uSource"
              id="m3uSourceFile"
              value="file"
            ${m3uSource === "file" ? "checked" : ""}
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
          value="${escapeHtml(m3uUrl)}"
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
            <option value="url" ${m3uEpgMode === "url" ? "selected" : ""}>URL personalizada</option>
            <option value="playlist" ${m3uEpgMode === "playlist" ? "selected" : ""}>Da playlist / provider</option>
            <option value="none" ${m3uEpgMode === "none" ? "selected" : ""}>Desativado</option>
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
          value="${escapeHtml(epgUrl)}"
          >

          <label class="field-label" for="m3uEpgOffset">
            EPG Offset (hours)
          </label>

          <input
            id="m3uEpgOffset"
            type="number"
            step="1"
            value="${m3uEpgOffset}"
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
          value="${escapeHtml(globalUserAgent)}"
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
          value="${escapeHtml(m3uCatalogName)}"
          >

          <div class="help">
            Nome apresentado na lista de canais do Stremio.
            Deixa em branco para utilizar o nome predefinido.
          </div>

        </div>

      </div>

    </div>

    <!-- =========================================================
         OPERADORES
         ========================================================= -->

    <div id="operatorsContainer" class="config-panel">

      <h2 class="panel-title">Operadores PT</h2>

      <p class="panel-description">
        Seleciona os operadores que queres disponibilizar no addon.
        Podes escolher um ou vários.
      </p>

      <div class="option-grid">
${operatorCheckboxes}
      </div>

    </div>

    <!-- =========================================================
         LEGENDAS
         ========================================================= -->

    <div class="config-panel" id="subtitlesPanel">

      <h2 class="panel-title">Legendas</h2>

      <p class="panel-description">
        Adiciona legendas automáticas (OpenSubtitles) a filmes e séries.
      </p>

    </div>

    <!-- =========================================================
         FONTES EXTERNAS
         ========================================================= -->

    <div class="config-panel" id="externalSourcesPanel">

      <h2 class="panel-title">Fontes Externas</h2>

      <p class="panel-description">
        Agrega streams de outros addons Stremio (ex: Torrentio) diretamente
        nas fichas de filmes/séries deste addon. Cola abaixo o URL do
        addon (o mesmo que usarias para o instalar normalmente), um por
        linha.
      </p>

      <label class="field-label" for="externalStreamSources">
        URLs dos addons (um por linha)
      </label>

      <textarea
        id="externalStreamSources"
        rows="4"
        placeholder="https://torrentio.strem.fun"
      >${escapeHtml(externalStreamSourcesText)}</textarea>

      <div class="help">
        Usa o URL base do addon (com ou sem /manifest.json no fim).
      </div>

      <label class="field-label" for="externalStreamMaxPerQuality">
        Máximo de resultados por qualidade
      </label>

      <input
        id="externalStreamMaxPerQuality"
        type="number"
        min="1"
        max="10"
        value="${externalStreamMaxPerQuality}"
      >

      <div class="help">
        Ex: com o valor 2, mostra no máximo 2 fontes de 4K, 2 de 1080p,
        2 de 720p, etc — em vez de dezenas de opções.
      </div>

    </div>

    <!-- =========================================================
         BOTÕES
         ========================================================= -->

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

  /*
   * ==============================================================
   * ESTADO
   * ==============================================================
   */

  let currentMode = "${mode}";

  /*
   * ==============================================================
   * ELEMENTOS PRINCIPAIS
   * ==============================================================
   */

  const featuredEnabled =
    document.getElementById("featuredEnabled");

  const streamersEnabled =
    document.getElementById("streamersEnabled");

  const operatorsEnabled =
    document.getElementById("operatorsEnabled");

  const iptvEnabled =
    document.getElementById("iptvEnabled");

  const ptContentEnabled =
    document.getElementById("ptContentEnabled");

  const rtpPlayEnabled =
    document.getElementById("rtpPlayEnabled");

  const ptPtEnabled =
    document.getElementById("ptPtEnabled");

  const ptPtAddonSources =
    document.getElementById("ptPtAddonSources");

  const ptSourceCotonet =
    document.getElementById("ptSourceCotonet");

  const portugueseProductionEnabled =
    document.getElementById("portugueseProductionEnabled");

  const portugueseAddonSources =
    document.getElementById("portugueseAddonSources");

  const ptSourcePortugueseProductions =
    document.getElementById("ptSourcePortugueseProductions");

  const subtitlesEnabled =
    document.getElementById("subtitlesEnabled");

  const externalSourcesEnabled =
    document.getElementById("externalSourcesEnabled");

  const externalStreamSources =
    document.getElementById("externalStreamSources");

  const externalStreamMaxPerQuality =
    document.getElementById("externalStreamMaxPerQuality");

  const featuredContainer =
    document.getElementById("featuredContainer");

  const streamersContainer =
    document.getElementById("streamersContainer");

  const operatorsContainer =
    document.getElementById("operatorsContainer");

  const iptvContainer =
    document.getElementById("iptvContainer");

  const ptContentContainer =
    document.getElementById("ptContentContainer");

  const subtitlesContainer =
    document.getElementById("subtitlesPanel");

  const externalSourcesContainer =
    document.getElementById("externalSourcesPanel");

  /*
   * ==============================================================
   * DESTAQUES
   * ==============================================================
   */

  const featuredMovies =
    document.getElementById("featuredMovies");

  const featuredSeries =
    document.getElementById("featuredSeries");

  /*
   * ==============================================================
   * STREAMERS
   * ==============================================================
   */

  const streamerMovieIds = ${streamerMovieIdsJs};
  const streamerSeriesIds = ${streamerSeriesIdsJs};

  /*
   * ==============================================================
   * OPERADORES
   * ==============================================================
   */

  const operatorIds = ${operatorIdsJs};

  /*
   * ==============================================================
   * IPTV
   * ============================================================== 
   */

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

  /*
   * ==============================================================
   * IPTV-ORG
   * ==============================================================
   */

  const iptvOrgCountry =
    document.getElementById("iptvOrgCountry");

  const iptvOrgCategory =
    document.getElementById("iptvOrgCategory");

  const iptvOrgCatalogName =
    document.getElementById("iptvOrgCatalogName");

  /*
   * ==============================================================
   * XTREAM
   * ==============================================================
   */

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

  /*
   * ==============================================================
   * M3U
   * ==============================================================
   */

  const m3uUrl =
    document.getElementById("m3uUrl");

  const catalogCountry =
    document.getElementById("catalogCountry");

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


  /*
   * ==============================================================
   * HELPERS
   * ==============================================================
   */

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

  /*
   * ==============================================================
   * CONTEÚDO — VISIBILIDADE DOS CONTAINERS
   * ============================================================== 
   */


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

 setPanelVisibility(
 ptContentContainer,
 ptContentEnabled.checked
 );

 setPanelVisibility(
 subtitlesContainer,
 subtitlesEnabled.checked
 );

 setPanelVisibility(
 externalSourcesContainer,
 externalSourcesEnabled.checked
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

  /*
   * ==============================================================
   * IPTV — MODO
   * ============================================================== 
   */

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

  /*
   * ==============================================================
   * XTREAM — EPG
   * ============================================================== 
   */

  function updateXtreamEpgVisibility() {

    if (!xtreamEpgMode) {
      return;
    }

    xtreamEpgUrlWrap.style.display =
      xtreamEpgMode.value === "url"
        ? "block"
        : "none";
  }

  /*
   * ==============================================================
   * M3U — URL OU FICHEIRO
   * ============================================================== 
   */

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

  /*
   * ==============================================================
   * SELEÇÕES
   * ============================================================== 
   */

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

  /*
   * ==============================================================
   * FICHEIRO M3U
   * ============================================================== 
   */

  let m3uFileId = "";

  m3uFile.addEventListener(
    "change",
    function () {

      const file =
        m3uFile.files &&
        m3uFile.files[0];

      if (!file) {

        m3uFileId = "";

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
        m3uFileId = "";

        m3uFileInfo.textContent =
          "Erro: seleciona um ficheiro .m3u ou .m3u8.";

        return;
      }

      m3uFileId = "";

      m3uFileInfo.textContent =
        "A carregar " + file.name + "...";

      const reader =
        new FileReader();

      reader.onload =
        async function (event) {

          const content =
            event.target.result || "";

          try {

            const response =
              await fetch("/upload-m3u", {
                method: "POST",
                headers: {
                  "Content-Type": "text/plain"
                },
                body: content
              });

            const data =
              await response.json();

            if (!response.ok || !data.id) {

              m3uFileId = "";

              m3uFileInfo.textContent =
                "Erro: " +
                (data.error ||
                  "não foi possível carregar o ficheiro.");

              return;
            }

            m3uFileId = data.id;

            m3uFileInfo.textContent =
              "Ficheiro carregado: " +
              file.name +
              " (" +
              Math.round(file.size / 1024) +
              " KB)";

          } catch (error) {

            m3uFileId = "";

            m3uFileInfo.textContent =
              "Erro ao enviar o ficheiro para o servidor.";

          }

        };

      reader.onerror =
        function () {

          m3uFileId = "";

          m3uFileInfo.textContent =
            "Não foi possível ler o ficheiro.";
        };

      reader.readAsText(file);
    }
  );

  /*
   * ==============================================================
   * CONFIGURAÇÃO
   * ============================================================== 
   */

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

      catalogCountry:
        catalogCountry.value.trim().toUpperCase(),

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

        selectedStreamerMovies:
          getCheckedValues(streamerMovieIds),

        selectedStreamerSeries:
          getCheckedValues(streamerSeriesIds),

        operators:
          operatorsEnabled.checked,

        selectedOperators:
          getCheckedValues(operatorIds),

        iptv:
          iptvEnabled.checked,

        ptContent:
          ptContentEnabled.checked,

        ptContentSources: {
          ptPt:
            ptPtEnabled.checked,

          portugueseProduction:
            portugueseProductionEnabled.checked,

          rtpPlay:
            rtpPlayEnabled.checked
        },

        subtitles:
          subtitlesEnabled.checked,

        externalSources:
          externalSourcesEnabled.checked
      },

      ptContentSelectedSources: {
        ptpt:
          ptPtEnabled.checked && ptSourceCotonet.checked
            ? ["cotonet"]
            : [],

        portuguese:
          portugueseProductionEnabled.checked &&
          ptSourcePortugueseProductions.checked
            ? ["filmes-series-novelas-portuguesas"]
            : []
      },

      ptContentExternalSources: {
        ptpt:
          ptPtEnabled.checked
            ? ptPtAddonSources.value
                .split("\\n")
                .map(function (line) { return line.trim(); })
                .filter(Boolean)
            : [],

        portuguese:
          portugueseProductionEnabled.checked
            ? portugueseAddonSources.value
                .split("\\n")
                .map(function (line) { return line.trim(); })
                .filter(Boolean)
            : []
      },

      externalStreamSources:
        externalSourcesEnabled.checked
          ? externalStreamSources.value
              .split("\\n")
              .map(function (line) { return line.trim(); })
              .filter(Boolean)
          : [],

      externalStreamMaxPerQuality:
        Number(externalStreamMaxPerQuality.value || 2),

      mode:
        currentMode,

      /*
       * IPTV-org
       */

      iptvOrg: {

        country:
          iptvOrgCountry.value.trim(),

        category:
          iptvOrgCategory.value.trim(),

        catalogName:
          iptvOrgCatalogName.value.trim()
      },

      /*
       * Xtream
       */

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

      /*
       * M3U / M3U+
       */

      m3uSource:
        m3uSource,

      m3uUrl:
        m3uUrl.value.trim(),

      /*
       * Nota:
       * m3uFileId é o identificador curto devolvido pelo
       * servidor após o upload do ficheiro em /upload-m3u.
       * O conteúdo do ficheiro NUNCA é embutido no link de
       * instalação (fica demasiado grande para o Stremio/Nuvio).
       */

      m3uFileId:
        m3uSource === "file"
          ? m3uFileId
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

  /*
   * ==============================================================
   * CODIFICAÇÃO
   * ============================================================== 
   */

  function pruneConfig(value) {

    if (Array.isArray(value)) {
      return value;
    }

    if (
      value &&
      typeof value === "object"
    ) {

      const result = {};

      Object.keys(value).forEach(function (key) {

        const pruned =
          pruneConfig(value[key]);

        const isEmptyString =
          pruned === "";

        const isEmptyArray =
          Array.isArray(pruned) &&
          pruned.length === 0;

        const isEmptyObject =
          pruned &&
          typeof pruned === "object" &&
          !Array.isArray(pruned) &&
          Object.keys(pruned).length === 0;

        if (
          isEmptyString ||
          isEmptyArray ||
          isEmptyObject
        ) {
          return;
        }

        result[key] = pruned;

      });

      return result;
    }

    return value;
  }

  function encodeConfig(config) {

    const json =
      JSON.stringify(pruneConfig(config));

    /*
     * Comprime com pako (deflateRaw) para encurtar o link de
     * instalação o máximo possível — importante porque o
     * Stremio rejeita links "stremio://" demasiado longos.
     * Se o pako não estiver disponível por algum motivo,
     * usa o método antigo (sem compressão) como reserva.
     */

    if (
      typeof pako === "undefined" ||
      !pako ||
      typeof pako.deflateRaw !== "function"
    ) {

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

    const compressed =
      pako.deflateRaw(json);

    let binary = "";

    compressed.forEach(function (byte) {
      binary += String.fromCharCode(byte);
    });

    return btoa(binary)
      .replace(/\\+/g, "-")
      .replace(/\\//g, "_")
      .replace(/=+$/g, "");
  }

  /*
   * ==============================================================
   * URL DE INSTALAÇÃO
   * ============================================================== 
   */

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

  /*
   * ==============================================================
   * EVENTOS — CHECKBOXES
   * ============================================================== 
   */

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

  ptContentEnabled.addEventListener(
    "change",
    function () {

      updateContentVisibility();
      hideInstall();
    }
  );

  [
    ptPtEnabled,
    ptSourceCotonet,
    portugueseProductionEnabled,
    ptSourcePortugueseProductions,
    rtpPlayEnabled
  ].forEach(function (element) {
    if (element) {
      element.addEventListener("change", hideInstall);
    }
  });

  subtitlesEnabled.addEventListener(
    "change",
    function () {

      updateContentVisibility();
      hideInstall();
    }
  );

  externalSourcesEnabled.addEventListener(
    "change",
    function () {

      updateContentVisibility();
      hideInstall();
    }
  );

  /*
   * ==============================================================
   * EVENTOS — IPTV
   * ============================================================== 
   */

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

  /*
   * ==============================================================
   * ALTERAÇÕES DE CONFIGURAÇÃO ESCONDEM INSTALAÇÃO ANTIGA
   * ============================================================== 
   */

  document
    .querySelectorAll(
      "input, select, textarea"
    )
    .forEach(function (element) {

      element.addEventListener(
        "change",
        hideInstall
      );

    });

  /*
   * ==============================================================
   * TESTAR LIGAÇÃO
   * ============================================================== 
   */

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

  /*
   * ==============================================================
   * VALIDAÇÃO M3U
   * ============================================================== 
   */

  function validateM3U(config) {

    if (config.m3uSource === "file") {

      if (!config.m3uFileId) {

        showStatus(
          "Seleciona um ficheiro M3U ou M3U8."
        );

        return false;
      }

      return true;
    }

    if (
      !/^https?:\\/\\//i.test(
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

  /*
   * ==============================================================
   * VALIDAÇÃO IPTV-ORG
   * ============================================================== 
   */

  function validateIPTVOrg(config) {

    /*
     * IPTV-org não necessita de credenciais.
     * Country e Category são opcionais.
     */

    return true;
  }

  /*
   * ==============================================================
   * VALIDAÇÃO XTREAM
   * ============================================================== 
   */

  function validateXtream(config) {

    if (
      !/^https?:\\/\\//i.test(
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


/*
 * ==============================================================
 * GERAR INSTALAÇÃO
 * ==============================================================
 */

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

 config.features.iptv ||

 config.features.ptContent ||

 config.features.externalSources;

 if (!hasContent) {

 showStatus(
 "Add-on não instalado. Deve selecionar pelo menos um conteúdo."
 );

 return;
 }

 /*
 * Conteúdo
 */

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
 config.features.selectedStreamerMovies.length === 0 &&
 config.features.selectedStreamerSeries.length === 0
 ) {

 showStatus(
 "Em Streamers seleciona pelo menos um streamer (Filmes e/ou Séries)."
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

 if (config.features.ptContent) {

 const ptSources =
 config.features.ptContentSources || {};

 if (
 !ptSources.ptPt &&
 !ptSources.portugueseProduction &&
 !ptSources.rtpPlay
 ) {

 showStatus(
 "Em Português ativa PT-PT, Produção Portuguesa, RTP Play ou uma combinação destas opções."
 );

 return;
 }

 if (
 ptSources.ptPt &&
 (!config.ptContentSelectedSources?.ptpt?.length) &&
 (!config.ptContentExternalSources?.ptpt?.length)
 ) {

 showStatus(
 "Em Filmes e Séries em PT-PT seleciona pelo menos uma fonte (ex.: Cotonet) ou adiciona uma fonte personalizada."
 );

 return;
 }

 if (
 ptSources.portugueseProduction &&
 (!config.ptContentSelectedSources?.portuguese?.length) &&
 (!config.ptContentExternalSources?.portuguese?.length)
 ) {

 showStatus(
 "Em Filmes, Séries e Novelas Portuguesas seleciona pelo menos uma fonte ou adiciona uma fonte personalizada."
 );

 return;
 }

 }

 /*
 * IPTV
 */

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

 /*
 * GERAR URL
 */

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

  /*
   * ==============================================================
   * COPIAR URL
   * ============================================================== 
   */

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

  /*
   * ==============================================================
   * ABRIR NO STREMIO
   * ============================================================== 
   */

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

  /*
   * ==============================================================
   * INICIALIZAÇÃO
   * ============================================================== 
   */

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

 const ptHubCatalogs =
 showPtContent
   ? getPtHubManifestCatalogs(config)
   : [];

 function isSpecialCatalog(id) {
 return (
 id === "featured" ||
 id === "movie-top" ||
 id === "series-top"
 );
 }

 /*
  * "Destaques" e "Populares" (movie-top/series-top) são
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

 const popularMovie = findCatalog(filteredMovieCatalogs, "movie-top");
 const popularSeries = findCatalog(filteredSeriesCatalogs, "series-top");

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

...ptHubCatalogs,

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
      p2p: false
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
await getCinemetaCatalog(
"movie"
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

      if (id === "featured") {
        data = await getFeaturedCatalog("movie", country);
      } else if (id === "movie-top") {
        data = await getCinemetaCatalog("movie", search);
        alreadyFiltered = Boolean(search);
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
await getCinemetaCatalog(
"series"
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

      if (id === "featured") {
        data = await getFeaturedCatalog("series", country);
      } else if (id === "series-top") {
        data = await getCinemetaCatalog("series", search);
        alreadyFiltered = Boolean(search);
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

  const text =
    `${stream.name || ""} ${stream.title || stream.description || ""}`;

  const match =
    text.match(/👤\D{0,3}(\d+)/) ||
    text.match(/(\d+)\s*seeds?/i);

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

async function getExternalStreams(config, type, id) {

  const sources =
    Array.isArray(config?.externalStreamSources)
      ? config.externalStreamSources.filter(Boolean)
      : [];

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

  const byQuality = new Map();

  for (const stream of allStreams) {

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
  "https://opensubtitles.strem.io";

app.get(
  "/:config/subtitles/:type/:id.json",
  async (req, res) => {

    try {

      const config =
        decodeConfig(req.params.config);

      if (!config?.features?.subtitles) {
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

      if (!config?.features?.subtitles) {
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
