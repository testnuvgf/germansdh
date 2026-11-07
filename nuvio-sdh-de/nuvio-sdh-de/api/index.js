// Stremio-protocol subtitle addon (works with Nuvio).
// Every option is a DUAL subtitle: German SDH (spoken words only) on top, a second language (English) underneath,
// like https://github.com/awerks/stremio-double-subtitles but with German SDH as the source.
//
// Second language, two ways (SECOND_MODE):
//   files     : a real, best-rated subtitle file in the second language is merged under the German
//   translate : (default) the 3 best German SDH files, each with its own translation and the German file's own timing
//   both      : 1 = German + own translation, timed like the best-rated real English file
//               2 = German + that real English file (its timing is the master)
//               3 = German + own translation, German file's own timing (exactly what the repo does)
// Sources: OpenSubtitles.com REST API, Wyzie Subs (aggregator), SubDL.
//
// Env vars: OS_API_KEY, OS_USERNAME, OS_PASSWORD (required)
//           DEEPL_KEY    (optional, recommended: DeepL translation; otherwise Google's free web endpoint is used)
//           SECOND_LANG  (default "en"; any 2-letter code, "ar" keeps the right-to-left handling)
//           SECOND_MODE  (both | translate | files)
//           WYZIE_KEY, SUBDL_KEY (optional extra sources)
//           ADDON_SECRET (optional: puts every route under /<secret>/)
//           SYNC_OFFSET_MS, SYNC_RATIO (optional: shift / stretch every subtitle)
//           READ_MS_PER_CHAR, MIN_CUE_MS, MAX_CUE_MS (optional: how long cues stay on screen)
//           SECOND_COLOR, FONT_FACE, ALIGN_SECOND=0 (optional look & feel)
//           OS_API_BASE, WYZIE_BASE (testing only)

const crypto = require("crypto");
const zlib = require("zlib");

const UA = "NuvioSdhDe v2.8.1";
const API_DEFAULT = "https://api.opensubtitles.com/api/v1";
const WYZIE_DEFAULT = "https://sub.wyzie.io";
const SUBDL_API = "https://api.subdl.com/api/v1/subtitles";
const SUBDL_DL = "https://dl.subdl.com";

// ---- Settings you may want to change -------------------------------------
const SECOND_LANG = (process.env.SECOND_LANG || "en").toLowerCase();
const SECOND_MODE = ["both", "files"].includes(process.env.SECOND_MODE) ? process.env.SECOND_MODE : "translate";
const RTL = ["ar", "he", "fa", "ur"].includes(SECOND_LANG);
const DUAL_OPTIONS = 3;            // how many dual choices to list
const FALLBACK_FILES = 2;          // extra second-language files tried when the first one fails to download or does not fit
const GOOD_FIT = 0.45;             // a real file this well aligned with the German is accepted immediately
const MIN_FIT = 0.2;               // below this the file is judged to be another episode/cut and dropped
const SECOND_SDH_ONLY = false;     // true = only use second-language files flagged SDH
const SECOND_COLOR = process.env.SECOND_COLOR || process.env.ARABIC_COLOR || "";   // e.g. "#FFEB3B"; empty = same colour
const FONT_FACE = process.env.FONT_FACE || "";         // e.g. "Arial"; many players ignore it
const ALIGN_SECOND = process.env.ALIGN_SECOND !== "0" && process.env.ALIGN_ARABIC !== "0";
const READ_MS_PER_CHAR = Number(process.env.READ_MS_PER_CHAR) || 85;  // reading time per character of BOTH languages (60 = ~17 chars/s)
const MIN_CUE_MS = Number(process.env.MIN_CUE_MS) || 2800;       // cues shorter than this are lengthened (never into the next cue)
const MAX_CUE_MS = Number(process.env.MAX_CUE_MS) || 7000;        // cues longer than this are cut (they linger on screen)
const MERGE_FRAGMENTS = process.env.MERGE_FRAGMENTS === "1";        // 1 = glue split sentences (shows words before they are spoken)
const ANCHOR_SECOND = process.env.ANCHOR !== "german";             // real-file option: timing of the second-language file is the master
const OTHER_SOURCE_PENALTY = 10;   // Wyzie / SubDL files carry no ratings, so they start slightly behind
const SYNC_OFFSET_MS = Number(process.env.SYNC_OFFSET_MS) || 0;
// Stretch all times (drift that grows over the film): 25 -> 23.976 fps = 1.04271, 23.976 -> 25 = 0.95904.
const SYNC_RATIO = Number(process.env.SYNC_RATIO) || 1;
const CACHE_V = "16";              // bump to force players/CDN to re-fetch subtitle files
const LEAD_MS = process.env.LEAD_MS === undefined ? 350 : Number(process.env.LEAD_MS) || 0;   // show each cue this much BEFORE its start
const LINE_MAX = Number(process.env.LINE_MAX) || 84;   // one line per language up to this many characters (about 95 % of the picture width); longer ones are broken in two. Lower it if your player wraps lines early.
// a cue of at most this many words that continues the previous (unfinished) sentence is merged into it; 0 = off
const ORPHAN_WORDS = process.env.ORPHAN_WORDS === undefined ? 2 : Number(process.env.ORPHAN_WORDS) || 0;
const SPACER = process.env.LANG_GAP === "0" ? "" : "\u200B\n";   // an empty line between German and the second language
// ---------------------------------------------------------------------------

