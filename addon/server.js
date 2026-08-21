const express = require("express");
const fs = require("fs");
const path = require("path");

const {
  addonBuilder,
  serveHTTP
} = require("stremio-addon-sdk");

const app = express();

const PORT = process.env.PORT || 7000;
const BASE = __dirname;

// ============================================================
// CORS
// ============================================================

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  next();
});

app.options("*", (req, res) => {
  res.sendStatus(204);
});

// ============================================================
// CARREGAR DADOS
// ============================================================

function loadJSON(file) {
  try {
    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch (error) {
    console.error(
      `Erro ao carregar ${file}:`,
      error.message
    );

    return [];
  }
}

const services = loadJSON(
  path.join(
    BASE,
    "..",
    "data",
    "services.json"
  )
);

const addons = loadJSON(
  path.join(
    BASE,
    "..",
    "data",
    "addons.json"
  )
);

// ============================================================
// M3U PARSER
// ============================================================

function parseM3U(text) {

  const lines = text.split(/\r?\n/);

  const channels = [];

  let current = null;

  for (const line0 of lines) {

    const line = line0.trim();

    if (!line) {
      continue;
    }

    if (line.startsWith("#EXTINF")) {

      const attrs = {};

      const attrRegex =
        /([\w-]+)="([^"]*)"/g;

      let match;

      while (
        (match = attrRegex.exec(line)) !== null
      ) {
        attrs[match[1]] = match[2];
      }

      const comma = line.indexOf(",");

      const title =
        comma >= 0
          ? line.slice(comma + 1).trim()
          : attrs["tvg-name"] || "Canal";

      current = {
        title,
        group:
          attrs["group-title"] || "IPTV",
        logo:
          attrs["tvg-logo"] || "",
        tvgId:
          attrs["tvg-id"] || ""
      };

      continue;
    }

    if (
      !line.startsWith("#") &&
      current
    ) {

      current.url = line;

      current.id =
        "m3u:" +
        Buffer
          .from(line)
          .toString("base64url")
          .slice(0, 24);

      channels.push(current);

      current = null;
    }
  }

  return channels;
}

// ============================================================
// FETCH M3U
// ============================================================

