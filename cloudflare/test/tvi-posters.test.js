import test from "node:test";
import assert from "node:assert/strict";
import { getTviVodCatalog } from "../src/tvi-player.js";

test("TVI catalog recovers posters from current card and serialized metadata layouts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const target = typeof input === "string" ? input : input.url;
    assert.equal(target, "https://tviplayer.iol.pt/programas/tvi");
    return new Response(
      '<article class="program-card">' +
      '<picture><source srcset="https://static.iol.pt/tvi/a-madrasta-640.webp 640w, https://static.iol.pt/tvi/a-madrasta-1280.webp 1280w"></picture>' +
      '<a href="/programa/a-madrasta/abc123" aria-label="Aceder a: A Madrasta"><span>A Madrasta</span></a>' +
      '</article>' +
      '<script>window.cards=[{"path":"\\/programa\\/dois-as-10\\/def456","imageUrl":"https:\\/\\/static.iol.pt\\/tvi\\/dois-as-10.jpg"}]</script>' +
      '<a href="/programa/dois-as-10/def456" aria-label="Aceder a: Dois às 10">Dois às 10</a>',
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };
  try {
    const { metas } = await getTviVodCatalog("series", "tvi-vod-programas");
    assert.equal(metas.length, 2);
    const madrasta = metas.find(x => x.name === "A Madrasta");
    const dois = metas.find(x => x.name === "Dois às 10");
    assert.equal(madrasta?.poster, "https://static.iol.pt/tvi/a-madrasta-640.webp");
    assert.equal(madrasta?.background, madrasta.poster);
    assert.equal(dois?.poster, "https://static.iol.pt/tvi/dois-as-10.jpg");
    assert.equal(dois?.background, dois.poster);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
