import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const origin="https://pt-hub.example";

test("catalog provider API exposes expanded dynamic registry", async()=>{
  const response=await worker.fetch(new Request(origin+"/api/catalog/providers"),{}, {waitUntil(){}});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.ok,true);
  assert.ok(body.providers.length>=40);
  for(const id of ["netflix","skyshowtime","paramount-plus","mubi","filmin","britbox","pluto-tv","tubi"]){
    assert.ok(body.providers.some(item=>item.id===id),id);
  }
});

test("aggregated Top 10 API returns ten ranked titles with source metadata", async()=>{
  const source=globalThis.fetch;
  globalThis.fetch=async (_url,options={})=>{
    const payload=JSON.parse(options.body||"{}");
    if(payload.operationName==="Packages"){
      return new Response(JSON.stringify({data:{packages:[
        {id:"1",clearName:"Netflix",shortName:"nfx"}
      ]}}),{headers:{"content-type":"application/json"}});
    }
    if(payload.operationName==="GetPopularTitles"){
      const edges=Array.from({length:12},(_,i)=>({node:{objectType:"MOVIE",content:{
        title:"Movie "+(i+1),posterUrl:null,externalIds:{imdbId:"tt"+String(1000000+i)}
      }}}));
      return new Response(JSON.stringify({data:{popularTitles:{edges}}}),{headers:{"content-type":"application/json"}});
    }
    throw new Error("Unexpected request");
  };
  try{
    const response=await worker.fetch(
      new Request(origin+"/api/catalog/rankings?country=PT&provider=netflix&type=movie"),
      {},
      {waitUntil(){}},
    );
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.ok,true);
    assert.equal(body.rankingSource,"aggregated");
    assert.equal(body.items.length,10);
    assert.deepEqual(body.items.map(item=>item.rank),[1,2,3,4,5,6,7,8,9,10]);
    assert.ok(body.items.every(item=>item.provider==="netflix"&&item.country==="PT"));
  }finally{
    globalThis.fetch=source;
  }
});

test("cinema API labels availability and country", async()=>{
  const source=globalThis.fetch;
  globalThis.fetch=async (_url,options={})=>{
    const payload=JSON.parse(options.body||"{}");
    if(payload.operationName==="GetPopularTitles"){
      return new Response(JSON.stringify({data:{popularTitles:{edges:[
        {node:{objectType:"MOVIE",content:{title:"Cinema A",originalReleaseYear:2026,originalReleaseDate:"2026-09-30",externalIds:{imdbId:"tt7654321"}}}}
      ]}}}),{headers:{"content-type":"application/json"}});
    }
    throw new Error("Unexpected request");
  };
  try{
    const response=await worker.fetch(
      new Request(origin+"/api/catalog/cinema?country=PT&section=now-playing"),
      {},
      {waitUntil(){}},
    );
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.ok,true);
    assert.equal(body.engine,"cinema");
    assert.equal(body.country,"PT");
    assert.deepEqual(body.items[0].availability.cinema,["PT"]);
  }finally{
    globalThis.fetch=source;
  }
});
