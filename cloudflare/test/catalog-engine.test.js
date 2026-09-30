import test from "node:test";
import assert from "node:assert/strict";
import {
  STREAMERS,
  normalizeCatalogCountries,
  configuredCountries,
  mergeCatalogMetas,
  parseTop10CatalogId,
  providerTargets
} from "../src/catalog-engine.js";

test("streamer registry is substantially expanded", () => {
  assert.ok(STREAMERS.length >= 40);
  for (const id of ["netflix","hbomax","prime-video","disney-plus","apple-tv-plus","skyshowtime","paramount-plus","crunchyroll","mubi","filmin","globoplay","hulu","peacock","starz","discovery-plus","britbox","rakuten-tv","plex","pluto-tv","tubi"]) {
    assert.ok(STREAMERS.some(item => item.id === id), id);
  }
});

test("multi-country supports one, many and ALL", () => {
  assert.deepEqual(normalizeCatalogCountries("PT"), ["PT"]);
  assert.deepEqual(normalizeCatalogCountries(["PT","ES","PT"]), ["PT","ES"]);
  assert.deepEqual(normalizeCatalogCountries(["ALL"]), ["PT","ES","FR","GB","US","BR"]);
});

test("configuredCountries preserves legacy catalogCountry", () => {
  assert.equal(configuredCountries({catalogCountry:"PT"}), "PT");
  assert.deepEqual(configuredCountries({catalogCountries:["PT","ES"]}), ["PT","ES"]);
});

test("catalog merge deduplicates IDs", () => {
  const result=mergeCatalogMetas([
    {metas:[{id:"tt1",name:"A"},{id:"tt2",name:"B"}]},
    {metas:[{id:"tt1",name:"A duplicate"},{id:"tt3",name:"C"}]}
  ]);
  assert.deepEqual(result.metas.map(x=>x.id), ["tt1","tt2","tt3"]);
});

test("Top10 catalog IDs round-trip", () => {
  assert.deepEqual(parseTop10CatalogId("top10--netflix--PT"), {streamerId:"netflix",country:"PT"});
  assert.equal(parseTop10CatalogId("netflix"), null);
});

test("provider aliases are normalized", () => {
  const prime=providerTargets("prime-video");
  assert.ok(prime.includes("amazonprimevideo"));
  assert.ok(prime.includes("primevideo"));
});
