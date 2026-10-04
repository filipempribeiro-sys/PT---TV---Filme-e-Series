'use strict';
// Run the current Cloudflare application on Node; no duplicated catalog engine.
const http = require('node:http');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRtpPlayMobileClient, summarizeRtpEpisode, probeRtpEpisodePlayback } = require('./rtp-play-mobile-api');

class LocalKV {
  constructor(directory) { this.directory = directory; }
  file(key) { return path.join(this.directory, createHash('sha256').update(key).digest('hex') + '.json'); }
  async get(key, options) {
    try {
      const entry = JSON.parse(await fs.readFile(this.file(key), 'utf8'));
      if (entry.expires && entry.expires <= Date.now()) { await this.delete(key); return null; }
      return (options === 'json' || options?.type === 'json') ? JSON.parse(entry.value) : entry.value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async put(key, value, options = {}) {
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.file(key), temporary = file + '.' + require('node:crypto').randomUUID();
    await fs.writeFile(temporary, JSON.stringify({ value: String(value), expires: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : 0 }), { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  async delete(key) { await fs.rm(this.file(key), { force: true }); }
}
const defaultConfig = {
  features: { operators: true, selectedOperators: ['meo','nos','vodafone','digi'], ptContentSources: { rtpPlay: true } }
};
const defaultToken = Buffer.from(JSON.stringify(defaultConfig)).toString('base64url');
const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

async function createApplication({ env = process.env, client } = {}) {
  const worker = (await import('../cloudflare/src/index.js')).default;
  const rtp = await import('../cloudflare/src/rtp-play.js');
  const mobile = client || createRtpPlayMobileClient({ authName: env.RTP_PLAY_AUTH_NAME, authKey: env.RTP_PLAY_AUTH_KEY, authUrl: env.RTP_PLAY_AUTH_URL, apiBase: env.RTP_PLAY_API_BASE });
  const bindings = { ...env, PT_HUB_M3U: new LocalKV(env.PT_HUB_DATA_DIR || path.join(require('node:os').tmpdir(), 'pt-hub-render-data')) };
  rtp.setNodePlaybackResolver(async originalPath => {
    const resolved = await rtp.resolveEpisodePath(originalPath);
    if (!resolved.episodeId) return null;
    try {
      const probe = await probeRtpEpisodePlayback(mobile, resolved.programId, resolved.episodeId);
      console.log('RTP PLAYBACK', JSON.stringify({ programId: resolved.programId, episodeId: resolved.episodeId, playable: probe.playable, assets: probe.assets.length, stage: probe.selected?.stage || probe.attempts.at(-1)?.stage || 'no-public-hls' }));
      return { ...resolved, urls: probe.playable ? [probe.selected.url] : [] };
    } catch (error) {
      console.error('RTP PLAYBACK FAILED', error.message);
      return null; // Preserve the existing public web resolver if mobile auth is unavailable.
    }
  });
  return async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/api/health') return json({ ok: true, name: 'PT•HUB', version: '4.0.0', runtime: 'node-render', sharedImplementation: 'cloudflare/src/index.js', torrentsDisabled: process.env.PT_HUB_RTP_TEST_ONLY === '1', storage: 'local-ephemeral' });
    if (url.pathname === '/rtp-test/status') {
      try { return json(await mobile.getStatus()); } catch(error) { return json({ authenticated: false, error: error.message }, 502); }
    }
    const diagnostic = url.pathname.match(/^\/rtp-test\/(episode|probe)\/(\d+)\/(\d+)$/);
    if (diagnostic) {
      try { return json(diagnostic[1] === 'probe' ? await probeRtpEpisodePlayback(mobile, diagnostic[2], diagnostic[3]) : summarizeRtpEpisode(await mobile.getEpisode(diagnostic[2], diagnostic[3]))); }
      catch(error) { return json({ ok: false, error: error.message }, 502); }
    }
    // Root installations expose the RTP/operator test selection and all protocol routes.
    // Explicit configuration tokens retain the full Cloudflare configurator behavior.
    if (url.pathname === '/manifest.json' || /^\/(catalog|meta|stream|subtitles)\//.test(url.pathname)) {
      url.pathname = '/' + defaultToken + url.pathname;
      request = new Request(url, request);
    }
    return worker.fetch(request, bindings, { waitUntil(promise) { promise.catch(error => console.error('PT HUB background:', error.message)); } });
  };
}
async function start() {
  // This Render deployment is a public-provider test, never a torrent resolver.
  process.env.PT_HUB_RTP_TEST_ONLY = '1';
  const handle = await createApplication();
  const server = http.createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.on('close', () => { if (!outgoing.writableEnded) controller.abort(); });
    try {
      const origin = process.env.RENDER_EXTERNAL_URL || 'http://' + incoming.headers.host;
      const options = { method: incoming.method, headers: incoming.headers, signal: controller.signal };
      if (!['GET','HEAD'].includes(incoming.method)) { options.body = Readable.toWeb(incoming); options.duplex = 'half'; }
      const response = await handle(new Request(new URL(incoming.url, origin), options));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (incoming.method === 'HEAD' || !response.body) outgoing.end();
      else await pipeline(Readable.fromWeb(response.body), outgoing);
    } catch(error) {
      if (!controller.signal.aborted) { console.error('PT HUB request:', error.message); if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type':'application/json' }); outgoing.end(JSON.stringify({ error:'Falha no PT•HUB' })); }
    }
  });
  server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log('PT•HUB 4.0 Node/Render — Cloudflare modules active; torrents disabled'));
  return server;
}
module.exports = { createApplication, LocalKV, defaultConfig };
if (require.main === module) start().catch(error => { console.error(error); process.exitCode = 1; });
