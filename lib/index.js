const { INDEX_MAX_AGE_MS, INDEX_PREF_KEY } = require("./config.js");
const { request, joinUrl } = require("./http.js");

/** Minimum shared path segments (besides basename) to treat paths as the same file. */
const PATH_SUFFIX_DEPTH = 2;

function basename(path) {
  if (!path) return "";
  const cleaned = String(path).split("?")[0].replace(/\\/g, "/");
  const parts = cleaned.split("/");
  return (parts[parts.length - 1] || "").toLowerCase();
}

function pathFromUrl(url) {
  if (!url) return "";
  let s = String(url);
  if (s.indexOf("file://") === 0) {
    s = decodeURIComponent(s.replace(/^file:\/\//, ""));
    if (/^\/[A-Za-z]:/.test(s)) {
      // keep windows-style
    } else if (s.charAt(0) !== "/") {
      s = "/" + s;
    }
  }
  return s;
}

function pathSegments(path) {
  return pathFromUrl(path)
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
}

/** Last `depth` segments joined, e.g. "movies/foo/bar.mkv". */
function pathSuffix(path, depth) {
  const parts = pathSegments(path);
  if (!parts.length) return "";
  const n = Math.max(1, depth || PATH_SUFFIX_DEPTH + 1);
  return parts.slice(-n).join("/");
}

/**
 * Score how well a Plex Part path matches the local path.
 * Basename must match. Prefer longer shared path tails (NAS mount prefixes differ).
 * Returns -1 if not a match.
 */
function pathMatchScore(localPath, plexFile) {
  if (!localPath || !plexFile) return -1;
  if (basename(localPath) !== basename(plexFile)) return -1;
  const a = pathSegments(localPath);
  const b = pathSegments(plexFile);
  let shared = 0;
  const max = Math.min(a.length, b.length);
  for (let i = 1; i <= max; i++) {
    if (a[a.length - i] !== b[b.length - i]) break;
    shared = i;
  }
  // basename alone = 1; require at least parent+file when both have depth
  if (a.length >= 2 && b.length >= 2 && shared < PATH_SUFFIX_DEPTH + 1) {
    // Still accept basename-only when paths are too shallow on one side,
    // but give it a low score so disambiguation prefers deeper matches.
    return shared;
  }
  return shared;
}

function sizesCompatible(localSize, plexSize) {
  const a = Number(localSize);
  const b = Number(plexSize);
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0) {
    return true; // unknown → don't reject
  }
  return a === b;
}

function loadIndex(preferences) {
  try {
    const raw = preferences.get(INDEX_PREF_KEY) || "";
    if (!raw) {
      return { builtAt: "", basenames: {}, ambiguous: {} };
    }
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      builtAt: data.builtAt || "",
      basenames: data.basenames || {},
      ambiguous: data.ambiguous || {},
    };
  } catch (e) {
    return { builtAt: "", basenames: {}, ambiguous: {} };
  }
}

function saveIndex(preferences, index) {
  const payload = {
    builtAt: index.builtAt,
    basenames: index.basenames,
    ambiguous: index.ambiguous,
    count: Object.keys(index.basenames).length,
  };
  preferences.set(INDEX_PREF_KEY, JSON.stringify(payload));
  preferences.set("index_built_at", index.builtAt || "");
  preferences.set("index_count", payload.count);
  preferences.sync();
}

function clearIndex(preferences) {
  preferences.set(INDEX_PREF_KEY, "");
  preferences.set("index_built_at", "");
  preferences.set("index_count", 0);
  preferences.sync();
}

function readIndexRatingKey(index, base) {
  const v = index.basenames[base];
  if (v == null) return null;
  if (typeof v === "object") return v.ratingKey ? String(v.ratingKey) : null;
  return String(v);
}

function addPart(acc, ratingKey, filePath, size) {
  const base = basename(filePath);
  if (!base || !ratingKey) return;
  const rk = String(ratingKey);
  if (acc.ambiguous[base]) return;
  const existing = readIndexRatingKey(acc, base);
  if (existing && existing !== rk) {
    delete acc.basenames[base];
    acc.ambiguous[base] = true;
    return;
  }
  const entry = { ratingKey: rk };
  const sz = Number(size);
  if (Number.isFinite(sz) && sz > 0) entry.size = sz;
  const suf = pathSuffix(filePath, PATH_SUFFIX_DEPTH + 1);
  if (suf) entry.suffix = suf;
  acc.basenames[base] = entry;
}

function walkMetadata(acc, items) {
  (items || []).forEach(function (meta) {
    const rk = meta.ratingKey;
    const medias = meta.Media || [];
    medias.forEach(function (m) {
      const parts = m.Part || [];
      parts.forEach(function (part) {
        if (part.file) addPart(acc, rk, part.file, part.size);
      });
    });
  });
}

function yieldUi() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
}

