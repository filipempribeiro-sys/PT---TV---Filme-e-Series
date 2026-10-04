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
test('Render RTP stream endpoint opens official page without mobile authentication', async () => {
  const originalFetch = global.fetch;
  const id = 'rtpvod:' + Buffer.from('/play/p15328/e867644/xutos').toString('base64url');
  process.env.PT_HUB_RTP_INTERNAL_ONLY = '1';
  let calls = 0;
  global.fetch = async () => { calls++; throw Error('Unexpected network'); };
  try {
    const app = await createApplication({ env: {}, client: { getEpisode() { throw Error('Mobile API must not run'); } } });
    const response = await app(new Request('https://pt-hub.test/stream/music/'+id+'.json'));
    assert.equal(response.status, 200);
    const { streams } = await response.json();
    assert.equal(streams.length, 1);
    assert.equal(streams[0].externalUrl, 'https://www.rtp.pt/play/p15328/e867644/xutos');
    assert.equal(streams[0].url, undefined);
    assert.equal(calls, 0);
  } finally { global.fetch = originalFetch; delete process.env.PT_HUB_RTP_INTERNAL_ONLY; }
});
test('RTP API bridge permits signed official API calls and rejects arbitrary targets', async () => {
  const worker = (await import('../../cloudflare/src/index.js')).default;
  const original = global.fetch;
  const seen = [];
  global.fetch = async (target, options) => { seen.push({ target: String(target), options }); return new Response('{"token":{"token":"test-token"}}', { headers: { 'content-type':'application/json' } }); };
  const post = data => worker.fetch(new Request('https://pt-hub.test/rtp-api', { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(data) }), {}, {});
  try {
    assert.equal((await post({ target: 'https://example.com/', headers: {} })).status, 400);
    assert.equal((await post({ target: 'https://rtpplayapi.rtp.pt/play/api/2/token-manager', headers: {} })).status, 400);
    const headers = { 'RTP-Play-Auth':'test-profile', 'RTP-Play-Auth-Hash':'signed', 'RTP-Play-Auth-Timestamp':'123', Cookie:'do-not-forward' };
    const response = await post({ target: 'https://rtpplayapi.rtp.pt/play/api/2/token-manager', headers });
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].options.headers.get('cookie'), null);
    assert.equal(seen[0].options.headers.get('RTP-Play-Auth-Hash'), 'signed');
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
  } finally { global.fetch = original; }
});
