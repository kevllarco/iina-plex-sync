const { overlay, preferences, event, console } = iina;

let ready = false;
let visible = false;
let pageLoaded = false;
let pendingState = null;
let sentInitialLayout = false;
/** Monotonic token so a stale render cannot re-show after hide/toggle. */
let showEpoch = 0;

const ANCHORS = { tl: 1, tr: 1, bl: 1, br: 1 };

function hudPrefEnabled() {
  const v = preferences.get("enable_hud");
  return v === undefined || v === null ? true : !!v;
}

function loadLayout() {
  const anchor = preferences.get("hud_anchor");
  if (anchor && ANCHORS[anchor]) {
    return { anchor: anchor, fx: 0, fy: 0 };
  }
  if (anchor === "free") {
    const fx = Number(preferences.get("hud_fx"));
    const fy = Number(preferences.get("hud_fy"));
    return {
      anchor: "free",
      fx: Number.isFinite(fx) ? Math.max(0, Math.min(1, fx)) : 0,
      fy: Number.isFinite(fy) ? Math.max(0, Math.min(1, fy)) : 0,
    };
  }
  const x = Number(preferences.get("hud_x"));
  const y = Number(preferences.get("hud_y"));
  if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0) {
    // Legacy pixel prefs without an explicit free/corner anchor.
    if (x !== 16 || y !== 16) {
      return { anchor: "legacy", x: Math.round(x), y: Math.round(y) };
    }
  }
  return { anchor: "tl", fx: 0, fy: 0 };
}

function saveLayout(data) {
  if (!data || typeof data !== "object") return;
  const anchor = data.anchor && ANCHORS[data.anchor] ? data.anchor : "free";
  preferences.set("hud_anchor", anchor === "free" ? "free" : anchor);
  if (anchor === "free") {
    const fx = Number(data.fx);
    const fy = Number(data.fy);
    preferences.set(
      "hud_fx",
      Number.isFinite(fx) ? Math.max(0, Math.min(1, fx)) : 0
    );
    preferences.set(
      "hud_fy",
      Number.isFinite(fy) ? Math.max(0, Math.min(1, fy)) : 0
    );
  }
  if (typeof data.x === "number") preferences.set("hud_x", Math.round(data.x));
  if (typeof data.y === "number") preferences.set("hud_y", Math.round(data.y));
  preferences.sync();
  try {
    console.log("HUD layout saved: " + preferences.get("hud_anchor"));
  } catch (e) {}
}

/**
 * IINA's overlay.onMessage is a no-op until overlayViewLoaded is true.
 * loadFile() sets that flag asynchronously and also clearListeners(), so we
 * must (re)bind only after iina.plugin-overlay-loaded — not right after loadFile.
 */
function bindListeners() {
  try {
    overlay.onMessage("hud-ready", function () {
      pageLoaded = true;
      sentInitialLayout = false;
      try {
        if (visible && hudPrefEnabled()) overlay.setClickable(true);
      } catch (e) {}
      pushState(pendingState || { status: "IDLE" });
    });
    overlay.onMessage("hud-moved", function (data) {
      saveLayout(data);
    });
  } catch (e) {}
}

function ensureReady() {
  if (ready) return;
  try {
    overlay.loadFile("overlay.html");
    ready = true;
    pageLoaded = false;
    sentInitialLayout = false;
  } catch (e) {
    ready = false;
  }
}

function attachLayout(payload) {
  const layout = loadLayout();
  if (layout.anchor === "legacy") {
    payload.x = layout.x;
    payload.y = layout.y;
  } else if (layout.anchor === "free") {
    payload.anchor = "free";
    payload.fx = layout.fx;
    payload.fy = layout.fy;
  } else {
    payload.anchor = layout.anchor || "tl";
  }
}

function pushState(state) {
  pendingState = state || pendingState;
  if (!pageLoaded || !pendingState) return;
  if (!hudPrefEnabled() || !visible) return;
  const payload = {
    status: pendingState.status || "IDLE",
    accountLine: pendingState.accountLine || "",
    file: pendingState.file || "",
    detail: pendingState.detail || "",
    geek: pendingState.geek || "",
  };
  // Re-send saved corner/position after hide, reload, or first show.
  if (!sentInitialLayout) {
    attachLayout(payload);
    sentInitialLayout = true;
  }
  try {
    overlay.postMessage("hud-update", payload);
  } catch (e) {}
}

function formatClock(sec) {
  if (sec == null || !(sec >= 0)) return "--:--";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = (m < 10 ? "0" : "") + m;
  const ss = (r < 10 ? "0" : "") + r;
  if (h > 0) return h + ":" + mm + ":" + ss;
  return mm + ":" + ss;
}

function render(state) {
  if (!hudPrefEnabled()) {
    hide();
    return;
  }
  const epoch = showEpoch;
  ensureReady();
  if (!ready) {
    pendingState = state;
    return;
  }
  pendingState = state;
  if (epoch !== showEpoch) return; // hidden while we were setting up
  // Show first so pushState is allowed to deliver layout + status.
  if (!visible) {
    try {
      overlay.setOpacity(1);
      overlay.setClickable(true);
      overlay.show();
      visible = true;
    } catch (e) {}
  }
  // Belt-and-suspenders: once the overlay view exists, onMessage works.
  bindListeners();
  pushState(state);
}

function hide() {
  showEpoch += 1;
  visible = false;
  // Next show must re-apply saved corner (overlay may reload or reset).
  sentInitialLayout = false;
  try {
    overlay.postMessage("hud-hide", {});
  } catch (e) {}
  try {
    overlay.hide();
    overlay.setClickable(false);
  } catch (e) {}
}

try {
  event.on("iina.window-loaded", function () {
    ready = false;
    pageLoaded = false;
    sentInitialLayout = false;
    ensureReady();
  });
  event.on("iina.plugin-overlay-loaded", function () {
    // loadFile clears listeners and only then sets overlayViewLoaded — bind here.
    bindListeners();
    pageLoaded = true;
    sentInitialLayout = false;
    if (visible && hudPrefEnabled()) {
      try {
        overlay.show();
        overlay.setClickable(true);
      } catch (e) {}
      pushState(pendingState || { status: "IDLE" });
    }
  });
} catch (e) {}

module.exports = {
  formatClock,
  render,
  hide,
};
