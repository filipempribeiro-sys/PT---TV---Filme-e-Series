import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import worker from "../src/index.js";
import { STREAMERS } from "../src/catalog-engine.js";

const origin = "https://pt-hub.example";
const tokenFor = config => Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
const configuredFetch = (config, resource = "manifest.json") =>
  worker.fetch(new Request(`${origin}/${tokenFor(config)}/${resource}`), {}, { waitUntil() {} });

const STREAMER_IDS = new Set(STREAMERS.map(streamer => streamer.id));

test("clean install has a new identity and no implicit streamer selections", async () => {
  const response = await worker.fetch(new Request(origin + "/manifest.json"), {}, { waitUntil() {} });
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.equal(manifest.id, "pt.filipe.nuvio.tvhub.clean");
  assert.equal(manifest.version, "4.1.0");
  assert.equal(manifest.catalogs.some(c => STREAMER_IDS.has(c.id)), false);

  const configured = await configuredFetch({ features: { streamers: true } });
  const configuredManifest = await configured.json();
  assert.equal(configuredManifest.catalogs.some(c => STREAMER_IDS.has(c.id)), false);
  assert.equal(configuredManifest.catalogs.some(c => c.id === "pthub-search" || c.id.startsWith("top10--")), false);
});

test("TVI Player stays an optional official VOD catalog, never a streamer", async () => {
  const response = await configuredFetch({ features: {
    streamers: true,
    selectedStreamerMovies: ["tvi-player", "netflix"],
    selectedStreamerSeries: ["tvi-player"],
    ptContentSources: { tviPlayer: true },
  } });
  const manifest = await response.json();
  assert.ok(manifest.catalogs.some(c => c.type === "movie" && c.id === "netflix"));
  assert.ok(!manifest.catalogs.some(c => c.id === "tvi-player"));
  assert.ok(manifest.catalogs.some(c => c.type === "series" && c.id.startsWith("tvi-vod-")));

  const page = await worker.fetch(new Request(origin + "/configure"), {}, { waitUntil() {} });
  const html = await page.text();
  assert.match(html, /VOD OFICIAL/);
  assert.match(html, /não é streamer externo/);
  assert.doesNotMatch(html, /TVI Player <span class=\\\"freeBadge\\\">ATIVO/);
});

test("new config tokens use c3 while old c2 install links remain readable", async () => {
  const saved = await worker.fetch(new Request(origin + "/config-store", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ features: { streamers: true, selectedStreamerMovies: ["netflix"] } }),
  }), {}, { waitUntil() {} });
  const payload = await saved.json();
  assert.equal(saved.status, 200);
  assert.match(payload.token, /^c3_/);

  const oldConfig = { features: { streamers: true, selectedStreamerMovies: ["netflix"] } };
  const oldToken = "c2_" + deflateRawSync(Buffer.from(JSON.stringify(oldConfig))).toString("base64url");
  const oldManifest = await worker.fetch(new Request(origin + "/" + oldToken + "/manifest.json"), {}, { waitUntil() {} });
  assert.equal(oldManifest.status, 200);
  assert.ok((await oldManifest.json()).catalogs.some(c => c.type === "movie" && c.id === "netflix"));
});


test("RTP Play live and VOD catalogs can be enabled without Portuguese films and series", async () => {
  const response = await configuredFetch({ features: { ptContentSources: { rtpPlay: true } } });
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.ok(manifest.catalogs.some(c => c.type === "channel" && c.id === "rtp-play"));
  assert.ok(manifest.catalogs.some(c => c.type === "series" && c.id === "rtp-vod-series"));
  assert.ok(manifest.catalogs.some(c => c.type === "series" && c.id === "rtp-vod-docs"));
  assert.ok(manifest.catalogs.some(c => c.type === "movie" && c.id === "rtp-vod-concerts"));
  assert.ok(manifest.resources.some(r => typeof r === "object" && r.name === "stream" &&
    r.types.includes("channel") && r.idPrefixes.includes("rtpplay:") && r.idPrefixes.includes("rtpvod:")));
});