async function fetchSectionItems(http, preferences, baseUri, token, sectionId, type) {
  const pageSize = 100;
  let start = 0;
  const all = [];

  while (true) {
    const url = joinUrl(baseUri, "/library/sections/" + sectionId + "/all");
    const res = await request(http, preferences, "get", url, {
      token: token,
      headers: {
        Accept: "application/xml",
        "X-Plex-Container-Start": String(start),
        "X-Plex-Container-Size": String(pageSize),
      },
      params: { type: String(type) },
    });

    const text = res.text || "";
    let page = [];
    if (
      text.indexOf("<MediaContainer") >= 0 ||
      text.indexOf("<Video") >= 0 ||
      text.indexOf("<Directory") >= 0
    ) {
      page = parseXmlLibraryItems(text);
    } else if (res.body) {
      const mc = res.body.MediaContainer || res.body;
      page = mc.Metadata || [];
    }

    for (let i = 0; i < page.length; i++) all.push(page[i]);

    if (page.length < pageSize) break;
    start += pageSize;
    await yieldUi();
  }

  return all;
}

function parseXmlLibraryItems(xml) {
  const items = [];
  const blocks = xml.split(/<(Video|Directory|Track) /);
  for (let i = 1; i < blocks.length; i += 2) {
    const tag = blocks[i];
    const body = blocks[i + 1] || "";
    const chunk = "<" + tag + " " + body;
    const rkMatch = chunk.match(/\bratingKey="(\d+)"/);
    if (!rkMatch) continue;
    // Prefer Part tags so we can pick up size= alongside file=.
    const partRe = /<Part\b[^>]*>/g;
    const parts = [];
    let pm;
    while ((pm = partRe.exec(chunk))) {
      const tagText = pm[0];
      const fm = tagText.match(/\bfile="([^"]+)"/);
      if (!fm) continue;
      const sm = tagText.match(/\bsize="(\d+)"/);
      parts.push({
        file: decodeXml(fm[1]),
        size: sm ? Number(sm[1]) : undefined,
      });
    }
    if (!parts.length) {
      const fileMatches = chunk.match(/\bfile="([^"]+)"/g) || [];
      fileMatches.forEach(function (m) {
        const fm = m.match(/\bfile="([^"]+)"/);
        if (fm) parts.push({ file: decodeXml(fm[1]) });
      });
    }
    if (!parts.length) continue;
    items.push({
      ratingKey: rkMatch[1],
      type: tag === "Video" ? "movie" : "episode",
      Media: [{ Part: parts }],
    });
  }
  return items;
}

function decodeXml(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function countParts(items) {
  let n = 0;
  (items || []).forEach(function (meta) {
    (meta.Media || []).forEach(function (m) {
      n += (m.Part || []).length;
    });
  });
  return n;
}

async function buildIndex(http, preferences, session, console) {
  const acc = { builtAt: new Date().toISOString(), basenames: {}, ambiguous: {} };
  const sectionsRes = await request(
    http,
    preferences,
    "get",
    joinUrl(session.uri, "/library/sections"),
    { token: session.accessToken }
  );
  if (sectionsRes.statusCode >= 400 || !sectionsRes.body) {
    throw new Error("Cannot list library sections (HTTP " + sectionsRes.statusCode + ")");
  }
  const mc = sectionsRes.body.MediaContainer || sectionsRes.body;
  const sections = mc.Directory || [];

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const type = Number(sec.type);
    const id = sec.key;
    if (type === 1) {
      const items = await fetchSectionItems(
        http,
        preferences,
        session.uri,
        session.accessToken,
        id,
        1
      );
      if (items.length && countParts(items) === 0) {
        console.log(
          "Section " +
            sec.title +
            " list has no file paths; plays will match on demand via file="
        );
      }
      walkMetadata(acc, items);
      console.log("Indexed movie section " + sec.title + ": " + items.length + " items");
      await yieldUi();
    } else if (type === 2) {
      const items = await fetchSectionItems(
        http,
        preferences,
        session.uri,
        session.accessToken,
        id,
        4
      );
      if (items.length && countParts(items) === 0) {
        console.log(
          "Section " +
            sec.title +
            " list has no file paths; plays will match on demand via file="
        );
      }
      walkMetadata(acc, items);
      console.log("Indexed TV section " + sec.title + ": " + items.length + " episodes");
      await yieldUi();
    }
  }

  saveIndex(preferences, acc);
  const count = Object.keys(acc.basenames).length;
  console.log(
    "Library index ready: " +
      count +
      " unique files, " +
      Object.keys(acc.ambiguous).length +
      " ambiguous"
  );
  return acc;
}

function indexIsStale(preferences) {
  const built = preferences.get("index_built_at");
  if (!built) return true;
  const t = Date.parse(built);
  if (!t) return true;
  return Date.now() - t > INDEX_MAX_AGE_MS;
}

function collectPartsFromMetadata(meta) {
  const out = [];
  (meta.Media || []).forEach(function (m) {
    (m.Part || []).forEach(function (part) {
      if (part && part.file) {
        out.push({
          file: part.file,
          size: part.size != null ? Number(part.size) : undefined,
        });
      }
    });
  });
  return out;
}

/**
 * Pick a single ratingKey from candidate parts. Requires basename match;
 * uses path suffix + size to disambiguate. Returns null if not unique/confident.
 */
