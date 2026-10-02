const { console, menu, http, utils, preferences } = iina;
const { signInWithPlex, signOut, selectServerByName } = require("./lib/auth.js");
const { getSession } = require("./lib/storage.js");
const { buildIndex, clearIndex } = require("./lib/index.js");
const { ensureClientId } = require("./lib/config.js");

ensureClientId(preferences);

let signingIn = false;
let indexing = false;

function logStatus(msg) {
  console.log(msg);
}

async function doSignIn() {
  if (signingIn) return;
  signingIn = true;
  try {
    const result = await signInWithPlex(http, utils, preferences, console);
    logStatus(
      "Signed in as " +
        result.username +
        "; server=" +
        result.server.name +
        ". Ready — index builds on demand while you watch (or use Refresh Library Index)."
    );
    // Do NOT await a full-library index here — it downloads entire
    // Movie/TV catalogs and freezes IINA's UI (beach ball).
    scheduleRebuildMenu();
  } catch (e) {
    console.log("Sign-in failed: " + e);
    logStatus("Plex sign-in failed: " + (e && e.message ? e.message : e));
    scheduleRebuildMenu();
  } finally {
    signingIn = false;
  }
}

function doSignOut() {
  signOut(utils, preferences);
  clearIndex(preferences);
  logStatus("Signed out of Plex.");
}

async function doBuildIndex(quiet) {
  if (indexing) return;
  const session = getSession(utils, preferences);
  if (!session.signedIn) {
    if (!quiet) logStatus("Sign in with Plex first.");
    return;
  }
  indexing = true;
  scheduleRebuildMenu();
  logStatus("Building library index in background (IINA may feel slow until done)…");
  // Yield so the menu can redraw before the heavy work starts.
  await new Promise(function (resolve) {
    setTimeout(resolve, 50);
  });
  try {
    const index = await buildIndex(http, preferences, session, console);
    const count = Object.keys(index.basenames).length;
    logStatus("Library index ready: " + count + " files.");
  } catch (e) {
    console.log("Index build failed: " + e);
    if (!quiet) {
      logStatus("Library index failed: " + (e && e.message ? e.message : e));
    }
  } finally {
    indexing = false;
    scheduleRebuildMenu();
  }
}

function rebuildMenu() {
  menu.removeAllItems();
  const session = getSession(utils, preferences);
  const hudOn = preferences.get("enable_hud");
  const hudEnabled = hudOn === undefined || hudOn === null ? true : !!hudOn;
  const syncOn = preferences.get("sync_enabled");
  const syncEnabled = syncOn === undefined || syncOn === null ? true : !!syncOn;

  // First actionable items (IINA only shows ~5 top-level plugin items).
  // Explicit Ctrl+Shift+… with lowercase letter so Cocoa gets the Shift mask.
  menu.addItem(
    menu.item(
      syncEnabled ? "Pause Plex Sync" : "Resume Plex Sync",
      function () {
        preferences.set("ui_command_player", "toggle_sync");
        preferences.sync();
        setTimeout(scheduleRebuildMenu, 500);
      },
      { keyBinding: "Ctrl+Shift+s", selected: syncEnabled }
    )
  );
  menu.addItem(
    menu.item(
      hudEnabled ? "Hide Sync HUD" : "Show Sync HUD",
      function () {
        preferences.set("ui_command_player", "toggle_hud");
        preferences.sync();
        setTimeout(scheduleRebuildMenu, 500);
      },
      { keyBinding: "Ctrl+Shift+p", selected: hudEnabled }
    )
  );

  if (session.signedIn) {
    menu.addItem(
      menu.item("Signed in as " + (session.username || "Plex user"), null, {
        enabled: false,
      })
    );
    menu.addItem(
      menu.item("Server: " + (session.serverName || session.uri), null, {
        enabled: false,
      })
    );

    let servers = [];
    try {
      servers = JSON.parse(preferences.get("servers_json") || "[]");
    } catch (e) {
      servers = [];
    }
    if (servers.length > 1) {
      const serverMenu = menu.item("Choose Server");
      servers.forEach(function (s) {
        serverMenu.addSubmenuItem(
          menu.item(
            s.name + (s.name === session.serverName ? " ✓" : ""),
            function () {
              if (selectServerByName(utils, preferences, s.name)) {
                clearIndex(preferences);
                scheduleRebuildMenu();
              }
            },
            { selected: s.name === session.serverName }
          )
        );
      });
      menu.addItem(serverMenu);
    }

    menu.addItem(
      menu.item("Refresh Library Index", function () {
        doBuildIndex(false).then(function () {
          scheduleRebuildMenu();
        });
      })
    );
    menu.addItem(
      menu.item("Sign Out of Plex", function () {
        doSignOut();
        scheduleRebuildMenu();
      })
    );
  } else {
    menu.addItem(
      menu.item("Sign in with Plex…", function () {
        doSignIn();
      })
    );
  }
  // Do NOT call menu.forceUpdate() here — during plugin load it re-enters
  // PlayerCore creation and crashes IINA (recursive dispatch_once).
}

function scheduleRebuildMenu() {
  setTimeout(function () {
    try {
      rebuildMenu();
    } catch (e) {
      console.log("rebuildMenu failed: " + e);
    }
  }, 0);
}

(function boot() {
  // Prefs webview cannot safely preferences.get("servers_json") (IINA JS bridge
  // breaks on the embedded quotes). Keep a plain newline name list for prefs.
  try {
    if (!preferences.get("servers_names")) {
      const raw = preferences.get("servers_json") || "[]";
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length) {
        preferences.set(
          "servers_names",
          list
            .map(function (s) {
              return s.name || s.clientIdentifier || "";
            })
            .filter(Boolean)
            .join("\n")
        );
        preferences.sync();
      }
    }
  } catch (e) {
    // ignore
  }

  // Defer past applicationDidFinishLaunching plugin load
  setTimeout(function () {
    scheduleRebuildMenu();
  }, 250);

  setInterval(function () {
    const cmd = preferences.get("ui_command");
    if (!cmd) return;
    preferences.set("ui_command", "");
    preferences.sync();
    if (cmd === "sign_in") {
      doSignIn();
    } else if (cmd === "sign_out") {
      doSignOut();
      scheduleRebuildMenu();
    } else if (cmd.indexOf("select_server:") === 0) {
      const name = cmd.slice("select_server:".length);
      if (name && selectServerByName(utils, preferences, name)) {
        clearIndex(preferences);
        scheduleRebuildMenu();
      }
    }
  }, 500);
})();
