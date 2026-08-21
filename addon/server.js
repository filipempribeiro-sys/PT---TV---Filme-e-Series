const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;
const BASE_DIR = __dirname;

const APP_VERSION = "2.0.0";
const APP_NAME = "PT TV Hub";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/144 Safari/537.36 PT-TV-Hub/2.0";


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  express.json({
    limit: "200kb"
  })
);

app.use((req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type,Accept,Range,User-Agent"
  );

  /*
   * Muito importante:
   * não queremos que Nuvio/Stremio reutilize
   * um catálogo IPTV antigo.
   */
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.setHeader(
    "Pragma",
    "no-cache"
  );

  res.setHeader(
    "Expires",
    "0"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});


// ============================================================
// JSON
// ============================================================

function loadJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(
        filePath,
        "utf8"
      )
    );
  } catch (error) {
    console.error(
      `Erro ao carregar ${filePath}:`,
      error.message
    );

    return fallback;
  }
}


const services = loadJSON(
  path.join(
    BASE_DIR,
    "..",
    "data",
    "services.json"
  ),
  []
);


const addons = loadJSON(
  path.join(
    BASE_DIR,
    "..",
    "data",
    "addons.json"
  ),
  []
);


const baseManifest = loadJSON(
  path.join(
    BASE_DIR,
    "manifest.json"
  ),
  {
    id: "pt.filipe.nuvio.tvhub",
    version: APP_VERSION,
    name: APP_NAME,
    description:
      "Hub IPTV para Nuvio e Stremio.",
    resources: [
      "catalog",
      "meta",
      "stream",
      "addon_catalog"
    ],
    types: [
      "channel",
      "tv"
    ],
    catalogs: []
  }
);


// ============================================================
// CONFIGURAÇÃO
// ============================================================

function encodeConfig(config) {
  return Buffer
    .from(
      JSON.stringify(config),
      "utf8"
    )
    .toString("base64url");
}


function decodeConfig(value) {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(
      Buffer
        .from(
          value,
          "base64url"
        )
        .toString("utf8")
    );
  } catch {
    return {};
  }
}


// ============================================================
// URL
// ============================================================

