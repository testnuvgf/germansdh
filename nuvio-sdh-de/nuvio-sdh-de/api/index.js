// Stremio-protocol subtitle addon (works with Nuvio).
// Every option is a DUAL subtitle: German SDH (spoken words only) on top, Arabic underneath.
//
// Sources: OpenSubtitles.com REST API, Wyzie Subs (sub.wyzie.io, itself an aggregator of several providers)
//          and SubDL (api.subdl.com). Wyzie and SubDL are optional and switched on by their keys.
//
// Env vars: OS_API_KEY, OS_USERNAME, OS_PASSWORD (required)
//           WYZIE_KEY    (optional: Wyzie Subs, queries several providers at once)
//           SUBDL_KEY    (optional: SubDL, free key from subdl.com)
//           ADDON_SECRET (optional: puts every route under /<secret>/)
//           SYNC_OFFSET_MS, SYNC_RATIO (optional: shift / stretch every subtitle)
//           READ_MS_PER_CHAR, MIN_CUE_MS, MAX_CUE_MS (optional: how long cues stay on screen)
//           ARABIC_COLOR, FONT_FACE, ALIGN_ARABIC=0 (optional look & feel)
//           OS_API_BASE, WYZIE_BASE (testing only)

const crypto = require("crypto");
const zlib = require("zlib");

const UA = "NuvioSdhDe v2.2.0";
const API_DEFAULT = "https://api.opensubtitles.com/api/v1";
const WYZIE_DEFAULT = "https://sub.wyzie.io";
const SUBDL_API = "https://api.subdl.com/api/v1/subtitles";
const SUBDL_DL = "https://dl.subdl.com";

// ---- Settings you may want to change -------------------------------------
const DUAL_OPTIONS = 3;            // how many dual (German + Arabic) choices to list
const ARABIC_FALLBACKS = 2;        // extra Arabic files tried when the first one fails to download or does not fit
const GOOD_FIT = 0.45;             // an Arabic file this well aligned with the German is accepted immediately
const MIN_FIT = 0.2;               // below this the Arabic file is judged to be another episode/cut and dropped
const ARABIC_SDH_ONLY = false;     // true = only use Arabic files flagged SDH (rare)
const ARABIC_COLOR = process.env.ARABIC_COLOR || "";   // e.g. "#FFEB3B"; empty = same colour as German
const FONT_FACE = process.env.FONT_FACE || "";         // e.g. "Arial"; many players ignore it
const ALIGN_ARABIC = process.env.ALIGN_ARABIC !== "0"; // 0 = use the Arabic file's own timing untouched
const COMPACT_MAX = 70;            // join a cue's lines into one when the whole thing is this short
const READ_MS_PER_CHAR = Number(process.env.READ_MS_PER_CHAR) || 95;
const MIN_CUE_MS = Number(process.env.MIN_CUE_MS) || 2800;
const MAX_CUE_MS = Number(process.env.MAX_CUE_MS) || 10000;
const OTHER_SOURCE_PENALTY = 10;   // Wyzie / SubDL files carry no ratings, so they start slightly behind
const SYNC_OFFSET_MS = Number(process.env.SYNC_OFFSET_MS) || 0;
// Stretch all times (drift that grows over the film): 25 -> 23.976 fps = 1.04271, 23.976 -> 25 = 0.95904.
const SYNC_RATIO = Number(process.env.SYNC_RATIO) || 1;
const CACHE_V = "9";               // bump to force players/CDN to re-fetch subtitle files
// ---------------------------------------------------------------------------

let token = null;
let apiBase = process.env.OS_API_BASE || API_DEFAULT;
const wyzieBase = process.env.WYZIE_BASE || WYZIE_DEFAULT;

const MANIFEST = {
  id: "community.opensubtitles.sdh.de",
  version: "2.2.0",
  name: "German SDH + Arabic (dual)",
  description: "German SDH (spoken words) with the best-rated Arabic subtitle underneath. Sources: OpenSubtitles, Wyzie, SubDL.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: false }
};

