export const STREAMERS = Object.freeze([
  {id:"netflix",name:"Netflix",aliases:["Netflix"]},
  {id:"prime-video",name:"Prime Video",aliases:["Amazon Prime Video","Prime Video"]},
  {id:"disney-plus",name:"Disney+",aliases:["Disney Plus","Disney+"]},
  {id:"apple-tv-plus",name:"Apple TV+",aliases:["Apple TV Plus","Apple TV+"]},
  {id:"paramount-plus",name:"Paramount+",aliases:["Paramount Plus","Paramount+"]},
  {id:"now",name:"NOW",aliases:["NOW","Now TV"]},
  {id:"skyshowtime",name:"SkyShowtime",aliases:["SkyShowtime"]},
  {id:"hbomax",name:"HBO Max",aliases:["HBO Max","Max"]},
  {id:"crunchyroll",name:"Crunchyroll",aliases:["Crunchyroll"]},
  {id:"mubi",name:"MUBI",aliases:["MUBI"]},
  {id:"filmin",name:"Filmin",aliases:["Filmin"]},
  {id:"rakuten-tv",name:"Rakuten TV",aliases:["Rakuten TV"]},
  {id:"viu",name:"Viu",aliases:["Viu"]},
  {id:"raiplay",name:"RaiPlay",aliases:["Rai Play","RaiPlay"]},
  {id:"chili",name:"CHILI",aliases:["CHILI","Chili"]},
  {id:"vudu",name:"Vudu",aliases:["Vudu","Fandango At Home"]},
  {id:"starz",name:"STARZ",aliases:["STARZ","Starz"]},
  {id:"hulu",name:"Hulu",aliases:["Hulu"]},
  {id:"peacock",name:"Peacock",aliases:["Peacock","Peacock Premium"]},
  {id:"discovery-plus",name:"Discovery+",aliases:["Discovery Plus","Discovery+"]},
  {id:"viki",name:"Viki",aliases:["Rakuten Viki","Viki"]},
  {id:"canal-plus",name:"Canal+",aliases:["Canal Plus","Canal+"]},
  {id:"tf1",name:"TF1",aliases:["TF1","TF1+"]},
  {id:"m6-plus",name:"M6+",aliases:["M6 Plus","M6+"]},
  {id:"wow",name:"WOW",aliases:["WOW"]},
  {id:"viaplay",name:"Viaplay",aliases:["Viaplay"]},
  {id:"videoland",name:"Videoland",aliases:["Videoland"]},
  {id:"globoplay",name:"Globoplay",aliases:["Globoplay"]},
  {id:"claro-video",name:"Claro Video",aliases:["Claro Video"]},
  {id:"u-next",name:"U-NEXT",aliases:["U-NEXT","U Next"]},
  {id:"wavve",name:"Wavve",aliases:["Wavve"]},
  {id:"coupang-play",name:"Coupang Play",aliases:["Coupang Play"]},
  {id:"jiohotstar",name:"JioHotstar",aliases:["JioHotstar","Hotstar","Disney+ Hotstar"]},
  {id:"zee5",name:"ZEE5",aliases:["ZEE5"]},
  {id:"stan",name:"Stan",aliases:["Stan"]},
  {id:"player",name:"Player.pl",aliases:["Player.pl"]},
  {id:"cda-pl",name:"cda.pl",aliases:["cda.pl","CDA Premium"]},
  {id:"oneplay",name:"Oneplay",aliases:["Oneplay"]},
  {id:"osn",name:"OSN+",aliases:["OSN Plus","OSN+"]},
  {id:"shahid",name:"Shahid",aliases:["Shahid","Shahid VIP"]},
  {id:"britbox",name:"BritBox",aliases:["BritBox"]},
  {id:"amc-plus",name:"AMC+",aliases:["AMC Plus","AMC+"]},
  {id:"plex",name:"Plex",aliases:["Plex"]},
  {id:"pluto-tv",name:"Pluto TV",aliases:["Pluto TV"]},
  {id:"tubi",name:"Tubi",aliases:["Tubi","Tubi TV"]}
]);

export const DEFAULT_CATALOG_COUNTRIES = Object.freeze(["PT","ES","FR","GB","US","BR"]);

export function normalizeCatalogCountries(value, allCountries = DEFAULT_CATALOG_COUNTRIES) {
  const raw = Array.isArray(value) ? value : [value];
  const countries = [...new Set(raw.map(v=>String(v||"").trim().toUpperCase()).filter(Boolean))];
  if (countries.includes("ALL")) return [...allCountries];
  return countries.length ? countries : ["PT"];
}

export function configuredCountries(config = {}) {
  if (Array.isArray(config.catalogCountries) && config.catalogCountries.length) return config.catalogCountries;
  return config.catalogCountry || config.country || "PT";
}

export function normalizeProviderName(value) {
  return String(value||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
}

export function providerTargets(streamerId) {
  const provider = STREAMERS.find(item=>item.id===streamerId);
  if (!provider) return [];
  return [...new Set([provider.id,provider.name,...(provider.aliases||[])].map(normalizeProviderName).filter(Boolean))];
}

export function normalizeTitle(value) {
  return String(value||"")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g," ")
    .trim()
    .replace(/\s+/g," ");
}

export function entityKey(meta = {}) {
  const imdb=String(meta.imdbId||meta.imdb_id||meta?.externalIds?.imdbId||"").trim().toLowerCase();
  if (/^tt\d+$/i.test(imdb)) return "imdb:"+imdb;
  const id=String(meta.id||"").trim().toLowerCase();
  if (/^tt\d+$/i.test(id)) return "imdb:"+id;
  if (/^tmdb:\d+$/i.test(id)) return id;
  const title=normalizeTitle(meta.name||meta.title||"");
  const year=String(meta.year||meta.releaseInfo||meta.released||"").match(/\b(19|20)\d{2}\b/)?.[0]||"";
  const type=String(meta.type||"").toLowerCase();
  return title ? "title:"+type+":"+title+":"+year : (id ? "id:"+id : "");
}

export function mergeCatalogMetas(results, limit = 100) {
  const seen = new Map();
  const metas = [];
  for (const result of results || []) {
    for (const meta of result?.metas || []) {
      const key = entityKey(meta);
      if (!key) continue;
      if (seen.has(key)) {
        const index=seen.get(key);
        const current=metas[index];
        const availability={
          ...(current?.availability||{}),
          ...(meta?.availability||{})
        };
        metas[index]={...current,...meta,availability:Object.keys(availability).length?availability:undefined};
        continue;
      }
      seen.set(key,metas.length);
      metas.push(meta);
      if (metas.length >= limit) return {metas};
    }
  }
  return {metas};
}

export function parseTop10CatalogId(id) {
  const match = String(id||"").match(/^top10--(.+?)--([A-Z]{2})$/i);
  return match ? {streamerId:match[1],country:match[2].toUpperCase()} : null;
}
