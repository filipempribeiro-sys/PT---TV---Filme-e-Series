const fs = require("fs");
const path = require("path");

const {
  addonBuilder,
  serveHTTP
} = require("stremio-addon-sdk");

const manifest = require("./manifest.json");

const BASE = __dirname;

// ============================================================
// DADOS
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
// M3U
// ============================================================

function parseM3U(text) {

  const lines =
    text.split(/\r?\n/);

  const channels = [];

  let current = null;

  for (const raw of lines) {

    const line = raw.trim();

    if (!line) continue;

    if (line.startsWith("#EXTINF")) {

      const attrs = {};

      const regex =
        /([\w-]+)="([^"]*)"/g;

      let match;

      while (
        (match = regex.exec(line)) !== null
      ) {
        attrs[match[1]] = match[2];
      }

      const comma =
        line.indexOf(",");

      const title =
        comma >= 0
          ? line.slice(comma + 1).trim()
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
          ""
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
// M3U URL
// ============================================================

async function fetchM3U(url) {

  if (!url) {
    return [];
  }

  try {

    const response =
      await fetch(url);

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
    (
      action
        ? `&action=${encodeURIComponent(action)}`
        : ""
    );

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

    // NÃO imprimir username/password
    console.error(
      "Erro na ligação Xtream:",
      error.message
    );

    return null;
  }
}

// ============================================================
// XTREAM — CANAIS
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

  return data.map(channel => {

    const extension =
      channel.container_extension ||
      "ts";

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
// BUILDER
// ============================================================

const builder =
  new addonBuilder(
    manifest
  );

// ============================================================
// CATALOG
// ============================================================

builder.defineCatalogHandler(
  async args => {

    // ------------------------------
    // TV PORTUGAL
    // ------------------------------

    if (
      args.type === "channel" &&
      args.id === "pt-services"
    ) {

      return {

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
      };
    }

    // ------------------------------
    // IPTV
    // ------------------------------

    if (
      args.type === "channel" &&
      args.id === "m3u"
    ) {

      const config =
        args.config || {};

      console.log(
        "Pedido IPTV:",
        config.iptv_type ||
        "Nenhuma"
      );

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
                channel.logo ||
                "",

              description:
                channel.group ||
                "IPTV",

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
// META
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
            service.logo ||
            "",

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
            channel.logo ||
            "",

          description:
            channel.group ||
            "IPTV",

          posterShape:
            "square"
        }
      };
    }

    return {
      meta: null
    };
  }
);

// ============================================================
// STREAM
// ============================================================

builder.defineStreamHandler(
  async args => {

    const id =
      args.id;

    // ------------------------------
    // OPERADORES
    // ------------------------------

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
              "O login e as permissões " +
              "são tratados pelo operador.",

            externalUrl:
              service.url
          }

        ]
      };
    }

    // ------------------------------
    // IPTV
    // ------------------------------

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

    return {
      streams: []
    };
  }
);

// ============================================================
// ADDON CATALOG
// ============================================================

builder.defineResourceHandler(
  "addon_catalog",
  async args => {

    if (
      args.type !== "addon"
    ) {

      return {
        addons: []
      };
    }

    return {

      addons:
        addons.map(
          addon => ({

            transportName:
              "http",

            transportUrl:
              addon.url,

            manifest: {

              id:
                `external.${Buffer
                  .from(addon.name)
                  .toString("hex")
                  .slice(0, 20)}`,

              version:
                "1.0.0",

              name:
                addon.name,

              description:
                "Addon externo.",

              catalogs: [],

              resources: [
                "catalog",
                "meta",
                "stream"
              ],

              types: [
                "movie",
                "series"
              ]
            }
          })
        )
    };
  }
);

// ============================================================
// SERVIDOR
// ============================================================

serveHTTP(
  builder.getInterface(),
  {
    port:
      process.env.PORT || 7000
  }
);

console.log(
  "PT TV Hub iniciado."
);
