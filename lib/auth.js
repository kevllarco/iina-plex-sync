const { PIN_POLL_MS, PIN_TIMEOUT_MS, ensureClientId } = require("./config.js");
const { request } = require("./http.js");
const {
  saveSecret,
  clearSecrets,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_ACCOUNT_TOKEN,
} = require("./storage.js");

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function rankConnection(c) {
  let score = 0;
  if (c.local) score += 100;
  if (c.relay) score -= 50;
  const uri = c.uri || "";
  if (uri.indexOf("http://") === 0) score += 20;
  if (uri.indexOf("https://") === 0) score += 5;
  return score;
}

function sortConnections(connections) {
  return (connections || []).slice().sort(function (a, b) {
    return rankConnection(b) - rankConnection(a);
  });
}

function resourceToServer(r) {
  const connections = sortConnections(r.connections || []);
  return {
    name: r.name || r.clientIdentifier || "Plex Server",
    clientIdentifier: r.clientIdentifier,
    owned: !!r.owned,
    accessToken: r.accessToken || "",
    connections: connections.map(function (c) {
      return {
        uri: c.uri,
        local: !!c.local,
        relay: !!c.relay,
        protocol: c.protocol,
      };
    }),
  };
}

async function createPin(http, preferences) {
  const res = await request(
    http,
    preferences,
    "post",
    "https://plex.tv/api/v2/pins?strong=true",
    {}
  );
  if (res.statusCode >= 400 || !res.body) {
    throw new Error("PIN create failed: HTTP " + res.statusCode);
  }
  return { id: res.body.id, code: res.body.code };
}

function authUrl(preferences, code) {
  const clientId = ensureClientId(preferences);
  return (
    "https://app.plex.tv/auth#?clientID=" +
    encodeURIComponent(clientId) +
    "&code=" +
    encodeURIComponent(code) +
    "&context%5Bdevice%5D%5Bproduct%5D=" +
    encodeURIComponent("IINA Plex Sync")
  );
}

async function pollPin(http, preferences, pinId) {
  const started = Date.now();
  while (Date.now() - started < PIN_TIMEOUT_MS) {
    const res = await request(
      http,
      preferences,
      "get",
      "https://plex.tv/api/v2/pins/" + pinId,
      {}
    );
    if (res.body && res.body.authToken) {
      return res.body.authToken;
    }
    await sleep(PIN_POLL_MS);
  }
  throw new Error("Sign-in timed out. Try again.");
}

async function fetchUser(http, preferences, accountToken) {
  const res = await request(
    http,
    preferences,
    "get",
    "https://plex.tv/api/v2/user",
    { token: accountToken }
  );
  if (res.body && (res.body.username || res.body.title)) {
    return res.body.username || res.body.title;
  }
  // fallback older endpoint shape
  const res2 = await request(
    http,
    preferences,
    "get",
    "https://plex.tv/users/account.json",
    { token: accountToken }
  );
  if (res2.body && res2.body.user) {
    return res2.body.user.username || res2.body.user.email || "Plex user";
  }
  return "Plex user";
}

async function fetchServers(http, preferences, accountToken) {
  const res = await request(
    http,
    preferences,
    "get",
    "https://plex.tv/api/v2/resources",
    {
      token: accountToken,
      params: { includeHttps: "1", includeRelay: "1" },
    }
  );
  const list = Array.isArray(res.body) ? res.body : [];
  return list
    .filter(function (r) {
      const p = (r.provides || "").toLowerCase();
      return p.indexOf("server") >= 0;
    })
    .map(resourceToServer)
    .filter(function (s) {
      return s.accessToken && s.connections.length;
    });
}

function pickDefaultServer(servers) {
  if (!servers.length) return null;
  const owned = servers.filter(function (s) {
    return s.owned;
  });
  const pool = owned.length ? owned : servers;
  const server = pool[0];
  const uri = server.connections[0].uri;
  const uris = server.connections.map(function (c) {
    return c.uri;
  });
  return { server: server, uri: uri, uris: uris };
}

function applyServerChoice(preferences, utils, server, uri, uris) {
  saveSecret(utils, preferences, KEYCHAIN_ACCOUNT, server.accessToken);
  preferences.set("plex_server_name", server.name);
  preferences.set("plex_server_uri", uri);
  preferences.set("plex_server_uris", JSON.stringify(uris || [uri]));
  preferences.sync();
}

async function signInWithPlex(http, utils, preferences, console) {
  console.log("Starting Plex PIN sign-in…");
  const pin = await createPin(http, preferences);
  const url = authUrl(preferences, pin.code);
  console.log("Opening browser for Plex auth, code=" + pin.code);
  utils.open(url);

  const accountToken = await pollPin(http, preferences, pin.id);
  saveSecret(utils, preferences, KEYCHAIN_ACCOUNT_TOKEN, accountToken);

  const username = await fetchUser(http, preferences, accountToken);
  const servers = await fetchServers(http, preferences, accountToken);
  if (!servers.length) {
    throw new Error("No Plex servers found for this account.");
  }

  preferences.set("servers_json", JSON.stringify(servers));
  preferences.set(
    "servers_names",
    servers
      .map(function (s) {
        return s.name || s.clientIdentifier || "";
      })
      .filter(Boolean)
      .join("\n")
  );
  preferences.set("plex_username", username);
  preferences.set("signed_in", true);
  preferences.sync();

  const picked = pickDefaultServer(servers);
  applyServerChoice(preferences, utils, picked.server, picked.uri, picked.uris);

  console.log(
    "Signed in as " +
      username +
      "; server=" +
      picked.server.name +
      " uri=" +
      picked.uri
  );
  return {
    username: username,
    server: picked.server,
    uri: picked.uri,
    servers: servers,
  };
}

function signOut(utils, preferences) {
  clearSecrets(utils, preferences);
}

function selectServerByName(utils, preferences, name) {
  let servers = [];
  try {
    servers = JSON.parse(preferences.get("servers_json") || "[]");
  } catch (e) {
    servers = [];
  }
  const server = servers.filter(function (s) {
    return s.name === name;
  })[0];
  if (!server) return false;
  const uris = (server.connections || []).map(function (c) {
    return c.uri;
  });
  const uri = uris[0];
  if (!uri || !server.accessToken) return false;
  applyServerChoice(preferences, utils, server, uri, uris);
  return true;
}

module.exports = {
  signInWithPlex,
  signOut,
  fetchServers,
  pickDefaultServer,
  applyServerChoice,
  selectServerByName,
  sortConnections,
};