// ===== File references =======================================================
// A "ref" identifies one subtitle file inside our own URLs:
//   digits                 -> OpenSubtitles file_id
//   "w" + base64url(url)   -> a Wyzie download URL
//   "s" + base64url(path|season|episode) -> a SubDL zip

const shortId = (ref) => crypto.createHash("sha1").update(ref).digest("hex").slice(0, 10);
const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url").toString("utf8");

const WYZIE_HOST = /(^|\.)wyzie\.(io|ru)$/i;
const SUBDL_PATH = /^\/subtitle\/[\w.\-]+\.zip$/;

function wyzieUrlFromRef(ref) {
  const url = new URL(unb64(ref.slice(1)));
  // Only ever fetch from Wyzie itself, never an arbitrary host.
  if (url.protocol !== "https:" || !WYZIE_HOST.test(url.hostname)) throw new Error("bad wyzie url");
  return url.toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== OpenSubtitles API ====================================================

function osHeaders(extra = {}) {
  return {
    "Api-Key": process.env.OS_API_KEY || "",
    "User-Agent": UA,
    Accept: "application/json",
    ...extra
  };
}

// Only ONE login runs at a time; everybody else waits for it (OpenSubtitles answers parallel logins with 429).
let loginPromise = null;
function login() {
  if (!loginPromise) loginPromise = doLogin().finally(() => { loginPromise = null; });
  return loginPromise;
}

async function doLogin() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${apiBase}/login`, {
      method: "POST",
      headers: osHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ username: process.env.OS_USERNAME, password: process.env.OS_PASSWORD })
    });
    if (r.status === 429) {
      const wait = Number(r.headers.get("retry-after")) || 0;
      await sleep(Math.min(5000, Math.max(1200, wait * 1000)) + attempt * 500);
      continue;
    }
    if (!r.ok) throw new Error(`login failed: ${r.status}`);
    const j = await r.json();
    token = j.token;
    if (!process.env.OS_API_BASE && j.base_url) apiBase = `https://${j.base_url}/api/v1`;
    return;
  }
  throw new Error("login failed: 429 (rate limited)");
}

// Returns every OpenSubtitles candidate for one language with the fields we rank on.
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
        ref: file && file.file_id ? String(file.file_id) : null,
        source: "os",
        release: [a.release, file && file.file_name].filter(Boolean).join(" "),
        ratings: Number(a.ratings) || 0,
        downloads: a.download_count || 0,
        trusted: a.from_trusted === true,
        hashMatch: a.moviehash_match === true,
        machine: a.machine_translated === true || a.ai_translated === true,
        hiUnknown: false
      };
    })
    .filter((c) => c.ref);
}

// ===== Wyzie Subs API (aggregates several providers) =========================

// First boolean found among the possible "hearing impaired" field names, else undefined.
const hiFlag = (d) => [d.isHearingImpaired, d.hearingImpaired, d.hi].find((v) => typeof v === "boolean");

