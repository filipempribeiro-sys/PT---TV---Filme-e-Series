"use strict";

/*
 * PT•HUB — Resolver PT V2
 * Filmes, Séries e Novelas Portuguesas
 *
 * Objetivo:
 * - converter externalUrl em reprodução interna apenas quando conseguimos
 *   identificar com confiança o conteúdo principal;
 * - rejeitar prerolls/assets publicitários curtos;
 * - nunca contornar DRM, autenticação, anti-bot ou sessões privadas;
 * - se houver dúvida, preservar o externalUrl original.
 */

const dns = require("dns").promises;
const net = require("net");

const TARGET_HOST = "filme-series-e-novelas-portuguesas.vercel.app";
const TARGET_STREAM_PATH = /^\/stream\/(?:movie|series)\//i;

const RESOLVE_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 1_500_000;
const MAX_STREAMS_TO_RESOLVE = 12;
const MAX_CANDIDATES = 12;
const MIN_MAIN_HLS_DURATION_SEC = 180;
const MIN_MAIN_FILE_BYTES = 20 * 1024 * 1024;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const originalFetch = global.fetch;

if (typeof originalFetch !== "function") {
  console.warn("PT•HUB Resolver PT V2: fetch global indisponível; resolver desativado.");
  return;
}

function isPrivateIPv4(ip) {
  const parts = String(ip).split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(ip) {
  const value = String(ip).toLowerCase();
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("ff") ||
    value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") ||
    value.startsWith("::ffff:192.168.")
  );
}

async function isPublicHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return false;
  }

  if (!/^https?:$/.test(url.protocol)) return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;

  const family = net.isIP(host);
  if (family === 4) return !isPrivateIPv4(host);
  if (family === 6) return !isPrivateIPv6(host);

  try {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length) return false;

    return addresses.every(({ address, family: resolvedFamily }) =>
      resolvedFamily === 4
        ? !isPrivateIPv4(address)
        : resolvedFamily === 6
          ? !isPrivateIPv6(address)
          : false
    );
  } catch {
    return false;
  }
}

function looksLikePlayableUrl(value) {
  return /\.(?:m3u8|mp4|m4v|webm|mpd)(?:$|[?#])/i.test(String(value || "").trim());
}

function looksLikePlayableContentType(contentType) {
  const value = String(contentType || "").toLowerCase();
  return (
    value.includes("application/vnd.apple.mpegurl") ||
    value.includes("application/x-mpegurl") ||
    value.includes("application/dash+xml") ||
    value.startsWith("video/")
  );
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/");
}

function normalizeCandidate(candidate, baseUrl) {
  const value = decodeHtmlEntities(candidate)
    .trim()
    .replace(/^[\"']|[\"']$/g, "");

  if (!value) return "";

  try {
    return new URL(value, baseUrl).href;
  } catch {
    return "";
  }
}

function isObviousAdText(value) {
  const text = String(value || "").toLowerCase();
  return /(?:^|[\W_])(ad|ads|advert|advertising|advertisement|preroll|pre-roll|vast|vpaid|ima|commercial|promo|sponsor|doubleclick|googlesyndication)(?:[\W_]|$)/i.test(text);
}

function hasPositiveMainContext(value) {
  const text = String(value || "").toLowerCase();
  return /(?:episode|episodio|episódio|movie|filme|novela|series|série|stream|source|video|player|content|manifest|master)/i.test(text);
}

function extractPlayableCandidates(html, baseUrl) {
  const text = decodeHtmlEntities(html);
  const found = new Map();

  const patterns = [
    /https?:\/\/[^\s\"'<>\\]+?\.(?:m3u8|mp4|m4v|webm|mpd)(?:\?[^\s\"'<>\\]*)?/gi,
    /(?:src|href|file|url|content|source|stream)\s*[:=]\s*[\"']([^\"']+?\.(?:m3u8|mp4|m4v|webm|mpd)(?:\?[^\"']*)?)[\"']/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1] || match[0];
      const url = normalizeCandidate(raw, baseUrl);
      if (!url || !looksLikePlayableUrl(url)) continue;

      const start = Math.max(0, match.index - 180);
      const end = Math.min(text.length, match.index + raw.length + 180);
      const context = text.slice(start, end);

      const current = found.get(url) || { url, contexts: [] };
      current.contexts.push(context);
      found.set(url, current);

      if (found.size >= MAX_CANDIDATES) break;
    }
    if (found.size >= MAX_CANDIDATES) break;
  }

  return [...found.values()];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = RESOLVE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await originalFetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow"
    });
  } finally {
    clearTimeout(timeout);
  }
}

function requestHeaders(referer = "") {
  const headers = {
    "User-Agent": BROWSER_UA,
    "Accept": "*/*",
    "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8"
  };

  if (referer) {
    headers.Referer = referer;
    try {
      headers.Origin = new URL(referer).origin;
    } catch {}
  }

  return headers;
}

function parseHlsDuration(manifest) {
  let total = 0;
  const regex = /#EXTINF:([0-9.]+)/gi;
  let match;
  while ((match = regex.exec(String(manifest || ""))) !== null) {
    total += Number(match[1]) || 0;
  }
  return total;
}

function extractMasterVariants(manifest, baseUrl) {
  const lines = String(manifest || "").split(/\r?\n/);
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;

    const bandwidth = Number((lines[i].match(/BANDWIDTH=(\d+)/i) || [])[1] || 0);
    let uri = "";

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      if (line.startsWith("#")) break;
      uri = normalizeCandidate(line, baseUrl);
      break;
    }

    if (uri) variants.push({ uri, bandwidth });
  }

  return variants.sort((a, b) => b.bandwidth - a.bandwidth);
}

