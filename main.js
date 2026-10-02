const { console, core, event, http, mpv, preferences, utils, input } = iina;
const { TIMELINE_INTERVAL_MS, ensureClientId } = require("./lib/config.js");
const { getSession } = require("./lib/storage.js");
const { resolveRatingKey, pathFromUrl } = require("./lib/index.js");
const { withFailover, timeline, scrobble } = require("./lib/plex.js");
const hud = require("./lib/hud.js");

ensureClientId(preferences);

let timer = null;
let hudTimer = null;
let lastTimelineAt = 0;
let current = {
  path: null,
  ratingKey: null,
  scrobbled: false,
  resolving: false,
  status: "IDLE",
};

function osd(msg) {
  if (!preferences.get("enable_osd")) return;
  try {
    core.osd(msg);
  } catch (e) {
    console.log(msg);
  }
}

function titleFromPath(path) {
  if (!path) return "";
  const cleaned = String(path).replace(/\\/g, "/");
  const parts = cleaned.split("/");
  return parts[parts.length - 1] || cleaned;
}

function recordScrobble(event, path) {
  preferences.set("last_scrobble_event", event);
  preferences.set("last_scrobble_title", titleFromPath(path || current.path || ""));
  preferences.set("last_scrobble_at", new Date().toISOString());
  preferences.sync();
}

