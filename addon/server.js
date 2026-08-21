const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;
const BASE = __dirname;

// ============================================================
// CONFIGURAÇÃO
// ============================================================

const BASE_URL =
  process.env.RENDER_EXTERNAL_URL ||
  "https://pt-tv-filme-e-series.onrender.com";

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json({ limit: "200kb" }));

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

// ============================================================
// DADOS DO PROJETO
// ============================================================

function loadJSON(file) {
  try {
    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch (error) {
    console.error(
      `Erro ao carregar ${file}: ${error.message}`
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

const baseManifest = JSON.parse(
  fs.readFileSync(
    path.join(BASE, "manifest.json"),
    "utf8"
  )
);

// ============================================================
// FUNÇÕES DE CONFIGURAÇÃO
// ============================================================

function encodeConfig(config) {
  const json =
    JSON.stringify(config);

  return Buffer
    .from(json, "utf8")
    .toString("base64url");
}

function decodeConfig(value) {
  if (!value) {
    return {};
  }

  try {
    const json =
      Buffer
        .from(value, "base64url")
        .toString("utf8");

    const config =
      JSON.parse(json);

    if (
      !config ||
      typeof config !== "object"
    ) {
      return {};
    }

    return config;

  } catch (error) {
    console.error(
      "Configuração inválida recebida."
    );

    return {};
  }
}

// ============================================================
// SEGURANÇA BÁSICA DOS URLS
// ============================================================

function isValidHttpUrl(value) {
  try {
    const url =
      new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );

  } catch {
    return false;
  }
}

// ============================================================
// M3U
// ============================================================

function parseM3U(text) {
  const lines =
    text.split(/\r?\n/);

  const channels = [];

  let current = null;

  for (const raw of lines) {

    const line =
      raw.trim();

    if (!line) {
      continue;
    }

    if (
      line.startsWith("#EXTINF")
    ) {

      const attrs = {};

      const regex =
        /([\w-]+)="([^"]*)"/g;

      let match;

      while (
        (match = regex.exec(line))
          !== null
      ) {

        attrs[match[1]] =
          match[2];
      }

      const comma =
        line.indexOf(",");

      const title =
        comma >= 0
          ? line
              .slice(comma + 1)
              .trim()
          : (
              attrs["tvg-name"] ||
              "Canal"
            );

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
          title
      };

      continue;
    }

    if (
      !line.startsWith("#") &&
      current
    ) {

      if (
        isValidHttpUrl(line)
      ) {

        current.url =
          line;

        current.id =
          "m3u:" +
          crypto
            .createHash("sha256")
            .update(line)
            .digest("hex")
            .slice(0, 24);

        channels.push(
          current
        );
      }

      current = null;
    }
  }

  return channels;
}

// ============================================================
// DOWNLOAD M3U
// ============================================================

async function fetchM3U(url) {

  if (
    !url ||
    !isValidHttpUrl(url)
  ) {
    return [];
  }

  try {

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        20000
      );

    const response =
      await fetch(
        url,
        {
          signal:
            controller.signal,
          headers: {
            "User-Agent":
              "PT-TV-Hub/1.3"
          }
        }
      );

    clearTimeout(timeout);

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
// XTREAM
// ============================================================

function cleanXtreamUrl(url) {

  return String(url || "")
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
    String(
      config.xtream_username || ""
    ).trim();

  const password =
    String(
      config.xtream_password || ""
    );

  if (
    !server ||
    !username ||
    !password
  ) {
    return null;
  }

  if (
    !isValidHttpUrl(server)
  ) {
    return null;
  }

  const url =
    `${server}/player_api.php` +
    `?username=${encodeURIComponent(username)}` +
    `&password=${encodeURIComponent(password)}` +
    (
      action
        ? `&action=${encodeURIComponent(action)}`
        : ""
    );

  try {

    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => controller.abort(),
        20000
      );

    const response =
      await fetch(
        url,
        {
          signal:
            controller.signal,
          headers: {
            "User-Agent":
              "PT-TV-Hub/1.3"
          }
        }
      );

    clearTimeout(timeout);

    if (!response.ok) {

      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return await response.json();

  } catch (error) {

    /*
     * Nunca imprimir URL Xtream,
     * username ou password.
     */

    console.error(
      "Erro na ligação Xtream:",
      error.message
    );

    return null;
  }
}

// ============================================================
// XTREAM - CANAIS
// ============================================================

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
    cleanXtreamUrl(
      config.xtream_url
    );

  const username =
    config.xtream_username;

  const password =
    config.xtream_password;

  return data
    .map(channel => {

      const streamId =
        channel.stream_id;

      if (
        streamId === undefined ||
        streamId === null
      ) {
        return null;
      }

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

        url:
          `${server}/live/` +
          `${encodeURIComponent(username)}/` +
          `${encodeURIComponent(password)}/` +
          `${streamId}.${extension}`
      };

    })
    .filter(Boolean);
}