async function searchWyzie(type, id, lang, hearing) {
  const key = process.env.WYZIE_KEY;
  if (!key) return [];
  const [imdb, season, episode] = id.split(":");
  const params = { id: imdb, language: lang, format: "srt", source: "all", key };
  if (hearing) params.hi = "true";
  if (type === "series") {
    if (!season || !episode) return [];
    params.season = season;
    params.episode = episode;
  }
  const call = (p) => fetch(`${wyzieBase}/search?${Object.keys(p).map((k) => `${k}=${encodeURIComponent(p[k])}`).join("&")}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  let r = await call(params);
  if (r.status === 400) {
    // some deployments reject source=all; retry with the default source
    delete params.source;
    r = await call(params);
  }
  if (!r.ok) throw new Error(`wyzie search failed (${lang}): ${r.status}`);
  const list = await r.json();
  if (!Array.isArray(list)) return [];

  let items = list
    .filter((d) => d && d.url && String(d.language || "").toLowerCase() === lang)
    .filter((d) => !d.format || String(d.format).toLowerCase() === "srt")
    .filter((d) => {
      try { return WYZIE_HOST.test(new URL(d.url).hostname); } catch { return false; }
    });
  // keep only flagged hearing-impaired files when the API tells us which ones they are
  const known = items.some((d) => hiFlag(d) !== undefined);
  if (hearing && known) items = items.filter((d) => hiFlag(d) === true);

  return items.map((d) => ({
    ref: "w" + b64(d.url),
    source: "wyzie",
    release: [d.matchedRelease, d.release, d.fileName, d.media].filter(Boolean).join(" "),
    ratings: 0,
    downloads: 0,
    trusted: false,
    hashMatch: false,
    machine: false,
    hiUnknown: hearing && !known
  }));
}

// ===== SubDL API ==============================================================

async function searchSubdl(type, id, lang, hearing) {
  const key = process.env.SUBDL_KEY;
  if (!key) return [];
  const [imdb, season, episode] = id.split(":");
  const L = lang.toUpperCase();
  const params = { api_key: key, imdb_id: imdb, languages: L, type: type === "series" ? "tv" : "movie", subs_per_page: 30 };
  if (type === "series") {
    if (!season || !episode) return [];
    params.season_number = season;
    params.episode_number = episode;
  }
  if (hearing) params.hi = 1;
  const qs = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const r = await fetch(`${SUBDL_API}?${qs}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error(`subdl search failed (${lang}): ${r.status}`);
  const j = await r.json();
  if (!j || j.status === false) return [];

  let items = (j.subtitles || [])
    .filter((d) => d && typeof d.url === "string" && SUBDL_PATH.test(d.url) && !d.full_season)
    .filter((d) => !/^[a-z]{2}$/i.test(String(d.language || "")) || String(d.language).toUpperCase() === L);
  const known = items.some((d) => typeof d.hi === "boolean");
  if (hearing && known) items = items.filter((d) => d.hi === true);

  return items.map((d) => ({
    ref: "s" + b64(`${d.url}|${season || ""}|${episode || ""}`),
    source: "subdl",
    release: [d.release_name, d.name].filter(Boolean).join(" "),
    ratings: 0,
    downloads: 0,
    trusted: false,
    hashMatch: false,
    machine: false,
    hiUnknown: hearing && !known
  }));
}

// ===== Downloading ===========================================================

function decodeText(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf); // older German subs
  }
}

async function downloadOs(fileId, retry = true) {
  if (!token) await login();
  const r = await fetch(`${apiBase}/download`, {
    method: "POST",
    headers: osHeaders({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }),
    body: JSON.stringify({ file_id: Number(fileId), sub_format: "srt" })
  });
  if (r.status === 401 && retry) {
    token = null;
    return downloadOs(fileId, false);
  }
  if (r.status === 429 && retry) {
    await sleep(1500);
    return downloadOs(fileId, false);
  }
  if (!r.ok) throw new Error(`download request failed: ${r.status}`);
  const j = await r.json();
  if (!j.link) throw new Error("no download link (quota reached?)");

  const f = await fetch(j.link, { headers: { "User-Agent": UA } });
  if (!f.ok) throw new Error(`file fetch failed: ${f.status}`);
  return decodeText(Buffer.from(await f.arrayBuffer()));
}

async function downloadWyzie(ref) {
  const f = await fetch(wyzieUrlFromRef(ref), {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(10000)
  });
  if (!f.ok) throw new Error(`wyzie file fetch failed: ${f.status}`);
  return decodeText(Buffer.from(await f.arrayBuffer()));
}