function clearTimer() {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

function clearHudTimer() {
  if (hudTimer != null) {
    clearInterval(hudTimer);
    hudTimer = null;
  }
}

function progressPct() {
  let pos = null;
  let dur = null;
  try {
    pos = mpv.getNumber("time-pos");
    dur = mpv.getNumber("duration");
  } catch (e) {
    return null;
  }
  if (pos == null || dur == null || !(dur > 0)) return null;
  return {
    pct: Math.min(100, (100 * pos) / dur),
    pos: pos,
    dur: dur,
    timeMs: Math.floor(pos * 1000),
    durationMs: Math.floor(dur * 1000),
  };
}

function hudEnabled() {
  const v = preferences.get("enable_hud");
  return v === undefined || v === null ? true : !!v;
}

function syncEnabled() {
  const v = preferences.get("sync_enabled");
  return v === undefined || v === null ? true : !!v;
}

function refreshHud() {
  if (!hudEnabled()) {
    clearHudTimer();
    hud.hide();
    return;
  }
  if (!current.path && current.status === "IDLE") {
    hud.hide();
    return;
  }

  const session = getSession(utils, preferences);
  const prog = progressPct();
  const threshold = Number(preferences.get("progress_threshold")) || 90;
  const syncOn = syncEnabled();
  let nextTl = "--";
  if (syncOn && lastTimelineAt && current.ratingKey) {
    const left = Math.max(
      0,
      Math.ceil((TIMELINE_INTERVAL_MS - (Date.now() - lastTimelineAt)) / 1000)
    );
    nextTl = left + "s";
  }

  let detail = "";
  if (prog) {
    detail =
      "pos " +
      hud.formatClock(prog.pos) +
      " / " +
      hud.formatClock(prog.dur) +
      " · " +
      Math.floor(prog.pct) +
      "% · watched≥" +
      threshold +
      "%";
  }

  let geek = "";
  if (!syncOn) {
    geek = "Plex sync paused · ⌃⇧S to resume";
  } else if (current.ratingKey) {
    geek =
      "ratingKey " +
      current.ratingKey +
      " · next timeline " +
      nextTl +
      (current.scrobbled ? " · scrobbled" : "");
  } else if (current.status === "NO MATCH") {
    geek = "no Plex library match for this file";
  } else if (current.status === "SYNC OFF") {
    geek = "Plex sync paused · ⌃⇧S to resume";
  }

  // Re-check after work — a toggle-off may have landed mid-refresh.
  if (!hudEnabled()) {
    clearHudTimer();
    hud.hide();
    return;
  }

  const status = !syncOn
    ? "SYNC OFF"
    : current.status === "SYNC OFF"
      ? "IDLE"
      : current.status;

  hud.render({
    status: status,
    accountLine: session.signedIn
      ? (session.username || "Plex") +
        (session.serverName ? " @ " + session.serverName : "")
      : "not signed in",
    file: titleFromPath(current.path),
    detail: detail,
    geek: geek,
  });
}

function startHudLoop() {
  clearHudTimer();
  if (!hudEnabled()) {
    hud.hide();
    return;
  }
  refreshHud();
  hudTimer = setInterval(refreshHud, 1000);
}

function stopHud() {
  clearHudTimer();
  current.status = "IDLE";
  hud.hide();
}

let lastToggleAt = 0;
function toggleHud() {
  const now = Date.now();
  // Menu key-repeat / double-fires will otherwise race overlay.show/hide.
  if (now - lastToggleAt < 350) return;
  lastToggleAt = now;

  const next = !hudEnabled();
  preferences.set("enable_hud", next);
  preferences.sync();
  if (next) {
    startHudLoop();
    osd("Plex Sync HUD on");
  } else {
    clearHudTimer();
    hud.hide();
    osd("Plex Sync HUD off");
  }
}

let lastSyncToggleAt = 0;

function applySyncEnabled(next, opts) {
  opts = opts || {};
  const quiet = !!opts.quiet;
  preferences.set("sync_enabled", !!next);
  preferences.sync();

  if (!next) {
    clearTimer();
    if (current.path) {
      current.status = "SYNC OFF";
      startHudLoop();
    }
    if (!quiet) osd("Plex sync off");
    return;
  }

  if (!quiet) osd("Plex sync on");
  if (current.path && !current.resolving) {
    onFileLoaded();
  } else {
    refreshHud();
  }
}

function toggleSync() {
  const now = Date.now();
  if (now - lastSyncToggleAt < 350) return;
  lastSyncToggleAt = now;
  applySyncEnabled(!syncEnabled());
}

async function report(state) {
  if (!syncEnabled()) return;
  if (!current.ratingKey) return;
  const prog = progressPct();
  const timeMs = prog ? prog.timeMs : 0;
  const durationMs = prog ? prog.durationMs : 0;
  const threshold = Number(preferences.get("progress_threshold")) || 90;

  try {
    await withFailover(http, preferences, utils, function (session) {
      return timeline(http, preferences, session, {
        ratingKey: current.ratingKey,
        state: state,
        timeMs: timeMs,
        durationMs: durationMs,
      });
    });
    lastTimelineAt = Date.now();
  } catch (e) {
    console.log("timeline failed: " + e);
    return;
  }

  if (
    !current.scrobbled &&
    prog &&
    prog.pct >= threshold &&
    (state === "playing" || state === "paused" || state === "stopped")
  ) {
    try {
      await withFailover(http, preferences, utils, function (session) {
        return scrobble(http, preferences, session, current.ratingKey);
      });
      current.scrobbled = true;
      current.status = "WATCHED";
      recordScrobble("watched", current.path);
      osd("Plex: marked watched");
      refreshHud();
      console.log("scrobbled ratingKey=" + current.ratingKey);
    } catch (e) {
      console.log("scrobble failed: " + e);
    }
  }
}

async function onFileLoaded() {
  clearTimer();
  stopHud();
  current = {
    path: null,
    ratingKey: null,
    scrobbled: false,
    resolving: true,
    status: "IDLE",
  };
  lastTimelineAt = 0;

  if (!syncEnabled()) {
    current.resolving = false;
    // Keep path so HUD can show SYNC OFF while a file is open.
    let path = "";
    try {
      path = mpv.getString("path") || mpv.getString("stream-open-filename") || "";
    } catch (e) {
      path = "";
    }
    if (!path && core.status && core.status.url) path = core.status.url;
    path = pathFromUrl(path);
    current.path = path;
    if (path && path.indexOf("http://") !== 0 && path.indexOf("https://") !== 0) {
      current.status = "SYNC OFF";
      startHudLoop();
    }
    return;
  }

  const session = getSession(utils, preferences);
  if (!session.signedIn) {
    current.resolving = false;
    return;
  }

  let path = "";
  try {
    path = mpv.getString("path") || mpv.getString("stream-open-filename") || "";
  } catch (e) {
    path = "";
  }
  if (!path && core.status && core.status.url) path = core.status.url;
  path = pathFromUrl(path);
  current.path = path;

  if (!path || path.indexOf("http://") === 0 || path.indexOf("https://") === 0) {
    current.resolving = false;
    return;
  }

  let localSize = 0;
  try {
    localSize = Number(mpv.getNumber("file-size")) || 0;
  } catch (e) {
    localSize = 0;
  }

  try {
    const rk = await resolveRatingKey(
      http,
      preferences,
      session,
      path,
      console,
      localSize
    );
    current.ratingKey = rk;
    current.resolving = false;
    if (!rk) {
      current.status = "NO MATCH";
      recordScrobble("no_match", path);
      osd("Plex: no library match");
      startHudLoop();
      return;
    }
    console.log("Matched " + path + " → ratingKey " + rk);
    current.status = "ACTIVE";
    recordScrobble("syncing", path);
    osd("Plex: syncing");
    startHudLoop();
    await report("playing");
    timer = setInterval(function () {
      report("playing");
    }, TIMELINE_INTERVAL_MS);
  } catch (e) {
    current.resolving = false;
    console.log("resolve failed: " + e);
  }
}

async function onEndFile() {
  clearTimer();
  if (current.ratingKey) {
    await report("stopped");
  }
  stopHud();
  current = {
    path: null,
    ratingKey: null,
    scrobbled: false,
    resolving: false,
    status: "IDLE",
  };
  lastTimelineAt = 0;
}

// Prefs / global can ask main to toggle HUD / sync
setInterval(function () {
  const cmd = preferences.get("ui_command_player");
  if (!cmd) return;
  preferences.set("ui_command_player", "");
  preferences.sync();
  if (cmd === "toggle_hud") {
    toggleHud();
  } else if (cmd === "show_hud") {
    preferences.set("enable_hud", true);
    preferences.sync();
    startHudLoop();
  } else if (cmd === "hide_hud") {
    preferences.set("enable_hud", false);
    preferences.sync();
    clearHudTimer();
    hud.hide();
  } else if (cmd === "toggle_sync") {
    toggleSync();
  } else if (cmd === "enable_sync") {
    applySyncEnabled(true);
  } else if (cmd === "disable_sync") {
    applySyncEnabled(false);
  }
}, 400);

// Reliable shortcuts during playback (menu keyBinding alone is flaky).
try {
  if (input && typeof input.onKeyDown === "function") {
    const pri =
      typeof input.PRIORITY_HIGH === "number" ? input.PRIORITY_HIGH : 200;
    input.onKeyDown(
      "Ctrl+Shift+p",
      function () {
        toggleHud();
        return true;
      },
      pri
    );
    input.onKeyDown(
      "Ctrl+Shift+s",
      function () {
        toggleSync();
        return true;
      },
      pri
    );
  }
} catch (e) {
  console.log("Key bind failed: " + e);
}

event.on("mpv.file-loaded", function () {
  onFileLoaded();
});

event.on("iina.file-loaded", function () {
  if (!current.ratingKey && !current.resolving) onFileLoaded();
});

event.on("mpv.end-file", function () {
  onEndFile();
});

event.on("mpv.pause", function () {
  if (mpv.getFlag("pause")) report("paused");
  else report("playing");
});

console.log("IINA Plex Sync main entry loaded");
