const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 10000;
const BASE_DIR = __dirname;

const APP_VERSION = "3.0.0";
const APP_NAME = "PT•TV HUB";

const TMDB_API_KEY =
  String(process.env.TMDB_API_KEY || "").trim();

const TMDB_BASE =
  "https://api.themoviedb.org/3";

const TMDB_IMAGE =
  "https://image.tmdb.org/t/p";

const DEFAULT_USER_AGENT =
  "PT-TV-HUB/3.0.0";


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

  if (
    req.method === "OPTIONS"
  ) {
    return res.sendStatus(204);
  }

  next();
});


// ============================================================
// HELPERS
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


function isValidHttpUrl(value) {
  try {
    const url =
      new URL(String(value || ""));

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


function loadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch {
    return fallback;
  }
}


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
        .from(value, "base64url")
        .toString("utf8")
    );
  } catch {
    return {};
  }
}


function hashId(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, 24);
}


// ============================================================
// CHANNEL ART
// ============================================================

const channelArt = loadJSON(
  path.join(
    BASE_DIR,
    "..",
    "data",
    "channels.json"
  ),
  {}
);


function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}


function resolveChannelArt(channel) {
  const candidates = [
    channel.tvgId,
    channel.tvgName,
    channel.title
  ];

  for (
    const candidate of candidates
  ) {
    const normalized =
      normalizeName(candidate);

    if (!normalized) {
      continue;
    }

    for (
      const key of Object.keys(channelArt)
    ) {
      if (
        normalizeName(key) ===
        normalized
      ) {
        return channelArt[key];
      }
    }
  }

  for (
    const candidate of candidates
  ) {
    const normalized =
      normalizeName(candidate);

    if (!normalized) {
      continue;
    }

    for (
      const key of Object.keys(channelArt)
    ) {
      const normalizedKey =
        normalizeName(key);

      if (
        normalized.includes(normalizedKey) ||
        normalizedKey.includes(normalized)
      ) {
        return channelArt[key];
      }
    }
  }

  return {};
}


// ============================================================
// M3U PARSER
// ============================================================

function parseAttributes(line) {
  const attrs = {};

  const regex =
    /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;

  let match;

  while (
    (match = regex.exec(line)) !== null
  ) {
    attrs[match[1]] =
      match[2] ??
      match[3] ??
      match[4] ??
      "";
  }

  return attrs;
}


function parseM3U(text) {
  const lines =
    String(text || "")
      .split(/\r?\n/);

  const channels = [];

  let current = null;

  let pendingHeaders = {
    userAgent: "",
    referrer: "",
    origin: ""
  };

  for (
    const rawLine of lines
  ) {
    const line =
      rawLine.trim();

    if (!line) {
      continue;
    }


    // --------------------------------------------------------
    // EXTINF
    // --------------------------------------------------------

    if (
      line.startsWith("#EXTINF")
    ) {
      const attrs =
        parseAttributes(line);

      const comma =
        line.indexOf(",");

      let title =
        comma >= 0
          ? line
              .slice(comma + 1)
              .trim()
          : "Canal";

      if (
        attrs["tvg-name"]
      ) {
        title =
          attrs["tvg-name"];
      }

      current = {
        title,

        group:
          attrs["group-title"] ||
          "IPTV",

        logo:
          attrs["tvg-logo"] ||
          attrs["logo"] ||
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
          attrs["http-referrer-url"] ||
          attrs["referrer"] ||
          "",

        userAgent:
          attrs["http-user-agent"] ||
          attrs["user-agent"] ||
          "",

        origin:
          attrs["http-origin"] ||
          attrs["origin"] ||
          "",

        url: ""
      };

      pendingHeaders = {
        userAgent:
          current.userAgent,

        referrer:
          current.httpReferrer,

        origin:
          current.origin
      };

      continue;
    }


    // --------------------------------------------------------
    // VLC OPTIONS
    // --------------------------------------------------------

    if (
      line.startsWith(
        "#EXTVLCOPT:"
      )
    ) {
      const value =
        line.slice(
          "#EXTVLCOPT:".length
        );

      const separator =
        value.indexOf("=");

      if (separator > 0) {
        const key =
          value
            .slice(0, separator)
            .trim()
            .toLowerCase();

        const val =
          value
            .slice(separator + 1)
            .trim();

        if (
          key ===
          "http-referrer"
        ) {
          pendingHeaders.referrer =
            val;
        }

        if (
          key ===
          "http-user-agent"
        ) {
          pendingHeaders.userAgent =
            val;
        }

        if (
          key ===
          "http-origin"
        ) {
          pendingHeaders.origin =
            val;
        }
      }

      continue;
    }


    // --------------------------------------------------------
    // EXTHTTP
    // --------------------------------------------------------

    if (
      line.startsWith("#EXTHTTP:")
    ) {
      const value =
        line.slice(
          "#EXTHTTP:".length
        );

      const separator =
        value.indexOf("=");

      if (separator > 0) {
        const key =
          value
            .slice(0, separator)
            .trim()
            .toLowerCase();

        const val =
          value
            .slice(separator + 1)
            .trim();

        if (
          key === "user-agent"
        ) {
          pendingHeaders.userAgent =
            val;
        }

        if (
          key === "referer"
        ) {
          pendingHeaders.referrer =
            val;
        }

        if (
          key === "origin"
        ) {
          pendingHeaders.origin =
            val;
        }
      }

      continue;
    }


    // --------------------------------------------------------
    // URL
    // --------------------------------------------------------

    if (
      current &&
      !line.startsWith("#") &&
      isValidHttpUrl(line)
    ) {
      current.url =
        line;

      current.userAgent =
        pendingHeaders.userAgent ||
        current.userAgent ||
        "";

      current.httpReferrer =
        pendingHeaders.referrer ||
        current.httpReferrer ||
        "";

      current.origin =
        pendingHeaders.origin ||
        current.origin ||
        "";

      const id =
        "m3u:" +
        hashId(
          current.title +
          "|" +
          current.url
        );

      const art =
        resolveChannelArt(
          current
        );

      channels.push({
        id,

        title:
          current.title,

        group:
          current.group,

        logo:
          current.logo ||
          art.logo ||
          "",

        background:
          art.background ||
          "",

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

        origin:
          current.origin,

        url:
          current.url
      });

      current = null;

      pendingHeaders = {
        userAgent: "",
        referrer: "",
        origin: ""
      };
    }
  }

  return channels;
}