// ============================================================
// OBTER CANAIS IPTV
// ============================================================

async function getIPTVChannels(
  config
) {

  if (!config) {
    return [];
  }

  if (
    config.iptv_type ===
    "M3U URL"
  ) {

    return await fetchM3U(
      config.m3u_url
    );
  }

  if (
    config.iptv_type ===
    "Xtream Codes"
  ) {

    return await getXtreamChannels(
      config
    );
  }

  return [];
}

// ============================================================
// CONFIGURAÇÃO - VALIDAÇÃO
// ============================================================

function validateConfig(
  config
) {

  const errors = [];

  if (
    !config ||
    typeof config !== "object"
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

    return errors;
  }

  if (
    config.iptv_type ===
    "M3U URL"
  ) {

    if (
      !config.m3u_url
    ) {

      errors.push(
        "Introduz a URL M3U."
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
// CONFIGURAÇÃO - HTML
// ============================================================

function configurationPage(
  req,
  res
) {

  const existingConfig =
    req.params.config
      ? decodeConfig(
          req.params.config
        )
      : {};

  const name =
    existingConfig.iptv_name ||
    "Minha IPTV";

  const type =
    existingConfig.iptv_type ||
    "Nenhuma";

  const m3uUrl =
    existingConfig.m3u_url ||
    "";

  const xtreamUrl =
    existingConfig.xtream_url ||
    "";

  const username =
    existingConfig.xtream_username ||
    "";

  const epgUrl =
    existingConfig.epg_url ||
    "";

  res
    .status(200)
    .type("html")
    .send(`<!DOCTYPE html>
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

html,
body {
  margin: 0;
  padding: 0;
  min-height: 100%;
}

body {

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

  min-height: 100vh;

  padding: 30px 16px;
}

.container {

  width: 100%;

  max-width: 700px;

  margin:
    0 auto;
}

.card {

  background:
    rgba(15, 23, 42, 0.96);

  border:
    1px solid
    rgba(255,255,255,0.10);

  border-radius: 20px;

  padding: 30px;

  box-shadow:
    0 25px 80px
    rgba(0,0,0,0.45);
}

.header {

  text-align: center;

  margin-bottom: 30px;
}

.logo {

  font-size: 50px;

  margin-bottom: 8px;
}

h1 {

  margin: 0;

  font-size: 30px;
}

.subtitle {

  color: #94a3b8;

  margin-top: 8px;
}

label {

  display: block;

  font-size: 14px;

  font-weight: 700;

  margin:
    18px 0 8px;
}

input,
select {

  width: 100%;

  border:
    1px solid
    #334155;

  background:
    #020617;

  color: #ffffff;

  border-radius: 10px;

  padding: 14px;

  font-size: 15px;
}

input:focus,
select:focus {

  outline: none;

  border-color:
    #38bdf8;

  box-shadow:
    0 0 0 2px
    rgba(56,189,248,.12);
}

.section {

  margin-top: 8px;

  padding:
    4px 0 0;
}

.hidden {

  display: none;
}

.hint {

  color: #64748b;

  font-size: 12px;

  margin-top: 7px;
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

  transition:
    transform .15s,
    opacity .15s;
}

button:hover {

  transform:
    translateY(-1px);

  opacity: .92;
}

.test {

  background:
    #334155;

  color: white;
}

.install {

  background:
    #0ea5e9;

  color: white;
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

.info {

  margin-top: 25px;

  padding: 15px;

  border-radius: 10px;

  background:
    rgba(30,41,59,.55);

  color:
    #94a3b8;

  font-size: 12px;

  line-height: 1.6;
}

@media (
  max-width: 600px
) {

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

<div class="logo">
📺
</div>

<h1>
PT TV Hub
</h1>

<div class="subtitle">
Configuração da fonte IPTV
</div>

</div>

<label for="iptv_name">
Nome da fonte
</label>

<input
  id="iptv_name"
  value="${escapeHtml(name)}"
  placeholder="Ex.: Minha IPTV"
>

<label for="iptv_type">
Tipo de IPTV
</label>

<select id="iptv_type">

<option
  value="Nenhuma"
  ${type === "Nenhuma" ? "selected" : ""}
>
Selecionar...
</option>

<option
  value="M3U URL"
  ${type === "M3U URL" ? "selected" : ""}
>
M3U URL
</option>

<option
  value="Xtream Codes"
  ${type === "Xtream Codes" ? "selected" : ""}
>
Xtream Codes
</option>

</select>

<div
  id="m3uSection"
  class="section ${
    type === "M3U URL"
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
  value="${escapeHtml(m3uUrl)}"
  placeholder="https://servidor/lista.m3u"
>

<div class="hint">
Utiliza uma lista M3U tua ou autorizada.
</div>

</div>

<div
  id="xtreamSection"
  class="section ${
    type === "Xtream Codes"
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
  value="${escapeHtml(xtreamUrl)}"
  placeholder="https://servidor:porta"
>

<label for="xtream_username">
Username
</label>

<input
  id="xtream_username"
  value="${escapeHtml(username)}"
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
  value="${escapeHtml(epgUrl)}"
  placeholder="https://servidor/epg.xml"
>

<div class="hint">
O EPG será utilizado na próxima etapa
para associação dos programas aos canais.
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
📺 Instalar
</button>

</div>

<div class="info">

<b>PT TV Hub</b><br>

Configura fontes IPTV autorizadas para
utilização no Stremio.<br><br>

As credenciais Xtream não são guardadas
no filesystem do servidor.

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

  clearStatus();
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

function validate(config) {

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

function clearStatus() {

  statusBox.textContent =
    "";

  statusBox.className =
    "status";
}

document
  .getElementById(
    "testButton"
  )
  .addEventListener(
    "click",
    async () => {

      const config =
        getConfig();

      const validation =
        validate(config);

      if (validation) {

        showStatus(
          validation,
          false
        );

        return;
      }

      showStatus(
        "A testar a ligação...",
        true
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
                JSON.stringify(config)
            }
          );

        const result =
          await response.json();

        if (
          result.ok
        ) {

          showStatus(
            result.message,
            true
          );

        } else {

          showStatus(
            result.message,
            false
          );
        }

      } catch (error) {

        showStatus(
          "Não foi possível contactar o servidor.",
          false
        );
      }
    }
  );

document
  .getElementById(
    "installButton"
  )
  .addEventListener(
    "click",
    () => {

      const config =
        getConfig();

      const validation =
        validate(config);

      if (validation) {

        showStatus(
          validation,
          false
        );

        return;
      }

      /*
       * O Stremio aceita user-data no
       * caminho do manifest.
       *
       * Exemplo:
       *
       * https://dominio/CONFIG/manifest.json
       *
       * O botão usa o protocolo stremio://
       * para abrir a aplicação.
       */

      const encoded =
        btoa(
          unescape(
            encodeURIComponent(
              JSON.stringify(config)
            )
          )
        )
        .replace(
          /=+$/,
          ""
        )
        .replace(
          /\\+/g,
          "-"
        )
        .replace(
          /\//g,
          "_"
        );

      const manifestUrl =
        location.origin +
        "/" +
        encoded +
        "/manifest.json";

      const stremioUrl =
        "stremio://addon/" +
        encodeURIComponent(
          manifestUrl
        );

      window.location.href =
        stremioUrl;
    }
  );

updateFields();

</script>

</body>

</html>`);
}

// ============================================================
// ESCAPAR HTML
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
// CONFIGURE
// ============================================================

app.get(
  "/configure",
  configurationPage
);

// Configuração já existente
app.get(
  "/:config/configure",
  configurationPage
);

// ============================================================
// TESTAR IPTV
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
      errors.length
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
        !channels.length
      ) {

        return res.json({
          ok: false,
          message:
            "Ligação efetuada, mas não foram encontrados canais na lista M3U."
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
          config
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

    res.json(
      baseManifest
    );
  }
);

// ============================================================
// MANIFEST CONFIGURADO
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

    /*
     * Criamos um manifest individual.
     *
     * O ID fica único por configuração,
     * mas não inclui a password em texto.
     */

    const configHash =
      crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            name:
              config.iptv_name || "",
            type:
              config.iptv_type || "",
            m3u:
              config.m3u_url || "",
            xtream:
              config.xtream_url || "",
            username:
              config.xtream_username || ""
          })
        )
        .digest("hex")
        .slice(0, 12);

    const manifest = {

      ...baseManifest,

      id:
        `pt.filipe.nuvio.tvhub.${configHash}`,

      name:
        config.iptv_name
          ? `PT TV Hub - ${config.iptv_name}`
          : baseManifest.name,

      version:
        baseManifest.version,

      description:
        errors.length
          ? "PT TV Hub - configuração inválida."
          : (
              config.iptv_type ===
              "Xtream Codes"
                ? "PT TV Hub - Xtream Codes"
                : "PT TV Hub - M3U"
            ),

      /*
       * Depois de instalado já não queremos
       * obrigar nova configuração.
       */

      behaviorHints: {
        configurable: true,
        configurationRequired: false,
        p2p: false
      }

    };

    res.json(
      manifest
    );
  }
);

