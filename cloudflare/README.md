# PT•HUB 4.0 — Cloudflare Free

PT•HUB runs directly on Cloudflare Workers. The Cloudflare runtime is self-contained for routing, catalogues, IPTV and external stream aggregation; the former Render Torrent Engine is no longer required by the Worker.

## Architecture
Stremio / Nuvio → PT•HUB Cloudflare Worker → independent stream providers → normalization → deduplication → quality/provider-aware ranking → Cloudflare Cache API → Stremio-compatible response.

Built-in stream sources are Torrentio, TorrentsDB and ThePirateBay+. They are enabled by default for compatible existing configurations and can be disabled individually. A provider failure, timeout, invalid JSON, 429 or 5xx does not fail the global response. Custom Stremio addon manifests remain supported and are kept separate from the built-in source list.

## Cloudflare Free design
- No Render wake-up, polling, Docker, Redis, child processes or permanent timers.
- Static assets are bundled from `../addon`; `.assetsignore` excludes the legacy Node server and its server-only helpers.
- Uploaded M3U persistence uses the `PT_HUB_M3U` KV binding.
- External stream responses use the Cloudflare Cache API. Movies use a 45-minute TTL, episodes 20 minutes, and empty responses are not stored. `PT_HUB_M3U` KV remains reserved for uploaded M3U persistence.
- HLS media bodies are streamed instead of buffered.
- Provider fan-out is bounded to six simultaneous outbound connections. New configurations accept up to 20 custom stream addons; older configurations with more are safely capped at the first 20 at runtime. Together with the three built-ins this remains below the Workers Free subrequest limit.

## Content responsibility
PT•HUB does not host, download or transmit P2P content. It aggregates interfaces, metadata and stream descriptors returned by independent providers. Provider availability, content and licensing remain the responsibility of those providers and the user must use sources they are entitled to access.

## Legacy
`PT-HUB-Torrent-Engine` is retained only as a rollback/legacy reference while the Cloudflare-only production path is validated. It is not required by the Cloudflare Worker.

## Validation
The native aggregator is verified for movie and episode IDs, multi-provider fallback, deduplication, ranking, configurable per-quality limits, provider 429/5xx/timeout/invalid JSON isolation, legacy defaults, custom-only mode, Cache API MISS/HIT and no caching of empty results.

## Deploy
From this directory: `npm install`, `npm run check`, then `npx wrangler deploy`. Wrangler is pinned to `4.136.3`. Authentication/account setup is intentionally not stored in GitHub.
