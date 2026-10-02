const PRODUCT = "IINA Plex Sync";
const VERSION = "1.0.0";
const KEYCHAIN_SERVICE = "plex";
const KEYCHAIN_ACCOUNT = "access-token";
const KEYCHAIN_ACCOUNT_TOKEN = "account-token";
const PIN_POLL_MS = 1500;
const PIN_TIMEOUT_MS = 5 * 60 * 1000;
const TIMELINE_INTERVAL_MS = 10000;
const INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INDEX_PREF_KEY = "library_index_json";

function uuid() {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += hex[Math.floor(Math.random() * 16)];
    if (i === 7 || i === 11 || i === 15 || i === 19) out += "-";
  }
  return out;
}

function ensureClientId(preferences) {
  let id = preferences.get("client_id");
  if (!id || typeof id !== "string" || id.length < 8) {
    id = uuid();
    preferences.set("client_id", id);
    preferences.sync();
  }
  return id;
}

function plexHeaders(clientId, token) {
  const headers = {
    Accept: "application/json",
    "X-Plex-Product": PRODUCT,
    "X-Plex-Version": VERSION,
    "X-Plex-Client-Identifier": clientId,
    "X-Plex-Platform": "macOS",
    "X-Plex-Device": "IINA",
    "X-Plex-Device-Name": "IINA Plex Sync",
    "X-Plex-Model": "bundled",
  };
  if (token) headers["X-Plex-Token"] = token;
  return headers;
}

module.exports = {
  PRODUCT,
  VERSION,
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_ACCOUNT_TOKEN,
  PIN_POLL_MS,
  PIN_TIMEOUT_MS,
  TIMELINE_INTERVAL_MS,
  INDEX_MAX_AGE_MS,
  INDEX_PREF_KEY,
  ensureClientId,
  plexHeaders,
};
