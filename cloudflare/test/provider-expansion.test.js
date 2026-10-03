import test from "node:test";
import assert from "node:assert/strict";
import { RTP_VOD_CATALOGS } from "../src/rtp-play.js";
import { TVI_VOD_CATALOGS } from "../src/tvi-player.js";
import { OPTO_VOD_CATALOGS } from "../src/opto.js";
import { JAMENDO_CATALOGS } from "../src/jamendo.js";
import { YOUTUBE_PUBLIC_CATALOGS } from "../src/youtube-public.js";
import { OFFICIAL_PROVIDER_CATALOGS } from "../src/official-providers.js";
import { STREAMERS } from "../src/catalog-engine.js";

test("RTP provider exposes separated hubs", () => {
  const ids = new Set(RTP_VOD_CATALOGS.map(x => x.id));
  assert.ok(ids.has("rtp-vod-series"));
  assert.ok(ids.has("rtp-vod-docs"));
  assert.ok(ids.has("rtp-vod-sports"));
  assert.ok(ids.has("rtp-sports-fit-em-casa"));
  assert.ok(ids.has("rtp-zigzag-programas"));
  assert.ok(ids.has("rtp-podcasts"));
  assert.ok(ids.has("rtp-vod-concerts"));
});

test("RTP routes special areas by media type", () => {
  assert.equal(RTP_VOD_CATALOGS.find(x => x.id === "rtp-vod-concerts")?.type, "music");
  assert.equal(RTP_VOD_CATALOGS.find(x => x.id === "rtp-podcasts")?.type, "podcast");
  assert.equal(RTP_VOD_CATALOGS.find(x => x.id === "rtp-zigzag-programas")?.type, "series");
});

test("TVI exposes program sections", () => {
  const ids = TVI_VOD_CATALOGS.map(x => x.id);
  assert.ok(ids.includes("tvi-vod-programas"));
  assert.ok(ids.includes("tvi-vod-novelas"));
  assert.ok(ids.includes("tvi-vod-reality"));
  assert.ok(ids.includes("tvi-vod-informacao"));
});

test("OPTO exposes Portuguese and podcast sections", () => {
  const ids = OPTO_VOD_CATALOGS.map(x => x.id);
  assert.ok(ids.includes("opto-vod-programas"));
  assert.ok(ids.includes("opto-vod-series"));
  assert.ok(ids.includes("opto-vod-novelas"));
  assert.ok(ids.includes("opto-vod-informacao"));
  assert.equal(OPTO_VOD_CATALOGS.find(x => x.id === "opto-podcasts")?.type, "podcast");
});

test("free music and YouTube providers are declared", () => {
  assert.ok(JAMENDO_CATALOGS.some(x => x.id === "jamendo-popular" && x.type === "music"));
  assert.ok(YOUTUBE_PUBLIC_CATALOGS.some(x => x.id === "youtube-music" && x.type === "music"));
  assert.ok(YOUTUBE_PUBLIC_CATALOGS.some(x => x.id === "youtube-podcasts" && x.type === "podcast"));
});

test("official provider hubs include sports, children and AVOD", () => {
  const ids = new Set(OFFICIAL_PROVIDER_CATALOGS.map(x => x.id));
  for (const id of [
    "official-panda-plus",
    "official-dazn",
    "official-fifa-plus",
    "official-sporttv",
    "official-canal11",
    "official-liga-portugal",
    "official-plex-free",
    "official-rakuten-free",
  ]) assert.ok(ids.has(id));
});

test("Player.pl is not exposed as generic Player", () => {
  const player = STREAMERS.find(x => x.id === "player");
  assert.equal(player?.name, "Player.pl");
  assert.deepEqual(player?.aliases, ["Player.pl"]);
});
