import { Buffer } from "node:buffer";

const RTP_BASE = "https://www.rtp.pt";
const RTP_LOGO = "https://www.rtp.pt/favicon.ico";
const CACHE_TTL_MS = 15 * 60 * 1000;
const catalogCache = new Map();
const metaCache = new Map();

export const RTP_VOD_CATALOGS = Object.freeze([
  { type: "series", id: "rtp-vod-series", name: "🇵🇹 RTP Play • Séries", url: RTP_BASE + "/play/hub/series" },
  { type: "series", id: "rtp-vod-docs", name: "🇵🇹 RTP Play • DOCS", url: RTP_BASE + "/play/hub/documentarios" },
  { type: "music", id: "rtp-vod-concerts", name: "🎵 RTP Palco • Concertos", url: RTP_BASE + "/play/palco/espetaculos/concertos/todos", palcoOnly: true },
]);

function decodeHtml(value = "") {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", aacute:"á", eacute:"é", iacute:"í", oacute:"ó", uacute:"ú", agrave:"à", acirc:"â", ecirc:"ê", ocirc:"ô", atilde:"ã", otilde:"õ", ccedil:"ç", Aacute:"Á", Eacute:"É", Iacute:"Í", Oacute:"Ó", Uacute:"Ú", Agrave:"À", Acirc:"Â", Ecirc:"Ê", Ocirc:"Ô", Atilde:"Ã", Otilde:"Õ", Ccedil:"Ç" };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, key) => named[key] ?? named[key.toLowerCase()] ?? m);
}

function stripTags(value = "") {
  return decodeHtml(String(value).replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attrValue(attrs = "", name) {
  const escaped = name.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const match = String(attrs).match(new RegExp("(?:^|\\s)" + escaped + "\\s*=\\s*([\"'])(.*?)\\1", "i"));
  return match ? decodeHtml(match[2]).trim() : "";
}

function absoluteRtpUrl(value = "") {
  try {
    const u = new URL(decodeHtml(value), RTP_BASE);
    return u.hostname === "www.rtp.pt" || u.hostname.endsWith(".rtp.pt") ? u.toString() : "";
  } catch {
    return "";
  }
}

function rtpPathFromUrl(value = "") {
  try {
    const u = new URL(value, RTP_BASE);
    if (u.hostname !== "www.rtp.pt") return "";
    const path = u.pathname.replace(/\/+/g, "/");
    if (!/^\/play\/(?:palco\/)?p\d+(?:\/|$)/i.test(path)) return "";
    return path + (u.search || "");
  } catch {
    return "";
  }
}

function encodeId(path) {
  return "rtpvod:" + Buffer.from(path, "utf8").toString("base64url");
}

function decodeId(id = "") {
  if (!String(id).startsWith("rtpvod:")) return "";
  try {
    const raw = Buffer.from(String(id).slice(7), "base64url").toString("utf8");
    return rtpPathFromUrl(raw);
  } catch {
    return "";
  }
}

async function fetchHtml(target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "PT-HUB/3.2 RTP-Play-Public-Catalog" },
    });
    if (!response.ok) throw new Error("RTP HTTP " + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function metaTag(html, property) {
  const escaped = property.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp("<meta[^>]+(?:property|name)=[\"']" + escaped + "[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>", "i"),
    new RegExp("<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']" + escaped + "[\"'][^>]*>", "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]).trim();
  }
  return "";
}

function firstHeading(html) {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? stripTags(match[1]) : "";
}

function slugTitle(path) {
  const slug = String(path).split("/").filter(Boolean).at(-1) || "RTP Play";
  return decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\s+/g, " ")
    .replace(/\b\p{L}/gu, c => c.toUpperCase());
}

function cleanTitle(value = "") {
  return stripTags(value).replace(/^Aceder\s+a:\s*/i, "").replace(/^Ver\s+(?:agora|detalhes):?\s*/i, "").trim();
}

function parseCatalog(html, type, catalog = null) {
  const metas = [];
  const seen = new Set();
  const anchorRe = /<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) && metas.length < 100) {
    const attrs = (match[1] || "") + " " + (match[4] || "");
    const href = absoluteRtpUrl(match[3]);
    const path = rtpPathFromUrl(href);
    if (!path || seen.has(path)) continue;
    if (catalog?.palcoOnly && !/^\/play\/palco\/p\d+(?:\/e\d+)?\//i.test(path)) continue;
    const body = match[5] || "";
    const imageMatch = body.match(/<img\b([^>]*)>/i);
    const imageAttrs = imageMatch?.[1] || "";
    const title = cleanTitle(attrValue(attrs, "title") || attrValue(attrs, "aria-label") ||
      attrValue(imageAttrs, "alt") || stripTags(body)) || slugTitle(path);
    if (!title || title.length > 220) continue;
    const srcset = attrValue(imageAttrs, "srcset") || attrValue(imageAttrs, "data-srcset");
    const srcsetFirst = srcset ? srcset.split(",")[0].trim().split(/\s+/)[0] : "";
    const posterRaw = attrValue(imageAttrs, "src") || attrValue(imageAttrs, "data-src") ||
      attrValue(imageAttrs, "data-original") || attrValue(imageAttrs, "data-lazy-src") || srcsetFirst;
    const poster = absoluteRtpUrl(posterRaw);
    seen.add(path);
    metas.push({
      id: encodeId(path),
      type,
      name: title,
      ...(poster ? { poster, background: poster } : { poster: RTP_LOGO }),
      description: "RTP Play",
      website: RTP_BASE + path,
    });
  }
  return metas;
}


