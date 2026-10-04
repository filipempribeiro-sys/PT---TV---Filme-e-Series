"use strict";

const https = require("https");
const crypto = require("crypto");

const DEFAULT_AUTH_URL =
  "https://rtpplayapi.rtp.pt/play/api/2/token-manager";
const DEFAULT_API_BASE =
  "https://www.rtp.pt/play/api/1/";
const DEFAULT_USER_AGENT = "okhttp/4.12.0";

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 8
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNumericId(value, label) {
  const text = String(value || "").trim().replace(/^[pe]/i, "");
  if (!/^\d+$/.test(text)) {
    throw new Error(label + " inválido.");
  }
  return text;
}

function interleaveKey(timestamp, authKey) {
  let result = "";
  let j = 0;

  for (let i = 0; i < authKey.length; i++) {
    if (i % 5 === 3 && j < timestamp.length) {
      result += timestamp[j++];
    }
    result += authKey[i];
  }

  return result;
}

function hmacSha256Hex(key, data) {
  return crypto
    .createHmac("sha256", key)
    .update(data)
    .digest("hex");
}

function requestBuffer(
  target,
  {
    headers = {},
    timeoutMs = 15000,
    maxRedirects = 4
  } = {}
) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);

    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        method: "GET",
        path: url.pathname + url.search,
        agent,
        minVersion: "TLSv1.2",
        headers
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        const location = res.headers.location;

        if (
          location &&
          [301, 302, 303, 307, 308].includes(status)
        ) {
          res.resume();

          if (maxRedirects <= 0) {
            return reject(new Error("Demasiados redirects RTP."));
          }

          const next = new URL(location, url).toString();

          return requestBuffer(next, {
            headers,
            timeoutMs,
            maxRedirects: maxRedirects - 1
          }).then(resolve, reject);
        }

        const chunks = [];

        res.on("data", (chunk) => {
          chunks.push(chunk);
        });

        res.on("end", () => {
          resolve({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks),
            url: target
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Timeout RTP."));
    });

    req.on("error", reject);
    req.end();
  });
}

async function requestJson(target, options = {}) {
  const response = await requestBuffer(target, options);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      "RTP HTTP " +
      response.status +
      ": " +
      response.body.toString("utf8", 0, 200)
    );
  }

  let data;

  try {
    data = JSON.parse(response.body.toString("utf8"));
  } catch {
    throw new Error("A RTP não devolveu JSON válido.");
  }

  if (data && data.error) {
    throw new Error("RTP API: " + data.error);
  }

  return data;
}

