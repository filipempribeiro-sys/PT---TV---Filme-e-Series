import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { getOptoVodStreams } from '../src/opto.js';
import worker from '../src/index.js';

test('OPTO official links preserve content paths without subscription or media requests', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('Unexpected network'); };
  try {
    const config = Buffer.from(JSON.stringify({features:{ptContentSources:{opto:true}}})).toString('base64url');
    for (const type of ['movie','series','podcast']) {
      const path='/content/12345678-1234-1234-1234-123456789abc';
      const id='optovod:'+Buffer.from(path).toString('base64url');
      const streams=await getOptoVodStreams(type,id);
      assert.equal(streams.length,1);
      assert.equal(streams[0].externalUrl,'https://opto.sic.pt'+path);
      assert.equal(streams[0].url,undefined);
      const response=await worker.fetch(new Request('https://pt-hub.test/'+config+'/stream/'+type+'/'+id+'.json'),{},{});
      assert.equal(response.status,200);
      assert.deepEqual((await response.json()).streams,streams);
    }
    assert.equal(calls,0);
    assert.deepEqual(await getOptoVodStreams('series','optovod:'+Buffer.from('https://example.com/content/12345678-1234-1234-1234-123456789abc').toString('base64url')),[]);
  } finally { globalThis.fetch=originalFetch; }
});
