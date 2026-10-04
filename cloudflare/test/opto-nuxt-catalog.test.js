import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublicNuxtState } from '../src/nuxt-public-data.js';
import { getOptoVodCatalog, getOptoVodStreams } from '../src/opto.js';

const fixture='<script>window.__NUXT__=(function(a,b,c,d){d.name=b;d.contents=[{id:a,title:"Azul",contentType:"SERIES",premium:true,images:{poster:"https://example.com/poster.jpg"}}];return {state:{homepage:{_homepagePlaylists:[d,{name:"Em Direto",contents:[{id:a,title:"SIC",contentType:"SERIES"}]}]}}};}("544a9611-47d2-4291-83cf-0f2a577c9893","Originais OPTO",void 0,{}));</script>';

test('Nuxt data is parsed without executing code or permitting unsafe property access',()=>{
  assert.equal(readPublicNuxtState(fixture).homepage._homepagePlaylists[0].name,'Originais OPTO');
  assert.equal(readPublicNuxtState(fixture.replace('d.name=b;','d.name=fetch("https://example.com");')),null);
  assert.equal(readPublicNuxtState(fixture.replace('d.name=b;','d.__proto__=b;')),null);
  assert.equal(readPublicNuxtState('<script>window.__NUXT__=malicious()</script>'),null);
});

test('OPTO catalog recovers cards without HTML links and opens premium items on official site',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(fixture);
  try{
    const {metas}=await getOptoVodCatalog('series','opto-vod-originais');
    assert.equal(metas.length,1);
    assert.equal(metas[0].name,'Azul');
    assert.equal(metas[0].website,'https://opto.sic.pt/series/azul/544a9611-47d2-4291-83cf-0f2a577c9893');
    assert.equal(metas[0].poster,'https://example.com/poster.jpg');
    const streams=await getOptoVodStreams('series',metas[0].id);
    assert.equal(streams[0].externalUrl,metas[0].website);
    assert.equal(streams[0].url,undefined);
    assert.equal((await getOptoVodCatalog('series','opto-vod-programas')).metas.length,0);
  }finally{globalThis.fetch=original;}
});