// ============================================================
// M3U FETCH
// ============================================================

async function fetchText(
  url,
  timeoutMs = 30000
) {
  if (
    !isValidHttpUrl(url)
  ) {
    throw new Error(
      "URL inválida."
    );
  }

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(
        url,
        {
          redirect: "follow",
          cache: "no-store",
          signal: controller.signal,

          headers: {
            "User-Agent":
              DEFAULT_USER_AGENT,

            "Accept":
              "*/*",

            "Cache-Control":
              "no-cache",

            "Pragma":
              "no-cache"
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return await response.text();

  } finally {
    clearTimeout(timer);
  }
}


async function fetchM3U(url) {
  try {
    const text =
      await fetchText(url);

    return parseM3U(text);

  } catch (error) {
    console.error(
      "M3U:",
      error.message
    );

    return [];
  }
}


// ============================================================
// XTREAM
// ============================================================

function cleanServerUrl(url) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
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
      config.xtream_username || ""
    ).trim();

  const password =
    String(
      config.xtream_password || ""
    );

  if (
    !server ||
    !username ||
    !password ||
    !isValidHttpUrl(server)
  ) {
    return null;
  }

  const url =
    new URL(
      `${server}/player_api.php`
    );

  url.searchParams.set(
    "username",
    username
  );

  url.searchParams.set(
    "password",
    password
  );

  if (action) {
    url.searchParams.set(
      "action",
      action
    );
  }

  try {
    const response =
      await fetch(
        url,
        {
          cache: "no-store",
          headers: {
            "User-Agent":
              DEFAULT_USER_AGENT
          }
        }
      );

    if (!response.ok) {
      return null;
    }

    return await response.json();

  } catch {
    return null;
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
      config.xtream_username || ""
    );

  const password =
    String(
      config.xtream_password || ""
    );

  return data
    .map(channel => {
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

      const url =
        `${server}/live/` +
        `${encodeURIComponent(username)}/` +
        `${encodeURIComponent(password)}/` +
        `${streamId}.${extension}`;

      const title =
        channel.name ||
        `Canal ${streamId}`;

      const art =
        resolveChannelArt({
          title,
          tvgId:
            channel.epg_channel_id ||
            "",
          tvgName:
            title
        });

      return {
        id:
          `xtream:${streamId}`,

        title,

        group:
          channel.category_name ||
          "TV",

        logo:
          channel.stream_icon ||
          art.logo ||
          "",

        background:
          art.background ||
          "",

        tvgId:
          channel.epg_channel_id ||
          "",

        tvgName:
          title,

        url,

        userAgent: "",

        httpReferrer: "",

        origin: ""
      };
    })
    .filter(Boolean);
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
// STREAM HELPERS
// ============================================================

function isHlsUrl(url) {
  return (
    /\.m3u8(\?|$)/i.test(
      String(url || "")
    ) ||
    /\/hls\//i.test(
      String(url || "")
    )
  );
}


function buildChannelStream(
  channel
) {
  const headers = {};

  if (
    channel.userAgent
  ) {
    headers["User-Agent"] =
      channel.userAgent;
  }

  if (
    channel.httpReferrer
  ) {
    headers["Referer"] =
      channel.httpReferrer;
  }

  if (
    channel.origin
  ) {
    headers["Origin"] =
      channel.origin;
  }

  const stream = {
    name:
      channel.title,

    title:
      channel.group ||
      "IPTV",

    url:
      channel.url,

    description:
      "Fonte IPTV configurada pelo utilizador.",

    behaviorHints: {
      notWebReady:
        isHlsUrl(channel.url),

      bingeGroup:
        `pt-tv-${hashId(
          channel.group || "iptv"
        )}`
    }
  };

  if (
    Object.keys(headers)
      .length
  ) {
    stream.behaviorHints
      .proxyHeaders = {
        request:
          headers
      };
  }

  return stream;
}


// ============================================================
// TMDB
// ============================================================

async function tmdbRequest(
  endpoint,
  params = {}
) {
  if (!TMDB_API_KEY) {
    return null;
  }

  const url =
    new URL(
      `${TMDB_BASE}${endpoint}`
    );

  url.searchParams.set(
    "api_key",
    TMDB_API_KEY
  );

  url.searchParams.set(
    "language",
    "pt-PT"
  );

  url.searchParams.set(
    "include_image_language",
    "pt,en,null"
  );

  for (
    const [key, value]
    of Object.entries(params)
  ) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(
        key,
        value
      );
    }
  }

  try {
    const response =
      await fetch(
        url,
        {
          headers: {
            "User-Agent":
              DEFAULT_USER_AGENT,

            "Accept":
              "application/json"
          }
        }
      );

    if (!response.ok) {
      console.error(
        "TMDB HTTP",
        response.status
      );

      return null;
    }

    return await response.json();

  } catch (error) {
    console.error(
      "TMDB:",
      error.message
    );

    return null;
  }
}