async function inspectHlsCandidate(url, referer, depth = 0) {
  if (!(await isPublicHttpUrl(url))) return null;
  if (isObviousAdText(url)) return null;

  let response;
  try {
    response = await fetchWithTimeout(url, {
      method: "GET",
      headers: requestHeaders(referer)
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const body = await response.text().catch(() => "");
  if (!body || !body.includes("#EXTM3U")) return null;

  if (isObviousAdText(body)) {
    const durationWithAdMarkers = parseHlsDuration(body);
    if (durationWithAdMarkers < MIN_MAIN_HLS_DURATION_SEC) return null;
  }

  const duration = parseHlsDuration(body);
  if (duration >= MIN_MAIN_HLS_DURATION_SEC) {
    return {
      url,
      duration,
      reason: `HLS ${Math.round(duration)}s`
    };
  }

  if (depth === 0) {
    const variants = extractMasterVariants(body, url).slice(0, 3);
    for (const variant of variants) {
      const inspected = await inspectHlsCandidate(variant.uri, referer || url, 1);
      if (inspected) {
        return {
          url,
          duration: inspected.duration,
          reason: `HLS master ${Math.round(inspected.duration)}s`
        };
      }
    }
  }

  return null;
}

async function inspectFileCandidate(url, referer, contexts = []) {
  if (!(await isPublicHttpUrl(url))) return null;
  if (isObviousAdText(url) || contexts.some(isObviousAdText)) return null;

  let response;
  try {
    response = await fetchWithTimeout(url, {
      method: "HEAD",
      headers: requestHeaders(referer)
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const type = response.headers.get("content-type") || "";
  const size = Number(response.headers.get("content-length") || 0);

  if (!looksLikePlayableContentType(type) && !looksLikePlayableUrl(url)) return null;

  const positive = contexts.some(hasPositiveMainContext);
  if (size >= MIN_MAIN_FILE_BYTES || (size >= 5 * 1024 * 1024 && positive)) {
    return {
      url,
      size,
      reason: `ficheiro ${Math.round(size / 1024 / 1024)}MB`
    };
  }

  return null;
}

async function inspectCandidate(candidate, referer) {
  const { url, contexts = [] } = candidate;

  if (isObviousAdText(url) || contexts.some(isObviousAdText)) {
    return null;
  }

  if (/\.m3u8(?:$|[?#])/i.test(url)) {
    return inspectHlsCandidate(url, referer);
  }

  if (/\.(?:mp4|m4v|webm)(?:$|[?#])/i.test(url)) {
    return inspectFileCandidate(url, referer, contexts);
  }

  // DASH só é aceite se a própria página o identifica claramente como conteúdo principal.
  if (/\.mpd(?:$|[?#])/i.test(url) && contexts.some(hasPositiveMainContext)) {
    return { url, reason: "DASH identificado como conteúdo" };
  }

  return null;
}

async function chooseMainCandidate(candidates, referer) {
  const accepted = [];

  for (const candidate of candidates) {
    const inspected = await inspectCandidate(candidate, referer);
    if (inspected) accepted.push(inspected);
  }

  if (!accepted.length) return null;

  accepted.sort((a, b) => {
    const ad = Number(a.duration || 0) * 1000000 + Number(a.size || 0);
    const bd = Number(b.duration || 0) * 1000000 + Number(b.size || 0);
    return bd - ad;
  });

  return accepted[0];
}

async function resolveExternalUrl(externalUrl) {
  if (!(await isPublicHttpUrl(externalUrl))) return null;

  if (looksLikePlayableUrl(externalUrl) && !isObviousAdText(externalUrl)) {
    const direct = await inspectCandidate({ url: externalUrl, contexts: ["direct stream"] }, "");
    if (direct) return { url: direct.url, referer: "", reason: direct.reason };
  }

  let response;
  try {
    response = await fetchWithTimeout(externalUrl, {
      method: "GET",
      headers: {
        ...requestHeaders(),
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,video/*;q=0.8,*/*;q=0.5"
      }
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const finalUrl = response.url || externalUrl;
  if (!(await isPublicHttpUrl(finalUrl))) return null;

  const contentType = response.headers.get("content-type") || "";

  if (looksLikePlayableContentType(contentType) || looksLikePlayableUrl(finalUrl)) {
    const direct = await inspectCandidate({ url: finalUrl, contexts: ["direct response"] }, externalUrl);
    if (direct) return { url: direct.url, referer: externalUrl, reason: direct.reason };
    return null;
  }

  if (!/(?:text\/html|application\/json|text\/plain|javascript)/i.test(contentType)) {
    return null;
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_HTML_BYTES) return null;

  const body = await response.text().catch(() => "");
  if (!body || Buffer.byteLength(body, "utf8") > MAX_HTML_BYTES) return null;

  const candidates = extractPlayableCandidates(body, finalUrl);

  console.log(
    `PT•HUB Resolver PT V2: ${candidates.length} candidato(s) de media encontrado(s) na página externa.`
  );

  const main = await chooseMainCandidate(candidates, finalUrl);
  if (!main) {
    console.log(
      "PT•HUB Resolver PT V2: nenhum candidato principal validado; externalUrl preservado."
    );
    return null;
  }

  console.log(
    `PT•HUB Resolver PT V2: conteúdo principal validado — ${main.reason}.`
  );

  return {
    url: main.url,
    referer: finalUrl,
    reason: main.reason
  };
}

async function resolveProviderStreams(data) {
  if (!data || !Array.isArray(data.streams) || !data.streams.length) {
    return data;
  }

  let resolvedCount = 0;
  const nextStreams = [];

  for (let index = 0; index < data.streams.length; index++) {
    const stream = data.streams[index];
    const externalUrl = String(stream?.externalUrl || "").trim();

    if (!externalUrl || stream?.url || index >= MAX_STREAMS_TO_RESOLVE) {
      nextStreams.push(stream);
      continue;
    }

    const resolved = await resolveExternalUrl(externalUrl);

    if (!resolved?.url) {
      nextStreams.push(stream);
      continue;
    }

    const behaviorHints = {
      ...(stream?.behaviorHints || {}),
      notWebReady: true
    };

    if (resolved.referer) {
      let origin = "";
      try {
        origin = new URL(resolved.referer).origin;
      } catch {}

      behaviorHints.proxyHeaders = {
        ...(behaviorHints.proxyHeaders || {}),
        request: {
          ...(behaviorHints.proxyHeaders?.request || {}),
          "Referer": resolved.referer,
          ...(origin ? { "Origin": origin } : {}),
          "User-Agent": BROWSER_UA
        }
      };
    }

    nextStreams.push({
      ...stream,
      url: resolved.url,
      externalUrl: undefined,
      name: stream?.name || "PT•HUB • Produção Portuguesa",
      title:
        stream?.title
          ? `${stream.title}\n▶ Reprodução interna PT•HUB`
          : "▶ Reprodução interna PT•HUB",
      behaviorHints
    });

    resolvedCount++;
  }

  if (resolvedCount > 0) {
    console.log(
      `PT•HUB Resolver PT V2: ${resolvedCount}/${data.streams.length} stream(s) convertido(s) para conteúdo principal interno.`
    );
  } else {
    console.log(
      `PT•HUB Resolver PT V2: nenhum stream convertido (${data.streams.length} stream(s)); opções externas preservadas.`
    );
  }

  return {
    ...data,
    streams: nextStreams
  };
}

global.fetch = async function ptHubFetch(input, init) {
  const requestUrl =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : String(input?.url || "");

  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return originalFetch(input, init);
  }

  const isTarget =
    parsed.hostname.toLowerCase() === TARGET_HOST &&
    TARGET_STREAM_PATH.test(parsed.pathname);

  if (!isTarget) {
    return originalFetch(input, init);
  }

  const response = await originalFetch(input, init);
  if (!response.ok) return response;

  let data;
  try {
    data = await response.clone().json();
  } catch {
    return response;
  }

  let transformed;
  try {
    transformed = await resolveProviderStreams(data);
  } catch (error) {
    console.warn(
      "PT•HUB Resolver PT V2: falha ao resolver stream externo —",
      error?.message || "erro desconhecido"
    );
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");
  headers.delete("content-encoding");

  return new Response(JSON.stringify(transformed), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

console.log("PT•HUB Resolver PT V2: ativo — conteúdo principal validado antes da reprodução interna.");
