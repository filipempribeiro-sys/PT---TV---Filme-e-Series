"use strict";

/*
 * PT•HUB — Resolver conservador para o addon
 * "Filmes, Series e Novelas Portuguesas Addon Stremio".
 *
 * Objetivo:
 * - quando o addon devolve externalUrl para uma página pública,
 *   tentar localizar um URL de media público diretamente reproduzível;
 * - nunca contornar DRM, autenticação, desafios anti-bot ou sessões privadas;
 * - se não existir um media URL público claro, preservar externalUrl.
 *
 * Este módulo é carregado com `node -r ... server.js` e só intercepta
 * as respostas /stream/... do provider abaixo. Todo o restante fetch
 * do PT•HUB passa sem qualquer alteração.
 */

const dns = require("dns").promises;
const net = require("net");

const TARGET_HOST = "filme-series-e-novelas-portuguesas.vercel.app";
const TARGET_STREAM_PATH = /^\/stream\/(?:movie|series)\//i;
const RESOLVE_TIMEOUT_MS = 9000;
const MAX_HTML_BYTES = 1_500_000;
const MAX_STREAMS_TO_RESOLVE = 12;

const originalFetch = global.fetch;

if (typeof originalFetch !== "function") {
  console.warn("PT•HUB Resolver PT: fetch global indisponível; resolver desativado.");
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
  const text = String(value || "").trim();
  return /\.(?:m3u8|mp4|m4v|webm|mpd)(?:$|[?#])/i.test(text);
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
  let value = decodeHtmlEntities(candidate)
    .trim()
    .replace(/^['\"]|['\"]$/g, "");

  if (!value) return "";

  try {
    return new URL(value, baseUrl).href;
  } catch {
    return "";
  }
}

function extractPlayableCandidates(html, baseUrl) {
  const text = decodeHtmlEntities(html);
  const candidates = new Set();

  const patterns = [
    /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|m4v|webm|mpd)(?:\?[^\s"'<>\\]*)?/gi,
    /(?:src|href|file|url|content)\s*[:=]\s*["']([^"']+?\.(?:m3u8|mp4|m4v|webm|mpd)(?:\?[^"']*)?)["']/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1] || match[0];
      const candidate = normalizeCandidate(raw, baseUrl);
      if (candidate && looksLikePlayableUrl(candidate)) {
        candidates.add(candidate);
      }
      if (candidates.size >= 8) break;
    }
    if (candidates.size >= 8) break;
  }

  return [...candidates];
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

async function resolveExternalUrl(externalUrl) {
  if (!(await isPublicHttpUrl(externalUrl))) return null;

  if (looksLikePlayableUrl(externalUrl)) {
    return {
      url: externalUrl,
      referer: ""
    };
  }

  let response;
  try {
    response = await fetchWithTimeout(externalUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,video/*;q=0.8,*/*;q=0.5",
        "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8"
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
    return {
      url: finalUrl,
      referer: externalUrl
    };
  }

  if (!/(?:text\/html|application\/json|text\/plain|javascript)/i.test(contentType)) {
    return null;
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_HTML_BYTES) return null;

  let body;
  try {
    body = await response.text();
  } catch {
    return null;
  }

  if (Buffer.byteLength(body, "utf8") > MAX_HTML_BYTES) return null;

  const candidates = extractPlayableCandidates(body, finalUrl);

  for (const candidate of candidates) {
    if (!(await isPublicHttpUrl(candidate))) continue;

    return {
      url: candidate,
      referer: finalUrl
    };
  }

  return null;
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
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36"
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
      `PT•HUB Resolver PT: ${resolvedCount}/${data.streams.length} stream(s) externo(s) convertido(s) para reprodução interna.`
    );
  } else {
    console.log(
      `PT•HUB Resolver PT: nenhum externalUrl convertível sem contornar proteção (${data.streams.length} stream(s)).`
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

  if (!response.ok) {
    return response;
  }

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
      "PT•HUB Resolver PT: falha ao resolver stream externo —",
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

console.log("PT•HUB Resolver PT: ativo para Filmes, Séries e Novelas Portuguesas.");
