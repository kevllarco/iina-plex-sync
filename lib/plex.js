const { request, joinUrl } = require("./http.js");
const { getSession } = require("./storage.js");

async function withFailover(http, preferences, utils, fn) {
  const session = getSession(utils, preferences);
  if (!session.signedIn) throw new Error("not signed in");
  const uris = session.uris.length ? session.uris : [session.uri];
  let lastErr = null;
  for (let i = 0; i < uris.length; i++) {
    const uri = uris[i];
    const trySession = Object.assign({}, session, { uri: uri });
    try {
      const result = await fn(trySession);
      if (uri !== session.uri) {
        preferences.set("plex_server_uri", uri);
        preferences.sync();
      }
      return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all connections failed");
}

async function timeline(http, preferences, session, opts) {
  const url = joinUrl(session.uri, "/:/timeline");
  const res = await request(http, preferences, "get", url, {
    token: session.accessToken,
    params: {
      ratingKey: String(opts.ratingKey),
      key: "/library/metadata/" + opts.ratingKey,
      state: opts.state || "playing",
      time: String(Math.floor(opts.timeMs || 0)),
      duration: String(Math.floor(opts.durationMs || 0)),
      identifier: "com.plexapp.plugins.library",
    },
  });
  if (res.statusCode >= 400) {
    throw new Error("timeline HTTP " + res.statusCode);
  }
  return res;
}

async function scrobble(http, preferences, session, ratingKey) {
  const url = joinUrl(session.uri, "/:/scrobble");
  const res = await request(http, preferences, "get", url, {
    token: session.accessToken,
    params: {
      identifier: "com.plexapp.plugins.library",
      key: String(ratingKey),
    },
  });
  if (res.statusCode >= 400) {
    throw new Error("scrobble HTTP " + res.statusCode);
  }
  return res;
}

module.exports = {
  withFailover,
  timeline,
  scrobble,
};