function tmdbPoster(
  pathValue,
  size = "w500"
) {
  if (!pathValue) {
    return "";
  }

  return (
    `${TMDB_IMAGE}/${size}` +
    `${pathValue}`
  );
}


function tmdbBackground(
  pathValue
) {
  if (!pathValue) {
    return "";
  }

  return (
    `${TMDB_IMAGE}/w1280` +
    `${pathValue}`
  );
}


function tmdbLogo(
  pathValue
) {
  if (!pathValue) {
    return "";
  }

  return (
    `${TMDB_IMAGE}/w500` +
    `${pathValue}`
  );
}


// ============================================================
// TMDB MOVIES
// ============================================================

async function getMovieCatalog(
  extra
) {
  const search =
    String(
      extra?.search || ""
    ).trim();

  if (search) {
    return tmdbRequest(
      "/search/movie",
      {
        query: search,
        include_adult: "false"
      }
    );
  }

  return tmdbRequest(
    "/trending/movie/week"
  );
}


// ============================================================
// TMDB SERIES
// ============================================================

async function getSeriesCatalog(
  extra
) {
  const search =
    String(
      extra?.search || ""
    ).trim();

  if (search) {
    return tmdbRequest(
      "/search/tv",
      {
        query: search,
        include_adult: "false"
      }
    );
  }

  return tmdbRequest(
    "/trending/tv/week"
  );
}


// ============================================================
// MOVIE META
// ============================================================

async function getMovieMeta(
  tmdbId
) {
  return tmdbRequest(
    `/movie/${encodeURIComponent(
      tmdbId
    )}`,
    {
      append_to_response:
        "credits,videos,external_ids"
    }
  );
}


// ============================================================
// SERIES META
// ============================================================

async function getSeriesMeta(
  tmdbId
) {
  return tmdbRequest(
    `/tv/${encodeURIComponent(
      tmdbId
    )}`,
    {
      append_to_response:
        "credits,videos,external_ids"
    }
  );
}


async function getSeason(
  tmdbId,
  season
) {
  return tmdbRequest(
    `/tv/${encodeURIComponent(
      tmdbId
    )}/season/${encodeURIComponent(
      season
    )}`
  );
}


// ============================================================
// MOVIE META OBJECT
// ============================================================

function buildMovieMeta(
  movie
) {
  if (!movie) {
    return null;
  }

  const cast =
    Array.isArray(
      movie.credits?.cast
    )
      ? movie.credits.cast
          .slice(0, 12)
          .map(person => ({
            name:
              person.name,

            character:
              person.character,

            photo:
              tmdbPoster(
                person.profile_path,
                "w185"
              )
          }))
      : [];

  const directors =
    Array.isArray(
      movie.credits?.crew
    )
      ? movie.credits.crew
          .filter(
            person =>
              person.job ===
              "Director"
          )
          .map(
            person =>
              person.name
          )
          .slice(0, 5)
      : [];

  const trailers =
    Array.isArray(
      movie.videos?.results
    )
      ? movie.videos.results
          .filter(
            video =>
              video.site ===
                "YouTube" &&
              video.type ===
                "Trailer"
          )
          .slice(0, 5)
          .map(video => ({
            source:
              video.key,

            type:
              "Trailer",

            name:
              video.name
          }))
      : [];

  const genres =
    Array.isArray(
      movie.genres
    )
      ? movie.genres.map(
          genre =>
            genre.name
        )
      : [];

  const year =
    movie.release_date
      ? movie.release_date
          .slice(0, 4)
      : "";

  const imdb =
    movie.vote_average
      ? movie.vote_average
      : null;

  const imdbId =
    movie.external_ids
      ?.imdb_id ||
    `tmdb:${movie.id}`;

  return {
    id:
      `tmdb:movie:${movie.id}`,

    type:
      "movie",

    name:
      movie.title ||
      movie.original_title ||
      "Filme",

    poster:
      tmdbPoster(
        movie.poster_path
      ),

    background:
      tmdbBackground(
        movie.backdrop_path
      ),

    logo:
      tmdbLogo(
        movie.logo_path
      ),

    description:
      movie.overview ||
      "",

    releaseInfo:
      year,

    runtime:
      movie.runtime
        ? movie.runtime * 60
        : undefined,

    imdbRating:
      imdb,

    genres,

    director:
      directors,

    cast,

    trailers,

    links: [
      {
        name: "IMDb",
        category: "imdb",
        url:
          movie.external_ids?.imdb_id
            ? `https://www.imdb.com/title/${movie.external_ids.imdb_id}/`
            : ""
      }
    ],

    imdb_id:
      movie.external_ids?.imdb_id ||
      "",

    tmdb_id:
      String(movie.id),

    meta:
      {
        originalTitle:
          movie.original_title ||
          "",

        popularity:
          movie.popularity,

        voteCount:
          movie.vote_count
      }
  };
}


// ============================================================
// SERIES META OBJECT
// ============================================================