// ============================================================
// CATÁLOGO - TV PORTUGAL
// ============================================================

app.get(
  "/:config/catalog/:type/:id.json",
  async (req, res) => {

    const config =
      decodeConfig(
        req.params.config
      );

    const type =
      req.params.type;

    const id =
      req.params.id;

    if (
      type === "channel" &&
      id === "pt-services"
    ) {

      return res.json({

        metas:
          services.map(
            service => ({

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
            })
          )
      });
    }

    if (
      type === "channel" &&
      id === "m3u"
    ) {

      const channels =
        await getIPTVChannels(
          config
        );

      return res.json({

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

    const config =
      decodeConfig(
        req.params.config
      );

    const id =
      req.params.id;

    const service =
      services.find(
        item =>
          item.id === id
      );

    if (service) {

      return res.json({

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

      });
    }

    const channels =
      await getIPTVChannels(
        config
      );

    const channel =
      channels.find(
        item =>
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

    });
  }
);

// ============================================================
// STREAM
// ============================================================

app.get(
  "/:config/stream/:type/:id.json",
  async (req, res) => {

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
      services.find(
        item =>
          item.id === id
      );

    if (service) {

      return res.json({

        streams: [

          {

            name:
              service.name,

            description:
              "Abrir serviço oficial do operador.",

            externalUrl:
              service.url

          }

        ]

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
        item =>
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

    });
  }
);

// ============================================================
// ADDON CATALOG
// ============================================================

app.get(
  "/:config/catalog/addon/recommended.json",
  (req, res) => {

    const addonList =
      Array.isArray(addons)
        ? addons
        : [];

    const result =
      addonList.map(
        addon => ({

          transportName:
            "http",

          transportUrl:
            addon.url,

          manifest: {

            id:
              `external.${crypto
                .createHash("sha256")
                .update(
                  String(
                    addon.name ||
                    addon.url
                  )
                )
                .digest("hex")
                .slice(0, 20)}`,

            version:
              "1.0.0",

            name:
              addon.name ||
              "Addon externo",

            description:
              addon.description ||
              "Addon externo recomendado.",

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

        })
      );

    res.json({
      addons: result
    });
  }
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.type("html").send(`
<!DOCTYPE html>

<html lang="pt-PT">

<head>

<meta charset="UTF-8">

<title>PT TV Hub</title>

<style>

body {
  font-family: Arial, sans-serif;
  background: #020617;
  color: white;
  padding: 40px;
  text-align: center;
}

.ok {
  color: #4ade80;
}

</style>

</head>

<body>

<h1>📺 PT TV Hub</h1>

<p class="ok">
● Serviço online
</p>

<p>
Versão ${baseManifest.version}
</p>

<p>
Stremio Addon / IPTV Hub
</p>

</body>

</html>
`);
  }
);

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      `PT TV Hub em http://localhost:${PORT}`
    );

    console.log(
      "Servidor pronto."
    );
  }
);