function pickUniqueMatch(localPath, localSize, candidates) {
  const base = basename(localPath);
  const scored = [];

  candidates.forEach(function (c) {
    if (!c || !c.ratingKey || !c.file) return;
    if (basename(c.file) !== base) return;
    if (!sizesCompatible(localSize, c.size)) return;
    const score = pathMatchScore(localPath, c.file);
    if (score < 0) return;
    scored.push({
      ratingKey: String(c.ratingKey),
      score: score,
      size: c.size,
    });
  });

  if (!scored.length) return null;

  scored.sort(function (a, b) {
    return b.score - a.score;
  });

  const best = scored[0];
  // If several ratingKeys tie at the best score, refuse to guess.
  const bestKeys = {};
  scored.forEach(function (s) {
    if (s.score === best.score) bestKeys[s.ratingKey] = true;
  });
  if (Object.keys(bestKeys).length !== 1) return null;

  // Basename-only (score 1) is OK when unique; deeper path is better.
  return best.ratingKey;
}

async function fetchMetadata(http, preferences, session, ratingKey) {
  const url = joinUrl(session.uri, "/library/metadata/" + ratingKey);
  const res = await request(http, preferences, "get", url, {
    token: session.accessToken,
  });
  if (res.statusCode >= 400 || !res.body) return null;
  const mc = res.body.MediaContainer || res.body;
  const items = mc.Metadata || [];
  return items[0] || null;
}

async function verifyRatingKey(
  http,
  preferences,
  session,
  ratingKey,
  localPath,
  localSize
) {
  const meta = await fetchMetadata(http, preferences, session, ratingKey);
  if (!meta) return false;
  const parts = collectPartsFromMetadata(meta).map(function (p) {
    return {
      ratingKey: ratingKey,
      file: p.file,
      size: p.size,
    };
  });
  return pickUniqueMatch(localPath, localSize, parts) === String(ratingKey);
}

async function resolveByFileFilter(
  http,
  preferences,
  session,
  localPath,
  localSize
) {
  const base = basename(localPath);
  const candidates = [];
  const types = [1, 4]; // movie, episode

  for (let ti = 0; ti < types.length; ti++) {
    const url = joinUrl(session.uri, "/library/all");
    const res = await request(http, preferences, "get", url, {
      token: session.accessToken,
      params: { type: String(types[ti]), file: base },
    });
    if (res.statusCode >= 400 || !res.body) continue;
    const items = (res.body.MediaContainer || res.body).Metadata || [];
    items.forEach(function (meta) {
      const parts = collectPartsFromMetadata(meta);
      // Require real Part.file — never accept title-only metadata hits.
      parts.forEach(function (p) {
        candidates.push({
          ratingKey: meta.ratingKey,
          file: p.file,
          size: p.size,
        });
      });
    });
  }

  return pickUniqueMatch(localPath, localSize, candidates);
}

/**
 * Resolve local playback path → Plex ratingKey.
 * File-based only: basename index, then Plex file= filter, verified with
 * path suffix + optional byte size. No title/hub search.
 *
 * @param {number} [localSize] optional file size in bytes (from mpv)
 */
async function resolveRatingKey(
  http,
  preferences,
  session,
  filePath,
  console,
  localSize
) {
  const localPath = pathFromUrl(filePath);
  const base = basename(localPath);
  if (!base) return null;

  let index = loadIndex(preferences);
  if (index.ambiguous[base]) {
    console.log("Ambiguous basename, skip: " + base);
    return null;
  }

  const indexedRk = readIndexRatingKey(index, base);
  if (indexedRk) {
    const indexed = index.basenames[base];
    const indexedSize =
      indexed && typeof indexed === "object" ? indexed.size : undefined;
    // Fast path: size known on both sides and matches → trust index.
    if (
      sizesCompatible(localSize, indexedSize) &&
      Number(localSize) > 0 &&
      Number(indexedSize) > 0
    ) {
      return indexedRk;
    }
    const ok = await verifyRatingKey(
      http,
      preferences,
      session,
      indexedRk,
      localPath,
      localSize
    );
    if (ok) return indexedRk;
    console.log("Index entry failed verify for " + base + ", re-resolving");
    delete index.basenames[base];
    saveIndex(preferences, index);
  }

  const fromFilter = await resolveByFileFilter(
    http,
    preferences,
    session,
    localPath,
    localSize
  );
  if (fromFilter) {
    index.basenames[base] = {
      ratingKey: fromFilter,
      suffix: pathSuffix(localPath, PATH_SUFFIX_DEPTH + 1),
    };
    if (Number(localSize) > 0) {
      index.basenames[base].size = Number(localSize);
    }
    saveIndex(preferences, index);
    return fromFilter;
  }

  console.log("No Plex file match for " + base);
  return null;
}

module.exports = {
  basename,
  pathFromUrl,
  pathSuffix,
  pathMatchScore,
  loadIndex,
  saveIndex,
  clearIndex,
  buildIndex,
  indexIsStale,
  resolveRatingKey,
};
