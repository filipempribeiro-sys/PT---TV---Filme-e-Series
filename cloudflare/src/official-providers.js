const PROVIDERS=Object.freeze([
  {id:"panda-plus",type:"series",catalogId:"official-panda-plus",catalogName:"🧒 Panda+ • Oficial",name:"Panda+",website:"https://www.pandaplus.pt/",description:"Serviço infantil oficial por subscrição. Catálogo e acesso dependem de autenticação/operador.",access:"subscription"},
  {id:"dazn",type:"series",catalogId:"official-dazn",catalogName:"🏅 DAZN • Oficial",name:"DAZN",website:"https://www.dazn.com/pt-PT/home",description:"Desporto oficial. Pode incluir conteúdo Freemium, subscrição e PPV conforme disponibilidade e conta.",access:"mixed"},
  {id:"fifa-plus",type:"series",catalogId:"official-fifa-plus",catalogName:"⚽ FIFA+ • Oficial",name:"FIFA+",website:"https://www.dazn.com/",description:"Conteúdo FIFA oficial integrado na plataforma DAZN. A disponibilidade gratuita varia por conteúdo e região.",access:"mixed"},
  {id:"sporttv",type:"series",catalogId:"official-sporttv",catalogName:"🏅 SPORT TV • Oficial",name:"SPORT TV",website:"https://www.sporttv.pt/",description:"Vídeos e informação pública; canais Multiscreen exigem subscrição/autenticação oficial.",access:"mixed"},
  {id:"canal11",type:"series",catalogId:"official-canal11",catalogName:"⚽ Canal 11 • Oficial",name:"Canal 11",website:"https://www.canal11.pt/",description:"Conteúdo oficial da FPF. Alguns jogos e vídeos podem estar disponíveis gratuitamente; canal linear pode depender de operador.",access:"mixed"},
  {id:"liga-portugal",type:"series",catalogId:"official-liga-portugal",catalogName:"⚽ Liga Portugal • Oficial",name:"Liga Portugal",website:"https://www.ligaportugal.pt/",description:"Vídeos, calendário, resultados, classificações e informação oficial da Liga Portugal.",access:"public"},
  {id:"plex-free",type:"movie",catalogId:"official-plex-free",catalogName:"🎬 Plex Free • Oficial",name:"Plex Free",website:"https://watch.plex.tv/",description:"VOD/FAST suportado por publicidade. Reprodução deve permanecer no mecanismo oficial quando exigido.",access:"avod"},
  {id:"rakuten-free",type:"movie",catalogId:"official-rakuten-free",catalogName:"🎬 Rakuten TV Free • Oficial",name:"Rakuten TV Free",website:"https://www.rakuten.tv/",description:"Conteúdo AVOD gratuito quando disponível na região. Reprodução depende das regras oficiais do serviço.",access:"avod"},
  {id:"spotify-podcasts",type:"podcast",catalogId:"official-spotify-podcasts",catalogName:"🎙️ Spotify • Podcasts",name:"Spotify Podcasts",website:"https://open.spotify.com/genre/podcasts-web",description:"Podcasts no Spotify. Catálogo e reprodução usam o serviço oficial; conteúdos e capacidades dependem da conta e da região.",access:"account"},
]);

export const OFFICIAL_PROVIDER_CATALOGS=Object.freeze(PROVIDERS.map(p=>({type:p.type,id:p.catalogId,name:p.catalogName})));
function providerByCatalog(type,id){return PROVIDERS.find(p=>p.type===type&&p.catalogId===id)||null}
function providerByMeta(id=""){const m=String(id).match(/^official:([a-z0-9-]+)$/i);return m?PROVIDERS.find(p=>p.id===m[1])||null:null}
function poster(p){try{return new URL("/favicon.ico",p.website).toString()}catch{return""}}

export async function getOfficialProviderCatalog(type,id,search=""){
  const p=providerByCatalog(type,id);if(!p)return{metas:[]};const q=String(search||"").trim().toLowerCase();if(q&&!(`${p.name} ${p.description}`.toLowerCase().includes(q)))return{metas:[]};
  const image=poster(p);return{metas:[{id:"official:"+p.id,type:p.type,name:p.name,poster:image||undefined,background:image||undefined,description:p.description,website:p.website,_ptHub:{source:"official-provider",access:p.access}}]}
}
export async function getOfficialProviderMeta(type,id){const p=providerByMeta(id);if(!p||p.type!==type)return null;const image=poster(p);return{id,type:p.type,name:p.name,poster:image||undefined,background:image||undefined,description:p.description,website:p.website,_ptHub:{source:"official-provider",access:p.access}}}
export async function getOfficialProviderStreams(type,id){const p=providerByMeta(id);if(!p||p.type!==type)return[];return[{name:"PT•HUB • Oficial",title:p.name,externalUrl:p.website}]}
