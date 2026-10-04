const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createApplication, LocalKV } = require('../render-server.cjs');
process.env.PT_HUB_RTP_TEST_ONLY = '1';
test('root and configured manifests expose RTP VOD and operator catalogs without network/torrents', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw Error('Unexpected network'); };
  try {
    const app = await createApplication({ env: {} });
    const root = await (await app(new Request('https://pt-hub.test/manifest.json'))).json();
    assert(root.catalogs.some(x => x.id === 'rtp-vod-series'));
    assert(root.catalogs.some(x => x.id === 'rtp-vod-concerts'));
    assert(root.catalogs.some(x => x.id === 'meo'));
    const live = await (await app(new Request('https://pt-hub.test/catalog/channel/rtp-play.json'))).json();
    assert(live.metas.length > 0);
    const stream = await (await app(new Request('https://pt-hub.test/stream/movie/tt0133093.json'))).json();
    assert.deepEqual(stream, { streams: [] });
    const diag = await (await app(new Request('https://pt-hub.test/api/torrent-diagnostics'))).json();
    assert.equal(diag.disabled, true);
    const configured = Buffer.from(JSON.stringify({ features: { operators: true, selectedOperators: ['nos'] } })).toString('base64url');
    const manifest = await (await app(new Request('https://pt-hub.test/' + configured + '/manifest.json'))).json();
    assert(manifest.catalogs.some(x => x.id === 'nos'));
    assert(!manifest.catalogs.some(x => x.id === 'rtp-vod-series'));
    assert.equal(calls, 0);
  } finally { global.fetch = original; }
});
test('Node storage supports upload values, TTL, JSON, and deletion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pt-hub-test-'));
  try {
    const kv = new LocalKV(directory);
    await kv.put('key', '{"ok":true}', { expirationTtl: 60 });
    assert.deepEqual(await kv.get('key', 'json'), { ok: true });
    await kv.delete('key');
    assert.equal(await kv.get('key'), null);
    await kv.put('expired', 'value', { expirationTtl: -1 });
    assert.equal(await kv.get('expired'), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
