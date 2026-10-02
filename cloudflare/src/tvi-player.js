import { Buffer } from "node:buffer";

const TVI_BASE = "https://tviplayer.iol.pt";
const TVI_LOGO = "https://tviplayer.iol.pt/favicon.ico";
const CACHE_TTL_MS = 15 * 60 * 1000;
const catalogCache = new Map();
const metaCache = new Map();

export const TVI_VOD_CATALOGS = Object.freeze([
  { type: "series", id: "tvi-vod-programas", name: "🇵🇹 TVI Player • Programas", url: TVI_BASE + "/programas/tvi" },
]);

function decodeHtml(value = "") {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", hellip: "…" };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, key) => named[key.toLowerCase()] ?? m);
}

function stripTags(value = "") {
  return decodeHtml(String(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attrValue(attrs = "", name) {
  const safe = String(name).replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const match = String(attrs).match(new RegExp("(?:^|\\s)" + safe + "\\s*=\\s*([\"'])(.*?)\\1", "i"));
  return match ? decodeHtml(match[2]).trim() : "";
}

function absoluteTviUrl(value = "") {
  try {
    const u = new URL(decodeHtml(value), TVI_BASE);
    if (u.hostname !== "tviplayer.iol.pt") return "";
    return u.toString();
  } catch {
    return "";
  }
}

function tviPath(value = "") {
  try {
    const u = new URL(value, TVI_BASE);
    if (u.hostname !== "tviplayer.iol.pt") return "";
    const path = u.pathname.replace(/\/+/g, "/");
    if (!/^\/programa\/[^/]+\/[a-z0-9]+(?:\/(?:t\d+|video\/[a-z0-9]+))?\/?$/i.test(path)) return "";
    return path.replace(/\/$/, "") + (u.search || "");
  } catch {
    return "";
  }
}

function encodeId(path) {
  return "tvivod:" + Buffer.from(path, "utf8").toString("base64url");
}

function decodeId(id = "") {
  if (!String(id).startsWith("tvivod:")) return "";
  try {
    return tviPath(Buffer.from(String(id).slice(7), "base64url").toString("utf8"));
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
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "PT-HUB/3.2 TVI-Player-Public-Catalog",
      },
    });
    if (!response.ok) throw new Error("TVI Player HTTP " + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function metaTag(html, property) {
  const safe = String(property).replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  for (const pattern of [
    new RegExp("<meta[^>]+(?:property|name)=[\"']" + safe + "[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>", "i"),
    new RegExp("<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']" + safe + "[\"'][^>]*>", "i"),
  ]) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]).trim();
  }
  return "";
}

function slugTitle(path) {
  const parts = String(path).split("/").filter(Boolean);
  const slug = parts[1] || "TVI Player";
  return decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\s+/g, " ")
    .replace(/\b\p{L}/gu, c => c.toUpperCase());
}

function parseAnchors(html) {
  const out = [];
  const re = /<a\b([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    out.push({
      attrs: (match[1] || "") + " " + (match[4] || ""),
      href: absoluteTviUrl(match[3]),
      body: match[5] || "",
    });
  }
  return out;
}

function anchorImage(anchor) {
  const imageMatch = anchor.body.match(/<img\b([^>]*)>/i);
  const attrs = imageMatch?.[1] || "";
  return absoluteTviUrl(
    attrValue(attrs, "src") || attrValue(attrs, "data-src") ||
    attrValue(attrs, "data-original") || attrValue(attrs, "data-lazy-src"),
  );
}

function anchorTitle(anchor, fallback = "") {
  const imageMatch = anchor.body.match(/<img\b([^>]*)>/i);
  const imageAttrs = imageMatch?.[1] || "";
  return attrValue(anchor.attrs, "title") || attrValue(anchor.attrs, "aria-label") ||
    attrValue(imageAttrs, "alt") || stripTags(anchor.body) || fallback;
}

function programRootPath(path) {
  const match = String(path).match(/^(\/programa\/[^/]+\/[a-z0-9]+)/i);
  return match ? match[1] : "";
}

function parseCatalog(html) {
  const metas = [];
  const seen = new Set();
  for (const anchor of parseAnchors(html)) {
    const path = tviPath(anchor.href);
    const root = programRootPath(path);
    if (!root || /\/video\//i.test(path) || seen.has(root)) continue;
    const title = anchorTitle(anchor, slugTitle(root));
    if (!title || title.length > 220) continue;
    const poster = anchorImage(anchor);
    seen.add(root);
    metas.push({
      id: encodeId(root),
      type: "series",
      name: title,
      ...(poster ? { poster, background: poster } : { poster: TVI_LOGO }),
      description: "TVI Player",
      website: TVI_BASE + root,
    });
    if (metas.length >= 100) break;
  }
  return metas;
}

function parseVideos(html, rootPath) {
  const videos = [];
  const seen = new Set();
  for (const anchor of parseAnchors(html)) {
    const path = tviPath(anchor.href);
    if (!path || !path.startsWith(rootPath + "/video/") || seen.has(path)) continue;
    const title = anchorTitle(anchor, "Episódio " + (videos.length + 1));
    const poster = anchorImage(anchor);
    seen.add(path);
    videos.push({
      id: encodeId(path),
      title,
      season: 1,
      episode: videos.length + 1,
      released: new Date(0).toISOString(),
      ...(poster ? { thumbnail: poster } : {}),
    });
    if (videos.length >= 300) break;
  }
  return videos;
}

export async function getTviVodCatalog(type, id, search = "") {
  if (type !== "series") return { metas: [] };
  const catalog = TVI_VOD_CATALOGS.find(item => item.type === type && item.id === id);
  if (!catalog) return { metas: [] };
  const cached = catalogCache.get(id);
  let metas;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    metas = cached.metas;
  } else {
    metas = parseCatalog(await fetchHtml(catalog.url));
    catalogCache.set(id, { at: Date.now(), metas });
  }
  const needle = stripTags(search).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (needle) {
    metas = metas.filter(item =>
      String(item.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().includes(needle));
  }
  return { metas: metas.slice(0, 100) };
}

export async function getTviVodMeta(type, id) {
  if (type !== "series") return null;
  const path = decodeId(id);
  const root = programRootPath(path);
  if (!root) return null;
  const rootId = encodeId(root);
  const cached = metaCache.get(rootId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.meta;

  const website = TVI_BASE + root;
  const html = await fetchHtml(website);
  const title = metaTag(html, "og:title") || slugTitle(root);
  const description = metaTag(html, "og:description") || metaTag(html, "description") || "Conteúdo TVI Player";
  const poster = absoluteTviUrl(metaTag(html, "og:image"));
  const videos = parseVideos(html, root);
  const meta = {
    id: rootId,
    type: "series",
    name: title,
    description,
    website,
    videos,
    ...(poster ? { poster, background: poster } : { poster: TVI_LOGO }),
  };
  metaCache.set(rootId, { at: Date.now(), meta });
  return meta;
}

export async function getTviVodStreams(type, id) {
  if (type !== "series") return [];
  const path = decodeId(id);
  if (!path) return [];
  return [{
    name: "PT•HUB • TVI Player",
    title: /\/video\//i.test(path) ? "Ver episódio no TVI Player" : "Abrir no TVI Player",
    externalUrl: TVI_BASE + path,
  }];
}
