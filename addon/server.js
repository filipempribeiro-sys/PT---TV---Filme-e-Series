const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 7000;
const BASE = __dirname;

// ============================================================
// CORS
// Permite que Stremio / Stremio Web aceda ao addon
// ============================================================

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options("*", (req, res) => {
  res.sendStatus(204);
});

// ============================================================
// CARREGAR DADOS
// ============================================================

const servicesFile = path.join(
  BASE,
  "..",
  "data",
  "services.json"
);

const addonsFile = path.join(
  BASE,
  "..",
  "data",
  "addons.json"
);

let services = [];
let addons = [];

try {
  services = JSON.parse(
    fs.readFileSync(servicesFile, "utf8")
  );
} catch (error) {
  console.error("Erro ao carregar services.json:", error.message);
}

try {
  addons = JSON.parse(
    fs.readFileSync(addonsFile, "utf8")
  );
} catch (error) {
  console.error("Erro ao carregar addons.json:", error.message);
}

// ============================================================
// FUNÇÕES AUXILIARES
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

    // Informação do canal
    if (line.startsWith("#EXTINF")) {
      const attrs = {};

      const attrRe = /([\w-]+)="([^"]*)"/g;

      let match;

      while ((match = attrRe.exec(line)) !== null) {
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
        logo: attrs["tvg-logo"] || ""
      };

      continue;
    }

    // URL do canal
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
// CARREGAR M3U DO UTILIZADOR
// ============================================================

function loadUserM3U() {
  const file = path.join(
    BASE,
    "..",
    "data",
    "user.m3u"
  );

  if (!fs.existsSync(file)) {
    return [];
  }

  try {
    const text = fs.readFileSync(
      file,
      "utf8"
    );

    return parseM3U(text);
  } catch (error) {
    console.error(
      "Erro ao carregar user.m3u:",
      error.message
    );

    return [];
  }
}

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
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      line-height: 1.6;
    }

    code {
      background: #eee;
      padding: 3px 6px;
      border-radius: 4px;
    }
  </style>
</head>

<body>

<h1>PT TV Hub</h1>

<p>O serviço está online.</p>

<p>
  <strong>Stremio Manifest:</strong><br>
  <code>/manifest.json</code>
</p>

<p>
  <strong>Configuração:</strong><br>
  <code>/configure</code>
</p>

