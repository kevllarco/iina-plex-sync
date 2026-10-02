const { plexHeaders, ensureClientId } = require("./config.js");

function parseBody(res) {
  if (res.data != null && typeof res.data === "object") return res.data;
  if (!res.text) return null;
  try {
    return JSON.parse(res.text);
  } catch (e) {
    return null;
  }
}

async function request(http, preferences, method, url, opts) {
  opts = opts || {};
  const clientId = ensureClientId(preferences);
  const headers = Object.assign(
    {},
    plexHeaders(clientId, opts.token),
    opts.headers || {}
  );
  const options = {
    params: opts.params || {},
    headers: headers,
    data: opts.data || {},
  };
  let res;
  if (method === "get") res = await http.get(url, options);
  else if (method === "post") res = await http.post(url, options);
  else if (method === "put") res = await http.put(url, options);
  else if (method === "delete") res = await http.delete(url, options);
  else throw new Error("unsupported method " + method);

  return {
    statusCode: res.statusCode,
    reason: res.reason,
    body: parseBody(res),
    text: res.text,
  };
}

function joinUrl(base, path, query) {
  const b = String(base).replace(/\/$/, "");
  const p = path.charAt(0) === "/" ? path : "/" + path;
  let url = b + p;
  if (query && Object.keys(query).length) {
    const parts = [];
    for (const k of Object.keys(query)) {
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(query[k])));
    }
    url += (url.indexOf("?") >= 0 ? "&" : "?") + parts.join("&");
  }
  return url;
}

module.exports = {
  request,
  joinUrl,
  parseBody,
};
