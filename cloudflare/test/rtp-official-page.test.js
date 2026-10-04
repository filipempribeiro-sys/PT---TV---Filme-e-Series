import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { getRtpVodStreams, setNodePlaybackResolver } from '../src/rtp-play.js';

test('RTP official links work for episodes, programs and special areas without media requests', async () => {
  const originalFetch = globalThis.fetch;
  const oldInternalOnly = process.env.PT_HUB_RTP_INTERNAL_ONLY;
  let resolverCalls = 0;
  globalThis.fetch = async () => { throw new Error('Official link must not fetch media or API'); };
  setNodePlaybackResolver(async () => { resolverCalls++; throw new Error('Mobile resolver must not run'); });
  process.env.PT_HUB_RTP_INTERNAL_ONLY = '1';
  try {
    for (const [type,path] of [
      ['podcast','/play/p7844/e944972/soqnao'],
      ['music','/play/p15328/xutos-e-pontapes-ao-vivo-45-anos-ola-vida-malvada'],
      ['music','/play/palco/p15328/xutos-e-pontapes-ao-vivo-45-anos-ola-vida-malvada'],
      ['series','/play/zigzag/p1234/e5678/programa'],
      ['movie','/play/p1234/programa'],
    ]) {
      const id = 'rtpvod:' + Buffer.from(path).toString('base64url');
      const streams = await getRtpVodStreams(type,id);
      assert.equal(streams.length,1);
      assert.equal(streams[0].externalUrl,'https://www.rtp.pt'+path);
      assert.equal(streams[0].url,undefined);
    }
    assert.equal(resolverCalls,0);
    assert.deepEqual(await getRtpVodStreams('movie','rtpvod:'+Buffer.from('https://example.com/play/p1234/programa').toString('base64url')),[]);
    assert.deepEqual(await getRtpVodStreams('channel','rtpplay:rtp1'),[]);
  } finally {
    globalThis.fetch = originalFetch;
    setNodePlaybackResolver(null);
    if(oldInternalOnly===undefined)delete process.env.PT_HUB_RTP_INTERNAL_ONLY;
    else process.env.PT_HUB_RTP_INTERNAL_ONLY=oldInternalOnly;
  }
});