async function buildSeriesMeta(
  series
) {
  if (!series) {
    return null;
  }

  const cast =
    Array.isArray(
      series.credits?.cast
    )
      ? series.credits.cast
          .slice(0, 12)
          .map(person => ({
            name:
              person.name,

            character:
              person.character,

            photo:
              tmdbPoster(
                person.profile_path,
                "w185"
              )
          }))
      : [];

  const creators =
    Array.isArray(
      series.created_by
    )
      ? series.created_by
          .map(
            person =>
              person.name
          )
      : [];

  const trailers =
    Array.isArray(
      series.videos?.results
    )
      ? series.videos.results
          .filter(
            video =>
              video.site ===
                "YouTube" &&
              video.type ===
                "Trailer"
          )
          .slice(0, 5)
          .map(video => ({
            source:
              video.key,

            type:
              "Trailer",

            name:
              video.name
          }))
      : [];

  const videos = [];

  const seasons =
    Array.isArray(
      series.seasons
    )
      ? series.seasons
          .filter(
            season =>
              season.season_number >= 0
          )
      : [];

  for (
    const season
    of seasons
  ) {
    const seasonData =
      await getSeason(
        series.id,
        season.season_number
      );

    if (
      !seasonData ||
      !Array.isArray(
        seasonData.episodes
      )
    ) {
      continue;
    }

    for (
      const episode
      of seasonData.episodes
    ) {
      videos.push({
        id:
          `tmdb:series:${series.id}:s${String(
            episode.season_number
          ).padStart(2, "0")}e${String(
            episode.episode_number
          ).padStart(2, "0")}`,

        title:
          episode.name ||
          `Episódio ${episode.episode_number}`,

        season:
          episode.season_number,

        episode:
          episode.episode_number,

        released:
          episode.air_date
            ? `${episode.air_date}T00:00:00.000Z`
            : undefined,

        overview:
          episode.overview ||
          "",

        thumbnail:
          tmdbPoster(
            episode.still_path,
            "w780"
          ),

        runtime:
          episode.runtime
            ? episode.runtime * 60
            : undefined
      });
    }
  }

  const year =
    series.first_air_date
      ? series.first_air_date
          .slice(0, 4)
      : "";

  return {
    id:
      `tmdb:series:${series.id}`,

    type:
      "series",

    name:
      series.name ||
      series.original_name ||
      "Série",

    poster:
      tmdbPoster(
        series.poster_path
      ),

    background:
      tmdbBackground(
        series.backdrop_path
      ),

    description:
      series.overview ||
      "",

    releaseInfo:
      year,

    imdbRating:
      series.vote_average ||
      undefined,

    genres:
      Array.isArray(
        series.genres
      )
        ? series.genres.map(
            genre =>
              genre.name
          )
        : [],

    cast,

    creator:
      creators,

    trailers,

    videos,

    imdb_id:
      series.external_ids?.imdb_id ||
      "",

    tmdb_id:
      String(series.id),

    meta: {
      originalTitle:
        series.original_name ||
        "",

      popularity:
        series.popularity,

      voteCount:
        series.vote_count
    }
  };
}


// ============================================================
// CONFIG PAGE
// ============================================================

function renderConfigure(
  req,
  res
) {
  const config =
    req.params.config
      ? decodeConfig(
          req.params.config
        )
      : {};

  const iptvName =
    config.iptv_name ||
    "Minha IPTV";

  const iptvType =
    config.iptv_type ||
    "Nenhuma";

  const m3uUrl =
    config.m3u_url ||
    "";

  const xtreamUrl =
    config.xtream_url ||
    "";

  const xtreamUsername =
    config.xtream_username ||
    "";

  const epgUrl =
    config.epg_url ||
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

<title>PT•TV HUB</title>

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
      #12352b 0,
      #07111d 38%,
      #02040a 100%
    );

  padding: 30px 16px;
}

.container {
  max-width: 760px;
  margin: 0 auto;
}

.card {
  background:
    rgba(7,15,26,.96);

  border:
    1px solid
    rgba(255,255,255,.10);

  border-radius: 24px;

  padding: 30px;

  box-shadow:
    0 25px 80px
    rgba(0,0,0,.55);
}

.logo {
  width: 110px;
  height: 110px;
  display: block;
  margin: 0 auto 18px;
}

h1 {
  text-align: center;
  margin: 0;
  font-size: 32px;
}

.subtitle {
  text-align: center;
  color: #d4af37;
  margin-top: 8px;
  font-size: 13px;
  letter-spacing: 2px;
}

h2 {
  margin-top: 34px;
}

label {
  display: block;
  margin-top: 18px;
  margin-bottom: 7px;
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

  color: white;

  font-size: 15px;
}

button {
  border: 0;

  border-radius: 10px;

  padding: 15px;

  font-size: 15px;

  font-weight: 700;

  cursor: pointer;
}

.primary {
  background:
    linear-gradient(
      135deg,
      #007847,
      #ce1126
    );

  color: white;
}

.secondary {
  background:
    #1e293b;

  color: white;
}

.buttons {
  display: grid;

  grid-template-columns:
    1fr 1fr;

  gap: 12px;

  margin-top: 28px;
}

.hidden {
  display: none;
}

.status {
  margin-top: 18px;

  padding: 14px;

  border-radius: 10px;

  display: none;
}

.status.show {
  display: block;
}

.status.ok {
  background:
    rgba(34,197,94,.12);

  color:
    #86efac;
}

.status.error {
  background:
    rgba(239,68,68,.12);

  color:
    #fca5a5;
}