async function fetchM3U(url) {

  if (!url) {
    return [];
  }

  try {

    const response = await fetch(url);

    if (!response.ok) {

      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const text =
      await response.text();

    return parseM3U(text);

  } catch (error) {

    console.error(
      "Erro ao obter M3U:",
      error.message
    );

    return [];
  }
}

// ============================================================
// XTREAM API
// ============================================================

function cleanXtreamUrl(url) {

  if (!url) {
    return "";
  }

  return url
    .trim()
    .replace(/\/+$/, "");
}

async function xtreamRequest(
  config,
  action = ""
) {

  const server =
    cleanXtreamUrl(
      config.xtream_url
    );

  const username =
    config.xtream_username || "";

  const password =
    config.xtream_password || "";

  if (
    !server ||
    !username ||
    !password
  ) {
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

    const response =
      await fetch(url);

    if (!response.ok) {

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
  }
}

// ============================================================
// XTREAM CHANNELS
// ============================================================

async function getXtreamChannels(
  config
) {

  const data =
    await xtreamRequest(
      config,
      "get_live_streams"
    );

  if (!Array.isArray(data)) {
    return [];
  }

  const server =
    cleanXtreamUrl(
      config.xtream_url
    );

  const username =
    config.xtream_username;

  const password =
    config.xtream_password;

  return data.map(
    channel => {

      const extension =
        channel.container_extension ||
        "ts";

      const streamUrl =
        `${server}/live/` +
        `${encodeURIComponent(username)}/` +
        `${encodeURIComponent(password)}/` +
        `${channel.stream_id}.${extension}`;

      return {

        id:
          `xtream:${channel.stream_id}`,

        title:
          channel.name ||
          `Canal ${channel.stream_id}`,

        group:
          channel.category_name ||
          "TV",

        logo:
          channel.stream_icon ||
          "",

        tvgId:
          channel.epg_channel_id ||
          "",

        url:
          streamUrl
      };
    }
  );
}

// ============================================================
// IPTV CHANNEL LOADER
// ============================================================

async function getIPTVChannels(
  config
) {

  if (!config) {
    return [];
  }

  const type =
    config.iptv_type;

  if (type === "M3U URL") {

    return await fetchM3U(
      config.m3u_url
    );
  }

  if (type === "Xtream Codes") {

    return await getXtreamChannels(
      config
    );
  }

  return [];
}

// ============================================================
// MANIFEST
// ============================================================

const manifest =
  require("./manifest.json");

// ============================================================
// STREMIO ADDON
// ============================================================

const builder =
  new addonBuilder(manifest);

// ============================================================
// CATALOG HANDLER
// ============================================================

builder.defineCatalogHandler(
  async args => {

    if (
      args.type === "channel" &&
      args.id === "pt-services"
    ) {

      return {

        metas:
          services.map(
            service => ({

              id: service.id,

              type: "channel",

              name:
                service.name,

              poster:
                service.logo || "",

              description:
                service.description ||
                "Serviço oficial.",

              posterShape:
                "square"
            })
          )
      };
    }

    if (
      args.type === "channel" &&
      args.id === "m3u"
    ) {

      const config =
        args.config || {};

      const channels =
        await getIPTVChannels(
          config
        );

      return {

        metas:
          channels.map(
            channel => ({

              id:
                channel.id,

              type:
                "channel",

              name:
                channel.title,

              poster:
                channel.logo || "",

              description:
                channel.group ||
                "IPTV",

              posterShape:
                "square"
            })
          )
      };
    }

    if (
      args.type === "addon" &&
      args.id === "recommended"
    ) {

      return {

        metas:
          addons.map(
            (addon, index) => ({

              id:
                `addon:${index}`,

              type:
                "addon",

              name:
                addon.name,

              description:
                "Recurso externo. " +
                "A instalação/configuração é feita pelo utilizador.",

              website:
                addon.url,

              posterShape:
                "square"
            })
          )
      };
    }

    return {
      metas: []
    };
  }
);

// ============================================================
// META HANDLER
// ============================================================

builder.defineMetaHandler(
  async args => {

    const id =
      args.id;

    const service =
      services.find(
        item => item.id === id
      );

    if (service) {

      return {

        meta: {

          id:
            service.id,

          type:
            "channel",

          name:
            service.name,

          poster:
            service.logo || "",

          description:
            service.description ||
            "Serviço oficial.",

          posterShape:
            "square"
        }
      };
    }

    const config =
      args.config || {};

    const channels =
      await getIPTVChannels(
        config
      );

    const channel =
      channels.find(
        item => item.id === id
      );

    if (channel) {

      return {

        meta: {

          id:
            channel.id,

          type:
            "channel",

          name:
            channel.title,

          poster:
            channel.logo || "",

          description:
            channel.group ||
            "IPTV",

          posterShape:
            "square"
        }
      };
    }

    if (
      id.startsWith("addon:")
    ) {

      const index =
        Number(
          id.replace(
            "addon:",
            ""
          )
        );

      const addon =
        addons[index];

      if (!addon) {

        return {
          meta: null
        };
      }

      return {

        meta: {

          id:
            `addon:${index}`,

          type:
            "addon",

          name:
            addon.name,

          description:
            addon.url,

          website:
            addon.url
        }
      };
    }

    return {
      meta: null
    };
  }
);

// ============================================================
// STREAM HANDLER
// ============================================================

builder.defineStreamHandler(
  async args => {

    const id =
      args.id;

    // --------------------------------------------------------
    // OPERADORES
    // --------------------------------------------------------

    const service =
      services.find(
        item => item.id === id
      );

    if (service) {

      return {

        streams: [

          {

            name:
              service.name,

            description:
              "Abrir serviço oficial. " +
              "O login e as permissões são tratados pelo operador.",

            externalUrl:
              service.url
          }

        ]
      };
    }

    // --------------------------------------------------------
    // IPTV
    // --------------------------------------------------------

    const config =
      args.config || {};

    const channels =
      await getIPTVChannels(
        config
      );

    const channel =
      channels.find(
        item => item.id === id
      );

    if (channel) {

      return {

        streams: [

          {

            name:
              channel.title,

            title:
              channel.group,

            description:
              "Fonte IPTV configurada pelo utilizador.",

            url:
              channel.url

          }

        ]
      };
    }

    // --------------------------------------------------------
    // ADDONS
    // --------------------------------------------------------

    if (
      id.startsWith("addon:")
    ) {

      const index =
        Number(
          id.replace(
            "addon:",
            ""
          )
        );

      const addon =
        addons[index];

      if (!addon) {

        return {
          streams: []
        };
      }

      return {

        streams: [

          {

            name:
              addon.name,

            externalUrl:
              addon.url
          }

        ]
      };
    }

    return {
      streams: []
    };
  }
);

// ============================================================
// CONFIGURAÇÃO CUSTOMIZADA
// ============================================================

app.get(
  "/configure",
  (req, res) => {

    res.type("html").send(`

<!doctype html>

<html>

<head>

<meta charset="utf-8">

<title>PT TV Hub — Configuração</title>

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
/>

<style>

body {
  font-family: Arial, sans-serif;
  max-width: 850px;
  margin: 30px auto;
  padding: 20px;
  background: #f5f5f5;
}

.card {
  background: white;
  padding: 25px;
  margin-bottom: 20px;
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,.08);
}

h1 {
  margin-top: 0;
}

h2 {
  margin-top: 0;
}

label {
  display: block;
  font-weight: bold;
  margin-top: 15px;
}

input,
select {
  width: 100%;
  box-sizing: border-box;
  padding: 11px;
  margin-top: 6px;
  border: 1px solid #ccc;
  border-radius: 6px;
}

button {
  margin-top: 20px;
  padding: 12px 20px;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  font-weight: bold;
}

.notice {
  background: #fff3cd;
  padding: 12px;
  border-radius: 6px;
}

</style>

</head>

<body>

<div class="card">

<h1>📺 PT TV Hub</h1>

<p>
Configure aqui a sua fonte IPTV.
</p>

<div class="notice">

<strong>Privacidade:</strong>

As credenciais IPTV são fornecidas pelo próprio
utilizador e usadas apenas para aceder à fonte
configurada.

</div>

</div>

<div class="card">

<h2>📡 IPTV</h2>

<label>Nome</label>

<input
  id="name"
  value="Minha IPTV"
/>

<label>Tipo</label>

<select id="type">

<option>Nenhuma</option>

<option>M3U URL</option>

<option>Xtream Codes</option>

</select>

<div id="m3u">

<label>M3U URL</label>

<input
  id="m3uUrl"
  placeholder="https://exemplo.com/lista.m3u"
/>

</div>

<div id="xtream">

<label>Xtream Server URL</label>

<input
  id="xtreamUrl"
  placeholder="http://servidor:8080"
/>

<label>Username</label>

<input
  id="username"
/>

<label>Password</label>

<input
  id="password"
  type="password"
/>

</div>

<label>EPG URL (opcional)</label>

<input
  id="epg"
  placeholder="https://exemplo.com/epg.xml"
/>

<button onclick="installAddon()">
  Adicionar PT TV Hub ao Stremio
</button>

</div>

<script>

const type =
  document.getElementById("type");

const m3u =
  document.getElementById("m3u");

const xtream =
  document.getElementById("xtream");

function updateFields() {

  m3u.style.display =
    type.value === "M3U URL"
      ? "block"
      : "none";

  xtream.style.display =
    type.value === "Xtream Codes"
      ? "block"
      : "none";
}

type.addEventListener(
  "change",
  updateFields
);

updateFields();

function installAddon() {

  const config = {

    iptv_name:
      document.getElementById("name").value,

    iptv_type:
      document.getElementById("type").value,

    m3u_url:
      document.getElementById("m3uUrl").value,

    xtream_url:
      document.getElementById("xtreamUrl").value,

    xtream_username:
      document.getElementById("username").value,

    xtream_password:
      document.getElementById("password").value,

    epg_url:
      document.getElementById("epg").value
  };

  const encoded =
    btoa(
      unescape(
        encodeURIComponent(
          JSON.stringify(config)
        )
      )
    )
    .replace(/\\+/g, "-")
    .replace(/\\//g, "_")
    .replace(/=+$/, "");

  const url =
    window.location.origin +
    "/c/" +
    encoded +
    "/manifest.json";

  const stremio =
    "stremio://" +
    url.replace(
      /^https?:\\/\\//,
      ""
    );

  window.location.href =
    stremio;
}

</script>

</body>

</html>

    `);
  }
);

// ============================================================
// CONFIGURATED MANIFEST
// ============================================================

app.get(
  "/c/:config/manifest.json",
  (req, res) => {

    res.json({
      ...manifest,

      id:
        `${manifest.id}.${req.params.config.slice(0, 12)}`,

      behaviorHints: {
        ...manifest.behaviorHints,
        configurable: true
      }
    });
  }
);

// ============================================================
// START
// ============================================================

app.use(
  (req, res, next) => {

    res.status(404).json({
      error: "Endpoint não encontrado"
    });
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `PT TV Hub em 0.0.0.0:${PORT}`
    );

    console.log(
      "PT TV Hub pronto."
    );
  }
);