test("IPTV installs under channel catalogs and does not enable RTP Play", async () => {
  const response = await configuredFetch({ features: { iptv: true }, mode: "m3u", m3uSource: "url",
    m3uUrl: "https://example.org/authorized.m3u" });
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.ok(manifest.catalogs.some(c => c.type === "channel" && c.id === "m3u"));
  assert.ok(!manifest.catalogs.some(c => c.id === "rtp-play"));
});

test("RTP Play stream route returns a playable source descriptor without fetching a provider", async () => {
  const response = await configuredFetch({ features: { ptContentSources: { rtpPlay: true } } },
    "stream/channel/rtpplay%3Artp1.json");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.streams?.length > 0);
  assert.match(body.streams[0].url, /^https:\/\/pt-hub\.example\/hls-proxy\/rtp\//);
});


test("extensionless M3U channel URLs still use the PT-HUB HLS proxy", async () => {
  const config = {
    features: { iptv: true },
    mode: "m3u",
    m3uSource: "url",
    m3uUrl: "https://playlist.example/authorized.m3u",
  };
  const streamUrl = "https://media.example/live/channel123?auth=test";
  const source = globalThis.fetch;
  let playlistReads = 0;
  globalThis.fetch = async input => {
    const target = typeof input === "string" ? input : input.url;
    if (target === config.m3uUrl) {
      playlistReads++;
      return new Response(
        '#EXTM3U\n#EXTINF:-1 tvg-id="demo" tvg-logo="https://logo.example/demo.png",Demo\n' +
        streamUrl + "\n",
        { headers: { "Content-Type": "application/x-mpegurl" } },
      );
    }
    if (target.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ tree: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("Unexpected mock request to " + new URL(target).origin);
  };
  try {
    const catalogResponse = await configuredFetch(config, "catalog/channel/m3u.json");
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.metas.length, 1);
    const streamsResponse = await configuredFetch(
      config, "stream/channel/" + encodeURIComponent(catalog.metas[0].id) + ".json",
    );
    assert.equal(streamsResponse.status, 200);
    const streams = (await streamsResponse.json()).streams;
    assert.equal(streams.length, 1);
    const proxied = new URL(streams[0].url);
    assert.equal(proxied.origin, origin);
    assert.match(proxied.pathname, new RegExp(
      "^/" + tokenFor(config) + "/hls-proxy/generic/",
    ));
    assert.equal(Buffer.from(proxied.pathname.split("/").at(-1), "base64url").toString(), streamUrl);
    assert.ok(playlistReads >= 2, "catalog and stream requests must load the M3U source");
  } finally {
    globalThis.fetch = source;
  }
});

test("opaque octet-stream HLS playlists rewrite segments and key URLs", async () => {
  const config = { mode: "m3u", globalUserAgent: "MEDIA-HUB-Test/1.0" };
  const token = tokenFor(config);
  const sourceUrl = "https://media.example/live/channel123?auth=test";
  const channelHeaders = { referrer: "https://media.example/app" };
  const encodedHeaders = Buffer.from(JSON.stringify(channelHeaders), "utf8").toString("base64url");
  const proxyUrl = origin + "/" + token + "/hls-proxy/generic/" +
    Buffer.from(sourceUrl, "utf8").toString("base64url") + "?ch=" +
    encodeURIComponent(encodedHeaders);
  const source = globalThis.fetch;
  globalThis.fetch = async (target, options) => {
    assert.equal(target, sourceUrl);
    assert.equal(options.headers["User-Agent"], config.globalUserAgent);
    assert.equal(options.headers.Referer, channelHeaders.referrer);
    return new Response(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n' +
      '#EXTINF:6,\nsegment001.ts\n#EXT-X-ENDLIST\n',
      { headers: { "Content-Type": "application/octet-stream" } },
    );
  };
  try {
    const response = await worker.fetch(
      new Request(proxyUrl), {}, { waitUntil() {} },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /mpegurl/);
    const playlist = await response.text();
    const expectedRoot = origin + "/" + token + "/hls-proxy/generic/";
    assert.ok(playlist.includes(expectedRoot +
      Buffer.from("https://media.example/live/segment001.ts", "utf8").toString("base64url")));
    assert.ok(playlist.includes(expectedRoot +
      Buffer.from("https://media.example/live/key.bin", "utf8").toString("base64url")));
    assert.ok(playlist.includes("ch=" + encodeURIComponent(encodedHeaders)));
  } finally {
    globalThis.fetch = source;
  }
});