.install {
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

.install.show {
  display: block;
}

.install input {
  margin-top: 10px;
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

@media(max-width:600px) {

  .buttons {
    grid-template-columns: 1fr;
  }

}

</style>

</head>

<body>

<div class="container">

<div class="card">

<img
  class="logo"
  src="/assets/logo.svg"
  alt="PT TV HUB"
>

<h1>
PT•TV HUB
</h1>

<div class="subtitle">
IPTV PORTUGUESA • FILMES • SÉRIES
</div>

<h2>
📺 Minha IPTV
</h2>

<label>
Nome da fonte
</label>

<input
  id="iptv_name"
  value="${escapeHtml(iptvName)}"
  placeholder="Ex.: IPTV Casa"
>

<label>
Tipo de IPTV
</label>

<select id="iptv_type">

<option
  value="Nenhuma"
  ${
    iptvType === "Nenhuma"
      ? "selected"
      : ""
  }
>
Selecionar...
</option>

<option
  value="M3U URL"
  ${
    iptvType === "M3U URL"
      ? "selected"
      : ""
  }
>
M3U URL
</option>

<option
  value="Xtream Codes"
  ${
    iptvType === "Xtream Codes"
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
    iptvType === "M3U URL"
      ? ""
      : "hidden"
  }"
>

<label>
URL da lista M3U
</label>

<input
  id="m3u_url"
  type="url"
  value="${escapeHtml(m3uUrl)}"
  placeholder="https://servidor/lista.m3u"
>

</div>

<div
  id="xtreamSection"
  class="${
    iptvType === "Xtream Codes"
      ? ""
      : "hidden"
  }"
>

<label>
Xtream Server
</label>

<input
  id="xtream_url"
  type="url"
  value="${escapeHtml(xtreamUrl)}"
  placeholder="https://servidor:porta"
>

<label>
Username
</label>

<input
  id="xtream_username"
  value="${escapeHtml(xtreamUsername)}"
>

<label>
Password
</label>

<input
  id="xtream_password"
  type="password"
>

</div>

<label>
EPG URL
</label>

<input
  id="epg_url"
  type="url"
  value="${escapeHtml(epgUrl)}"
  placeholder="https://servidor/epg.xml"
>

<div class="buttons">

<button
  class="secondary"
  id="testButton"
>
🔎 Testar IPTV
</button>

<button
  class="primary"
  id="installButton"
>
📺 Gerar instalação
</button>

</div>

<div
  id="status"
  class="status"
></div>

<div
  id="installBox"
  class="install"
>

<b>
🔗 Manifest configurado
</b>

<input
  id="manifestUrl"
  readonly
>

<button
  class="primary"
  id="copyButton"
  style="width:100%;margin-top:10px"
>
📋 Copiar URL
</button>

<button
  class="primary"
  id="openButton"
  style="width:100%;margin-top:10px"
>
📺 Abrir no Stremio
</button>

</div>

<div class="info">

<b>PT•TV HUB 3.0</b><br><br>

📺 IPTV através da tua M3U ou Xtream.<br>
🎬 Catálogo de filmes.<br>
📺 Catálogo de séries e episódios.<br>
⭐ Metadata, ratings, elenco e trailers.<br><br>

As fontes IPTV devem ser próprias ou autorizadas.

</div>

</div>

</div>

<script>

const type =
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

const status =
  document.getElementById(
    "status"
  );

const installBox =
  document.getElementById(
    "installBox"
  );

const manifestUrl =
  document.getElementById(
    "manifestUrl"
  );

function updateFields() {

  const value =
    type.value;

  m3uSection.classList.toggle(
    "hidden",
    value !== "M3U URL"
  );

  xtreamSection.classList.toggle(
    "hidden",
    value !== "Xtream Codes"
  );

}

type.addEventListener(
  "change",
  updateFields
);

function showStatus(
  message,
  ok
) {

  status.textContent =
    message;

  status.className =
    "status show " +
    (
      ok
        ? "ok"
        : "error"
    );
}

function getConfig() {

  return {

    iptv_name:
      document
        .getElementById(
          "iptv_name"
        )
        .value,

    iptv_type:
      type.value,

    m3u_url:
      document
        .getElementById(
          "m3u_url"
        )
        .value,

    xtream_url:
      document
        .getElementById(
          "xtream_url"
        )
        .value,

    xtream_username:
      document
        .getElementById(
          "xtream_username"
        )
        .value,

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
  };

}

document
  .getElementById(
    "testButton"
  )
  .addEventListener(
    "click",
    async () => {

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
                  getConfig()
                )
            }
          );

        const result =
          await response.json();

        showStatus(
          result.message,
          result.ok
        );

      } catch {

        showStatus(
          "Não foi possível testar a ligação.",
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

      if (
        config.iptv_type ===
        "Nenhuma"
      ) {
        showStatus(
          "Seleciona primeiro uma fonte IPTV.",
          false
        );

        return;
      }

      const encoded =
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

      const url =
        window.location.origin +
        "/" +
        encoded +
        "/manifest.json";

      manifestUrl.value =
        url;

      installBox.classList.add(
        "show"
      );

      showStatus(
        "Manifest criado com sucesso.",
        true
      );

    }
  );

document
  .getElementById(
    "copyButton"
  )
  .addEventListener(
    "click",
    async () => {

      try {

        await navigator
          .clipboard
          .writeText(
            manifestUrl.value
          );

        showStatus(
          "URL copiado.",
          true
        );

      } catch {

        manifestUrl.select();

        document.execCommand(
          "copy"
        );

      }

    }
  );

document
  .getElementById(
    "openButton"
  )
  .addEventListener(
    "click",
    () => {

      const stremioUrl =
        manifestUrl.value.replace(
          /^https?:\/\//i,
          "stremio://"
        );

      window.location.href =
        stremioUrl;

    }
  );

updateFields();

</script>