function createRtpPlayMobileClient(options = {}) {
  const authName =
    String(options.authName || "").trim();
  const authKey =
    String(options.authKey || "").trim();
  const authUrl =
    String(options.authUrl || DEFAULT_AUTH_URL).trim();
  const apiBase =
    String(options.apiBase || DEFAULT_API_BASE).trim();

  let authToken = "";
  let authExpiryMs = 0;
  let authUser = "";

  function assertConfigured() {
    if (!authName || !authKey) {
      throw new Error(
        "RTP Play API não configurada no Render " +
        "(RTP_PLAY_AUTH_NAME/RTP_PLAY_AUTH_KEY)."
      );
    }
  }

  async function getAuthToken(force = false) {
    assertConfigured();

    const now = Date.now();

    if (
      !force &&
      authToken &&
      now < authExpiryMs - 30000
    ) {
      return authToken;
    }

    const timestamp = String(now);
    const signingKey = interleaveKey(timestamp, authKey);
    const signature = hmacSha256Hex(
      signingKey,
      timestamp + authUrl
    );

    const data = await requestJson(authUrl, {
      headers: {
        Accept: "*/*",
        "User-Agent": DEFAULT_USER_AGENT,
        "RTP-Play-Auth": authName,
        "RTP-Play-Auth-Hash": signature,
        "RTP-Play-Auth-Timestamp": timestamp
      }
    });

    const token = data?.token?.token;

    if (!token) {
      throw new Error("A RTP não devolveu Bearer token.");
    }

    authToken = token;
    authUser = String(data?.token?.user || "");

    const expireSeconds = Number(data?.token?.expire);
    authExpiryMs = Number.isFinite(expireSeconds)
      ? expireSeconds * 1000
      : now + 8 * 60 * 60 * 1000;

    return authToken;
  }

  async function apiRequest(endpoint, retry = true) {
    const token = await getAuthToken();
    const timestamp = String(Date.now());

    try {
      const data = await requestJson(
        new URL(endpoint, apiBase).toString(),
        {
          headers: {
            Accept: "*/*",
            Authorization: "Bearer " + token,
            "RTP-Play-Auth-Timestamp": timestamp,
            "User-Agent": DEFAULT_USER_AGENT
          }
        }
      );

      return data?.result ?? data;
    } catch (error) {
      if (
        retry &&
        /Not Authenticated|401|403/i.test(error.message)
      ) {
        authToken = "";
        authExpiryMs = 0;
        await sleep(150);
        await getAuthToken(true);
        return apiRequest(endpoint, false);
      }

      throw error;
    }
  }

  return {
    async getStatus() {
      await getAuthToken();

      return {
        authenticated: true,
        authUser: authUser || undefined,
        tokenExpiresAt:
          authExpiryMs > 0
            ? new Date(authExpiryMs).toISOString()
            : undefined
      };
    },

    async getEpisode(programId, episodeId) {
      const p = assertNumericId(programId, "program_id");
      const e = assertNumericId(episodeId, "episode_id");

      return apiRequest(
        "get-episode/" +
        encodeURIComponent(p) +
        "/" +
        encodeURIComponent(e) +
        "?include_assets=true&include_webparams=true"
      );
    },

    async getAsset(assetId) {
      const asset = assertNumericId(assetId, "asset_id");

      return apiRequest(
        "get-asset/" + encodeURIComponent(asset)
      );
    },

    async listEpisodes(programId, page = 1) {
      const p = assertNumericId(programId, "program_id");
      const pageNo = Math.max(1, Number(page) || 1);

      return apiRequest(
        "list-episodes/" +
        encodeURIComponent(p) +
        "/?page=" +
        pageNo +
        "&order_type=desc"
      );
    }
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function getAssetMediaUrls(asset = {}) {
  const urls = [];

  const add = (kind, url) => {
    const value = firstString(url);

    if (!value || !/^https?:\/\//i.test(value)) {
      return;
    }

    if (!urls.some((item) => item.url === value)) {
      urls.push({ kind, url: value });
    }
  };

  add("hls", asset.hls_url);
  add("hls", asset.hls_url_new);
  add("hls", asset?.hls?.stream_url);
  add("hls", asset?.stream?.hls?.stream_url);
  add("hls", asset?.stream_url?.http?.standard);
  add("hls", asset?.stream_url?.http?.smil);

  add("dash", asset.dash_url);
  add("dash", asset?.dash?.stream_url);
  add("dash", asset?.stream?.dash?.stream_url);

  add("mp4", asset.download_url);

  return urls;
}

function assetLooksProtected(asset = {}) {
  const serialized = JSON.stringify(asset);

  if (/\/drm-(?:fps|dash)\//i.test(serialized)) {
    return true;
  }

  const values = [
    asset.drm,
    asset?.hls?.drm,
    asset?.dash?.drm,
    asset?.stream?.hls?.drm,
    asset?.stream?.dash?.drm
  ];

  return values.some(
    (value) =>
      value === 1 ||
      value === "1" ||
      value === true ||
      String(value || "").toLowerCase() === "true"
  );
}

function summarizeAsset(asset = {}) {
  return {
    assetId:
      String(asset.asset_id || asset.id || ""),
    type:
      String(asset.asset_type || asset.type || ""),
    duration:
      String(asset.asset_duration || ""),
    geo:
      String(
        asset.asset_geoblock_info ||
        asset.geoblock ||
        ""
      ),
    protected:
      assetLooksProtected(asset),
    media:
      getAssetMediaUrls(asset),
    rightsApi:
      firstString(asset.rights_api) || undefined
  };
}

function summarizeRtpEpisode(data = {}) {
  const episode = data?.episode || {};
  const assets = Array.isArray(data?.assets)
    ? data.assets
    : [];

  return {
    episode: {
      programId:
        String(episode.program_id || ""),
      episodeId:
        String(episode.episode_id || ""),
      title:
        String(
          episode.episode_title ||
          episode.program_title ||
          ""
        ),
      program:
        String(episode.program_title || ""),
      duration:
        String(episode.episode_duration_complete || ""),
      date:
        String(
          episode.episode_date ||
          episode.episode_air_date ||
          ""
        )
    },
    assets: assets.map(summarizeAsset)
  };
}

const RTP_MEDIA_HEADERS = {
  Accept: "*/*",
  "User-Agent": DEFAULT_USER_AGENT,
  Origin: "https://www.rtp.pt",
  Referer: "https://www.rtp.pt/"
};

function firstPlaylistUri(text) {
  for (const raw of String(text || "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();

    if (line && !line.startsWith("#")) {
      return line;
    }
  }

  return "";
}

function firstMediaSegmentUri(text) {
  const lines =
    String(text || "").replace(/\r/g, "").split("\n");

  let sawExtInf = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (line.startsWith("#EXTINF:")) {
      sawExtInf = true;
      continue;
    }

    if (
      sawExtInf &&
      line &&
      !line.startsWith("#")
    ) {
      return line;
    }
  }

  return "";
}

async function probeBytes(target, range = "bytes=0-1") {
  const response = await requestBuffer(target, {
    timeoutMs: 12000,
    headers: {
      ...RTP_MEDIA_HEADERS,
      Range: range
    }
  });

  return {
    ok:
      ((response.status >= 200 && response.status < 300) ||
      response.status === 206) && response.body.length > 0,
    status: response.status,
    contentType:
      String(response.headers["content-type"] || "")
  };
}

async function probeHls(target, depth = 0) {
  if (depth > 3) {
    return {
      ok: false,
      stage: "playlist-depth",
      status: 0
    };
  }

  const response = await requestBuffer(target, {
    timeoutMs: 12000,
    headers: RTP_MEDIA_HEADERS
  });

  const text = response.body.toString("utf8");

  if (
    response.status < 200 ||
    response.status >= 300 ||
    !text.trimStart().startsWith("#EXTM3U")
  ) {
    return {
      ok: false,
      stage: "manifest",
      status: response.status,
      contentType:
        String(response.headers["content-type"] || "")
    };
  }

  // Public HLS only: never consume encrypted media or license/key endpoints.
  if (/^#EXT-X-(?:SESSION-)?KEY:(?![^\r\n]*METHOD=NONE(?:,|$))/im.test(text)) {
    return { ok: false, stage: "protected-playlist", status: response.status };
  }
  const initUri = text.match(/^#EXT-X-MAP:.*?URI="([^"]+)"/m)?.[1];
  if (initUri) {
    const initProbe = await probeBytes(new URL(initUri, target).toString());
    if (!initProbe.ok) return { ok: false, stage: "init", status: initProbe.status };
  }
  const segment = firstMediaSegmentUri(text);

  if (segment) {
    const segmentUrl =
      new URL(segment, target).toString();

    const segmentProbe =
      await probeBytes(segmentUrl);

    return {
      ok: segmentProbe.ok,
      stage: "segment",
      status: segmentProbe.status,
      manifestStatus: response.status,
      segmentUrl,
      contentType: segmentProbe.contentType
    };
  }

  const child = firstPlaylistUri(text);

  if (!child) {
    return {
      ok: false,
      stage: "empty-playlist",
      status: response.status
    };
  }

  const childUrl =
    new URL(child, target).toString();

  const nested =
    await probeHls(childUrl, depth + 1);

  return {
    ...nested,
    masterUrl:
      depth === 0
        ? target
        : nested.masterUrl,
    childUrl
  };
}

async function probeRtpEpisodePlayback(
  client,
  programId,
  episodeId
) {
  const raw =
    await client.getEpisode(programId, episodeId);

  const summary =
    summarizeRtpEpisode(raw);

  const attempts = [];

  for (const asset of summary.assets) {
    if (asset.protected) {
      attempts.push({
        assetId: asset.assetId,
        skipped: true,
        reason: "protected"
      });
      continue;
    }

    const hlsEntries =
      asset.media.filter(
        (item) =>
          item.kind === "hls" &&
          /\.m3u8(?:$|[?#])/i.test(item.url)
      );

    for (const media of hlsEntries) {
      try {
        const probe =
          await probeHls(media.url);

        const entry = {
          assetId: asset.assetId,
          url: media.url,
          ...probe
        };

        attempts.push(entry);

        if (probe.ok) {
          return {
            playable: true,
            selected: entry,
            episode: summary.episode,
            assets: summary.assets,
            attempts
          };
        }
      } catch (error) {
        attempts.push({
          assetId: asset.assetId,
          url: media.url,
          ok: false,
          stage: "exception",
          error: error.message
        });
      }
    }
  }

  return {
    playable: false,
    selected: null,
    episode: summary.episode,
    assets: summary.assets,
    attempts
  };
}

module.exports = {
  createRtpPlayMobileClient,
  summarizeRtpEpisode,
  probeRtpEpisodePlayback
};
