# PT•HUB 4.0 — Cloudflare Free

PT•HUB runs directly on Cloudflare Workers. The Cloudflare runtime is self-contained for routing, catalogues, IPTV and external stream aggregation; the former Render Torrent Engine is no longer required by the Worker.

## Architecture
Stremio / Nuvio → PT•HUB Cloudflare Worker → independent stream providers → normalization → deduplication → quality/provider-aware ranking → Cloudflare Cache API → Stremio-compatible response.

Built-in stream sources are queried independently with short per-provider timeouts. A provider failure, timeout, 429 or 5xx does not fail the global response. Custom Stremio addon manifests remain supported and are kept separate from the built-in source list.

## Cloudflare Free design
- No Render wake-up, polling, Docker, Redis, child processes or permanent timers.
- Static assets are bundled from `../addon`.
- Uploaded M3U persistence uses the `PT_HUB_M3U` KV binding.
- External stream responses prefer the Cloudflare Cache API; on `*.workers.dev`, `PT_HUB_M3U` KV is also used as a fallback because Cache API operations may have no effect there. Movies use a 45-minute TTL, episodes 20 minutes, and empty responses are not stored.
- HLS media bodies are streamed instead of buffered.
- Provider fan-out is bounded to six simultaneous outbound connections, while still consulting every enabled source in batches, matching the Workers connection limit and staying comfortably below the Free-plan subrequest limit.

## Content responsibility
PT•HUB does not host, download or transmit P2P content. It aggregates interfaces, metadata and stream descriptors returned by independent providers. Provider availability, content and licensing remain the responsibility of those providers and the user must use sources they are entitled to access.

## Legacy
`PT-HUB-Torrent-Engine` is retained only as a rollback/legacy reference while the Cloudflare-only production path is validated. It is not required by the Cloudflare Worker.

## Deploy
From this directory: `npm install`, then `npx wrangler deploy`. Authentication/account setup is intentionally not stored in GitHub.