</body>
</html>
`);
}


// ============================================================
// CONFIG ROUTES
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
            "A ligação foi efetuada mas não foram encontrados canais."
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

      const channels =
        await getXtreamChannels(
          config
        );

      return res.json({

        ok:
          channels.length > 0,

        message:
          channels.length > 0
            ? `Xtream OK — ${channels.length} canais encontrados.`
            : "Não foi possível obter canais Xtream."

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
// BASE MANIFEST
// ============================================================

app.get(
  "/manifest.json",
  (req, res) => {

    noCache(res);

    const manifest =
      loadJSON(
        path.join(
          BASE_DIR,
          "manifest.json"
        ),
        {}
      );

    res.json(
      manifest
    );

  }
);


// ============================================================
// CONFIGURED MANIFEST
// ============================================================

app.get(
  "/:config/manifest.json",
  (req, res) => {

    noCache(res);

    const config =
      decodeConfig(
        req.params.config
      );

    const manifest =
      loadJSON(
        path.join(
          BASE_DIR,
          "manifest.json"
        ),
        {}
      );

    const configured =
      JSON.parse(
        JSON.stringify(
          manifest
        )
      );

    configured.id =
      `${manifest.id}.${hashId(
        req.params.config
      )}`;

    configured.name =
      config.iptv_name
        ? `PT•TV HUB — ${config.iptv_name}`
        : "PT•TV HUB";

    res.json(
      configured
    );

  }
);


// ============================================================
// CATALOG — IPTV
// ============================================================

app.get(
  "/:config/catalog/channel/:id.json",
  async (req, res) => {

    noCache(res);

    const config =
      decodeConfig(
        req.params.config
      );

    let channels =
      await getIPTVChannels(
        config
      );

    const search =
      String(
        req.query.search || ""
      ).trim();

    if (search) {

      const term =
        normalizeName(
          search
        );

      channels =
        channels.filter(
          channel =>
            normalizeName(
              channel.title
            ).includes(term) ||
            normalizeName(
              channel.group
            ).includes(term)
        );

    }

    const metas =
      channels.map(
        channel => {

          const poster =
            channel.logo ||
            "";

          return {

            id:
              channel.id,

            type:
              "channel",

            name:
              channel.title,

            poster,

            background:
              channel.background ||
              "",

            logo:
              channel.logo ||
              "",

            description:
              channel.group ||
              "IPTV",

            genres: [
              channel.group ||
              "IPTV"
            ]
          };

        }
      );

    res.json({
      metas
    });

  }
);


// ============================================================
// CATALOG — MOVIES
// ============================================================

app.get(
  "/catalog/movie/:id.json",
  async (req, res) => {

    noCache(res);

    const data =
      await getMovieCatalog(
        req.query
      );

    if (!data) {

      return res.json({
        metas: []
      });

    }

    const metas =
      (data.results || [])
        .map(movie => ({

          id:
            `tmdb:movie:${movie.id}`,

          type:
            "movie",

          name:
            movie.title ||
            movie.original_title ||
            "Filme",

          poster:
            tmdbPoster(
              movie.poster_path
            ),

          background:
            tmdbBackground(
              movie.backdrop_path
            ),

          description:
            movie.overview ||
            "",

          releaseInfo:
            movie.release_date
              ? movie.release_date
                  .slice(0, 4)
              : "",

          imdbRating:
            movie.vote_average ||
            undefined

        }));

    res.json({
      metas
    });

  }
);


// ============================================================
// CATALOG — SERIES
// ============================================================

app.get(
  "/catalog/series/:id.json",
  async (req, res) => {

    noCache(res);

    const data =
      await getSeriesCatalog(
        req.query
      );

    if (!data) {

      return res.json({
        metas: []
      });

    }

    const metas =
      (data.results || [])
        .map(series => ({

          id:
            `tmdb:series:${series.id}`,

          type:
            "series",

          name:
            series.name ||
            series.original_name ||
            "Série",

          poster:
            tmdbPoster(
              series.poster_path
            ),

          background:
            tmdbBackground(
              series.backdrop_path
            ),

          description:
            series.overview ||
            "",

          releaseInfo:
            series.first_air_date
              ? series.first_air_date
                  .slice(0, 4)
              : "",

          imdbRating:
            series.vote_average ||
            undefined

        }));

    res.json({
      metas
    });

  }
);


// ============================================================
// META — IPTV
// ============================================================

app.get(
  "/:config/meta/channel/:id.json",
  async (req, res) => {

    noCache(res);

    const config =
      decodeConfig(
        req.params.config
      );

    const channels =
      await getIPTVChannels(
        config
      );

    const channel =
      channels.find(
        item =>
          item.id ===
          req.params.id
      );

    if (!channel) {

      return res.json({
        meta: null
      });

    }

    res.json({

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

        background:
          channel.background ||
          "",

        logo:
          channel.logo ||
          "",

        description:
          channel.group ||
          "IPTV",

        genres: [
          channel.group ||
          "IPTV"
        ]

      }

    });

  }
);


// ============================================================
// META — MOVIE
// ============================================================

app.get(
  "/meta/movie/:id.json",
  async (req, res) => {

    noCache(res);

    const id =
      String(
        req.params.id
      ).replace(
        /^tmdb:movie:/,
        ""
      );

    const movie =
      await getMovieMeta(
        id
      );

    const meta =
      buildMovieMeta(
        movie
      );

    res.json({
      meta
    });

  }
);


// ============================================================
// META — SERIES
// ============================================================

app.get(
  "/meta/series/:id.json",
  async (req, res) => {

    noCache(res);

    const id =
      String(
        req.params.id
      ).replace(
        /^tmdb:series:/,
        ""
      );

    const series =
      await getSeriesMeta(
        id
      );

    const meta =
      await buildSeriesMeta(
        series
      );

    res.json({
      meta
    });

  }
);


// ============================================================
// STREAM — IPTV
// ============================================================

app.get(
  "/:config/stream/channel/:id.json",
  async (req, res) => {

    noCache(res);

    const config =
      decodeConfig(
        req.params.config
      );

    const channels =
      await getIPTVChannels(
        config
      );

    const channel =
      channels.find(
        item =>
          item.id ===
          req.params.id
      );

    if (!channel) {

      return res.json({
        streams: []
      });

    }

    res.json({

      streams: [
        buildChannelStream(
          channel
        )
      ]

    });

  }
);


// ============================================================
// STREAM — MOVIE
// ============================================================

app.get(
  "/stream/movie/:id.json",
  async (req, res) => {

    noCache(res);

    /*
     * Nesta fase o catálogo/metadata
     * já está funcional.
     *
     * As fontes de reprodução de
     * filmes serão adicionadas através
     * do Source Engine.
     */

    res.json({
      streams: []
    });

  }
);


// ============================================================
// STREAM — SERIES
// ============================================================

app.get(
  "/stream/series/:id.json",
  async (req, res) => {

    noCache(res);

    /*
     * Nesta fase o catálogo/metadata
     * de séries e episódios já está
     * preparado.
     *
     * O Source Engine será ligado
     * posteriormente.
     */

    res.json({
      streams: []
    });

  }
);


// ============================================================
// LOGO
// ============================================================

app.get(
  "/assets/logo.svg",
  (req, res) => {

    res.type(
      "image/svg+xml"
    );

    res.setHeader(
      "Cache-Control",
      "public, max-age=86400"
    );

    res.send(`