function parseEpisodes(html, programPath) {
  const videos = [];
  const seen = new Set();
  const re = /<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) && videos.length < 300) {
    const href = absoluteRtpUrl(match[3]);
    const path = rtpPathFromUrl(href);
    if (!path || !/\/e\d+\//i.test(path) || seen.has(path)) continue;
    const attrs = (match[1] || "") + " " + (match[4] || "");
    const body = match[5] || "";
    const imageMatch = body.match(/<img\b([^>]*)>/i);
    const imageAttrs = imageMatch?.[1] || "";
    const rawTitle = attrValue(attrs, "title") || attrValue(attrs, "aria-label") ||
      attrValue(imageAttrs, "alt") || stripTags(body);
    const title = cleanTitle(rawTitle) || ("Episódio " + (videos.length + 1));
    const ep = path.match(/\/e(\d+)\//i)?.[1] || "";
    seen.add(path);
    videos.push({
      id: encodeId(path),
      title,
      season: 1,
      episode: videos.length + 1,
      ...(ep ? { episodeId: ep } : {}),
    });
  }
  return videos;
}

function unescapeMediaUrl(value = "") {
  return decodeHtml(String(value))
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\");
}

function extractPublicMediaUrl(html = "") {
  const text = String(html);
  const candidates = [];
  for (const pattern of [
    /https?:\\?\/\\?\/[^"'<>\\\s]+?\.m3u8(?:\?[^"'<>\\\s]*)?/gi,
    /https?:\\?\/\\?\/[^"'<>\\\s]+?\.mpd(?:\?[^"'<>\\\s]*)?/gi,
    /["'](?:file|src|url)["']\s*:\s*["'](https?:\\?\/\\?\/[^"']+)["']/gi,
  ]) {
    for (const match of text.matchAll(pattern)) candidates.push(match[1] || match[0]);
  }
  for (const raw of candidates) {
    const value = unescapeMediaUrl(raw);
    try {
      const u = new URL(value);
      if ((u.protocol === "https:" || u.protocol === "http:") &&
          (/\.m3u8(?:$|[?#])/i.test(u.toString()) || /\.mpd(?:$|[?#])/i.test(u.toString()))) {
        return u.toString();
      }
    } catch {}
  }
  return "";
}

function findCatalog(type, id) {
  return RTP_VOD_CATALOGS.find(item => item.type === type && item.id === id) || null;
}

export async function getRtpVodCatalog(type, id, search = "") {
  const catalog = findCatalog(type, id);
  if (!catalog) return { metas: [] };
  const key = type + ":" + id;
  const cached = catalogCache.get(key);
  let metas;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    metas = cached.metas;
  } else {
    const html = await fetchHtml(catalog.url);
    metas = parseCatalog(html, type, catalog);
    catalogCache.set(key, { at: Date.now(), metas });
  }
  const needle = stripTags(search).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (needle) {
    metas = metas.filter(item =>
      String(item.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().includes(needle));
  }
  return { metas: metas.slice(0, 100) };
}

export async function getRtpVodMeta(type, id) {
  const path = decodeId(id);
  if (!path) return null;
  const key = type + ":" + id;
  const cached = metaCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.meta;
  const website = RTP_BASE + path;
  const html = await fetchHtml(website);
  const title = metaTag(html, "og:title") || firstHeading(html) || slugTitle(path);
  const description = cleanTitle(metaTag(html, "og:description") || metaTag(html, "description")) || "Conteúdo RTP Play";
  const poster = absoluteRtpUrl(metaTag(html, "og:image"));
  const videos = parseEpisodes(html, path);
  const meta = { id, type, name: cleanTitle(title), description, website, ...(videos.length ? { videos } : {}), ...(poster ? { poster, background: poster } : { poster: RTP_LOGO }) };
  metaCache.set(key, { at: Date.now(), meta });
  return meta;
}

export async function getRtpVodStreams(type, id) {
  if (type !== "movie" && type !== "series" && type !== "music") return [];
  const path = decodeId(id);
  if (!path) return [];
  const website = RTP_BASE + path;
  try {
    const html = await fetchHtml(website);
    const mediaUrl = extractPublicMediaUrl(html);
    if (mediaUrl) return [{ name: "PT•HUB • RTP Play", title: "RTP Play", url: mediaUrl, behaviorHints: { notWebReady: true } }];
  } catch {}
  return [];
}