// Minimal zip reader: returns the .srt inside a SubDL zip (for season packs, the one for this episode).
function unzipSrt(buf, season, episode) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65600); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    files.push({ name: buf.subarray(off + 46, off + 46 + nlen).toString("utf8"), method, csize, lho });
    off += 46 + nlen + xlen + clen;
  }
  const srts = files.filter((f) => /\.srt$/i.test(f.name));
  if (!srts.length) throw new Error("no srt in zip");
  let pick = srts[0];
  if (srts.length > 1 && episode) {
    const s = Number(season) || 0, e = Number(episode);
    const re = new RegExp(`(s0*${s}[\\s._-]*e0*${e}(?!\\d))|(\\b0*${s}x0*${e}(?!\\d))`, "i");
    pick = srts.find((f) => re.test(f.name)) || srts[0];
  }
  const ln = buf.readUInt16LE(pick.lho + 26), lx = buf.readUInt16LE(pick.lho + 28);
  const start = pick.lho + 30 + ln + lx;
  const data = buf.subarray(start, start + pick.csize);
  return pick.method === 0 ? data : zlib.inflateRawSync(data);
}

async function downloadSubdl(ref) {
  const [path, season, episode] = unb64(ref.slice(1)).split("|");
  if (!SUBDL_PATH.test(path)) throw new Error("bad subdl path");
  const f = await fetch(`${SUBDL_DL}${path}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!f.ok) throw new Error(`subdl file fetch failed: ${f.status}`);
  return decodeText(unzipSrt(Buffer.from(await f.arrayBuffer()), season, episode));
}

function download(ref) {
  if (ref.startsWith("w")) return downloadWyzie(ref);
  if (ref.startsWith("s")) return downloadSubdl(ref);
  return downloadOs(ref);
}

// ===== Ranking ================================================================

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

// German: the best SDH file = exact video match, then same release name, trusted, rated, popular.
function scoreDe(c, fileTokens) {
  let s = 0;
  if (c.hashMatch) s += 1000;
  s += jaccard(tokens(c.release), fileTokens) * 100;
  if (c.trusted) s += 20;
  s += c.ratings * 5;
  s += Math.log10(c.downloads + 1) * 10;
  if (c.machine) s -= 40;
  if (c.hiUnknown) s -= 30;
  if (c.source !== "os") s -= OTHER_SOURCE_PENALTY;
  return s;
}

// Arabic: the best NOTED (rated) file first, then popularity, then closeness to your video file.
function scoreAr(c, fileTokens) {
  let s = 0;
  if (c.hashMatch) s += 1000;
  s += c.ratings * 30;
  s += Math.log10(c.downloads + 1) * 15;
  if (c.trusted) s += 20;
  s += jaccard(tokens(c.release), fileTokens) * 40;
  if (c.machine) s -= 60;
  if (c.source !== "os") s -= OTHER_SOURCE_PENALTY;
  return s;
}

function rank(list, fileTokens, scorer) {
  const seen = new Set();
  return list
    .filter((c) => (seen.has(c.ref) ? false : (seen.add(c.ref), true)))
    .map((c) => ({ ...c, score: scorer(c, fileTokens) }))
    .sort((a, b) => b.score - a.score);
}

// ===== SRT parsing ============================================================

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

// LRM/RLM, LRE/RLE/PDF/LRO/RLO, and the isolate controls.
const BIDI = /[‎‏‪-‮⁦-⁩]/g;
const plain = (t) => t.replace(/<[^>]+>/g, "").replace(BIDI, "");

// ===== Cleaning: spoken words only ============================================

// [Musik] (Leute jubeln) {..} are removed, then any lone bracket characters that are left over.
function stripNoise(t) {
  return t.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, "").replace(/[\[\](){}]/g, "");
}

// ALL-CAPS speaker labels like "MAMA:" or "- ELENA:" at the start of a line.
const SPEAKER = /^(\s*(?:<[^>]+>)*\s*-?\s*(?:<[^>]+>)*\s*)[A-ZÄÖÜ][A-ZÄÖÜ0-9 .'\-]{1,24}:\s*(?:<\/[a-z]+>)?\s*/;

function balanceTags(line) {
  return ["i", "b", "u"].reduce((x, tg) => {
    const open = (x.match(new RegExp(`<${tg}>`, "g")) || []).length;
    const close = (x.match(new RegExp(`</${tg}>`, "g")) || []).length;
    return open === close ? x : x.replace(new RegExp(`</?${tg}>`, "g"), "");
  }, line);
}

// Returns the spoken lines of one cue (possibly none).
function cleanLines(text, german) {
  const before = text.split("\n").filter((l) => l.trim()).length;
  const lines = stripNoise(text)
    .split("\n")
    .filter((l) => !/[♪♫]/.test(l) && !/^\s*#.*#?\s*$/.test(l))
    .map((l) => (german ? l.replace(SPEAKER, "$1") : l))
    .map((l) => balanceTags(l.replace(/<(\w+)[^>]*>\s*<\/\1>/g, "").replace(/\s{2,}/g, " ").trim()))
    .filter((l) => plain(l).replace(/^[-–—\s]+$/, "").trim());
  // the other speaker's line was sound-only: a lone dialogue dash makes no sense any more
  if (before > 1 && lines.length === 1) lines[0] = lines[0].replace(/^((?:<[^>]+>)*)[-–—]\s*/, "$1");
  return lines;
}

function cleanSdh(cues) {
  const out = [];
  for (const c of cues) {
    const lines = cleanLines(c.text, true);
    if (lines.length) out.push({ ...c, text: lines.join("\n") });
  }
  return out;
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

// parse + clean + glue fragments; falls back to the uncleaned cues if cleaning would remove everything
function loadGerman(text) {
  const raw = parseSrt(text);
  const cleaned = cleanSdh(raw);
  return mergeFragments(cleaned.length ? cleaned : raw);
}

// ===== Alignment ==============================================================

function nearest(arr, t) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1; else hi = mid;
  }
  let v = arr[lo];
  if (lo > 0 && Math.abs(arr[lo - 1] - t) < Math.abs(v - t)) v = arr[lo - 1];
  return v;
}

const isSoundCue = (t) => {
  const p = plain(t).trim();
  return /^[\[(♪]/.test(p) && /[\])♪]$/.test(p);
};

// Frame-rate stretch + offset (coarse then fine search), then local drift per ~8 minutes.
// Returns { map(t) } converting an Arabic timestamp to German time.
function computeMap(de, ar) {
  const identity = { map: (t) => t };
  if (!de.length || !ar.length) return identity;

  const ref = de.filter((c) => !isSoundCue(c.text));
  const base = ref.length >= 10 ? ref : de;
  const step = Math.max(1, Math.ceil(base.length / 600));
  const sample = base.filter((_, i) => i % step === 0);
  const ratios = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];
  const count = (scaled, off, tol) => {
    let sc = 0;
    for (const c of sample) {
      const t = c.start - off;
      if (Math.abs(nearest(scaled, t) - t) <= tol) sc++;
    }
    return sc;
  };

  let best = { r: 1, off: 0, score: -1 };
  let zero = 0;
  for (const r of ratios) {
    const scaled = ar.map((c) => c.start * r);
    for (let off = -60000; off <= 60000; off += 500) {
      const sc = count(scaled, off, 800);
      if (r === 1 && off === 0) zero = sc;
      if (sc > best.score) best = { r, off, score: sc };
    }
  }
  if (!(best.score >= zero * 1.15 && best.score >= sample.length * 0.15)) {
    if (zero < sample.length * 0.15) return identity;
    best = { r: 1, off: 0, score: zero };
  }

  const scaledBest = ar.map((c) => c.start * best.r);
  let fineBest = { off: best.off, score: -1 };
  for (let off = best.off - 600; off <= best.off + 600; off += 50) {
    const sc = count(scaledBest, off, 350);
    if (sc > fineBest.score) fineBest = { off, score: sc };
  }
  const diffs = [];
  for (const c of sample) {
    const t = c.start - fineBest.off;
    const d = t - nearest(scaledBest, t);
    if (Math.abs(d) <= 500) diffs.push(d);
  }
  diffs.sort((x, y) => x - y);
  const off0 = Math.round(fineBest.off + (diffs.length ? diffs[diffs.length >> 1] : 0));
  const map0 = (t) => t * best.r + off0;

  const aligned = ar.map((c) => map0(c.start));
  const WIN = 8 * 60 * 1000;
  const groups = new Map();
  for (const c of base) {
    const d = c.start - nearest(aligned, c.start);
    if (Math.abs(d) > 2000) continue;
    const k = Math.floor(c.start / WIN);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ t: c.start, d });
  }
  const pts = [];
  for (const g of groups.values()) {
    if (g.length < 6) continue;
    const ds = g.map((x) => x.d).sort((x, y) => x - y);
    pts.push({ t: g.reduce((a, x) => a + x.t, 0) / g.length, d: ds[ds.length >> 1] });
  }
  pts.sort((x, y) => x.t - y.t);
  if (!pts.length) return { map: map0 };

  const drift = (t) => {
    if (t <= pts[0].t) return pts[0].d;
    if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].d;
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i].t) {
        const p = pts[i - 1], q = pts[i];
        return p.d + ((q.d - p.d) * (t - p.t)) / (q.t - p.t);
      }
    }
    return 0;
  };
  return { map: (t) => { const m = map0(t); return m + drift(m); } };
}

// Alignment plus a "quality": the share of German cues that now have an Arabic cue starting within 1 s.
// A low quality means the Arabic file is another episode / cut and should not be used.
function bestAlignment(de, ar) {
  const al = ALIGN_ARABIC ? computeMap(de, ar) : { map: (t) => t };
  const ref = de.filter((c) => !isSoundCue(c.text));
  const base = ref.length >= 10 ? ref : de;
  const starts = ar.map((c) => al.map(c.start)).sort((x, y) => x - y);
  const step = Math.max(1, Math.ceil(base.length / 600));
  let n = 0, hit = 0;
  for (let i = 0; i < base.length && starts.length; i += step) {
    n++;
    if (Math.abs(nearest(starts, base[i].start) - base[i].start) <= 1000) hit++;
  }
  return { map: al.map, quality: n ? hit / n : 0 };
}

// ===== Look: bidi marks, joining, durations ===================================

function styled(text, color) {
  if (!color && !FONT_FACE) return text;
  const attrs = `${FONT_FACE ? ` face="${FONT_FACE}"` : ""}${color ? ` color="${color}"` : ""}`;
  return `<font${attrs}>${text}</font>`;
}

// Short two-line cues read better as one line.
function compactLines(lines) {
  const ok = lines.length > 1 && !lines.some((l) => /^\s*[-–—]/.test(plain(l))) &&
    lines.reduce((n, l) => n + plain(l).length, 0) <= COMPACT_MAX;
  return ok ? [lines.map((l) => l.trim()).join(" ")] : lines;
}

// Arabic line: a right-to-left mark at both ends keeps "." "?" "!" and the dialogue dash on the correct side.
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
  return styled(`‏${l}‏`, ARABIC_COLOR);
}

function arabicBlock(text) {
  const lines = cleanLines(text.replace(/<[^>]+>/g, ""), false);
  return compactLines(lines).map(fixArabicLine).filter(Boolean).join("\n");
}

// German line: a left-to-right mark at both ends. Even when the player lays the whole cue out right-to-left
// (because Arabic is present), the final "." and the leading "-" stay on the correct side.
function germanBlock(text) {
  return compactLines(text.split("\n").filter((l) => l.trim()))
    .map((l) => styled(`‎${l.replace(BIDI, "")}‎`, ""))
    .join("\n");
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
  if (SYNC_OFFSET_MS || SYNC_RATIO !== 1) {
    for (const c of cues) {
      c.start = c.start * SYNC_RATIO + SYNC_OFFSET_MS;
      c.end = c.end * SYNC_RATIO + SYNC_OFFSET_MS;
    }
  }
  return toSrt(cues);
}

function germanOnly(de) {
  return finalize(de.map((c) => ({ ...c })));
}

// ===== Merging ================================================================

// Every Arabic cue goes under the German cue it overlaps most, or the closest one within 1.5 s,
// so Arabic does not drop out just because the two files are a fraction of a second apart.
function mergeDual(de, arRaw, al) {
  const TOL = 1500;
  const ar = arRaw
    .map((c) => ({
      start: Math.round(al.map(c.start)),
      end: Math.round(al.map(c.end)),
      text: arabicBlock(c.text)
    }))
    .filter((c) => c.text);

  const attached = de.map(() => []);
  const standalone = [];
  for (const a of ar) {
    let bestI = -1, bestO = -Infinity;
    for (let i = 0; i < de.length; i++) {
      const d = de[i];
      if (d.start > a.end + TOL) break;
      if (d.end < a.start - TOL) continue;
      const o = Math.min(d.end, a.end) - Math.max(d.start, a.start); // negative = gap between them
      if (o > bestO) { bestO = o; bestI = i; }
    }
    if (bestI >= 0) attached[bestI].push(a);
    else standalone.push(a);
  }

  const out = de.map((d, i) => {
    if (!attached[i].length) return { start: d.start, end: d.end, text: d.text };
    const next = de[i + 1];
    const cap = next ? next.start - 60 : Infinity;
    let end = d.end;
    for (const a of attached[i]) end = Math.max(end, Math.min(a.end, cap, d.end + TOL));
    return { start: d.start, end, text: `${germanBlock(d.text)}\n${attached[i].map((a) => a.text).join("\n")}` };
  });
  // Arabic cues far from any German cue are kept, so no line is lost.
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

const safe = (p) => p.catch((e) => { console.error(e); return []; });

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

    // /debug/<type>/<imdb[:season:episode]>  -> what each source returned (keys are never shown)
    if (parts[0] === "debug" && parts.length >= 3) {
      const type = parts[1];
      const id = parts[2];
      const run = async (name, fn) => {
        try {
          const l = await fn();
          const via = {};
          for (const c of l) via[c.source] = (via[c.source] || 0) + 1;
          return { name, count: l.length, via, sample: l.slice(0, 2).map((c) => c.release) };
        } catch (e) { return { name, error: String(e.message || e) }; }
      };
      const out = await Promise.all([
        run("os-de-sdh", () => searchLang(type, id, {}, "de", "only", { ai_translated: "exclude", machine_translated: "exclude" })),
        run("os-ar", () => searchLang(type, id, {}, "ar", ARABIC_SDH_ONLY ? "only" : "include")),
        run("wyzie-de-sdh", () => searchWyzie(type, id, "de", true)),
        run("wyzie-ar", () => searchWyzie(type, id, "ar", ARABIC_SDH_ONLY)),
        run("subdl-de-sdh", () => searchSubdl(type, id, "de", true)),
        run("subdl-ar", () => searchSubdl(type, id, "ar", ARABIC_SDH_ONLY))
      ]);
      return sendJson(res, 200, {
        osKeySet: !!process.env.OS_API_KEY, wyzieKeySet: !!process.env.WYZIE_KEY, subdlKeySet: !!process.env.SUBDL_KEY, results: out
      });
    }

    if (parts[0] === "subtitles" && parts.length >= 3) {
      const type = parts[1];
      const id = parts[2].replace(/\.json$/, "");
      const extraRaw = (parts[3] || "").replace(/\.json$/, "");
      const extra = Object.fromEntries(new URLSearchParams(extraRaw));
      const subtitles = [];

      if (id.startsWith("tt") && process.env.OS_API_KEY) {
        const fileTokens = tokens(extra.filename || "");
        const arHearing = ARABIC_SDH_ONLY;
        const [deOs, arOs, deWy, arWy, deSd, arSd] = await Promise.all([
          safe(searchLang(type, id, extra, "de", "only", { ai_translated: "exclude", machine_translated: "exclude" })),
          safe(searchLang(type, id, extra, "ar", arHearing ? "only" : "include")),
          safe(searchWyzie(type, id, "de", true)),
          safe(searchWyzie(type, id, "ar", arHearing)),
          safe(searchSubdl(type, id, "de", true)),
          safe(searchSubdl(type, id, "ar", arHearing))
        ]);
        const de = rank([...deOs, ...deWy, ...deSd], fileTokens, scoreDe);
        const ar = rank([...arOs, ...arWy, ...arSd], fileTokens, scoreAr);

        // Option 1 = best German + best-rated Arabic. The next ones swap in the 2nd German or the 2nd Arabic.
        const pairs = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2]]
          .filter(([i, j]) => de[i] && ar[j])
          .slice(0, DUAL_OPTIONS);
        pairs.forEach(([i, j], n) => {
          const others = ar.map((_, k) => k).filter((k) => k !== j).slice(0, ARABIC_FALLBACKS);
          const arRefs = [ar[j].ref, ...others.map((k) => ar[k].ref)];
          subtitles.push({
            id: `dual-${n + 1}-${shortId(de[i].ref)}-${shortId(ar[j].ref)}`,
            url: `${base}/dual/${de[i].ref}~${arRefs.join("~")}.v${CACHE_V}.srt`,
            lang: "ger"
          });
        });
        // No Arabic exists anywhere for this title: still offer the best German SDH instead of an empty list.
        if (!pairs.length && de[0]) {
          subtitles.push({ id: `de-only-${shortId(de[0].ref)}`, url: `${base}/dual/${de[0].ref}.v${CACHE_V}.srt`, lang: "ger" });
        }
      }
      return sendJson(res, 200, { subtitles }, "public, s-maxage=3600");
    }

    if (parts[0] === "dual" && parts[1]) {
      // /dual/<germanRef>~<arabicRef>[~<fallbackArabicRef>...].vN.srt
      const m = parts[1].match(/^([\w-]+)((?:~[\w-]+)*)(?:\.v\d+)?\.srt$/);
      if (!m) {
        res.statusCode = 400;
        return res.end("Bad id");
      }
      const deRef = m[1];
      const arRefs = m[2] ? m[2].slice(1).split("~") : [];
      if (!token && [deRef, ...arRefs].some((r) => /^\d+$/.test(r))) await login();

      const deText = await download(deRef);
      const de = loadGerman(deText);
      if (!de.length) return sendSrt(res, deText);

      // Try the Arabic candidates in order; keep the first that fits the German timing well,
      // otherwise the best-fitting one. A failed download no longer silently drops the Arabic.
      let chosen = null;
      for (const ref of arRefs) {
        let arRaw;
        try {
          arRaw = parseSrt(await download(ref));
        } catch (e) {
          console.error(`arabic ${ref.slice(0, 12)} failed:`, e.message || e);
          continue;
        }
        if (arRaw.length < 5) continue;
        const al = bestAlignment(de, arRaw);
        if (!chosen || al.quality > chosen.al.quality) chosen = { arRaw, al };
        if (al.quality >= GOOD_FIT) break;
      }
      if (chosen && chosen.al.quality >= MIN_FIT) return sendSrt(res, mergeDual(de, chosen.arRaw, chosen.al));
      console.error(`no usable Arabic file (best fit ${chosen ? chosen.al.quality.toFixed(2) : "n/a"}), serving German only`);
      return sendSrt(res, germanOnly(de));
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
