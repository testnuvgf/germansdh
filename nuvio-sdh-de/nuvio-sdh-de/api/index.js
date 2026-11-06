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
const READ_MS_PER_CHAR = 55;       // minimum on-screen time per character (about 18 chars/second)
const MIN_CUE_MS = 1500;           // no subtitle stays shorter than this (if the next one allows)
const MAX_CUE_MS = 7000;
// Shift every subtitle later (+) or earlier (-), in milliseconds. Set it in Vercel as the
// environment variable SYNC_OFFSET_MS if everything is consistently early or late.
const SYNC_OFFSET_MS = Number(process.env.SYNC_OFFSET_MS) || 0;
const CACHE_V = "3";               // bump to force players/CDN to re-fetch subtitle files
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

const BIDI = /[‎‏‪-‮⁦-⁩]/g;
const plain = (t) => t.replace(/<[^>]+>/g, "").replace(BIDI, "");

// Finds the shift (and frame-rate stretch) that best lines the Arabic file up with the German one,
// then refines the shift to the millisecond.
function bestAlignment(de, ar) {
  const identity = { r: 1, off: 0 };
  if (!de.length || !ar.length) return identity;

  const near = (arr, t) => {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < t) lo = mid + 1; else hi = mid;
    }
    let v = arr[lo];
    if (lo > 0 && Math.abs(arr[lo - 1] - t) < Math.abs(v - t)) v = arr[lo - 1];
    return v;
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
      for (const c of sample) {
        const t = c.start - off;
        if (Math.abs(near(scaled, t) - t) <= 700) sc++;
      }
      if (r === 1 && off === 0) base = sc;
      if (sc > best.score) best = { r, off, score: sc };
    }
  }
  if (!(best.score >= base * 1.15 && best.score >= sample.length * 0.15)) return identity;

  // Millisecond refinement: median remaining difference of matched cue starts.
  const scaled = ar.map((c) => c.start * best.r);
  const diffs = [];
  for (const c of sample) {
    const t = c.start - best.off;
    const d = t - near(scaled, t);
    if (Math.abs(d) <= 700) diffs.push(d);
  }
  diffs.sort((x, y) => x - y);
  const fine = diffs.length ? diffs[diffs.length >> 1] : 0;
  return { r: best.r, off: Math.round(best.off + fine) };
}

// Arabic needs explicit right-to-left handling, otherwise "?" "." "!" jump to the wrong end of the line.
function fixArabicLine(line) {
  let l = line.replace(BIDI, "").trim();
  if (!l) return "";
  // A question/exclamation mark typed at the logical START of the line belongs at the end.
  const m = l.match(/^(-\s*)?([?؟!]+)\s*(.+)$/);
  if (m) {
    const endsWithMark = /[?؟!]$/.test(m[3]);
    l = `${m[1] || ""}${m[3]}${endsWithMark ? "" : m[2]}`;
  }
  l = l.replace(/\?/g, "؟").replace(/(?<!\d),|,(?!\d)/g, "،");
  // RLM + RLE ... PDF + RLM: whole line is right-to-left and trailing punctuation stays at the left end.
  const wrapped = `‏‫${l}‬‏`;
  return ARABIC_COLOR ? `<font color="${ARABIC_COLOR}">${wrapped}</font>` : wrapped;
}

function arabicBlock(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map(fixArabicLine)
    .filter(Boolean)
    .join("\n");
}

// Joins German cues that are one sentence cut in two (no end punctuation, tiny gap).
function mergeFragments(cues) {
  const out = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev) {
      const a = plain(prev.text).trim();
      const b = plain(c.text).trim();
      const complete = /[.?!…؟»"'\])]$/.test(a);
      if (!complete && c.start - prev.end <= 400 && !/^[-–—\[(]/.test(b) && a.length + b.length <= 84) {
        prev.text = `${prev.text.replace(/\n/g, " ")} ${c.text.replace(/\n/g, " ")}`;
        prev.end = Math.max(prev.end, c.end);
        continue;
      }
    }
    out.push({ ...c });
  }
  return out;
}

// Gives every cue enough time to be read (never shortens, never runs into the next cue).
function fixDurations(cues) {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const next = cues[i + 1];
    const chars = plain(c.text).replace(/\s+/g, " ").trim().length;
    const want = Math.min(MAX_CUE_MS, Math.max(MIN_CUE_MS, chars * READ_MS_PER_CHAR));
    let end = Math.max(c.end, c.start + want);
    if (next) end = Math.min(end, Math.max(c.end, next.start - 60));
    c.end = end;
  }
  return cues;
}

