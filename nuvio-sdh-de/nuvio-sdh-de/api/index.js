// Stremio-protocol subtitle addon (works with Nuvio).
// Offers DUAL subtitles: German SDH on top, Arabic translation underneath, merged into one track,
// plus plain German SDH alternatives. Source: the official OpenSubtitles.com REST API.
//
// Env vars: OS_API_KEY, OS_USERNAME, OS_PASSWORD (required)
//           ADDON_SECRET (optional: puts every route under /<secret>/)
//           OS_API_BASE  (optional, testing only)

const UA = "NuvioSdhDe v2.0.0";
const API_DEFAULT = "https://api.opensubtitles.com/api/v1";

// ---- Settings you may want to change -------------------------------------
const ARABIC_SDH_ONLY = false;     // true = only use Arabic files flagged SDH (rare)
const ARABIC_COLOR = "#FFEB3B";    // colour of the Arabic lines ("" = no colour tag)
const DUAL_OPTIONS = 3;            // how many dual (German+Arabic) choices to list
const GERMAN_ONLY_OPTIONS = 2;     // how many plain German SDH choices to list
// ---------------------------------------------------------------------------

let token = null;
let apiBase = process.env.OS_API_BASE || API_DEFAULT;

const MANIFEST = {
  id: "community.opensubtitles.sdh.de",
  version: "2.0.0",
  name: "German SDH + Arabic (dual)",
  description: "Best-rated German SDH subtitles with an Arabic translation underneath, from OpenSubtitles.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: false }
};

// ===== OpenSubtitles API ====================================================

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