function isValidHttpUrl(value) {
  try {
    const url = new URL(
      String(value || "")
    );

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}


function getUrlExtension(url) {
  try {
    const parsed = new URL(url);

    const pathname =
      parsed.pathname.toLowerCase();

    if (
      pathname.endsWith(".m3u8")
    ) {
      return "hls";
    }

    if (
      pathname.endsWith(".mp4")
    ) {
      return "mp4";
    }

    if (
      pathname.endsWith(".ts")
    ) {
      return "mpegts";
    }

    return "stream";
  } catch {
    return "stream";
  }
}


function isHlsUrl(url) {
  return (
    getUrlExtension(url) === "hls"
  );
}


// ============================================================
// HTML
// ============================================================

function escapeHtml(value) {
  return String(value || "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}


// ============================================================
// SVG
// ============================================================

function svgResponse(
  res,
  svg
) {
  res.setHeader(
    "Content-Type",
    "image/svg+xml; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "public, max-age=3600"
  );

  return res.send(svg);
}


// ============================================================
// LOGO PT TV HUB
// ============================================================

app.get(
  "/assets/logo.svg",
  (req, res) => {
    return svgResponse(
      res,
      `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="256"
  height="256"
  viewBox="0 0 256 256"
>
  <defs>
    <linearGradient
      id="g"
      x1="0"
      y1="0"
      x2="1"
      y2="1"
    >
      <stop
        offset="0%"
        stop-color="#38bdf8"
      />
      <stop
        offset="100%"
        stop-color="#2563eb"
      />
    </linearGradient>
  </defs>

  <rect
    width="256"
    height="256"
    rx="54"
    fill="#020617"
  />

  <rect
    x="34"
    y="50"
    width="188"
    height="132"
    rx="24"
    fill="url(#g)"
  />

  <rect
    x="49"
    y="65"
    width="158"
    height="102"
    rx="15"
    fill="#020617"
  />

  <polygon
    points="104,91 104,141 157,116"
    fill="#ffffff"
  />

  <path
    d="M82 199 H174"
    stroke="#38bdf8"
    stroke-width="12"
    stroke-linecap="round"
  />

  <text
    x="128"
    y="231"
    text-anchor="middle"
    font-family="Arial, Helvetica, sans-serif"
    font-size="20"
    font-weight="700"
    fill="#ffffff"
  >
    PT TV HUB
  </text>
</svg>
      `
    );
  }
);


// ============================================================
// BACKGROUND PT TV HUB
// ============================================================

app.get(
  "/assets/background.svg",
  (req, res) => {
    return svgResponse(
      res,
      `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="1600"
  height="900"
  viewBox="0 0 1600 900"
>
  <defs>
    <linearGradient
      id="bg"
      x1="0"
      y1="0"
      x2="1"
      y2="1"
    >
      <stop
        offset="0%"
        stop-color="#020617"
      />

      <stop
        offset="50%"
        stop-color="#0f172a"
      />

      <stop
        offset="100%"
        stop-color="#172554"
      />
    </linearGradient>

    <radialGradient
      id="glow"
      cx="50%"
      cy="45%"
      r="60%"
    >
      <stop
        offset="0%"
        stop-color="#38bdf8"
        stop-opacity=".28"
      />

      <stop
        offset="100%"
        stop-color="#020617"
        stop-opacity="0"
      />
    </radialGradient>
  </defs>

  <rect
    width="1600"
    height="900"
    fill="url(#bg)"
  />

  <rect
    width="1600"
    height="900"
    fill="url(#glow)"
  />

  <circle
    cx="1300"
    cy="180"
    r="260"
    fill="#2563eb"
    opacity=".12"
  />

  <circle
    cx="300"
    cy="720"
    r="300"
    fill="#38bdf8"
    opacity=".08"
  />

  <text
    x="100"
    y="700"
    font-family="Arial, Helvetica, sans-serif"
    font-size="96"
    font-weight="800"
    fill="#ffffff"
    opacity=".92"
  >
    PT TV HUB
  </text>

  <text
    x="105"
    y="760"
    font-family="Arial, Helvetica, sans-serif"
    font-size="32"
    fill="#94a3b8"
  >
    TV • IPTV • Streaming
  </text>
</svg>
      `
    );
  }
);


// ============================================================
// M3U PARSER
// ============================================================

function parseM3U(text) {
  const lines =
    String(text || "")
      .split(/\r?\n/);

  const channels = [];

  let current = null;

  for (const rawLine of lines) {
    const line =
      rawLine.trim();

    if (!line) {
      continue;
    }

    if (
      line.startsWith(
        "#EXTINF"
      )
    ) {
      const attrs = {};

      const attributeRegex =
        /([\w-]+)="([^"]*)"/g;

      let match;

      while (
        (match =
          attributeRegex.exec(
            line
          )) !== null
      ) {
        attrs[match[1]] =
          match[2];
      }

      const commaIndex =
        line.indexOf(",");

      let title =
        "Canal";

      if (
        commaIndex >= 0
      ) {
        title =
          line
            .slice(
              commaIndex + 1
            )
            .trim() ||
          "Canal";
      }

      if (
        attrs["tvg-name"]
      ) {
        title =
          attrs["tvg-name"] ||
          title;
      }

      current = {
        title,

        group:
          attrs["group-title"] ||
          "IPTV",

        logo:
          attrs["tvg-logo"] ||
          "",

        tvgId:
          attrs["tvg-id"] ||
          "",

        tvgName:
          attrs["tvg-name"] ||
          title,

        catchup:
          attrs["catchup"] ||
          "",

        catchupDays:
          attrs["catchup-days"] ||
          "",

        httpReferrer:
          attrs["http-referrer"] ||
          attrs["referrer"] ||
          "",

        userAgent:
          attrs["http-user-agent"] ||
          attrs["user-agent"] ||
          ""
      };

      continue;
    }

    if (
      current &&
      !line.startsWith("#") &&
      isValidHttpUrl(line)
    ) {
      const id =
        "m3u:" +
        crypto
          .createHash("sha256")
          .update(line)
          .digest("hex")
          .slice(0, 24);

      channels.push({
        id,

        title:
          current.title,

        group:
          current.group,

        logo:
          current.logo,

        tvgId:
          current.tvgId,

        tvgName:
          current.tvgName,

        catchup:
          current.catchup,

        catchupDays:
          current.catchupDays,

        httpReferrer:
          current.httpReferrer,

        userAgent:
          current.userAgent,

        url:
          line
      });

      current = null;
    }
  }

  return channels;
}


// ============================================================
// FETCH M3U
// ============================================================

async function fetchM3U(url) {
  if (
    !url ||
    !isValidHttpUrl(url)
  ) {
    return [];
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      30000
    );

  try {
    const response =
      await fetch(
        url,
        {
          method: "GET",

          redirect:
            "follow",

          cache:
            "no-store",

          signal:
            controller.signal,

          headers: {
            "User-Agent":
              DEFAULT_USER_AGENT,

            "Accept":
              "application/x-mpegURL,application/vnd.apple.mpegurl,text/plain,*/*",

            "Cache-Control":
              "no-cache",

            "Pragma":
              "no-cache"
          }
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const text =
      await response.text();

    return parseM3U(
      text
    );
  } catch (error) {
    console.error(
      "Erro ao obter M3U:",
      error.message
    );

    return [];
  } finally {
    clearTimeout(
      timeout
    );
  }
}


// ============================================================
// XTREAM
// ============================================================

function cleanServerUrl(url) {
  return String(
    url || ""
  )
    .trim()
    .replace(
      /\/+$/,
      ""
    );
}


async function xtreamRequest(
  config,
  action
) {
  const server =
    cleanServerUrl(
      config.xtream_url
    );

  const username =
    String(
      config.xtream_username ||
      ""
    ).trim();

  const password =
    String(
      config.xtream_password ||
      ""
    );

  if (
    !server ||
    !username ||
    !password
  ) {
    return null;
  }

  if (
    !isValidHttpUrl(
      server
    )
  ) {
    return null;
  }

  let url =
    `${server}/player_api.php`;

  url +=
    `?username=${encodeURIComponent(
      username
    )}`;

  url +=
    `&password=${encodeURIComponent(
      password
    )}`;

  if (action) {
    url +=
      `&action=${encodeURIComponent(
        action
      )}`;
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      30000
    );

  try {
    const response =
      await fetch(
        url,
        {
          signal:
            controller.signal,

          cache:
            "no-store",

          headers: {
            "User-Agent":
              DEFAULT_USER_AGENT,

            "Cache-Control":
              "no-cache"
          }
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return await response.json();
  } catch (error) {
    console.error(
      "Erro Xtream:",
      error.message
    );

    return null;
  } finally {
    clearTimeout(
      timeout
    );
  }
}


async function getXtreamChannels(
  config
) {
  const data =
    await xtreamRequest(
      config,
      "get_live_streams"
    );

  if (
    !Array.isArray(data)
  ) {
    return [];
  }

  const server =
    cleanServerUrl(
      config.xtream_url
    );

  const username =
    String(
      config.xtream_username ||
      ""
    );

  const password =
    String(
      config.xtream_password ||
      ""
    );

  return data
    .map(
      (channel) => {
        if (
          channel.stream_id ===
          undefined
        ) {
          return null;
        }

        const streamId =
          String(
            channel.stream_id
          );

        const extension =
          channel.container_extension ||
          "ts";

        return {
          id:
            `xtream:${streamId}`,

          title:
            channel.name ||
            `Canal ${streamId}`,

          group:
            channel.category_name ||
            "TV",

          logo:
            channel.stream_icon ||
            "",

          tvgId:
            channel.epg_channel_id ||
            "",

          userAgent:
            "",

          httpReferrer:
            "",

          url:
            `${server}/live/` +
            `${encodeURIComponent(
              username
            )}/` +
            `${encodeURIComponent(
              password
            )}/` +
            `${streamId}.${extension}`
        };
      }
    )
    .filter(Boolean);
}


// ============================================================
// OBTER CANAIS
// ============================================================

async function getIPTVChannels(
  config
) {
  if (!config) {
    return [];
  }

  /*
   * IMPORTANTE:
   *
   * Não existe cache da M3U.
   *
   * Cada chamada volta a consultar
   * a lista original.
   */

  if (
    config.iptv_type ===
    "M3U URL"
  ) {
    return fetchM3U(
      config.m3u_url
    );
  }

  if (
    config.iptv_type ===
    "Xtream Codes"
  ) {
    return getXtreamChannels(
      config
    );
  }

  return [];
}


// ============================================================
// CONFIG VALIDATION
// ============================================================

function validateConfig(
  config
) {
  const errors = [];

  if (
    !config ||
    typeof config !==
      "object"
  ) {
    errors.push(
      "Configuração inválida."
    );

    return errors;
  }

  if (
    !config.iptv_type ||
    config.iptv_type ===
      "Nenhuma"
  ) {
    errors.push(
      "Seleciona o tipo de IPTV."
    );
  }

  if (
    config.iptv_type ===
    "M3U URL"
  ) {
    if (
      !config.m3u_url
    ) {
      errors.push(
        "Introduz a URL da lista M3U."
      );
    } else if (
      !isValidHttpUrl(
        config.m3u_url
      )
    ) {
      errors.push(
        "A URL M3U não é válida."
      );
    }
  }

  if (
    config.iptv_type ===
    "Xtream Codes"
  ) {
    if (
      !config.xtream_url
    ) {
      errors.push(
        "Introduz o servidor Xtream."
      );
    } else if (
      !isValidHttpUrl(
        config.xtream_url
      )
    ) {
      errors.push(
        "O servidor Xtream não é válido."
      );
    }

    if (
      !config.xtream_username
    ) {
      errors.push(
        "Introduz o username Xtream."
      );
    }

    if (
      !config.xtream_password
    ) {
      errors.push(
        "Introduz a password Xtream."
      );
    }
  }

  if (
    config.epg_url &&
    !isValidHttpUrl(
      config.epg_url
    )
  ) {
    errors.push(
      "A URL EPG não é válida."
    );
  }

  return errors;
}


// ============================================================
// CACHE HEADERS
// ============================================================

function noCache(res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );

  res.setHeader(
    "Pragma",
    "no-cache"
  );

  res.setHeader(
    "Expires",
    "0"
  );
}


// ============================================================
// STREAM HELPERS
// ============================================================

function buildStreamObject(
  channel
) {
  const headers = {};

  /*
   * Só adicionamos headers que
   * estejam explicitamente presentes
   * na M3U/Xtream.
   */

  if (
    channel.userAgent
  ) {
    headers[
      "User-Agent"
    ] =
      channel.userAgent;
  }

  if (
    channel.httpReferrer
  ) {
    headers[
      "Referer"
    ] =
      channel.httpReferrer;
  }

  const stream = {
    name:
      channel.title,

    title:
      channel.group ||
      "IPTV",

    description:
      "Fonte IPTV configurada pelo utilizador.",

    url:
      channel.url,

    behaviorHints: {
      notWebReady:
        isHlsUrl(
          channel.url
        ),

      bingeGroup:
        `pt-tv-hub-${channel.group || "iptv"}`
    }
  };

  /*
   * proxyHeaders é suportado pelo
   * protocolo Stremio para streams
   * HTTP(S). Só o usamos quando
   * realmente existem headers.
   */

  if (
    Object.keys(
      headers
    ).length > 0
  ) {
    stream.behaviorHints.proxyHeaders = {
      request:
        headers
    };
  }

  return stream;
}


// ============================================================
// CONFIGURE PAGE
// ============================================================

function renderConfigure(
  req,
  res
) {
  const existingConfig =
    req.params.config
      ? decodeConfig(
          req.params.config
        )
      : {};

  const iptvName =
    existingConfig.iptv_name ||
    "Minha IPTV";

  const iptvType =
    existingConfig.iptv_type ||
    "Nenhuma";

  const m3uUrl =
    existingConfig.m3u_url ||
    "";

  const xtreamUrl =
    existingConfig.xtream_url ||
    "";

  const xtreamUsername =
    existingConfig.xtream_username ||
    "";

  const epgUrl =
    existingConfig.epg_url ||
    "";

  res.type(
    "html"
  );

  res.send(`
<!DOCTYPE html>

<html lang="pt-PT">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>PT TV Hub</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;

  font-family:
    Arial,
    Helvetica,
    sans-serif;

  color: #ffffff;

  background:
    radial-gradient(
      circle at top,
      #172554 0,
      #020617 55%,
      #000000 100%
    );

  padding: 30px 16px;
}

.container {
  max-width: 760px;
  margin: 0 auto;
}

.card {
  background:
    rgba(15,23,42,.97);

  border:
    1px solid
    rgba(255,255,255,.10);

  border-radius: 24px;

  padding: 30px;

  box-shadow:
    0 25px 80px
    rgba(0,0,0,.45);
}

.header {
  text-align: center;
  margin-bottom: 28px;
}

.logo-box {
  width: 110px;
  height: 110px;

  margin: 0 auto 15px;

  border-radius: 28px;

  background:
    linear-gradient(
      135deg,
      #38bdf8,
      #2563eb
    );

  display: flex;
  align-items: center;
  justify-content: center;

  font-size: 55px;

  box-shadow:
    0 15px 45px
    rgba(37,99,235,.35);
}

h1 {
  margin: 0;
  font-size: 32px;
}

.subtitle {
  color: #94a3b8;
  margin-top: 8px;
}

label {
  display: block;

  margin:
    18px 0 8px;

  font-size: 14px;
  font-weight: 700;
}

input,
select {
  width: 100%;

  padding: 14px;

  border-radius: 10px;

  border:
    1px solid
    #334155;

  background:
    #020617;

  color: #ffffff;

  font-size: 15px;
}

input:focus,
select:focus {
  outline: none;

  border-color:
    #38bdf8;
}

.hidden {
  display: none;
}

.hint {
  margin-top: 7px;

  color:
    #64748b;

  font-size:
    12px;
}

.buttons {
  display: grid;

  grid-template-columns:
    1fr 1fr;

  gap: 12px;

  margin-top: 28px;
}

button {
  border: 0;

  border-radius: 10px;

  padding: 15px;

  font-size: 15px;

  font-weight: 700;

  cursor: pointer;
}

button:disabled {
  opacity: .6;
  cursor: wait;
}

.test {
  background:
    #334155;

  color:
    #ffffff;
}

.install {
  background:
    #0ea5e9;

  color:
    #ffffff;
}

.secondary {
  background:
    #1e293b;

  color:
    #ffffff;
}

button:hover {
  opacity: .9;
}

.status {
  display: none;

  margin-top: 18px;

  padding: 14px;

  border-radius: 10px;

  font-size: 14px;

  line-height: 1.5;
}

.status.show {
  display: block;
}

.status.ok {
  background:
    rgba(34,197,94,.12);

  border:
    1px solid
    rgba(34,197,94,.25);

  color:
    #86efac;
}

.status.error {
  background:
    rgba(239,68,68,.12);

  border:
    1px solid
    rgba(239,68,68,.25);

  color:
    #fca5a5;
}

.install-box {
  display: none;

  margin-top: 20px;

  padding: 18px;

  border-radius: 14px;

  background:
    #020617;

  border:
    1px solid
    #334155;
}

.install-box.show {
  display: block;
}

.install-box input {
  margin-top: 8px;
}

.info {
  margin-top: 25px;

  padding: 15px;

  border-radius: 10px;

  background:
    rgba(30,41,59,.55);

  color:
    #94a3b8;

  font-size:
    12px;

  line-height:
    1.6;
}

@media (max-width: 600px) {

  .card {
    padding: 22px;
  }

  .buttons {
    grid-template-columns:
      1fr;
  }

}

</style>

</head>

<body>

<div class="container">

<div class="card">

<div class="header">

<div class="logo-box">
  📺
</div>

<h1>
PT TV Hub
</h1>

<div class="subtitle">
IPTV • Nuvio • Stremio
</div>

</div>


<label for="iptv_name">
Nome da fonte
</label>

<input
  id="iptv_name"
  value="${escapeHtml(
    iptvName
  )}"
  placeholder="Ex.: IPTV Casa"
>


<label for="iptv_type">
Tipo de IPTV
</label>

<select id="iptv_type">

<option
  value="Nenhuma"
  ${
    iptvType ===
    "Nenhuma"
      ? "selected"
      : ""
  }
>
Selecionar...
</option>

<option
  value="M3U URL"
  ${
    iptvType ===
    "M3U URL"
      ? "selected"
      : ""
  }
>
M3U URL
</option>

<option
  value="Xtream Codes"
  ${
    iptvType ===
    "Xtream Codes"
      ? "selected"
      : ""
  }
>
Xtream Codes
</option>

</select>


<div
  id="m3uSection"
  class="${
    iptvType ===
    "M3U URL"
      ? ""
      : "hidden"
  }"
>

<label for="m3u_url">
URL da lista M3U
</label>

<input
  id="m3u_url"
  type="url"
  value="${escapeHtml(
    m3uUrl
  )}"
  placeholder="https://servidor/lista.m3u"
>

<div class="hint">
A lista deve ser tua ou autorizada.
A lista é recarregada quando o catálogo é solicitado.
</div>

</div>


<div
  id="xtreamSection"
  class="${
    iptvType ===
    "Xtream Codes"
      ? ""
      : "hidden"
  }"
>

<label for="xtream_url">
Xtream Server URL
</label>

<input
  id="xtream_url"
  type="url"
  value="${escapeHtml(
    xtreamUrl
  )}"
  placeholder="https://servidor:porta"
>


<label for="xtream_username">
Username
</label>

<input
  id="xtream_username"
  value="${escapeHtml(
    xtreamUsername
  )}"
  autocomplete="username"
>


<label for="xtream_password">
Password
</label>

<input
  id="xtream_password"
  type="password"
  autocomplete="current-password"
>

</div>


<label for="epg_url">
EPG URL
<span
  style="
    color:#64748b;
    font-weight:normal;
  "
>
(opcional)
</span>
</label>

<input
  id="epg_url"
  type="url"
  value="${escapeHtml(
    epgUrl
  )}"
  placeholder="https://servidor/epg.xml"
>


<div class="hint">
Preparado para integração EPG.
</div>


<div
  id="status"
  class="status"
></div>


<div class="buttons">

<button
  type="button"
  class="test"
  id="testButton"
>
🔎 Testar ligação
</button>

<button
  type="button"
  class="install"
  id="installButton"
>
📺 Gerar instalação
</button>

</div>


<div
  id="installBox"
  class="install-box"
>

<b>
🔗 Manifest configurado
</b>

<input
  id="manifestUrl"
  readonly
>

<button
  type="button"
  class="secondary"
  id="copyButton"
  style="width:100%;margin-top:10px;"
>
📋 Copiar URL
</button>

<button
  type="button"
  class="install"
  id="openButton"
  style="width:100%;margin-top:10px;"
>
📺 Abrir no Stremio
</button>

</div>


<div class="info">

<b>PT TV Hub 2.0</b>

<br><br>

A lista IPTV é consultada novamente sempre que
Nuvio/Stremio solicita o catálogo.

<br><br>

Os logos dos canais são obtidos do
campo <b>tvg-logo</b> da M3U.

<br><br>

A reprodução continua a utilizar diretamente
as fontes IPTV configuradas pelo utilizador.

</div>


</div>

</div>


<script>

const typeSelect =
  document.getElementById(
    "iptv_type"
  );

const m3uSection =
  document.getElementById(
    "m3uSection"
  );

const xtreamSection =
  document.getElementById(
    "xtreamSection"
  );

const statusBox =
  document.getElementById(
    "status"
  );

const installBox =
  document.getElementById(
    "installBox"
  );

const manifestUrlInput =
  document.getElementById(
    "manifestUrl"
  );

const testButton =
  document.getElementById(
    "testButton"
  );

const installButton =
  document.getElementById(
    "installButton"
  );

const copyButton =
  document.getElementById(
    "copyButton"
  );

const openButton =
  document.getElementById(
    "openButton"
  );


let currentStremioUrl = "";


function updateFields() {

  m3uSection.classList.add(
    "hidden"
  );

  xtreamSection.classList.add(
    "hidden"
  );

  if (
    typeSelect.value ===
    "M3U URL"
  ) {
    m3uSection.classList.remove(
      "hidden"
    );
  }

  if (
    typeSelect.value ===
    "Xtream Codes"
  ) {
    xtreamSection.classList.remove(
      "hidden"
    );
  }
}


typeSelect.addEventListener(
  "change",
  updateFields
);


function getConfig() {

  return {

    iptv_name:
      document
        .getElementById(
          "iptv_name"
        )
        .value
        .trim(),

    iptv_type:
      typeSelect.value,

    m3u_url:
      document
        .getElementById(
          "m3u_url"
        )
        .value
        .trim(),

    xtream_url:
      document
        .getElementById(
          "xtream_url"
        )
        .value
        .trim(),

    xtream_username:
      document
        .getElementById(
          "xtream_username"
        )
        .value
        .trim(),

    xtream_password:
      document
        .getElementById(
          "xtream_password"
        )
        .value,

    epg_url:
      document
        .getElementById(
          "epg_url"
        )
        .value
        .trim()

  };
}


function validateClientConfig(
  config
) {

  if (
    !config.iptv_type ||
    config.iptv_type ===
      "Nenhuma"
  ) {
    return "Seleciona o tipo de IPTV.";
  }

  if (
    config.iptv_type ===
    "M3U URL"
  ) {

    if (
      !config.m3u_url
    ) {
      return "Introduz a URL da lista M3U.";
    }

    try {

      const url =
        new URL(
          config.m3u_url
        );

      if (
        url.protocol !==
          "http:" &&
        url.protocol !==
          "https:"
      ) {
        return "A URL M3U deve começar por http:// ou https://.";
      }

    } catch {

      return "A URL M3U não é válida.";

    }
  }


  if (
    config.iptv_type ===
    "Xtream Codes"
  ) {

    if (
      !config.xtream_url
    ) {
      return "Introduz o servidor Xtream.";
    }

    if (
      !config.xtream_username
    ) {
      return "Introduz o username Xtream.";
    }

    if (
      !config.xtream_password
    ) {
      return "Introduz a password Xtream.";
    }

  }

  return null;
}


function showStatus(
  message,
  ok
) {

  statusBox.textContent =
    message;

  statusBox.className =
    "status show " +
    (
      ok
        ? "ok"
        : "error"
    );
}


testButton.addEventListener(
  "click",
  async () => {

    const config =
      getConfig();

    const validation =
      validateClientConfig(
        config
      );

    if (
      validation
    ) {

      showStatus(
        validation,
        false
      );

      return;
    }

    testButton.disabled =
      true;

    installButton.disabled =
      true;

    showStatus(
      "A testar a ligação...",
      true
    );

    try {

      const response =
        await fetch(
          "/test-iptv",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify(
                config
              )
          }
        );

      const result =
        await response.json();

      showStatus(
        result.message ||
          "Teste concluído.",
        !!result.ok
      );

    } catch {

      showStatus(
        "Não foi possível contactar o servidor.",
        false
      );

    } finally {

      testButton.disabled =
        false;

      installButton.disabled =
        false;

    }

  }
);


installButton.addEventListener(
  "click",
  () => {

    const config =
      getConfig();

    const validation =
      validateClientConfig(
        config
      );

    if (
      validation
    ) {

      showStatus(
        validation,
        false
      );

      return;
    }

    const encodedConfig =
      btoa(
        unescape(
          encodeURIComponent(
            JSON.stringify(
              config
            )
          )
        )
      )
        .replace(
          /=+$/,
          ""
        )
        .replace(
          /\+/g,
          "-"
        )
        .replace(
          /\//g,
          "_"
        );

    const manifestUrl =
      window.location.origin +
      "/" +
      encodedConfig +
      "/manifest.json";

    currentStremioUrl =
      manifestUrl.replace(
        /^https?:\/\//i,
        "stremio://"
      );

    manifestUrlInput.value =
      manifestUrl;

    installBox.classList.add(
      "show"
    );

    showStatus(
      "Manifest criado. Podes copiar o URL ou abrir diretamente no Stremio.",
      true
    );

  }
);


copyButton.addEventListener(
  "click",
  async () => {

    const value =
      manifestUrlInput.value;

    try {

      await navigator.clipboard.writeText(
        value
      );

      showStatus(
        "URL copiado.",
        true
      );

    } catch {

      manifestUrlInput.select();

      document.execCommand(
        "copy"
      );

      showStatus(
        "URL copiado.",
        true
      );

    }

  }
);


openButton.addEventListener(
  "click",
  () => {

    if (
      !currentStremioUrl
    ) {
      return;
    }

    window.location.href =
      currentStremioUrl;

  }
);


updateFields();

</script>

</body>

</html>
  `);
}


// ============================================================
// CONFIGURE ROUTES
// ============================================================

app.get(
  "/configure",
  renderConfigure
);


app.get(
  "/:config/configure",
  renderConfigure
);


// ============================================================
// TEST IPTV
// ============================================================

app.post(
  "/test-iptv",
  async (req, res) => {

    const config =
      req.body || {};

    const errors =
      validateConfig(
        config
      );

    if (
      errors.length > 0
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          message:
            errors.join(" ")
        });
    }


    if (
      config.iptv_type ===
      "M3U URL"
    ) {

      const channels =
        await fetchM3U(
          config.m3u_url
        );

      if (
        channels.length ===
        0
      ) {
        return res.json({
          ok: false,
          message:
            "A ligação foi efetuada, mas não foram encontrados canais na lista M3U."
        });
      }

      return res.json({
        ok: true,
        message:
          `Ligação OK — ${channels.length} canais encontrados.`
      });
    }


    if (
      config.iptv_type ===
      "Xtream Codes"
    ) {

      const auth =
        await xtreamRequest(
          config,
          ""
        );

      if (!auth) {
        return res.json({
          ok: false,
          message:
            "Não foi possível ligar ao servidor Xtream ou as credenciais foram rejeitadas."
        });
      }

      const channels =
        await getXtreamChannels(
          config
        );

      return res.json({
        ok: true,
        message:
          `Ligação Xtream OK — ${channels.length} canais encontrados.`
      });
    }


    return res.json({
      ok: false,
      message:
        "Seleciona uma fonte IPTV."
    });

  }
);


// ============================================================
// MANIFEST BASE
// ============================================================

app.get(
  "/manifest.json",
  (req, res) => {

    noCache(res);

    return res.json(
      {
        ...baseManifest,

        version:
          APP_VERSION,

        logo:
          `${getPublicOrigin(req)}/assets/logo.svg`,

        background:
          `${getPublicOrigin(req)}/assets/background.svg`
      }
    );

  }
);


// ============================================================
// PUBLIC ORIGIN
// ============================================================

function getPublicOrigin(req) {

  const forwardedProto =
    String(
      req.headers[
        "x-forwarded-proto"
      ] ||
      ""
    )
      .split(",")[0]
      .trim();

  const proto =
    forwardedProto ||
    req.protocol ||
    "https";

  return (
    `${proto}://${req.get(
      "host"
    )}`
  );

}


// ============================================================
// CONFIGURED MANIFEST
// ============================================================

app.get(
  "/:config/manifest.json",
  (req, res) => {

    const config =
      decodeConfig(
        req.params.config
      );

    const errors =
      validateConfig(
        config
      );

    const configHash =
      crypto
        .createHash(
          "sha256"
        )
        .update(
          JSON.stringify({
            name:
              config.iptv_name ||
              "",

            type:
              config.iptv_type ||
              "",

            m3u:
              config.m3u_url ||
              "",

            xtream:
              config.xtream_url ||
              "",

            username:
              config.xtream_username ||
              ""
          })
        )
        .digest("hex")
        .slice(
          0,
          12
        );

    const origin =
      getPublicOrigin(
        req
      );

    const manifest = {

      ...baseManifest,

      id:
        `pt.filipe.nuvio.tvhub.${configHash}`,

      version:
        APP_VERSION,

      name:
        config.iptv_name
          ? `PT TV Hub - ${config.iptv_name}`
          : APP_NAME,

      description:
        errors.length > 0
          ? "PT TV Hub - configuração inválida."
          :
            (
              config.iptv_type ===
              "Xtream Codes"
                ? "PT TV Hub - Xtream Codes"
                : "PT TV Hub - M3U IPTV"
            ),

      logo:
        `${origin}/assets/logo.svg`,

      background:
        `${origin}/assets/background.svg`,

      behaviorHints: {
        configurable:
          true,

        configurationRequired:
          false,

        p2p:
          false
      }

    };

    noCache(res);

    return res.json(
      manifest
    );

  }
);


// ============================================================
// CATALOG
// ============================================================

app.get(
  "/:config/catalog/:type/:id.json",
  async (req, res) => {

    noCache(res);

    const config =
      decodeConfig(
        req.params.config
      );

    const type =
      req.params.type;

    const id =
      req.params.id;

    const search =
      String(
        req.query.search ||
        ""
      )
        .trim()
        .toLowerCase();


    /*
     * Serviços oficiais
     */

    if (
      type === "channel" &&
      id === "pt-services"
    ) {

      const metas =
        Array.isArray(
          services
        )
          ? services
              .map(
                (service) => {

                  const name =
                    service.name ||
                    "Serviço";

                  if (
                    search &&
                    !name
                      .toLowerCase()
                      .includes(
                        search
                      )
                  ) {
                    return null;
                  }

                  return {
                    id:
                      service.id ||
                      `pttv:${crypto
                        .createHash(
                          "sha256"
                        )
                        .update(
                          name
                        )
                        .digest(
                          "hex"
                        )
                        .slice(
                          0,
                          16
                        )}`,

                    type:
                      "channel",

                    name,

                    poster:
                      service.logo ||
                      "",

                    background:
                      service.background ||
                      service.logo ||
                      "",

                    logo:
                      service.logo ||
                      "",

                    description:
                      service.description ||
                      "Serviço oficial.",

                    posterShape:
                      "square"
                  };
                }
              )
              .filter(Boolean)
          : [];

      return res.json({
        metas
      });
    }


    /*
     * IPTV M3U/Xtream
     *
     * A lista é SEMPRE consultada
     * novamente neste momento.
     */

    if (
      type === "channel" &&
      id === "m3u"
    ) {

      const channels =
        await getIPTVChannels(
          config
        );

      const filtered =
        search
          ? channels.filter(
              (channel) =>
                String(
                  channel.title ||
                  ""
                )
                  .toLowerCase()
                  .includes(
                    search
                  ) ||
                String(
                  channel.group ||
                  ""
                )
                  .toLowerCase()
                  .includes(
                    search
                  )
            )
          : channels;


      return res.json({

        metas:
          filtered.map(
            (channel) => {

              const poster =
                channel.logo ||
                `${getPublicOrigin(
                  req
                )}/assets/logo.svg`;

              return {

                id:
                  channel.id,

                type:
                  "channel",

                name:
                  channel.title,

                poster,

                posterShape:
                  "square",

                /*
                 * O Stremio usa background
                 * na página de detalhe.
                 *
                 * Quando a M3U não fornece
                 * uma imagem separada,
                 * usamos o logo como fallback.
                 */

                background:
                  channel.logo ||
                  poster,

                logo:
                  channel.logo ||
                  poster,

                description:
                  channel.group ||
                  "IPTV"

              };

            }
          )

      });

    }


    return res.json({
      metas: []
    });

  }
);


// ============================================================
// META
// ============================================================

app.get(
  "/:config/meta/:type/:id.json",
  async (req, res) => {

    noCache(res);

    const config =
      decodeConfig(
        req.params.config
      );

    const id =
      req.params.id;


    /*
     * Serviços oficiais
     */

    const service =
      Array.isArray(
        services
      )
        ? services.find(
            (item) =>
              item.id === id
          )
        : null;

    if (
      service
    ) {

      return res.json({

        meta: {

          id:
            service.id,

          type:
            "channel",

          name:
            service.name,

          poster:
            service.logo ||
            "",

          background:
            service.background ||
            service.logo ||
            "",

          logo:
            service.logo ||
            "",

          description:
            service.description ||
            "Serviço oficial.",

          posterShape:
            "square"

        }

      });

    }


    /*
     * IPTV
     */

    const channels =
      await getIPTVChannels(
        config
      );

    const channel =
      channels.find(
        (item) =>
          item.id === id
      );

    if (
      !channel
    ) {

      return res.json({
        meta: null
      });

    }


    const fallbackLogo =
      `${getPublicOrigin(
        req
      )}/assets/logo.svg`;

    const poster =
      channel.logo ||
      fallbackLogo;


    return res.json({

      meta: {

        id:
          channel.id,

        type:
          "channel",

        name:
          channel.title,

        poster,

        posterShape:
          "square",

        background:
          channel.logo ||
          fallbackLogo,

        logo:
          channel.logo ||
          fallbackLogo,

        description:
          channel.group ||
          "IPTV",

        genres:
          channel.group
            ? [
                channel.group
              ]
            : []

      }

    });

  }
);


// ============================================================
// STREAM
// ============================================================

app.get(
  "/:config/stream/:type/:id.json",
  async (req, res) => {

    noCache(res);

    const config =
      decodeConfig(
        req.params.config
      );

    const id =
      req.params.id;


    /*
     * Serviços oficiais
     */

    const service =
      Array.isArray(
        services
      )
        ? services.find(
            (item) =>
              item.id === id
          )
        : null;

    if (
      service
    ) {

      const serviceUrl =
        service.url ||
        service.link ||
        service.web ||
        "";

      if (
        isValidHttpUrl(
          serviceUrl
        )
      ) {

        return res.json({

          streams: [

            {

              name:
                service.name,

              description:
                "Abrir serviço oficial.",

              externalUrl:
                serviceUrl

            }

          ]

        });

      }

      return res.json({
        streams: []
      });

    }


    /*
     * IPTV
     *
     * A M3U é novamente consultada
     * no momento de obter o stream.
     *
     * Isto significa que, se a lista
     * mudar, o stream também recebe
     * a versão atualizada.
     */

    const channels =
      await getIPTVChannels(
        config
      );

    const channel =
      channels.find(
        (item) =>
          item.id === id
      );

    if (
      !channel
    ) {

      return res.json({
        streams: []
      });

    }


    if (
      !isValidHttpUrl(
        channel.url
      )
    ) {

      return res.json({
        streams: []
      });

    }


    const stream =
      buildStreamObject(
        channel
      );


    return res.json({

      streams: [
        stream
      ]

    });

  }
);


// ============================================================
// ADDONS RECOMENDADOS
// ============================================================

app.get(
  "/:config/catalog/addon/recommended.json",
  (req, res) => {

    noCache(res);

    const addonList =
      Array.isArray(
        addons
      )
        ? addons
        : [];

    const result =
      addonList

        .filter(
          (addon) =>
            addon &&
            isValidHttpUrl(
              addon.url
            )
        )

        .map(
          (addon) => {

            const addonId =
              crypto
                .createHash(
                  "sha256"
                )
                .update(
                  String(
                    addon.name ||
                    addon.url
                  )
                )
                .digest(
                  "hex"
                )
                .slice(
                  0,
                  20
                );

            return {

              transportName:
                "http",

              transportUrl:
                addon.url,

              manifest: {

                id:
                  `external.${addonId}`,

                version:
                  "1.0.0",

                name:
                  addon.name ||
                  "Addon externo",

                description:
                  addon.description ||
                  "Addon externo recomendado.",

                logo:
                  addon.logo ||
                  "",

                resources: [
                  "catalog",
                  "meta",
                  "stream"
                ],

                types: [
                  "movie",
                  "series"
                ],

                catalogs: []

              }

            };

          }
        );


    return res.json({
      addons:
        result
    });

  }
);


// ============================================================
// HEALTH / HOME
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.type(
      "html"
    );

    res.send(`
<!DOCTYPE html>

<html lang="pt-PT">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>PT TV Hub</title>

<style>

body {

  margin: 0;

  min-height: 100vh;

  font-family:
    Arial,
    Helvetica,
    sans-serif;

  color:
    #ffffff;

  background:
    radial-gradient(
      circle at top,
      #172554,
      #020617 60%,
      #000000
    );

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  text-align:
    center;

}

.box {

  padding:
    40px;

}

.logo {

  width:
    120px;

  height:
    120px;

  margin:
    0 auto 20px;

  border-radius:
    30px;

  background:
    linear-gradient(
      135deg,
      #38bdf8,
      #2563eb
    );

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  font-size:
    60px;

}

.ok {

  color:
    #4ade80;

}

a {

  color:
    #38bdf8;

}

</style>

</head>

<body>

<div class="box">

<div class="logo">
📺
</div>

<h1>
PT TV Hub
</h1>

<p class="ok">
● Serviço online
</p>

<p>
Versão ${APP_VERSION}
</p>

<p>
<a href="/configure">
Configurar IPTV
</a>
</p>

</div>

</body>

</html>
    `);

  }
);


// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {

    res
      .status(404)
      .json({
        error:
          "Endpoint não encontrado."
      });

  }
);


// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "Erro interno:",
      error.message
    );

    res
      .status(500)
      .json({
        error:
          "Erro interno do servidor."
      });

  }
);


// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      `PT TV Hub ${APP_VERSION} em http://localhost:${PORT}`
    );

    console.log(
      "Servidor iniciado com sucesso."
    );

  }
);