function finalize(cues) {
  cues.sort((a, b) => a.start - b.start);
  fixDurations(cues);
  if (SYNC_OFFSET_MS) {
    for (const c of cues) {
      c.start += SYNC_OFFSET_MS;
      c.end += SYNC_OFFSET_MS;
    }
  }
  return toSrt(cues);
}

function germanOnly(text) {
  const cues = mergeFragments(parseSrt(text));
  return cues.length ? finalize(cues) : text;
}

function mergeDual(deText, arText) {
  const de = mergeFragments(parseSrt(deText));
  const arRaw = parseSrt(arText);
  if (!de.length) return deText;
  const al = bestAlignment(de, arRaw);
  const ar = arRaw
    .map((c) => ({
      start: Math.round(c.start * al.r + al.off),
      end: Math.round(c.end * al.r + al.off),
      text: arabicBlock(c.text)
    }))
    .filter((c) => c.text);

  // Each Arabic cue is attached ONCE, to the German cue it overlaps most.
  const attached = de.map(() => []);
  const standalone = [];
  for (const a of ar) {
    let bestI = -1, bestO = 0;
    for (let i = 0; i < de.length; i++) {
      const d = de[i];
      if (d.start > a.end) break;
      if (d.end < a.start) continue;
      const o = Math.min(d.end, a.end) - Math.max(d.start, a.start);
      if (o > bestO) { bestO = o; bestI = i; }
    }
    const need = bestI >= 0 ? Math.min(300, 0.3 * Math.min(a.end - a.start, de[bestI].end - de[bestI].start)) : 0;
    if (bestI >= 0 && bestO >= need) attached[bestI].push(a.text);
    else standalone.push(a);
  }

  const out = de.map((d, i) => ({
    start: d.start,
    end: d.end,
    text: attached[i].length ? `${d.text}\n${attached[i].join("\n")}` : d.text
  }));
  // Arabic cues that matched no German cue are kept, so no translation is lost.
  for (const a of standalone) out.push({ start: a.start, end: a.end, text: a.text });
  return finalize(out);
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
                url: `${base}/dual/${d.fileId}-${a.fileId}.v${CACHE_V}.srt`,
                lang: "ger"
              });
            }
          });
        }
        // Plain German SDH alternatives, in case a dual one is off for your video.
        de.slice(0, GERMAN_ONLY_OPTIONS).forEach((d, i) => {
          subtitles.push({ id: `de-sdh-${i + 1}-${d.fileId}`, url: `${base}/dl/${d.fileId}.v${CACHE_V}.srt`, lang: "ger" });
        });
      }
      return sendJson(res, 200, { subtitles }, "public, s-maxage=3600");
    }

    if (parts[0] === "dual" && parts[1]) {
      const m = parts[1].match(/^(\d+)-(\d+)(?:\.v\d+)?\.srt$/);
      if (!m) {
        res.statusCode = 400;
        return res.end("Bad id");
      }
      const [deText, arText] = await Promise.all([
        download(m[1]),
        download(m[2]).catch((e) => { console.error(e); return null; })
      ]);
      return sendSrt(res, arText ? mergeDual(deText, arText) : germanOnly(deText));
    }

    if (parts[0] === "dl" && parts[1]) {
      const fileId = parts[1].replace(/(?:\.v\d+)?\.srt$/, "");
      if (!/^\d+$/.test(fileId)) {
        res.statusCode = 400;
        return res.end("Bad id");
      }
      return sendSrt(res, germanOnly(await download(fileId)));
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
