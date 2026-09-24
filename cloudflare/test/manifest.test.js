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
