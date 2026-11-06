// Stremio-protocol subtitle addon (works with Nuvio): German SDH subtitles only,
// sourced from the official OpenSubtitles.com REST API.
//
// Env vars: OS_API_KEY, OS_USERNAME, OS_PASSWORD (required)
//           ADDON_SECRET (optional, strongly recommended: puts every route under /<secret>/)
//           OS_API_BASE  (optional, testing only)

const UA = "NuvioSdhDe v1.0.0";
const API_DEFAULT = "https://api.opensubtitles.com/api/v1";

let token = null;
let apiBase = process.env.OS_API_BASE || API_DEFAULT;

const MANIFEST = {
  id: "community.opensubtitles.sdh.de",
  version: "1.0.0",
  name: "OpenSubtitles German SDH",
  description: "German subtitles for the deaf and hard of hearing (SDH) only, from OpenSubtitles.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: false }
};

function osHeaders(extra = {}) {
  return {
    "Api-Key": process.env.OS_API_KEY || "",
    "User-Agent": UA,
    Accept: "application/json",
    ...extra
  };
}

async function login() {
  const r = await fetch(`${apiBase}/login`, {
    method: "POST",
    headers: osHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ username: process.env.OS_USERNAME, password: process.env.OS_PASSWORD })
  });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  const j = await r.json();
  token = j.token;
  if (!process.env.OS_API_BASE && j.base_url) apiBase = `https://${j.base_url}/api/v1`;
}

async function searchSdh(type, id, extra) {
  const [imdb, season, episode] = id.split(":");
  const params = { hearing_impaired: "only", languages: "de" };

  if (type === "series") {
    if (!season || !episode) return [];
    params.parent_imdb_id = imdb.replace(/^tt/, "");
    params.season_number = season;
    params.episode_number = episode;
  } else {
    params.imdb_id = imdb.replace(/^tt/, "");
    if (extra.videoHash) params.moviehash = extra.videoHash;
  }

  // The API wants alphabetically sorted parameters.
  const qs = Object.keys(params).sort().map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const r = await fetch(`${apiBase}/subtitles?${qs}`, { headers: osHeaders() });
  if (!r.ok) throw new Error(`search failed: ${r.status}`);
  const j = await r.json();

  return (j.data || [])
    .filter((d) => d.attributes && d.attributes.hearing_impaired === true && d.attributes.language === "de")
    .map((d) => ({
      fileId: d.attributes.files && d.attributes.files[0] && d.attributes.files[0].file_id,
      downloads: d.attributes.download_count || 0
    }))
    .filter((d) => d.fileId)
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, 15);
}

async function download(fileId, retry = true) {
  if (!token) await login();
  const r = await fetch(`${apiBase}/download`, {
    method: "POST",
    headers: osHeaders({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    body: JSON.stringify({ file_id: Number(fileId), sub_format: "srt" })
  });
  if (r.status === 401 && retry) {
    token = null;
    return download(fileId, false);
  }
  if (!r.ok) throw new Error(`download request failed: ${r.status}`);
  const j = await r.json();
  if (!j.link) throw new Error("no download link (quota reached?)");

  const f = await fetch(j.link, { headers: { "User-Agent": UA } });
  if (!f.ok) throw new Error(`file fetch failed: ${f.status}`);
  const buf = Buffer.from(await f.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf); // older German subs
  }
}

function sendJson(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cache) res.setHeader("Cache-Control", cache);
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  const secret = process.env.ADDON_SECRET;
  if (secret) {
    if (parts[0] !== secret) {
      res.statusCode = 404;
      return res.end("Not found");
    }
    parts.shift();
  }

  const proto = req.headers["x-forwarded-proto"] || "http";
  const base = `${proto}://${req.headers.host}${secret ? "/" + encodeURIComponent(secret) : ""}`;

  try {
    if (parts[0] === "manifest.json") {
      return sendJson(res, 200, MANIFEST, "public, max-age=3600");
    }

    if (parts[0] === "subtitles" && parts.length >= 3) {
      const type = parts[1];
      const id = parts[2].replace(/\.json$/, "");
      const extraRaw = (parts[3] || "").replace(/\.json$/, "");
      const extra = Object.fromEntries(new URLSearchParams(extraRaw));
      let subtitles = [];
      if (id.startsWith("tt") && process.env.OS_API_KEY) {
        const found = await searchSdh(type, id, extra);
        subtitles = found.map((f, i) => ({
          id: `sdh-de-${f.fileId}`,
          url: `${base}/dl/${f.fileId}.srt`,
          lang: "ger"
        }));
      }
      return sendJson(res, 200, { subtitles }, "public, s-maxage=3600");
    }

    if (parts[0] === "dl" && parts[1]) {
      const fileId = parts[1].replace(/\.srt$/, "");
      if (!/^\d+$/.test(fileId)) {
        res.statusCode = 400;
        return res.end("Bad id");
      }
      const text = await download(fileId);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
      // Cache hard: each real download counts against the daily quota.
      res.setHeader("Cache-Control", "public, s-maxage=604800, max-age=86400");
      return res.end(text);
    }

    res.statusCode = 404;
    res.end("Not found");
  } catch (err) {
    console.error(err);
    if (parts[0] === "subtitles") return sendJson(res, 200, { subtitles: [] });
    res.statusCode = 502;
    res.end("Upstream error");
  }
};
