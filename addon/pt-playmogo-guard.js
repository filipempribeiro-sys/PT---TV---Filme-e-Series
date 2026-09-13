"use strict";

/*
 * PT•HUB — Guard para hosts externos com reprodução própria/ad-supported.
 *
 * Objetivo:
 * - impedir que o resolver PT tente converter páginas Playmogo em streams
 *   internos e acabe por apanhar apenas assets publicitários/prerolls;
 * - preservar o externalUrl original do addon;
 * - não extrair, contornar ou reconstruir a reprodução do host externo.
 *
 * Este módulo deve ser carregado ANTES de pt-external-player-resolver.js.
 */

const BLOCKED_RESOLVER_HOSTS = new Set([
  "playmogo.com",
  "www.playmogo.com"
]);

const previousFetch = global.fetch;

if (typeof previousFetch !== "function") {
  console.warn("PT•HUB Playmogo Guard: fetch global indisponível; guard desativado.");
  return;
}

function isBlockedResolverHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    BLOCKED_RESOLVER_HOSTS.has(host) ||
    host.endsWith(".playmogo.com")
  );
}

global.fetch = async function ptHubPlaymogoGuard(input, init) {
  const requestUrl =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : String(input?.url || "");

  let parsed;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return previousFetch(input, init);
  }

  if (isBlockedResolverHost(parsed.hostname)) {
    console.log(
      `PT•HUB Playmogo Guard: resolução interna ignorada para ${parsed.hostname}; externalUrl será preservado.`
    );

    return new Response("External playback preserved", {
      status: 403,
      statusText: "External playback preserved",
      headers: {
        "content-type": "text/plain; charset=utf-8"
      }
    });
  }

  return previousFetch(input, init);
};

console.log("PT•HUB Playmogo Guard: ativo — Playmogo permanece em reprodução externa.");