<svg
xmlns="http://www.w3.org/2000/svg"
viewBox="0 0 800 800"
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
offset="0"
stop-color="#02050a"
/>

<stop
offset=".55"
stop-color="#071525"
/>

<stop
offset="1"
stop-color="#020308"
/>

</linearGradient>

<linearGradient
id="green"
x1="0"
y1="0"
x2="1"
y2="1"
>

<stop
offset="0"
stop-color="#00a86b"
/>

<stop
offset="1"
stop-color="#006b45"
/>

</linearGradient>

<linearGradient
id="red"
x1="0"
y1="0"
x2="1"
y2="1"
>

<stop
offset="0"
stop-color="#ef3340"
/>

<stop
offset="1"
stop-color="#a80d1c"
/>

</linearGradient>

<linearGradient
id="gold"
x1="0"
y1="0"
x2="1"
y2="1"
>

<stop
offset="0"
stop-color="#fff0a0"
/>

<stop
offset=".45"
stop-color="#d4af37"
/>

<stop
offset="1"
stop-color="#8d6b18"
/>

</linearGradient>

<filter
id="glow"
>

<feGaussianBlur
stdDeviation="7"
result="blur"
/>

<feMerge>

<feMergeNode
in="blur"
/>

<feMergeNode
in="SourceGraphic"
/>

</feMerge>

</filter>

</defs>


<rect
width="800"
height="800"
rx="130"
fill="url(#bg)"
/>


<g
opacity=".12"
stroke="#6b8aa8"
fill="none"
>

<path
d="M0 150H800"
/>

<path
d="M0 650H800"
/>

<path
d="M150 0V800"
/>

<path
d="M650 0V800"
/>

<path
d="M0 0L800 800"
/>

<path
d="M800 0L0 800"
/>

</g>


<!-- Seven stars -->

<g
fill="url(#gold)"
filter="url(#glow)"
>

<circle
cx="270"
cy="100"
r="7"
/>

<circle
cx="315"
cy="77"
r="7"
/>

<circle
cx="365"
cy="64"
r="7"
/>

<circle
cx="415"
cy="64"
r="7"
/>

<circle
cx="465"
cy="77"
r="7"
/>

<circle
cx="510"
cy="100"
r="7"
/>

<circle
cx="555"
cy="130"
r="7"
/>

</g>


<!-- Dynamic shield -->

<path
d="
M400 150
C325 180 265 215 225 270
C190 320 205 415 270 465
C320 503 370 530 400 550
C430 530 480 503 530 465
C595 415 610 320 575 270
C535 215 475 180 400 150Z
"
fill="#07111c"
stroke="url(#gold)"
stroke-width="8"
/>


<!-- Green ribbon -->

<path
d="
M390 190
C320 225 275 275 265 330
C255 385 290 425 350 450
C390 467 415 490 400 525
C440 500 455 465 435 430
C410 385 350 370 340 330
C330 292 360 255 420 225Z
"
fill="url(#green)"
filter="url(#glow)"
/>


<!-- Red ribbon -->

<path
d="
M410 190
C480 225 525 275 535 330
C545 385 510 425 450 450
C410 467 385 490 400 525
C360 500 345 465 365 430
C390 385 450 370 460 330
C470 292 440 255 380 225Z
"
fill="url(#red)"
filter="url(#glow)"
/>


<!-- Armillary sphere -->

<g
fill="none"
stroke="url(#gold)"
stroke-width="5"
filter="url(#glow)"
>

<circle
cx="400"
cy="345"
r="62"
/>

<ellipse
cx="400"
cy="345"
rx="62"
ry="27"
/>

<ellipse
cx="400"
cy="345"
rx="27"
ry="62"
/>

<path
d="M338 345H462"
/>

<path
d="M400 283V407"
/>

</g>


<!-- Azulejos -->

<g
fill="#fff"
stroke="url(#gold)"
stroke-width="3"
>

<rect
x="355"
y="410"
width="22"
height="22"
rx="3"
/>

