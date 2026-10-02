const {
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_ACCOUNT_TOKEN,
} = require("./config.js");

function saveSecret(utils, preferences, keyName, value) {
  try {
    const ok = utils.keyChainWrite(KEYCHAIN_SERVICE, keyName, value);
    if (ok) {
      if (keyName === KEYCHAIN_ACCOUNT) {
        preferences.set("plex_access_token", "");
        preferences.set("token_in_prefs", false);
      }
      preferences.sync();
      return "keychain";
    }
  } catch (e) {
    // fall through
  }
  if (keyName === KEYCHAIN_ACCOUNT) {
    preferences.set("plex_access_token", value);
    preferences.set("token_in_prefs", true);
    preferences.sync();
    return "prefs";
  }
  // account token only in prefs as backup name
  preferences.set("plex_account_token", value);
  preferences.sync();
  return "prefs";
}

function readSecret(utils, preferences, keyName) {
  try {
    const v = utils.keyChainRead(KEYCHAIN_SERVICE, keyName);
    if (v && typeof v === "string") return v;
  } catch (e) {
    // fall through
  }
  if (keyName === KEYCHAIN_ACCOUNT) {
    return preferences.get("plex_access_token") || "";
  }
  return preferences.get("plex_account_token") || "";
}

function clearSecrets(utils, preferences) {
  try {
    utils.keyChainWrite(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, "");
    utils.keyChainWrite(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_TOKEN, "");
  } catch (e) {
    // ignore
  }
  preferences.set("plex_access_token", "");
  preferences.set("plex_account_token", "");
  preferences.set("token_in_prefs", false);
  preferences.set("signed_in", false);
  preferences.set("plex_username", "");
  preferences.set("plex_server_name", "");
  preferences.set("plex_server_uri", "");
  preferences.set("plex_server_uris", "[]");
  preferences.set("servers_json", "[]");
  preferences.set("servers_names", "");
  preferences.set("library_index_json", "");
  preferences.set("index_built_at", "");
  preferences.set("index_count", 0);
  preferences.set("last_scrobble_at", "");
  preferences.set("last_scrobble_title", "");
  preferences.set("last_scrobble_event", "");
  preferences.set("ui_command", "");
  preferences.sync();
}

function getSession(utils, preferences) {
  const accessToken = readSecret(utils, preferences, KEYCHAIN_ACCOUNT);
  const accountToken = readSecret(utils, preferences, KEYCHAIN_ACCOUNT_TOKEN) || accessToken;
  const uri = preferences.get("plex_server_uri") || "";
  let uris = [];
  try {
    uris = JSON.parse(preferences.get("plex_server_uris") || "[]");
  } catch (e) {
    uris = uri ? [uri] : [];
  }
  if (uri && uris.indexOf(uri) < 0) uris.unshift(uri);
  return {
    accessToken,
    accountToken,
    uri,
    uris,
    username: preferences.get("plex_username") || "",
    serverName: preferences.get("plex_server_name") || "",
    signedIn: !!preferences.get("signed_in") && !!accessToken && !!uri,
  };
}

module.exports = {
  saveSecret,
  readSecret,
  clearSecrets,
  getSession,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_ACCOUNT_TOKEN,
};
