const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;
const BASE = __dirname;

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json({ limit: "200kb" }));

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
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
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

const baseManifest = JSON.parse(
  fs.readFileSync(
    path.join(
      BASE,
      "manifest.json"
    ),
    "utf8"
  )
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
  } catch (error) {
    console.error(
      "Erro ao descodificar configuração."
    );

    return {};
  }
}

// ============================================================
// SEGURANÇA / URL
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
// M3U FETCH
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
              "PT-TV-Hub/1.3.1"
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
              "PT-TV-Hub/1.3.1"
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
     * Nunca imprimir credenciais
     * ou o URL Xtream completo.
     */

    console.error(
      "Erro na ligação Xtream:",
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
// IPTV CHANNELS
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
  }

  if (
    config.iptv_type ===
    "M3U URL"
  ) {

    if (!config.m3u_url) {

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

    if (!config.xtream_url) {

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
// ESCAPE HTML
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

  res.type("html");

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

html,
body {
  margin: 0;
  padding: 0;
}

body {

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

  padding:
    30px 16px;
}

.container {

  max-width: 700px;

  margin:
    0 auto;
}

.card {

  background:
    rgba(15,23,42,.97);

  border:
    1px solid
    rgba(255,255,255,.10);

  border-radius:
    20px;

  padding:
    30px;

  box-shadow:
    0 25px 80px
    rgba(0,0,0,.45);
}

.header {

  text-align:
    center;

  margin-bottom:
    30px;
}

.logo {

  font-size:
    50px;

  margin-bottom:
    8px;
}

h1 {

  margin:
    0;

  font-size:
    30px;
}

.subtitle {

  color:
    #94a3b8;

  margin-top:
    8px;
}

label {

  display:
    block;

  margin:
    18px 0 8px;

  font-size:
    14px;

  font-weight:
    700;
}

input,
select {

  width:
    100%;

  padding:
    14px;

  border-radius:
    10px;

  border:
    1px solid
    #334155;

  background:
    #020617;

  color:
    #ffffff;

  font-size:
    15px;
}

input:focus,
select:focus {

  outline:
    none;

  border-color:
    #38bdf8;
}

.hidden {
  display:
    none;
}

.hint {

  margin-top:
    7px;

  color:
    #64748b;

  font-size:
    12px;
}

.buttons {

  display:
    grid;

  grid-template-columns:
    1fr 1fr;

  gap:
    12px;

  margin-top:
    28px;
}

button {

  border:
    0;

  border-radius:
    10px;

  padding:
    15px;

  font-size:
    15px;

  font-weight:
    700;

  cursor:
    pointer;
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

button:hover {

  opacity:
    .9;
}

.status {

  display:
    none;

  margin-top:
    18px;

  padding:
    14px;

  border-radius:
    10px;

  font-size:
    14px;

  line-height:
    1.5;
}

.status.show {
  display:
    block;
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

  margin-top:
    25px;

  padding:
    15px;

  border-radius:
    10px;

  background:
    rgba(30,41,59,.55);

  color:
    #94a3b8;

  font-size:
    12px;

  line-height:
    1.6;
}

@media(max-width:600px) {

  .card {
    padding:
      22px;
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
  placeholder="Ex.: IPTV Casa"
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
  class="${
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
  class="${
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
EPG preparado para a próxima etapa.
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
📺 Instalar no Stremio
</button>

</div>

<div class="info">

<b>PT TV Hub</b><br><br>

Configura uma fonte M3U ou Xtream Codes
autorizada e instala-a diretamente no
Stremio.

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

    return:
      "Seleciona o tipo de IPTV.";
  }

  if (
    config.iptv_type ===
    "M3U URL"
  ) {

    if (!config.m3u_url) {

      return:
        "Introduz a URL da lista M3U.";
    }

    try {

      new URL(
        config.m3u_url
      );

    } catch {

      return:
        "A URL M3U não é válida.";
    }
  }

  if (
    config.iptv_type ===
    "Xtream Codes"
  ) {

    if (!config.xtream_url) {

      return:
        "Introduz o servidor Xtream.";
    }

    if (
      !config.xtream_username
    ) {

      return:
        "Introduz o username Xtream.";
    }

    if (
      !config.xtream_password
    ) {

      return:
        "Introduz a password Xtream.";
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

// ============================================================
// TESTAR
// ============================================================

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
              method:
                "POST",

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

// ============================================================
// INSTALAR NO STREMIO
// ============================================================

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
       * Codificação da configuração.
       */

      const encodedConfig =
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
          /\+/g,
          "-"
        )
        .replace(
          /\//g,
          "_"
        );

      /*
       * URL HTTPS real do manifest.
       *
       * Exemplo:
       *
       * https://pt-tv-filme-e-series.onrender.com/
       * CONFIG/manifest.json
       */

      const manifestUrl =
        window.location.origin +
        "/" +
        encodedConfig +
        "/manifest.json";

      /*
       * CORREÇÃO PRINCIPAL
       *
       * O protocolo stremio:// substitui
       * diretamente https://.
       *
       * NÃO devemos criar:
       *
       * stremio://addon/...
       *
       * nem fazer encodeURIComponent()
       * ao URL completo.
       */

      const stremioUrl =
        manifestUrl.replace(
          /^https?:\/\//i,
          "stremio://"
        );

      showStatus(
        "A abrir o Stremio...",
        true
      );

      /*
       * Criamos temporariamente um link
       * para garantir que o browser trata
       * o protocolo personalizado como
       * uma navegação externa.
       */

      const link =
        document.createElement(
          "a"
        );

      link.href =
        stremioUrl;

      link.style.display =
        "none";

      document.body.appendChild(
        link
      );

      link.click();

      setTimeout(
        () => {
          link.remove();
        },
        1000
      );
    }
  );

updateFields();

</script>

</body>

</html>
`);
}

// ============================================================
// PÁGINA CONFIGURE
// ============================================================

app.get(
  "/configure",
  renderConfigure
);

// ============================================================
// CONFIGURE COM CONFIGURAÇÃO EXISTENTE
// ============================================================

app.get(
  "/:config/configure",
  renderConfigure
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
        channels.length === 0
      ) {

        return res.json({

          ok: false,

          message:
            "Não foram encontrados canais na lista M3U."
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
// MANIFEST SEM CONFIGURAÇÃO
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
// MANIFEST COM CONFIGURAÇÃO
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

      description:
        errors.length > 0
          ? "PT TV Hub - configuração inválida."
          : (
              config.iptv_type ===
              "Xtream Codes"
                ? "PT TV Hub - Xtream Codes"
                : "PT TV Hub - M3U"
            ),

      behaviorHints: {

        configurable:
          true,

        configurationRequired:
          false,

        p2p:
          false
      }
    };

    res.json(
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
                .slice(0, 20)`,

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
      addons:
        result
    });
  }
);

// ============================================================
// HOME / HEALTH
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.type("html");

    res.send(`
<!DOCTYPE html>

<html lang="pt-PT">

<head>

<meta charset="UTF-8">

<title>PT TV Hub</title>

<style>

body {

  font-family:
    Arial,
    sans-serif;

  background:
    #020617;

  color:
    white;

  text-align:
    center;

  padding:
    40px;
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

<h1>
📺 PT TV Hub
</h1>

<p class="ok">
● Serviço online
</p>

<p>
Versão ${baseManifest.version}
</p>

<p>
<a href="/configure">
Configurar IPTV
</a>
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