<rect
x="389"
y="420"
width="22"
height="22"
rx="3"
/>

<rect
x="423"
y="410"
width="22"
height="22"
rx="3"
/>

<rect
x="372"
y="448"
width="22"
height="22"
rx="3"
/>

<rect
x="406"
y="448"
width="22"
height="22"
rx="3"
/>

</g>


<!-- PT -->

<text
x="400"
y="325"
text-anchor="middle"
font-family="Montserrat,Arial,sans-serif"
font-size="50"
font-weight="900"
fill="url(#gold)"
>
PT
</text>


<!-- Brand -->

<text
x="400"
y="635"
text-anchor="middle"
font-family="Montserrat,Arial,sans-serif"
font-size="66"
font-weight="900"
letter-spacing="2"
fill="url(#gold)"
>
PT•TV HUB
</text>


<text
x="400"
y="680"
text-anchor="middle"
font-family="Montserrat,Arial,sans-serif"
font-size="20"
font-weight="600"
letter-spacing="6"
fill="#e3c45a"
>
IPTV PORTUGUESA
</text>

</svg>

`);

  }
);


// ============================================================
// BACKGROUND
// ============================================================

app.get(
  "/assets/background.svg",
  (req, res) => {

    res.type(
      "image/svg+xml"
    );

    res.setHeader(
      "Cache-Control",
      "public, max-age=86400"
    );

    res.send(`

<svg
xmlns="http://www.w3.org/2000/svg"
viewBox="0 0 1920 1080"
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
offset="0"
stop-color="#02050a"
/>

<stop
offset=".5"
stop-color="#071625"
/>

<stop
offset="1"
stop-color="#030507"
/>

</linearGradient>

<radialGradient
id="green"
cx="20%"
cy="50%"
r="55%"
>

<stop
offset="0"
stop-color="#007847"
stop-opacity=".30"
/>

<stop
offset="1"
stop-color="#007847"
stop-opacity="0"
/>

</radialGradient>

<radialGradient
id="red"
cx="85%"
cy="45%"
r="55%"
>

<stop
offset="0"
stop-color="#ce1126"
stop-opacity=".25"
/>

<stop
offset="1"
stop-color="#ce1126"
stop-opacity="0"
/>

</radialGradient>

</defs>


<rect
width="1920"
height="1080"
fill="url(#bg)"
/>

<rect
width="1920"
height="1080"
fill="url(#green)"
/>

<rect
width="1920"
height="1080"
fill="url(#red)"
/>


<g
stroke="#d4af37"
stroke-opacity=".10"
fill="none"
stroke-width="2"
>

<path
d="M0 180H1920"
/>

<path
d="M0 540H1920"
/>

<path
d="M0 900H1920"
/>

<path
d="M320 0V1080"
/>

<path
d="M960 0V1080"
/>

<path
d="M1600 0V1080"
/>

<path
d="M0 0L1920 1080"
/>

<path
d="M1920 0L0 1080"
/>

</g>


<g
fill="#d4af37"
fill-opacity=".15"
>

<circle
cx="320"
cy="180"
r="5"
/>

<circle
cx="960"
cy="540"
r="5"
/>

<circle
cx="1600"
cy="900"
r="5"
/>

<circle
cx="320"
cy="900"
r="5"
/>

<circle
cx="1600"
cy="180"
r="5"
/>

</g>


<text
x="120"
y="850"
font-family="Montserrat,Arial,sans-serif"
font-size="105"
font-weight="900"
letter-spacing="4"
fill="#d4af37"
fill-opacity=".88"
>
PT•TV HUB
</text>

<text
x="128"
y="905"
font-family="Montserrat,Arial,sans-serif"
font-size="30"
font-weight="600"
letter-spacing="8"
fill="#e3c45a"
fill-opacity=".8"
>
IPTV PORTUGUESA • FILMES • SÉRIES
</text>

</svg>

`);

  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {

    res.json({

      ok: true,

      name:
        APP_NAME,

      version:
        APP_VERSION,

      tmdb:
        Boolean(
          TMDB_API_KEY
        ),

      time:
        new Date().toISOString()

    });

  }
);


// ============================================================
// HOME
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

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
PT•TV HUB
</title>

<style>

body {
  margin:0;
  min-height:100vh;

  display:flex;
  align-items:center;
  justify-content:center;

  font-family:
    Arial,
    sans-serif;

  color:white;

  background:
    radial-gradient(
      circle at top,
      #12352b,
      #02050a 65%
    );

  text-align:center;
}

.card {
  max-width:720px;
  padding:40px;
}

img {
  width:180px;
  max-width:60vw;
}

h1 {
  font-size:48px;
  margin:20px 0 8px;
}

p {
  color:#94a3b8;
}

a {
  display:inline-block;

  margin-top:25px;

  padding:14px 22px;

  border-radius:10px;

  background:
    linear-gradient(
      135deg,
      #007847,
      #ce1126
    );

  color:white;

  text-decoration:none;

  font-weight:700;
}

</style>

</head>

<body>

<div class="card">

<img
src="/assets/logo.svg"
alt="PT TV HUB"
>

<h1>
PT•TV HUB
</h1>

<p>
IPTV • FILMES • SÉRIES
</p>

<p>
Versão ${APP_VERSION}
</p>

<a
href="/configure"
>
⚙️ Configurar IPTV
</a>

</div>

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
      `${APP_NAME} ${APP_VERSION} em http://localhost:${PORT}`
    );

    console.log(
      `TMDB: ${
        TMDB_API_KEY
          ? "configurado"
          : "NÃO CONFIGURADO"
      }`
    );

  }
);
