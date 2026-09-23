# PT•HUB — Nuvio / Stremio

PT•HUB é um hub configurável compatível com o ecossistema Stremio/Nuvio para reunir catálogos, IPTV autorizada, conteúdo português, streamers e fontes externas numa única instalação.

## Produção atual

A produção corre diretamente em **Cloudflare Workers**.

Arquitetura principal:

```
Stremio / Nuvio
→ PT•HUB Cloudflare Worker
→ catálogos / IPTV / conteúdo português
→ agregador de streams externo nativo
→ normalização
→ deduplicação
→ ranking
→ Cache API
→ resposta compatível com Stremio
```

O runtime Cloudflare não depende de Render, Google Cloud, Docker, Magnetio, Redis Render nem de um servidor torrent próprio.

## Instalar

O endpoint de produção é o Worker Cloudflare:

```
https://pt---tv---filme-e-series.filipe-m-p-ribeiro.workers.dev
```

Abre `/configure`, escolhe os conteúdos e instala o manifest gerado no Stremio/Nuvio.

## IPTV

São suportados:

- IPTV-org;
- playlists M3U/M3U+ por URL;
- ficheiros M3U/M3U8;
- Xtream Codes;
- EPG e offsets configuráveis;
- headers por canal e User-Agent global;
- proxy HLS quando necessário.

Ficheiros M3U enviados usam o binding Cloudflare KV `PT_HUB_M3U`. Credenciais não são gravadas no GitHub.

## Fontes externas

O Worker agrega diretamente fontes Stremio independentes. As fontes torrent integradas são configuráveis e ficam separadas dos addons personalizados.

A resposta é normalizada, deduplicada por `infoHash + fileIdx`, ordenada por qualidade/seeders/diversidade e limitada por qualidade. O PT•HUB não descarrega nem faz streaming P2P do conteúdo; devolve apenas descritores de stream fornecidos pelas fontes independentes.

## Estrutura

```
cloudflare/
  src/index.js        <- runtime de produção
  wrangler.jsonc
  package.json
  README.md

addon/
  logo.png
  background.jpg
  manifest.json
  logos/
  server.js           <- legado / rollback, não publicado como asset Cloudflare
  package.json        <- legado
  pt-playmogo-guard.js
  pt-external-player-resolver.js

data/
plugin/
```

`addon/.assetsignore` impede que os ficheiros server-side legados sejam publicados como assets do Worker.

## Legado

O antigo `addon/server.js` e o repositório `PT-HUB-Torrent-Engine` são mantidos apenas como referência/rollback enquanto a migração Cloudflare-only é validada em produção. Não fazem parte do runtime Cloudflare atual.

## Desenvolvimento Cloudflare

A partir de `cloudflare/`:

```bash
npm install
npm run check
npx wrangler deploy
```

O Wrangler está fixado na versão validada pelo projeto para tornar os builds reprodutíveis.

## Responsabilidade de conteúdo

PT•HUB é um projeto independente. Não aloja conteúdos de terceiros, não contorna DRM e não recolhe credenciais de serviços externos. Cada utilizador deve usar apenas fontes e conteúdos a que tenha direito de acesso.
