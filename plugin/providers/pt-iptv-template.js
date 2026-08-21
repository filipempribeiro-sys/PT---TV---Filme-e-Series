function getStreams(tmdbId, mediaType, season, episode) {
  // Nuvio plugins currently do not expose a general user configuration UI.
  // Keep this provider disabled until you adapt it to your own authorized API/M3U source.
  return Promise.resolve([]);
}
module.exports = { getStreams };
