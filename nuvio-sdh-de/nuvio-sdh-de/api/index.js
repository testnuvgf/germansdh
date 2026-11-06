// Stremio-protocol subtitle addon (works with Nuvio).
// Offers DUAL subtitles: German SDH on top, Arabic translation underneath, merged into one track,
// plus plain German SDH alternatives. Source: the official OpenSubtitles.com REST API.
//
// Env vars: OS_API_KEY, OS_USERNAME, OS_PASSWORD (required)
//           ADDON_SECRET (optional: puts every route under /<secret>/)
//           OS_API_BASE  (optional, testing only)

const UA = "NuvioSdhDe v2.0.0";
const API_DEFAULT = "https://opensubtitles.com";

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
  
  // MODIFIED: Relaxes constraints to ensure the best synchronization match is used
  if (best.score === -1 || best.score === 0) return identity;

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
