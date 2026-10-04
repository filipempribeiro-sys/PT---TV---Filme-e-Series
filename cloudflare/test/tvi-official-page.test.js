import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { getTviVodStreams } from '../src/tvi-player.js';
import worker from '../src/index.js';

test('TVI programs and episodes return official links without media or rights requests', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('Unexpected network'); };
  try {
    const config = Buffer.from(JSON.stringify({features:{ptContentSources:{tviPlayer:true}}})).toString('base64url');
    for (const path of [
      '/programa/dois-as-10/5fe219a40cf2cc9de7ef9590',
      '/programa/dois-as-10/5fe219a40cf2cc9de7ef9590/video/6abfa4b70cf20dc52778e252',
    ]) {
      const id = 'tvivod:'+Buffer.from(path).toString('base64url');
      const streams = await getTviVodStreams('series',id);
      assert.equal(streams.length,1);
      assert.equal(streams[0].externalUrl,'https://tviplayer.iol.pt'+path);
      assert.equal(streams[0].url,undefined);
      const response = await worker.fetch(new Request('https://pt-hub.test/'+config+'/stream/series/'+id+'.json'),{},{});
      assert.equal(response.status,200);
      assert.deepEqual((await response.json()).streams,streams);
    }
    assert.equal(calls,0);
    assert.deepEqual(await getTviVodStreams('series','tvivod:'+Buffer.from('https://example.com/programa/show/abc').toString('base64url')),[]);
    assert.deepEqual(await getTviVodStreams('movie','invalid'),[]);
  } finally { globalThis.fetch=originalFetch; }
});