// Returns every candidate for one language with the fields we rank on.
async function searchLang(type, id, extra, lang, hearing, extraParams = {}) {
  const [imdb, season, episode] = id.split(":");
  const params = { hearing_impaired: hearing, languages: lang, ...extraParams };

  if (type === "series") {
    if (!season || !episode) return [];
    params.parent_imdb_id = imdb.replace(/^tt/, "");
    params.season_number = season;
    params.episode_number = episode;
  } else {
    params.imdb_id = imdb.replace(/^tt/, "");
  }
  if (extra.videoHash) params.moviehash = extra.videoHash;

  const qs = Object.keys(params).sort().map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const r = await fetch(`${apiBase}/subtitles?${qs}`, { headers: osHeaders() });
  if (!r.ok) throw new Error(`search failed (${lang}): ${r.status}`);
  const j = await r.json();

  return (j.data || [])
    .filter((d) => d.attributes && d.attributes.language === lang)
    .filter((d) => hearing !== "only" || d.attributes.hearing_impaired === true)
    .map((d) => {
      const a = d.attributes;
      const file = a.files && a.files[0];
      return {
        fileId: file && file.file_id,
        release: [a.release, file && file.file_name].filter(Boolean).join(" "),
        ratings: Number(a.ratings) || 0,
        downloads: a.download_count || 0,
        trusted: a.from_trusted === true,
        hashMatch: a.moviehash_match === true,
        machine: a.machine_translated === true || a.ai_translated === true
      };
    })
    .filter((c) => c.fileId);
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

// ===== Ranking: pick the best-matching, best-rated file ======================

const STOP = new Set(["srt", "mkv", "mp4", "avi", "the", "de", "ger", "german", "sdh", "hi", "and", "ar", "arabic"]);

function tokens(s) {
  return new Set(
    String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t))
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Higher is better. Release similarity to the video file decides most timing problems.
function score(c, fileTokens) {
  let s = 0;
  if (c.hashMatch) s += 1000;
  s += jaccard(tokens(c.release), fileTokens) * 100;
  if (c.trusted) s += 20;
  s += c.ratings * 5;
  s += Math.log10(c.downloads + 1) * 10;
  if (c.machine) s -= 40;
  return s;
}

function rank(list, fileTokens) {
  return list
    .map((c) => ({ ...c, score: score(c, fileTokens) }))
    .sort((a, b) => b.score - a.score);
}

// Best Arabic file for a given German pick: good on its own AND from the same release.
function bestArabicFor(de, arList, fileTokens) {
  const deTokens = tokens(de.release);
  return arList
    .map((c) => ({ c, s: score(c, fileTokens) + jaccard(tokens(c.release), deTokens) * 100 }))
    .sort((a, b) => b.s - a.s)[0]?.c;
}

// ===== SRT parsing / alignment / merging =====================================

function parseSrt(text) {
  text = text.replace(/^﻿/, "").replace(/\r/g, "");
  const cues = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx < 0) continue;
    const m = lines[idx].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const ms = (h, mi, s, f) => ((+h * 60 + +mi) * 60 + +s) * 1000 + +String(f).padEnd(3, "0").slice(0, 3);
    const body = lines.slice(idx + 1).join("\n").replace(/\{\\[^}]*\}/g, "").trim();
    if (!body) continue;
    cues.push({ start: ms(m[1], m[2], m[3], m[4]), end: ms(m[5], m[6], m[7], m[8]), text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function fmtTime(t) {
  t = Math.max(0, Math.round(t));
  const ms = t % 1000, s = Math.floor(t / 1000) % 60, m = Math.floor(t / 60000) % 60, h = Math.floor(t / 3600000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}\n`).join("\n");
}

// Finds the shift (and frame-rate stretch) that best lines the Arabic file up with the German one.
function bestAlignment(de, ar) {
  const identity = { r: 1, off: 0 };
  if (!de.length || !ar.length) return identity;

  const nearest = (arr, t) => {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < t) lo = mid + 1; else hi = mid;
    }
    let d = Math.abs(arr[lo] - t);
    if (lo > 0) d = Math.min(d, Math.abs(arr[lo - 1] - t));
    return d;
  };

  const step = Math.max(1, Math.ceil(de.length / 600));
  const sample = de.filter((_, i) => i % step === 0);
  const ratios = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];

  let best = { r: 1, off: 0, score: -1 };
  let base = 0;
  for (const r of ratios) {
    const scaled = ar.map((c) => c.start * r);
    for (let off = -15000; off <= 15000; off += 250) {
      let sc = 0;
      for (const c of sample) if (nearest(scaled, c.start - off) <= 700) sc++;
      if (r === 1 && off === 0) base = sc;
      if (sc > best.score) best = { r, off, score: sc };
    }
  }
  if (best.score >= base * 1.15 && best.score >= sample.length * 0.15) return { r: best.r, off: best.off };
  return identity;
}

function arabicBlock(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const line = `‏${l}`;
      return ARABIC_COLOR ? `<font color="${ARABIC_COLOR}">${line}</font>` : line;
    })
    .join("\n");
}

function mergeDual(deText, arText) {
  const de = parseSrt(deText);
  const arRaw = parseSrt(arText);
  const al = bestAlignment(de, arRaw);
  const ar = arRaw
    .map((c) => ({
      start: Math.round(c.start * al.r + al.off),
      end: Math.round(c.end * al.r + al.off),
      text: arabicBlock(c.text)
    }))
    .filter((c) => c.text);

  const used = new Set();
  const out = [];
  for (const d of de) {
    const lines = [];
    ar.forEach((a, j) => {
      if (a.end < d.start - 1000 || a.start > d.end + 1000) return;
      const overlap = Math.min(d.end, a.end) - Math.max(d.start, a.start);
      const need = Math.min(300, 0.3 * Math.min(d.end - d.start, a.end - a.start));
      if (overlap > 0 && overlap >= need) {
        lines.push(a.text);
        used.add(j);
      }
    });
    out.push({ start: d.start, end: d.end, text: lines.length ? `${d.text}\n${lines.join("\n")}` : d.text });
  }
  // Keep Arabic cues that matched no German cue so no translation is lost.
  ar.forEach((a, j) => {
    if (!used.has(j)) out.push({ start: a.start, end: a.end, text: a.text });
  });
  out.sort((a, b) => a.start - b.start);
  return toSrt(out);
}

// ===== HTTP handler ==========================================================

function sendJson(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cache) res.setHeader("Cache-Control", cache);
  res.end(JSON.stringify(body));
}

function sendSrt(res, text) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
  // Cache hard: each real download counts against the daily quota.
  res.setHeader("Cache-Control", "public, s-maxage=604800, max-age=86400");
  res.end(text);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  // On Vercel the rewrite passes the path as ?__p=... (maybe with %2F); locally it is the URL path.
  const rawUrl = req.url || "/";
  const qIndex = rawUrl.indexOf("?");
  const rawPath = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const rawQuery = qIndex === -1 ? "" : rawUrl.slice(qIndex + 1);
  let pathString = rawPath;
  if (rawQuery.startsWith("__p=")) pathString = "/" + rawQuery.slice(4).replace(/%2F/gi, "/");
  const parts = pathString
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      try { return decodeURIComponent(seg); } catch { return seg; }
    });
  if (parts[0] === "api") parts.shift();

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
        const fileTokens = tokens(extra.filename || "");
        const safe = (p) => p.catch((e) => { console.error(e); return []; });
        const [deAll, arAll] = await Promise.all([
          safe(searchLang(type, id, extra, "de", "only", { ai_translated: "exclude", machine_translated: "exclude" })),
          safe(searchLang(type, id, extra, "ar", ARABIC_SDH_ONLY ? "only" : "include"))
        ]);
        const de = rank(deAll, fileTokens);
        const ar = rank(arAll, fileTokens);

        // Dual choices: best German files, each paired with the best-matching Arabic file.
        if (ar.length) {
          de.slice(0, DUAL_OPTIONS).forEach((d, i) => {
            const a = bestArabicFor(d, ar, fileTokens);
            if (a) {
              subtitles.push({
                id: `dual-${i + 1}-${d.fileId}-${a.fileId}`,
                url: `${base}/dual/${d.fileId}-${a.fileId}.srt`,
                lang: "ger"
              });
            }
          });
        }
        // Plain German SDH alternatives, in case a dual one is off for your video.
        de.slice(0, GERMAN_ONLY_OPTIONS).forEach((d, i) => {
          subtitles.push({ id: `de-sdh-${i + 1}-${d.fileId}`, url: `${base}/dl/${d.fileId}.srt`, lang: "ger" });
        });
      }
      return sendJson(res, 200, { subtitles }, "public, s-maxage=3600");
    }

    if (parts[0] === "dual" && parts[1]) {
      const m = parts[1].match(/^(\d+)-(\d+)\.srt$/);
      if (!m) {
        res.statusCode = 400;
        return res.end("Bad id");
      }
      const [deText, arText] = await Promise.all([
        download(m[1]),
        download(m[2]).catch((e) => { console.error(e); return null; })
      ]);
      return sendSrt(res, arText ? mergeDual(deText, arText) : deText);
    }

    if (parts[0] === "dl" && parts[1]) {
      const fileId = parts[1].replace(/\.srt$/, "");
      if (!/^\d+$/.test(fileId)) {
        res.statusCode = 400;
        return res.end("Bad id");
      }
      return sendSrt(res, await download(fileId));
    }

    res.statusCode = 404;
    res.end(`Not found (path seen: /${parts.join("/")}, secret ${secret ? "ON" : "OFF"})`);
  } catch (err) {
    console.error(err);
    if (parts[0] === "subtitles") return sendJson(res, 200, { subtitles: [] });
    res.statusCode = 502;
    res.end("Upstream error");
  }
};