let token = null;
let apiBase = process.env.OS_API_BASE || API_DEFAULT;
const wyzieBase = process.env.WYZIE_BASE || WYZIE_DEFAULT;

const MANIFEST = {
  id: "community.opensubtitles.sdh.de",
  version: "2.8.1",
  name: "German SDH + English (dual)",
  description: "German SDH (spoken words) on top, English underneath, in one subtitle. Sources: OpenSubtitles, Wyzie, SubDL.",
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

const STOP = new Set(["srt", "mkv", "mp4", "avi", "the", "de", "ger", "german", "sdh", "hi", "and", "ar", "arabic", "en", "eng", "english"]);

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

// Second language: the best NOTED (rated) file first, then popularity, then closeness to your video file.
function scoreSecond(c, fileTokens) {
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

const wordCount = (t) => plain(t).trim().split(/\s+/).filter(Boolean).length;
const hasDash = (t) => /(^|\n)\s*(<[^>]+>)*[-\u2013\u2014]/.test(t);
const SENTENCE_END = /[.?!\u2026:"\u00BB\u201D)\]]$/;

// A cue with only one or two words that belongs to the previous, unfinished sentence ("Ein bisschen" / "Hexengezwitscher?")
// is joined to it instead of flashing up alone. Everything else keeps the file's own timing.
function mergeOrphans(cues) {
  const out = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && ORPHAN_WORDS) {
      const a = plain(prev.text).trim(), b = plain(c.text).trim();
      const small = wordCount(b) <= ORPHAN_WORDS || wordCount(a) <= ORPHAN_WORDS;
      if (small && !SENTENCE_END.test(a) && c.start - prev.end <= 700 && !hasDash(prev.text) && !hasDash(c.text) && a.length + b.length <= 90) {
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
  const cues = cleaned.length ? cleaned : raw;
  return MERGE_FRAGMENTS ? mergeFragments(cues) : mergeOrphans(cues);
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
// Returns { map(t) } converting a second-language timestamp to German time.
function computeMap(de, ar) {
  const identity = { map: (t) => t, ratio: 1, offset: 0 };
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
  if (!pts.length) return { map: map0, ratio: best.r, offset: off0 };

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
  return { map: (t) => { const m = map0(t); return m + drift(m); }, ratio: best.r, offset: off0 };
}

// Alignment plus a "quality": the share of German cues that now have a second-language cue starting within 1 s.
// A low quality means the file is another episode / cut and should not be used.
function bestAlignment(de, ar) {
  const al = ALIGN_SECOND ? computeMap(de, ar) : { map: (t) => t, ratio: 1, offset: 0 };
  const ref = de.filter((c) => !isSoundCue(c.text));
  const base = ref.length >= 10 ? ref : de;
  const starts = ar.map((c) => al.map(c.start)).sort((x, y) => x - y);
  const step = Math.max(1, Math.ceil(base.length / 600));
  let n = 0, hit = 0;
  for (let i = 0; i < base.length && starts.length; i += step) {
    n++;
    if (Math.abs(nearest(starts, base[i].start) - base[i].start) <= 1000) hit++;
  }
  return { map: al.map, ratio: al.ratio, offset: al.offset, quality: n ? hit / n : 0 };
}

// ===== Look: bidi marks, joining, durations ===================================

function styled(text, color) {
  if (!color && !FONT_FACE) return text;
  const attrs = `${FONT_FACE ? ` face="${FONT_FACE}"` : ""}${color ? ` color="${color}"` : ""}`;
  return `<font${attrs}>${text}</font>`;
}

// Breaks one long line in two where it reads best: after a sentence end, else after a comma, else at the space nearest the middle.
function breakLine(text) {
  const t = text.trim();
  if (plain(t).length <= LINE_MAX) return [t];
  const mid = t.length / 2;
  let best = -1, bestScore = Infinity, inTag = false;
  for (let i = 1; i < t.length - 1; i++) {
    if (t[i] === "<") inTag = true;
    else if (t[i] === ">") inTag = false;
    else if (!inTag && t[i] === " ") {
      const pen = /[.?!\u2026]/.test(t[i - 1]) ? 0 : /[,;:]/.test(t[i - 1]) ? 8 : 20;
      const score = Math.abs(i - mid) + pen;
      if (score < bestScore) { bestScore = score; best = i; }
    }
  }
  return best < 0 ? [t] : [t.slice(0, best).trim(), t.slice(best + 1).trim()];
}

// Re-lays the lines of a cue: a sentence the file wrapped at some odd place ("Was wird / das?") is joined and broken again in
// a sensible place; dialogue with dashes keeps one line per speaker.
function layoutLines(lines) {
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  const dialogue = clean.some((l) => /^(<[^>]+>)*[-\u2013\u2014]/.test(l));
  return (dialogue ? clean : [clean.join(" ")]).flatMap(breakLine).map(balanceTags).filter(Boolean);
}

// German block + empty line + second-language block
const joinLangs = (g, sec) => `${g}\n${SPACER}${sec}`;

// Right-to-left language line: an RLM at both ends keeps "." "?" "!" and the dialogue dash on the correct side.
function fixRtlLine(line) {
  let l = line.replace(BIDI, "").trim();
  if (!l) return "";
  // A question/exclamation mark typed at the logical START of the line belongs at the end.
  const m = l.match(/^(-\s*)?([?\u061F!]+)\s*(.+)$/);
  if (m) {
    const endsWithMark = /[?\u061F!]$/.test(m[3]);
    l = `${m[1] || ""}${m[3]}${endsWithMark ? "" : m[2]}`;
  }
  l = l.replace(/\?/g, "\u061F").replace(/(?<!\d),|,(?!\d)/g, "\u060C");
  return styled(`\u200F${l}\u200F`, SECOND_COLOR);
}

// The second-language lines of one cue (spoken words only).
function secondBlock(text) {
  const lines = layoutLines(cleanLines(text.replace(/<[^>]+>/g, ""), !RTL));
  return lines.map((l) => (RTL ? fixRtlLine(l) : styled(l.trim(), SECOND_COLOR))).filter(Boolean).join("\n");
}

// German lines of a dual cue. With a right-to-left second language an LRM at both ends keeps the final "." and the
// leading "-" on the correct side even if the player lays the whole cue out right-to-left. With English: plain text.
function germanBlock(text) {
  return layoutLines(text.split("\n"))
    .map((l) => styled(RTL ? `\u200E${l.replace(BIDI, "")}\u200E` : l.replace(BIDI, ""), ""))
    .join("\n");
}

// Keeps the file's own timing. Only cues shorter than MIN_CUE_MS are lengthened (never into the next cue),
// and cues longer than MAX_CUE_MS are cut so nothing lingers on screen.
function fixDurations(cues) {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const next = cues[i + 1];
    const chars = plain(c.text).replace(/\s+/g, " ").trim().length;
    const want = Math.max(MIN_CUE_MS, READ_MS_PER_CHAR ? chars * READ_MS_PER_CHAR : 0);
    let end = c.end;
    if (end - c.start < want) {
      end = c.start + want;
      if (next) end = Math.min(end, Math.max(c.end, next.start - 60));
    }
    c.end = Math.min(end, c.start + MAX_CUE_MS);
  }
  return cues;
}

function finalize(cues) {
  cues.sort((a, b) => a.start - b.start);
  if (LEAD_MS) {
    // appear a little early so reading starts with the speech; never earlier than the previous cue's end
    for (let i = 0; i < cues.length; i++) {
      const floor = i ? Math.min(cues[i - 1].end, cues[i].start) : 0;
      cues[i].start = Math.max(floor, cues[i].start - LEAD_MS);
    }
  }
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

// Pairs each cue of `others` with the base cue it overlaps most, or the closest one within 1.5 s.
function attachNearest(base, others) {
  const TOL = 1500;
  const attached = base.map(() => []);
  const standalone = [];
  for (const a of others) {
    let bestI = -1, bestO = -Infinity;
    for (let i = 0; i < base.length; i++) {
      const d = base[i];
      if (d.start > a.end + TOL) break;
      if (d.end < a.start - TOL) continue;
      const o = Math.min(d.end, a.end) - Math.max(d.start, a.start); // negative = gap between them
      if (o > bestO) { bestO = o; bestI = i; }
    }
    if (bestI >= 0) attached[bestI].push(a); else standalone.push(a);
  }
  return { attached, standalone };
}

const shift = (cues, al) => cues.map((c) => ({ start: Math.round(al.map(c.start)), end: Math.round(al.map(c.end)), text: c.text }));

// German timing is the master (what the repo does): the second language goes under each German cue.
function mergeDual(de, sec, al) {
  const { attached, standalone } = attachNearest(de, shift(sec, al));
  const out = de.map((d, i) => ({
    start: d.start,
    end: d.end,
    text: attached[i].length ? joinLangs(germanBlock(d.text), attached[i].map((a) => a.text).join("\n")) : d.text
  }));
  for (const a of standalone) out.push(a); // far from any German cue: kept, so no line is lost
  return finalize(out);
}

// Second-language timing is the master: the German cues are mapped onto it (this also removes a 25 vs 23.976 fps drift).
function mergeAnchored(sec, de, al) {
  const { attached, standalone } = attachNearest(sec, shift(de, al));
  const out = sec.map((s, i) => ({
    start: s.start,
    end: s.end,
    text: attached[i].length ? joinLangs(germanBlock(attached[i].map((d) => d.text).join("\n")), s.text) : s.text
  }));
  for (const d of standalone) out.push({ start: d.start, end: d.end, text: d.text });
  return finalize(out);
}

// cues of a real second-language file, cleaned to spoken words (sound-only cues disappear)
const cleanSecond = (raw) => raw.map((c) => ({ ...c, text: secondBlock(c.text) })).filter((c) => c.text);

// ===== Translation of the German file itself (what the repo does) ============
// DeepL if DEEPL_KEY is set (official, best quality), otherwise Google's free web endpoint.

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

async function deeplChunk(chunk) {
  const key = process.env.DEEPL_KEY;
  const host = key.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
  const target = SECOND_LANG === "en" ? "EN-US" : SECOND_LANG.toUpperCase();
  const r = await fetch(`${host}/v2/translate`, {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ text: chunk, source_lang: "DE", target_lang: target }),
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error(`deepl failed: ${r.status}`);
  const j = await r.json();
  return (j.translations || []).map((t) => t.text);
}

async function googleRaw(lines) {
  const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=de&tl=${SECOND_LANG}&dt=t`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0" },
    body: "q=" + encodeURIComponent(lines.join("\n")),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`google translate failed: ${r.status}`);
  const j = await r.json();
  return (j[0] || []).map((seg) => seg[0] || "").join("").replace(/\n$/, "").split("\n");
}

async function googleChunk(chunk) {
  const lines = await googleRaw(chunk);
  if (lines.length === chunk.length) return lines;
  // line count got mangled: translate this chunk one line at a time
  return pool(chunk, 4, async (t) => (await googleRaw([t]))[0] || "");
}

// texts[i] -> translated text (or "" when it could not be translated)
async function translateTexts(texts) {
  const idx = texts.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
  const chunks = [];
  let cur = [], size = 0;
  const maxItems = process.env.DEEPL_KEY ? 50 : 40;
  for (const i of idx) {
    if (cur.length && (cur.length >= maxItems || size + texts[i].length > 3500)) {
      chunks.push(cur); cur = []; size = 0;
    }
    cur.push(i); size += texts[i].length;
  }
  if (cur.length) chunks.push(cur);

  const run = process.env.DEEPL_KEY ? deeplChunk : googleChunk;
  const res = await pool(chunks, 6, async (ids) => {
    try { return await run(ids.map((i) => texts[i])); }
    catch (e) { console.error(e); return []; }
  });
  const out = texts.map(() => "");
  chunks.forEach((ids, c) => ids.forEach((i, k) => { out[i] = (res[c] && res[c][k]) || ""; }));
  return out;
}

const isDashLine = (l) => /^\s*(<[^>]+>)*[-\u2013\u2014]/.test(l);

// What goes to the translator: dash dialogue line by line (separate speakers); a sentence that the file cut into
// several cues is translated as ONE sentence (much better than translating the halves), then shared back over those cues.
function translationPlan(de) {
  const units = [];
  for (let i = 0; i < de.length; ) {
    const lines = de[i].text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.some(isDashLine)) {
      lines.forEach((l, k) => units.push({ text: l, cues: [i], line: k }));
      i++;
      continue;
    }
    const group = [i];
    let total = plain(de[i].text).length;
    while (group.length < 3) {
      const j = group[group.length - 1], last = de[j], nxt = de[j + 1];
      if (!nxt || SENTENCE_END.test(plain(last.text).trim())) break;
      if (nxt.start - last.end > 1000 || nxt.text.split("\n").some(isDashLine)) break;
      total += plain(nxt.text).length + 1;
      if (total > 150) break;
      group.push(j + 1);
    }
    units.push({ text: group.map((j) => de[j].text.replace(/\n/g, " ")).join(" "), cues: group, line: null });
    i += group.length;
  }
  return units;
}

// Splits a translated sentence over several cues in proportion to the German parts, preferably after punctuation.
function shareOut(text, weights) {
  const words = text.split(/\s+/).filter(Boolean);
  const n = weights.length;
  if (words.length < n) return [text, ...Array(n - 1).fill("")];
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const cuts = [];
  let acc = 0, prevCut = 0;
  for (let i = 0; i < n - 1; i++) {
    acc += weights[i];
    let idx = Math.round((words.length * acc) / total);
    for (const d of [0, 1, -1, 2, -2]) {
      const j = idx + d;
      if (j > prevCut && j < words.length && /[.,;:?!\u2026]$/.test(words[j - 1])) { idx = j; break; }
    }
    idx = Math.max(prevCut + 1, Math.min(idx, words.length - (n - 1 - i)));
    cuts.push(idx);
    prevCut = idx;
  }
  const parts = [];
  let from = 0;
  for (const c of [...cuts, words.length]) { parts.push(words.slice(from, c).join(" ")); from = c; }
  return parts;
}

const trCache = new Map();   // German ref -> translated text per German cue (index-aligned with the cues)

// Translated text for every German cue, or null when translating failed.
async function getTranslations(deRef, de) {
  if (trCache.has(deRef)) return trCache.get(deRef);
  const units = translationPlan(de);
  let tr;
  try { tr = await translateTexts(units.map((u) => plain(u.text).replace(/\s+/g, " ").trim())); } catch (e) { console.error(e); return null; }
  if (tr.filter(Boolean).length < units.length * 0.6) return null;
  const per = de.map(() => []);
  units.forEach((u, n) => {
    if (!tr[n]) return;
    if (u.line !== null) per[u.cues[0]][u.line] = tr[n];
    else if (u.cues.length === 1) per[u.cues[0]][0] = tr[n];
    else shareOut(tr[n], u.cues.map((j) => plain(de[j].text).length)).forEach((part, k) => { if (part) per[u.cues[k]][0] = part; });
  });
  const second = per.map((p) => p.filter(Boolean).join("\n"));
  trCache.set(deRef, second);
  if (trCache.size > 10) trCache.delete(trCache.keys().next().value);
  return second;
}

// German cue + its own translation, under the timing of `cues` (the German file's own, or re-timed).
function buildTranslated(cues, second) {
  return finalize(cues.map((d, i) => {
    const block = second[i] ? secondBlock(second[i]) : "";
    return { start: d.start, end: d.end, text: block ? joinLangs(germanBlock(d.text), block) : d.text };
  }));
}

// Alignment that moves the German cues onto the timeline of a well-rated REAL second-language file (null if none fits).
// Such a file was timed from the actual speech, so this also removes constant offsets and 25 <-> 23.976 fps drift.
async function anchorMap(de, refs) {
  let best = null;
  for (const ref of refs) {
    let sec;
    try {
      sec = cleanSecond(parseSrt(await download(ref)));
    } catch (e) {
      console.error(`anchor file ${ref.slice(0, 12)} failed:`, e.message || e);
      continue;
    }
    if (sec.length < 5) continue;
    const al = bestAlignment(sec, de);   // reference = the real file, moving = the German cues
    if (!best || al.quality > best.quality) best = al;
    if (al.quality >= GOOD_FIT) break;
  }
  if (best && best.quality >= MIN_FIT) {
    console.log(`anchored: fit ${best.quality.toFixed(2)}, ratio ${best.ratio.toFixed(4)}, offset ${Math.round(best.offset)} ms`);
    return best;
  }
  console.error(`could not anchor (best fit ${best ? best.quality.toFixed(2) : "n/a"}), keeping German timing`);
  return null;
}

// German + a REAL second-language file. Tries the refs in order; keeps the first that fits the German timing
// well, otherwise the best-fitting one. Returns null when none is usable.
async function buildWithFiles(de, refs, anchorSecond) {
  let chosen = null;
  for (const ref of refs) {
    let sec;
    try {
      sec = cleanSecond(parseSrt(await download(ref)));
    } catch (e) {
      console.error(`second file ${ref.slice(0, 12)} failed:`, e.message || e);
      continue;
    }
    if (sec.length < 5) continue;
    const al = anchorSecond ? bestAlignment(sec, de) : bestAlignment(de, sec);
    if (!chosen || al.quality > chosen.al.quality) chosen = { sec, al };
    if (al.quality >= GOOD_FIT) break;
  }
  if (chosen && chosen.al.quality >= MIN_FIT) {
    const { al } = chosen;
    console.log(`fit ${al.quality.toFixed(2)}, ratio ${al.ratio.toFixed(4)}, offset ${Math.round(al.offset)} ms, master ${anchorSecond ? "second file" : "german"}`);
    return anchorSecond ? mergeAnchored(chosen.sec, de, al) : mergeDual(de, chosen.sec, al);
  }
  console.error(`no usable second-language file (best fit ${chosen ? chosen.al.quality.toFixed(2) : "n/a"})`);
  return null;
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

const outCache = new Map();
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
        run(`os-${SECOND_LANG}`, () => searchLang(type, id, {}, SECOND_LANG, SECOND_SDH_ONLY ? "only" : "include")),
        run("wyzie-de-sdh", () => searchWyzie(type, id, "de", true)),
        run(`wyzie-${SECOND_LANG}`, () => searchWyzie(type, id, SECOND_LANG, SECOND_SDH_ONLY)),
        run("subdl-de-sdh", () => searchSubdl(type, id, "de", true)),
        run(`subdl-${SECOND_LANG}`, () => searchSubdl(type, id, SECOND_LANG, SECOND_SDH_ONLY))
      ]);
      return sendJson(res, 200, {
        secondLang: SECOND_LANG, mode: SECOND_MODE, deeplKeySet: !!process.env.DEEPL_KEY, osKeySet: !!process.env.OS_API_KEY, wyzieKeySet: !!process.env.WYZIE_KEY, subdlKeySet: !!process.env.SUBDL_KEY, results: out
      });
    }

    if (parts[0] === "subtitles" && parts.length >= 3) {
      const type = parts[1];
      const id = parts[2].replace(/\.json$/, "");
      const extraRaw = (parts[3] || "").replace(/\.json$/, "");
      const extra = Object.fromEntries(new URLSearchParams(extraRaw));
      const subtitles = [];
      console.log("extra:", JSON.stringify(extra));   // does the player send videoHash / filename / videoSize?

      if (id.startsWith("tt") && process.env.OS_API_KEY) {
        const fileTokens = tokens(extra.filename || "");
        const wantFiles = SECOND_MODE !== "translate";
        const none = Promise.resolve([]);
        const [deOs, seOs, deWy, seWy, deSd, seSd] = await Promise.all([
          safe(searchLang(type, id, extra, "de", "only", { ai_translated: "exclude", machine_translated: "exclude" })),
          wantFiles ? safe(searchLang(type, id, extra, SECOND_LANG, SECOND_SDH_ONLY ? "only" : "include")) : none,
          safe(searchWyzie(type, id, "de", true)),
          wantFiles ? safe(searchWyzie(type, id, SECOND_LANG, SECOND_SDH_ONLY)) : none,
          safe(searchSubdl(type, id, "de", true)),
          wantFiles ? safe(searchSubdl(type, id, SECOND_LANG, SECOND_SDH_ONLY)) : none
        ]);
        const de = rank([...deOs, ...deWy, ...deSd], fileTokens, scoreDe);
        const se = rank([...seOs, ...seWy, ...seSd], fileTokens, scoreSecond);

        // translated option: needs only the German file; real files are the fallback if translating fails
        const trOpt = (i) => ({
          key: `tr-${shortId(de[i].ref)}`,
          path: `tr/${de[i].ref}${se.slice(0, FALLBACK_FILES + 1).map((c) => "~" + c.ref).join("")}`
        });
        // translated + re-timed to the best-rated real file (needs a real file to anchor to)
        const anchOpt = (i) => ({
          key: `tra-${shortId(de[i].ref)}-${shortId(se[0].ref)}`,
          path: `tra/${de[i].ref}${se.slice(0, FALLBACK_FILES + 1).map((c) => "~" + c.ref).join("")}`
        });
        // real-file option: the j-th best file first, the others as fallbacks
        const fileOpt = (i, j) => {
          const others = se.map((_, k) => k).filter((k) => k !== j).slice(0, FALLBACK_FILES);
          return {
            key: `f-${shortId(de[i].ref)}-${shortId(se[j].ref)}`,
            path: `dual/${de[i].ref}~${[se[j].ref, ...others.map((k) => se[k].ref)].join("~")}`
          };
        };

        const opts = [];
        if (SECOND_MODE === "translate") {
          for (let i = 0; i < DUAL_OPTIONS; i++) if (de[i]) opts.push(trOpt(i));
        } else if (SECOND_MODE === "files") {
          [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2]]
            .filter(([i, j]) => de[i] && se[j]).slice(0, DUAL_OPTIONS)
            .forEach(([i, j]) => opts.push(fileOpt(i, j)));
        } else {
          // both: 1 = translation re-timed to the best-rated real file, 2 = that real file under the German,
          //       3 = translation with the German file's own timing. No real file at all: 3 translated options.
          if (de[0] && se[0]) {
            opts.push(anchOpt(0), fileOpt(0, 0), trOpt(0));
          } else {
            for (let i = 0; i < DUAL_OPTIONS; i++) if (de[i]) opts.push(trOpt(i));
          }
        }
        opts.slice(0, DUAL_OPTIONS).forEach((o, n) => {
          subtitles.push({ id: `dual-${n + 1}-${o.key}`, url: `${base}/${o.path}.v${CACHE_V}.srt`, lang: "ger" });
        });
        // files mode and no second-language file anywhere: still offer the best German SDH
        if (!subtitles.length && de[0]) {
          subtitles.push({ id: `de-only-${shortId(de[0].ref)}`, url: `${base}/dual/${de[0].ref}.v${CACHE_V}.srt`, lang: "ger" });
        }
      }
      return sendJson(res, 200, { subtitles }, "public, s-maxage=3600");
    }

    // /dual/<de>[~<file>...] real file merged | /tr/<de>[~<file>...] translated | /tra/<de>~<file>... translated + re-timed
    if (["dual", "tr", "tra"].includes(parts[0]) && parts[1]) {
      const m = parts[1].match(/^([\w-]+)((?:~[\w-]+)*)(?:\.v\d+)?\.srt$/);
      if (!m) {
        res.statusCode = 400;
        return res.end("Bad id");
      }
      const deRef = m[1];
      const refs = m[2] ? m[2].slice(1).split("~") : [];
      const cacheKey = `${parts[0]}/${parts[1]}`;
      if (outCache.has(cacheKey)) return sendSrt(res, outCache.get(cacheKey));

      const deText = await download(deRef);
      const de = loadGerman(deText);
      if (!de.length) return sendSrt(res, deText);

      let out = null;
      if (parts[0] !== "dual") {
        const second = await getTranslations(deRef, de);
        if (second) {
          const al = parts[0] === "tra" ? await anchorMap(de, refs) : null;
          out = buildTranslated(al ? shift(de, al) : de, second);
        }
      }
      if (!out) out = await buildWithFiles(de, refs, parts[0] !== "tr" && ANCHOR_SECOND);
      out = out || germanOnly(de);
      outCache.set(cacheKey, out);
      if (outCache.size > 30) outCache.delete(outCache.keys().next().value);
      return sendSrt(res, out);
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
