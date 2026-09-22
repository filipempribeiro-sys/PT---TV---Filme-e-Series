# PT•HUB 4.0 — Cloudflare Free

Isolated migration target for the PT•HUB addon. The Render implementation remains untouched until endpoint parity is validated.

## Target
- Cloudflare Workers Free for routing/API.
- Static assets bundled from ../addon.
- No keep-alive requirement for the main addon.
- Existing torrent engine remains a separate optional upstream during migration.

## Free-plan design constraints
Keep each request within Workers Free CPU/subrequest limits. HLS must stream upstream bodies instead of buffering full media segments. Uploaded M3U persistence will use a free-tier Cloudflare storage binding only if required; URL-based M3U/Xtream requires no storage.

## Deploy
From this directory: npm install, then npx wrangler deploy. Authentication/account setup is intentionally not stored in GitHub.