test("opaque non-HLS live media begins streaming before the source closes", async () => {
  const sourceUrl = "https://media.example/live/continuous";
  const proxyUrl = origin + "/hls-proxy/generic/" +
    Buffer.from(sourceUrl, "utf8").toString("base64url");
  const source = globalThis.fetch;
  let inputController;
  let timer;
  globalThis.fetch = async target => {
    assert.equal(target, sourceUrl);
    return new Response(new ReadableStream({
      start(controller) {
        inputController = controller;
        controller.enqueue(Uint8Array.from([0x47, 0x01, 0x02, 0x03]));
        // Intentionally leave the upstream response open like a live channel.
      },
    }), { headers: { "Content-Type": "application/octet-stream" } });
  };
  try {
    const response = await Promise.race([
      worker.fetch(new Request(proxyUrl), {}, { waitUntil() {} }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Proxy waited for the live stream to end")), 1000);
      }),
    ]);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.deepEqual([...first.value], [0x47, 0x01, 0x02, 0x03]);
    await reader.cancel();
  } finally {
    clearTimeout(timer);
    try { inputController?.close(); } catch {}
    globalThis.fetch = source;
  }
});


test("M3U TS channel descriptors keep progressive media type through the proxy", async () => {
  const sourceUrl = "https://media.example/live/channel001.ts";
  const config = {
    features: { iptv: true }, mode: "m3u", m3uSource: "file",
    m3uFileData: '#EXTM3U\n#EXTINF:-1 tvg-id="ts-1",Transport Stream\n' + sourceUrl + "\n",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async target => {
    if (String(target).startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ tree: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("Unexpected mock network request");
  };
  try {
    const catalog = await (await configuredFetch(config, "catalog/channel/m3u.json")).json();
    assert.equal(catalog.metas.length, 1);
    const response = await configuredFetch(
      config, "stream/channel/" + encodeURIComponent(catalog.metas[0].id) + ".json",
    );
    const streams = (await response.json()).streams;
    assert.equal(streams.length, 1);
    assert.equal(streams[0].type, "mpegts");
    assert.match(streams[0].url, /\/hls-proxy\/generic\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DASH streams remain direct and retain M3U request headers", async () => {
  const sourceUrl = "https://media.example/manifest.mpd";
  const config = {
    features: { iptv: true }, mode: "m3u", m3uSource: "file",
    m3uFileData:
      '#EXTM3U\n#EXTINF:-1 tvg-id="dash-1",DASH\n' +
      '#EXTVLCOPT:http-user-agent=MEDIA-HUB-Test/1.0\n' +
      '#EXTVLCOPT:http-referrer=https://media.example/app\n' +
      sourceUrl + "\n",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async target => {
    if (String(target).startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ tree: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("Unexpected mock network request");
  };
  try {
    const catalog = await (await configuredFetch(config, "catalog/channel/m3u.json")).json();
    assert.equal(catalog.metas.length, 1);
    const response = await configuredFetch(
      config, "stream/channel/" + encodeURIComponent(catalog.metas[0].id) + ".json",
    );
    const streams = (await response.json()).streams;
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, sourceUrl);
    assert.equal(streams[0].type, "dash");
    assert.deepEqual(streams[0].behaviorHints.proxyHeaders.request, {
      "User-Agent": "MEDIA-HUB-Test/1.0",
      Referer: "https://media.example/app",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("ordinary M3U channels return direct HLS first with a proxy backup", async () => {
  const sourceUrl = "https://media.example/live/channel001.m3u8?key=example";
  const config = {
    features: { iptv: true }, mode: "m3u", m3uSource: "file",
    m3uFileData: '#EXTM3U\n#EXTINF:-1 tvg-id="hls-1",HLS\n' + sourceUrl + "\n",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async target => {
    if (String(target).startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ tree: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("Unexpected mock network request");
  };
  try {
    const catalog = await (await configuredFetch(config, "catalog/channel/m3u.json")).json();
    assert.equal(catalog.metas.length, 1);
    const response = await configuredFetch(
      config, "stream/channel/" + encodeURIComponent(catalog.metas[0].id) + ".json",
    );
    const streams = (await response.json()).streams;
    assert.equal(streams.length, 2);
    assert.equal(streams[0].name, "PT•HUB • Direto");
    assert.equal(streams[0].type, "hls");
    assert.equal(streams[0].url, sourceUrl);
    assert.equal(streams[1].name, "PT•HUB • Proxy");
    assert.equal(streams[1].type, "hls");
    assert.match(streams[1].url, /\/hls-proxy\/generic\//);
    assert.equal(Buffer.from(new URL(streams[1].url).pathname.split("/").at(-1),
      "base64url").toString(), sourceUrl);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("M3U HLS with custom User-Agent stays proxy-first and preserves that header", async () => {
  const sourceUrl = "https://media.example/live/protected.m3u8";
  const config = {
    features: { iptv: true }, mode: "m3u", m3uSource: "file",
    globalUserAgent: "Authorized-Player/1.0",
    m3uFileData: '#EXTM3U\n#EXTINF:-1 tvg-id="hls-2",Protected HLS\n' +
      sourceUrl + "\n",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async target => {
    if (String(target).startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ tree: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("Unexpected mock network request");
  };
  try {
    const catalog = await (await configuredFetch(config, "catalog/channel/m3u.json")).json();
    assert.equal(catalog.metas.length, 1);
    const response = await configuredFetch(
      config, "stream/channel/" + encodeURIComponent(catalog.metas[0].id) + ".json",
    );
    const streams = (await response.json()).streams;
    assert.equal(streams.length, 2);
    assert.equal(streams[0].name, "PT•HUB • Proxy");
    assert.equal(streams[0].type, "hls");
    assert.match(streams[0].url, /\/hls-proxy\/generic\//);
    assert.equal(streams[1].name, "PT•HUB • Direto");
    assert.equal(streams[1].url, sourceUrl);
    assert.equal(streams[1].type, "hls");
    assert.deepEqual(streams[1].behaviorHints.proxyHeaders.request, {
      "User-Agent": config.globalUserAgent,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("safe IPTV diagnostic observes playlist, variant and first segment without leaking URLs", async () => {
  const playlistUrl = "https://media.example/live/master.m3u8?private=fixture-secret";
  const variantUrl = "https://media.example/live/variant.m3u8?private=fixture-secret";
  const segmentUrl = "https://media.example/live/segment00001.ts?private=fixture-secret";
  const config = {
    features: { iptv: true }, mode: "m3u", m3uSource: "file",
    m3uFileData: '#EXTM3U\n#EXTINF:-1 tvg-logo="https://logo.example/channel.png",Diagnostic\n' +
      playlistUrl + "\n",
  };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (target,options) => {
    const requested = String(target);
    requests.push(requested);
    if (requested.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ tree: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (requested === playlistUrl) {
      assert.equal(options.headers["User-Agent"], "Mozilla/5.0 (PT-HUB HLS Engine)");
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n' +
        "variant.m3u8?private=fixture-secret\n", {
          headers: { "Content-Type": "application/vnd.apple.mpegurl" },
        });
    }
    if (requested === variantUrl) {
      return new Response('#EXTM3U\n#EXTINF:6.0,\nsegment00001.ts?private=fixture-secret\n', {
        headers: { "Content-Type": "application/vnd.apple.mpegurl" },
      });
    }
    if (requested === segmentUrl) {
      return new Response(Uint8Array.from([0x47, 0x11, 0x22, 0x33]), {
        headers: { "Content-Type": "video/MP2T" },
      });
    }
    throw new Error("Unexpected diagnostic host");
  };
  try {
    const response = await configuredFetch(config, "iptv-diagnostic.json?index=0");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.channelIndex, 0);
    assert.deepEqual(data.stages.map(stage => stage.stage),
      ["playlist", "variant", "segment"]);
    assert.ok(data.stages.every(stage => stage.status === 200 && stage.ok));
    assert.equal(data.stages[2].hasData, true);
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes("fixture-secret"));
    assert.ok(!serialized.includes("media.example"));
    assert.ok(!serialized.includes(tokenFor(config)));
    assert.ok(requests.includes(segmentUrl));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("safe IPTV diagnostic reports origin HTTP failure without exposing source", async () => {
  const playlistUrl = "https://media.example/blocked.m3u8?private=fixture-secret";
  const config = {
    features: { iptv: true }, mode: "m3u", m3uSource: "file",
    m3uFileData: '#EXTM3U\n#EXTINF:-1 tvg-logo="https://logo.example/channel.png",Blocked\n' +
      playlistUrl + "\n",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async target => {
    if (String(target).startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ tree: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    assert.equal(target, playlistUrl);
    return new Response("Denied", { status: 403 });
  };
  try {
    const response = await configuredFetch(config, "iptv-diagnostic.json?index=0");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, false);
    assert.equal(data.stages[0].status, 403);
    assert.equal(data.stages.length, 1);
    assert.ok(!JSON.stringify(data).includes("fixture-secret"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streamer configuration exposes expanded services, multi-country and discovery controls", async () => {
  const response = await worker.fetch(
    new Request(origin + "/configure"), {}, { waitUntil() {} },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-streamer="skyshowtime"/);
  assert.match(html, /data-streamer="paramount-plus"/);
  assert.match(html, /data-streamer="crunchyroll"/);
  assert.match(html, /data-catalog-country="ALL"/);
  assert.match(html, /data-catalog-country="PT"/);
  assert.match(html, /data-catalog-country="ES"/);
  assert.match(html, /streamerTop10Preview/);
  assert.match(html, /streamerMultiSearchPreview/);
});

test("configured streamer manifest supports multiple countries, top 10 and multi-source search", async () => {
  const config = {
    catalogCountries: ["PT", "ES"],
    catalogCountry: "PT",
    features: {
      streamers: true,
      streamerTop10: true,
      streamerMultiSearch: true,
      selectedStreamerMovies: ["netflix", "skyshowtime"],
      selectedStreamerSeries: ["netflix", "skyshowtime"],
    },
  };
  const response = await configuredFetch(config);
  assert.equal(response.status, 200);
  const body = await response.json();
  const ids = new Set(body.catalogs.map(c => c.type + ":" + c.id));
  assert.ok(ids.has("movie:netflix"));
  assert.ok(ids.has("series:skyshowtime"));
  assert.ok(ids.has("movie:pthub-search"));
  assert.ok(ids.has("series:pthub-search"));
  assert.ok(ids.has("movie:top10--netflix--PT"));
  assert.ok(ids.has("movie:top10--netflix--ES"));
  assert.ok(ids.has("series:top10--skyshowtime--PT"));
  assert.ok(ids.has("series:top10--skyshowtime--ES"));
});

test("Todos expands to every configured PT HUB streamer country in Top 10 catalogs", async () => {
  const config = {
    catalogCountries: ["ALL"],
    catalogCountry: "ALL",
    features: {
      streamers: true,
      streamerTop10: true,
      streamerMultiSearch: false,
      selectedStreamerMovies: ["netflix"],
      selectedStreamerSeries: [],
    },
  };
  const response = await configuredFetch(config);
  assert.equal(response.status, 200);
  const body = await response.json();
  const topIds = body.catalogs
    .filter(c => c.type === "movie" && c.id.startsWith("top10--netflix--"))
    .map(c => c.id)
    .sort();
  assert.deepEqual(topIds, [
    "top10--netflix--BR",
    "top10--netflix--ES",
    "top10--netflix--FR",
    "top10--netflix--GB",
    "top10--netflix--PT",
    "top10--netflix--US",
  ]);
});



test("configured manifest exposes compact AGORA catalogs without catalog explosion", async () => {
  const config = {
    catalogCountries: ["PT"],
    catalogCountry: "PT",
    features: {
      featured: true,
      featuredContent: { movies: true, series: true },
      streamers: true,
      streamerTop10: false,
      streamerMultiSearch: false,
      selectedStreamerMovies: ["netflix"],
      selectedStreamerSeries: ["netflix"],
      iptv: true,
    },
    mode: "m3u",
    m3uSource: "url",
    m3uUrl: "https://example.org/authorized.m3u",
  };
  const response = await configuredFetch(config);
  assert.equal(response.status, 200);
  const body = await response.json();
  const ids = new Set(body.catalogs.map(c => c.type + ":" + c.id));
  assert.ok(ids.has("movie:now-top10"));
  assert.ok(ids.has("movie:now-cinema"));
  assert.ok(ids.has("movie:now-arrivals"));
  assert.ok(ids.has("movie:now-week"));
  assert.ok(ids.has("channel:tv-now"));
});


test("RTP Palco public concert catalog exposes meta and official playback link", async () => {
  const config = { features: { ptContentSources: { rtpPlay: true } } };
  const source = globalThis.fetch;
  globalThis.fetch = async input => {
    const target = typeof input === "string" ? input : input.url;
    if (target === "https://www.rtp.pt/play/palco/colecao/concertos") {
      return new Response(
        '<a href="/play/palco/p15328/xutos-e-pontapes-ao-vivo-45-anos-ola-vida-malvada">' +
        '<img src="https://cdn-images.rtp.pt/test/xutos.jpg" alt="Xutos &amp; Pontapés ao Vivo 45 Anos - Olá Vida Malvada"></a>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (target === "https://www.rtp.pt/play/palco/p15328/xutos-e-pontapes-ao-vivo-45-anos-ola-vida-malvada") {
      return new Response(
        '<html><head><meta property="og:title" content="Xutos &amp; Pontapés ao Vivo 45 Anos - Olá Vida Malvada">' +
        '<meta property="og:description" content="Concerto RTP Palco">' +
        '<meta property="og:image" content="https://cdn-images.rtp.pt/test/xutos-detail.jpg"></head></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    throw new Error("Unexpected mock request: " + target);
  };
  try {
    const catalogResponse = await configuredFetch(config, "catalog/movie/rtp-vod-concerts.json");
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.metas.length, 1);
    assert.equal(catalog.metas[0].name, "Xutos & Pontapés ao Vivo 45 Anos - Olá Vida Malvada");
    assert.match(catalog.metas[0].id, /^rtpvod:/);
    const encodedId = encodeURIComponent(catalog.metas[0].id);
    const metaResponse = await configuredFetch(config, "meta/movie/" + encodedId + ".json");
    assert.equal(metaResponse.status, 200);
    const meta = (await metaResponse.json()).meta;
    assert.equal(meta.name, "Xutos & Pontapés ao Vivo 45 Anos - Olá Vida Malvada");
    assert.equal(meta.description, "Concerto RTP Palco");
    const streamResponse = await configuredFetch(config, "stream/movie/" + encodedId + ".json");
    assert.equal(streamResponse.status, 200);
    const streams = (await streamResponse.json()).streams;
    assert.equal(streams.length, 1);
    assert.equal(streams[0].externalUrl, "https://www.rtp.pt/play/palco/p15328/xutos-e-pontapes-ao-vivo-45-anos-ola-vida-malvada");
  } finally {
    globalThis.fetch = source;
  }
});


test("TVI Player public VOD catalog exposes programs and episode playback links", async () => {
  const config = { features: { ptContent: true, ptContentSources: { tviPlayer: true } } };
  const source = globalThis.fetch;
  globalThis.fetch = async input => {
    const target = typeof input === "string" ? input : input.url;
    if (target === "https://tviplayer.iol.pt/programas/tvi") {
      return new Response(
        '<a href="/programa/o-beijo-do-escorpiao/6989b284d34e92a344989887">' +
        '<img src="https://tviplayer.iol.pt/img/beijo.jpg" alt="O Beijo do Escorpião"></a>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (target === "https://tviplayer.iol.pt/programa/o-beijo-do-escorpiao/6989b284d34e92a344989887") {
      return new Response(
        '<html><head><meta property="og:title" content="O Beijo do Escorpião">' +
        '<meta property="og:description" content="Novela TVI">' +
        '<meta property="og:image" content="https://tviplayer.iol.pt/img/beijo-detail.jpg"></head><body>' +
        '<a href="/programa/o-beijo-do-escorpiao/6989b284d34e92a344989887/video/abc123">' +
        '<img alt="Episódio 1" src="https://tviplayer.iol.pt/img/e1.jpg"></a></body></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    throw new Error("Unexpected mock request: " + target);
  };
  try {
    const manifestResponse = await configuredFetch(config, "manifest.json");
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.ok(manifest.catalogs.some(c => c.type === "series" && c.id === "tvi-vod-programas"));

    const catalogResponse = await configuredFetch(config, "catalog/series/tvi-vod-programas.json");
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.metas.length, 1);
    assert.equal(catalog.metas[0].name, "O Beijo do Escorpião");
    assert.match(catalog.metas[0].id, /^tvivod:/);

    const metaResponse = await configuredFetch(config, "meta/series/" + encodeURIComponent(catalog.metas[0].id) + ".json");
    assert.equal(metaResponse.status, 200);
    const meta = (await metaResponse.json()).meta;
    assert.equal(meta.name, "O Beijo do Escorpião");
    assert.equal(meta.videos.length, 1);
    assert.equal(meta.videos[0].title, "Episódio 1");

    const streamResponse = await configuredFetch(config, "stream/series/" + encodeURIComponent(meta.videos[0].id) + ".json");
    assert.equal(streamResponse.status, 200);
    const streams = (await streamResponse.json()).streams;
    assert.equal(streams.length, 1);
    assert.equal(streams[0].externalUrl,
      "https://tviplayer.iol.pt/programa/o-beijo-do-escorpiao/6989b284d34e92a344989887/video/abc123");
  } finally {
    globalThis.fetch = source;
  }
});


test("RTP VOD cleans accessibility labels, decodes PT entities, exposes episodes and prefers public HLS", async () => {
  const config = { features: { ptContentSources: { rtpPlay: true } } };
  const source = globalThis.fetch;
  globalThis.fetch = async input => {
    const target = typeof input === "string" ? input : input.url;
    if (target === "https://www.rtp.pt/play/hub/series") {
      return new Response(
        '<a href="/play/p15493/a-febre" aria-label="Aceder a: A Febre">' +
        '<img data-src="https://cdn-images.rtp.pt/a-febre.jpg" alt="Aceder a: A Febre"></a>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (target === "https://www.rtp.pt/play/p15493/a-febre") {
      return new Response(
        '<html><head><meta property="og:title" content="A Febre">' +
        '<meta property="og:description" content="Thriller pol&amp;iacute;tico"></head><body>' +
        '<a href="/play/p15493/e956396/a-febre">Ep. 1</a>' +
        '<script>window.media={"file":"https:\\/\\/streaming.rtp.pt\\/vod\\/a-febre\\/master.m3u8"}</script>' +
        '</body></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (target === "https://www.rtp.pt/play/p15493/e956396/a-febre") {
      return new Response(
        '<html><script>var player={"src":"https:\\/\\/streaming.rtp.pt\\/vod\\/a-febre\\/e956396.m3u8"}</script></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    throw new Error("Unexpected mock request: " + target);
  };
  try {
    const catalogResponse = await configuredFetch(config, "catalog/series/rtp-vod-series.json");
    const catalog = await catalogResponse.json();
    assert.equal(catalog.metas[0].name, "A Febre");
    assert.equal(catalog.metas[0].poster, "https://cdn-images.rtp.pt/a-febre.jpg");

    const id = encodeURIComponent(catalog.metas[0].id);
    const metaResponse = await configuredFetch(config, "meta/series/" + id + ".json");
    const meta = (await metaResponse.json()).meta;
    assert.equal(meta.name, "A Febre");
    assert.equal(meta.description, "Thriller político");
    assert.equal(meta.videos.length, 1);
    assert.match(meta.videos[0].id, /^rtpvod:/);

    const streamResponse = await configuredFetch(config, "stream/series/" + encodeURIComponent(meta.videos[0].id) + ".json");
    const streams = (await streamResponse.json()).streams;
    assert.equal(streams[0].url, "https://streaming.rtp.pt/vod/a-febre/e956396.m3u8");
    assert.equal(streams[0].externalUrl, undefined);
  } finally {
    globalThis.fetch = source;
  }
});


test("TVI Player cleans labels, keeps lazy posters, decodes entities and prefers public HLS", async () => {
  const config = { features: { ptContent: true, ptContentSources: { tviPlayer: true } } };
  const source = globalThis.fetch;
  globalThis.fetch = async input => {
    const target = typeof input === "string" ? input : input.url;
    if (target === "https://tviplayer.iol.pt/programas/tvi") {
      return new Response(
        '<a href="/programa/o-beijo-do-escorpiao/6989b284d34e92a344989887" aria-label="Aceder a: O Beijo do Escorpião">' +
        '<img data-srcset="https://tviplayer.iol.pt/img/beijo-600.jpg 600w, https://tviplayer.iol.pt/img/beijo-1200.jpg 1200w" alt="Aceder a: O Beijo do Escorpião"></a>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (target === "https://tviplayer.iol.pt/programa/o-beijo-do-escorpiao/6989b284d34e92a344989887") {
      return new Response(
        '<html><head><meta property="og:title" content="O Beijo do Escorpião">' +
        '<meta property="og:description" content="Produ&ccedil;&atilde;o portuguesa">' +
        '<meta property="og:image" content="https://tviplayer.iol.pt/img/beijo-detail.jpg"></head><body>' +
        '<a href="/programa/o-beijo-do-escorpiao/6989b284d34e92a344989887/video/abc123">Episódio 1</a></body></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    if (target === "https://tviplayer.iol.pt/programa/o-beijo-do-escorpiao/6989b284d34e92a344989887/video/abc123") {
      return new Response(
        '<html><script>window.player={"playbackUrl":"https:\\/\\/video.iol.pt\\/vod\\/abc123\\/master.m3u8"}</script></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    throw new Error("Unexpected mock request: " + target);
  };
  try {
    const catalogResponse = await configuredFetch(config, "catalog/series/tvi-vod-programas.json");
    const catalog = await catalogResponse.json();
    assert.equal(catalog.metas[0].name, "O Beijo do Escorpião");
    assert.equal(catalog.metas[0].poster, "https://tviplayer.iol.pt/img/beijo-600.jpg");

    const id = encodeURIComponent(catalog.metas[0].id);
    const metaResponse = await configuredFetch(config, "meta/series/" + id + ".json");
    const meta = (await metaResponse.json()).meta;
    assert.equal(meta.description, "Produção portuguesa");
    assert.equal(meta.videos.length, 1);

    const streamResponse = await configuredFetch(config, "stream/series/" + encodeURIComponent(meta.videos[0].id) + ".json");
    const streams = (await streamResponse.json()).streams;
    assert.equal(streams[0].url, "https://video.iol.pt/vod/abc123/master.m3u8");
    assert.equal(streams[0].externalUrl, undefined);
  } finally {
    globalThis.fetch = source;
  }
});