</body>
</html>
  `);
});

// ============================================================
// MANIFEST
// ============================================================

app.get("/manifest.json", (req, res) => {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(BASE, "manifest.json"),
        "utf8"
      )
    );

    res.json(manifest);
  } catch (error) {
    console.error(
      "Erro ao carregar manifest.json:",
      error.message
    );

    res.status(500).json({
      error: "Não foi possível carregar o manifest.json"
    });
  }
});

// ============================================================
// CATÁLOGO — SERVIÇOS TV PORTUGAL
// ============================================================

app.get(
  "/catalog/channel/pt-services.json",
  (req, res) => {

    const metas = services.map(service => ({
      id: service.id,
      type: "channel",
      name: service.name,
      poster: service.logo || "",
      description:
        service.description ||
        "Serviço oficial.",
      posterShape: "square"
    }));

    res.json({
      metas
    });
  }
);

// ============================================================
// CATÁLOGO — M3U
// ============================================================

app.get(
  "/catalog/channel/m3u.json",
  (req, res) => {

    const channels = loadUserM3U();

    const metas = channels.map(channel => ({
      id: channel.id,
      type: "channel",
      name: channel.title,
      poster: channel.logo || "",
      description:
        channel.group || "IPTV",
      posterShape: "square"
    }));

    res.json({
      metas
    });
  }
);

// ============================================================
// META — CANAIS
// ============================================================

app.get(
  "/meta/channel/:id.json",
  (req, res) => {

    const id = decodeURIComponent(
      req.params.id
    );

    // Serviço oficial
    const service = services.find(
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

    // Canal M3U
    const channel = loadUserM3U().find(
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

    return res.json({
      meta: null
    });
  }
);

// ============================================================
// STREAM — CANAIS
// ============================================================

app.get(
  "/stream/channel/:id.json",
  (req, res) => {

    const id = decodeURIComponent(
      req.params.id
    );

    // Serviço oficial
    const service = services.find(
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

    // Canal M3U
    const channel = loadUserM3U().find(
      item => item.id === id
    );

    if (channel) {

      return res.json({
        streams: [
          {
            name: channel.title,
            title: channel.group,
            url: channel.url
          }
        ]
      });
    }

    return res.json({
      streams: []
    });
  }
);

// ============================================================
// CATÁLOGO — ADDONS RECOMENDADOS
// ============================================================

app.get(
  "/catalog/addon/recommended.json",
  (req, res) => {

    const metas = addons.map(
      (addon, index) => ({
        id: "addon:" + index,

        type: "addon",

        name: addon.name,

        description:
          "Manifest/recurso externo. " +
          "A instalação e configuração são feitas pelo utilizador.",

        website: addon.url,

        posterShape: "square"
      })
    );

    res.json({
      metas
    });
  }
);

// ============================================================
// META — ADDONS
// ============================================================

app.get(
  "/meta/addon/:id.json",
  (req, res) => {

    const id = req.params.id;

    const index = Number(
      id.replace("addon:", "")
    );

    const addon = addons[index];

    if (!addon) {
      return res.json({
        meta: null
      });
    }

    return res.json({
      meta: {
        id: "addon:" + index,
        type: "addon",
        name: addon.name,
        description: addon.url,
        website: addon.url
      }
    });
  }
);

// ============================================================
// STREAM — ADDONS
// ============================================================

app.get(
  "/stream/addon/:id.json",
  (req, res) => {

    const id = req.params.id;

    const index = Number(
      id.replace("addon:", "")
    );

    const addon = addons[index];

    if (!addon) {
      return res.json({
        streams: []
      });
    }

    return res.json({
      streams: [
        {
          name: addon.name,
          externalUrl: addon.url
        }
      ]
    });
  }
);

// ============================================================
// CONFIGURAÇÃO
// ============================================================

app.get(
  "/configure",
  (req, res) => {

    res.type("html").send(`
<!doctype html>

<html>

<head>

<meta charset="utf-8">

<title>PT TV Hub</title>

<style>

body {
  font-family: Arial, sans-serif;
  max-width: 800px;
  margin: 40px auto;
  padding: 20px;
  line-height: 1.6;
}

code {
  background: #eee;
  padding: 3px 6px;
  border-radius: 4px;
}

h1 {
  margin-bottom: 5px;
}

.box {
  background: #f5f5f5;
  padding: 15px;
  border-radius: 8px;
  margin-top: 20px;
}

</style>

</head>

<body>

<h1>PT TV Hub</h1>

<p>
Hub para serviços de TV em Portugal e listas M3U
fornecidas pelo utilizador.
</p>

<div class="box">

<h2>IPTV própria / autorizada</h2>

<p>
Coloque a sua lista M3U em:
</p>

<code>data/user.m3u</code>

</div>

<div class="box">

<h2>Privacidade</h2>

<p>
O PT TV Hub não recolhe nem guarda credenciais
Vodafone, DIGI, MEO ou NOS.
</p>

<p>
O sistema não contorna autenticação,
DRM ou outras proteções de conteúdos.
</p>

</div>

</body>

</html>
    `);
  }
);

// ============================================================
// TRATAMENTO DE ERROS
// ============================================================

app.use(
  (err, req, res, next) => {

    console.error(
      "Erro no servidor:",
      err
    );

    res.status(500).json({
      error: "Erro interno do PT TV Hub"
    });
  }
);

// ============================================================
// ARRANQUE
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `PT TV Hub em http://0.0.0.0:${PORT}`
    );

    console.log(
      `Manifest: /manifest.json`
    );

  }
);
