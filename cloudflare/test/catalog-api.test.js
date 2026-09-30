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


test("configured TV catalog API exposes current EPG programme", async()=>{
  const pad=n=>String(n).padStart(2,"0");
  const xmlTime=date=>date.getUTCFullYear()+pad(date.getUTCMonth()+1)+pad(date.getUTCDate())+
    pad(date.getUTCHours())+pad(date.getUTCMinutes())+pad(date.getUTCSeconds())+" +0000";
  const now=Date.now();
  const start=xmlTime(new Date(now-30*60*1000));
  const stop=xmlTime(new Date(now+30*60*1000));
  const config={
    features:{iptv:true},
    mode:"m3u",
    m3uSource:"file",
    m3uFileData:'#EXTM3U\n#EXTINF:-1 tvg-id="demo" tvg-name="Demo",Demo\nhttps://media.example/demo.m3u8\n',
    m3uEpgMode:"url",
    epgUrl:"https://epg.example/guide.xml",
  };
  const token=Buffer.from(JSON.stringify(config),"utf8").toString("base64url");
  const source=globalThis.fetch;
  globalThis.fetch=async target=>{
    const url=String(target);
    if(url==="https://epg.example/guide.xml"){
      return new Response(
        '<?xml version="1.0"?><tv><programme channel="demo" start="'+start+'" stop="'+stop+'">'+
        '<title>Programa Atual</title><desc>Descrição</desc></programme></tv>',
        {headers:{"content-type":"application/xml"}},
      );
    }
    if(url.startsWith("https://api.github.com/")){
      return new Response(JSON.stringify({tree:[]}),{headers:{"content-type":"application/json"}});
    }
    throw new Error("Unexpected request: "+url);
  };
  try{
    const response=await worker.fetch(
      new Request(origin+"/"+token+"/api/catalog/tv?section=now"),
      {},
      {waitUntil(){}},
    );
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.ok,true);
    assert.equal(body.engine,"television");
    assert.ok(body.items.some(item=>item.channel==="Demo"&&item.title==="Programa Atual"));
  }finally{
    globalThis.fetch=source;
  }
});
