import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const origin = "https://pt-hub.example";
const tokenFor = config => Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
const configuredFetch = (config, resource = "manifest.json") =>
  worker.fetch(new Request(`${origin}/${tokenFor(config)}/${resource}`), {}, { waitUntil() {} });

test("RTP Play live channels can be enabled without Portuguese films and series", async () => {
  const response = await configuredFetch({ features: { ptContentSources: { rtpPlay: true } } });
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.ok(manifest.catalogs.some(c => c.type === "channel" && c.id === "rtp-play"));
  assert.ok(manifest.resources.some(r => typeof r === "object" && r.name === "stream" &&
    r.types.includes("channel") && r.idPrefixes.includes("rtpplay:")));
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
