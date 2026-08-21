# PT TV Hub — Nuvio / Stremio

Projeto-base para centralizar serviços de TV portugueses e uma lista IPTV M3U que o utilizador tenha autorização para usar.

## O que faz

- Catálogo "TV Portugal" com Vodafone TV, DIGI TV, MEO Go e NOS TV.
- Os serviços oficiais aparecem como `externalUrl`, para abrir o serviço oficial e fazer login normalmente.
- Catálogo "Minha IPTV" lê `data/user.m3u` e expõe os canais como streams HTTP/HLS.
- Não recolhe credenciais, não tenta descobrir URLs internas dos operadores e não contorna DRM.
- Inclui um catálogo de referências de add-ons externos e um template de plugin Nuvio.

## Instalar o add-on

1. `npm install`
2. `npm start`
3. Servir o diretório num HTTPS público (por exemplo num VPS/Cloudflare/Render).
4. No Nuvio/Stremio: Addons -> Install from URL -> `https://SEU_HOST/manifest.json`

## IPTV própria

Coloque a sua lista autorizada em `data/user.m3u` e reinicie o servidor.

Exemplo:

#EXTM3U
#EXTINF:-1 tvg-name="Canal Demo" group-title="Legal",Canal Demo
https://exemplo.legal/stream.m3u8

## Plugin Nuvio

O diretório `plugin/` contém um repositório Nuvio compatível com o formato atual de providers, mas o provider vem desativado. Os plugins Nuvio executam código localmente e o sistema atual não fornece uma configuração genérica de credenciais/listas dentro do plugin; por isso não é seguro ou prático embutir credenciais.

## Add-ons externos

O projeto não faz proxy nem copia código de add-ons de terceiros. Os manifests podem ser instalados/configurados separadamente no Nuvio/Stremio.

Para fontes de torrent/índices de terceiros, usa apenas conteúdo para o qual tenhas autorização. Este projeto não automatiza fontes de conteúdo não autorizado.

## Estrutura

addon/
  manifest.json
  server.js
  package.json
data/
  services.json
  addons.json
  user.m3u       <- criar pelo utilizador
plugin/
  manifest.json
  providers/pt-iptv-template.js
