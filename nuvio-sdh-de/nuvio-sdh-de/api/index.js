// Stremio-protocol subtitle addon (works with Nuvio).
// Offers DUAL subtitles: German SDH on top, Arabic translation underneath, merged into one track,
// plus plain German SDH alternatives.
// Sources: the official OpenSubtitles.com REST API + Wyzie Subs (sub.wyzie.io) as a second source.
//
// Env vars: OS_API_KEY, OS_USERNAME, OS_PASSWORD (required)
//           DEEPL_KEY (optional but recommended: better Arabic translation, free tier 500k chars/month)
//           ARABIC_MODE=files (optional: use separate Arabic files instead of translating)
//           WYZIE_KEY    (optional: enables Wyzie Subs as an extra source)
//           ADDON_SECRET (optional: puts every route under /<secret>/)
//           SYNC_OFFSET_MS (optional: shift all subtitles, in ms)
//           OS_API_BASE, WYZIE_BASE (optional, testing only)

const UA = "NuvioSdhDe v2.1.1";
const API_DEFAULT = "https://api.opensubtitles.com/api/v1";
const WYZIE_DEFAULT = "https://sub.wyzie.io";

// ---- Settings you may want to change -------------------------------------
const ARABIC_SDH_ONLY = false;     // true = only use Arabic files flagged SDH (rare)
const ARABIC_COLOR = process.env.ARABIC_COLOR || "";   // e.g. "#FFEB3B"; empty = same colour as German (looks like ONE block)
const FONT_FACE = process.env.FONT_FACE || "";         // e.g. "Arial"; many players ignore it
// "translate" (default): Arabic = machine translation of the SAME German file -> identical timing, perfect sync.
// "files": merge a separate human-made Arabic file (can drift against the German one).
const ARABIC_MODE = process.env.ARABIC_MODE === "files" ? "files" : "translate";
// Set env ALIGN_ARABIC=0 to use the Arabic file's own timing untouched.
const ALIGN_ARABIC = process.env.ALIGN_ARABIC !== "0";
const COMPACT_MAX = 70;            // join a cue's lines into one when the whole thing is this short
const DUAL_OPTIONS = 6;            // how many dual (German+Arabic) choices to list
const GERMAN_ONLY_OPTIONS = 2;     // how many plain German SDH choices to list
const READ_MS_PER_CHAR = 55;       // minimum on-screen time per character (about 18 chars/second)
const MIN_CUE_MS = 1500;           // no subtitle stays shorter than this (if the next one allows)
const MAX_CUE_MS = 7000;
const WYZIE_PENALTY = 10;          // small score penalty for Wyzie files (they carry no ratings)
const SYNC_OFFSET_MS = Number(process.env.SYNC_OFFSET_MS) || 0;
// Stretch all times (fixes drift that grows over the film): 25 -> 23.976 fps = 1.04271, 23.976 -> 25 = 0.95904.
const SYNC_RATIO = Number(process.env.SYNC_RATIO) || 1;
const CACHE_V = "7";               // bump to force players/CDN to re-fetch subtitle files
// ---------------------------------------------------------------------------

let token = null;
let apiBase = process.env.OS_API_BASE || API_DEFAULT;
const wyzieBase = process.env.WYZIE_BASE || WYZIE_DEFAULT;

const MANIFEST = {
  id: "community.opensubtitles.sdh.de",
  version: "2.1.0",
  name: "German SDH + Arabic (dual)",
  description: "Best-rated German SDH subtitles with an Arabic translation underneath, from OpenSubtitles and Wyzie.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: false }
};

// ===== File references =======================================================
// A "ref" identifies one subtitle file inside our own URLs:
//   digits        -> OpenSubtitles file_id
//   "w" + base64url(url) -> a Wyzie download URL

const crypto = require("crypto");
const shortId = (ref) => crypto.createHash("sha1").update(ref).digest("hex").slice(0, 10);

const WYZIE_HOST = /(^|\.)wyzie\.(io|ru)$/i;

function wyzieRef(url) {
  return "w" + Buffer.from(url, "utf8").toString("base64url");
}

function wyzieUrlFromRef(ref) {
  const url = new URL(Buffer.from(ref.slice(1), "base64url").toString("utf8"));
  // Only ever fetch from Wyzie itself, never an arbitrary host.
  if (url.protocol !== "https:" || !WYZIE_HOST.test(url.hostname)) throw new Error("bad wyzie url");
  return url.toString();
}

// ===== OpenSubtitles API ====================================================

function osHeaders(extra = {}) {
  return {
    "Api-Key": process.env.OS_API_KEY || "",
    "User-Agent": UA,
    Accept: "application/json",
    ...extra
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only ONE login runs at a time; everybody else waits for it. OpenSubtitles allows ~1 login/second,
// so parallel logins (German + Arabic download at once) were answered with 429.
let loginPromise = null;
function login() {
  if (!loginPromise) {
    loginPromise = doLogin().finally(() => { loginPromise = null; });
  }
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
        machine: a.machine_translated === true || a.ai_translated === true
      };
    })
    .filter((c) => c.ref);
}

// ===== Wyzie Subs API ========================================================

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
  const qs = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const call = (q) => fetch(`${wyzieBase}/search?${q}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  let r = await call(qs);
  if (r.status === 400) {
    // some deployments reject source=all; retry with the default source
    delete params.source;
    r = await call(Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&"));
  }
  if (!r.ok) throw new Error(`wyzie search failed (${lang}): ${r.status}`);
  const list = await r.json();
  if (!Array.isArray(list)) return [];

  return list
    .filter((d) => d && d.url && String(d.language || "").toLowerCase() === lang)
    .filter((d) => !d.format || String(d.format).toLowerCase() === "srt")
    .filter((d) => !hearing || d.isHearingImpaired === true)
    .filter((d) => {
      try { return WYZIE_HOST.test(new URL(d.url).hostname); } catch { return false; }
    })
    .map((d) => ({
      ref: wyzieRef(d.url),
      source: "wyzie",
      release: [d.matchedRelease, d.release, d.fileName, d.media].filter(Boolean).join(" "),
      ratings: 0,
      downloads: 0,
      trusted: false,
      hashMatch: false,
      machine: false
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

function download(ref) {
  return ref.startsWith("w") ? downloadWyzie(ref) : downloadOs(ref);
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
  if (c.source === "wyzie") s -= WYZIE_PENALTY;
  return s;
}

function rank(list, fileTokens) {
  const seen = new Set();
  return list
    .filter((c) => (seen.has(c.ref) ? false : (seen.add(c.ref), true)))
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
  text = text.replace(/^\uFEFF/, "").replace(/\r/g, "");
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
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const plain = (t) => t.replace(/<[^>]+>/g, "").replace(BIDI, "");

// Cues that only describe sounds ([Musik], (lacht), ♪ ...) have no Arabic twin, so they must not
// take part in the alignment.
const isSoundCue = (t) => {
  const p = plain(t).trim();
  return /^[\[(♪#].*[\])♪#]?$/s.test(p) && /^[\[(♪]/.test(p) && /[\])♪]$/.test(p);
};

// Lines the Arabic file up with the German one:
//  1. global frame-rate stretch + offset (coarse search over +-60 s, then 50 ms fine search),
//  2. local drift correction per ~8 minute window (handles different cuts / ad breaks).
// Returns { map(t) } that converts an Arabic timestamp to German time.
function bestAlignment(de, ar) {
  const identity = { map: (t) => t };
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

  const ref = de.filter((c) => !isSoundCue(c.text));
  const base = ref.length >= 10 ? ref : de;
  const step = Math.max(1, Math.ceil(base.length / 600));
  const sample = base.filter((_, i) => i % step === 0);
  const ratios = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];
  const count = (scaled, off, tol) => {
    let sc = 0;
    for (const c of sample) {
      const t = c.start - off;
      if (Math.abs(near(scaled, t) - t) <= tol) sc++;
    }
    return sc;
  };

  // coarse
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

  // fine
  const scaledBest = ar.map((c) => c.start * best.r);
  let fineBest = { off: best.off, score: -1 };
  for (let off = best.off - 600; off <= best.off + 600; off += 50) {
    const sc = count(scaledBest, off, 350);
    if (sc > fineBest.score) fineBest = { off, score: sc };
  }
  const diffs = [];
  for (const c of sample) {
    const t = c.start - fineBest.off;
    const d = t - near(scaledBest, t);
    if (Math.abs(d) <= 500) diffs.push(d);
  }
  diffs.sort((x, y) => x - y);
  const off0 = Math.round(fineBest.off + (diffs.length ? diffs[diffs.length >> 1] : 0));
  const map0 = (t) => t * best.r + off0;

  // local drift per window
  const aligned = ar.map((c) => map0(c.start));
  const WIN = 8 * 60 * 1000;
  const groups = new Map();
  for (const c of base) {
    const d = c.start - near(aligned, c.start);
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

// Arabic needs explicit right-to-left handling, otherwise "?" "." "!" jump to the wrong end of the line.
function fixArabicLine(line) {
  let l = line.replace(BIDI, "").trim();
  if (!l) return "";
  // A question/exclamation mark typed at the logical START of the line belongs at the end.
  const m = l.match(/^(-\s*)?([?\u061F!]+)\s*(.+)$/);
  if (m) {
    const endsWithMark = /[?\u061F!]$/.test(m[3]);
    l = `${m[1] || ""}${m[3]}${endsWithMark ? "" : m[2]}`;
  }
  l = l.replace(/\?/g, "\u061F").replace(/(?<!\d),|,(?!\d)/g, "\u060C");
  // RLM + RLE ... PDF + RLM: whole line is right-to-left and trailing punctuation stays at the left end.
  const wrapped = `\u200F\u202B${l}\u202C\u200F`;
  return styled(wrapped, ARABIC_COLOR);
}

// Short two-line cues read better as one line: it makes each language a single compact unit.
function compactLines(lines) {
  const ok = lines.length > 1 && !lines.some((l) => /^\s*[-\u2013\u2014]/.test(plain(l))) &&
    lines.reduce((n, l) => n + plain(l).length, 0) <= COMPACT_MAX;
  return ok ? [lines.map((l) => l.trim()).join(" ")] : lines;
}

function styled(text, color) {
  let out = text;
  if (color || FONT_FACE) {
    const attrs = `${FONT_FACE ? ` face="${FONT_FACE}"` : ""}${color ? ` color="${color}"` : ""}`;
    out = `<font${attrs}>${out}</font>`;
  }
  return out;
}

function arabicBlock(text) {
  const lines = text.replace(/<[^>]+>/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  return compactLines(lines).map(fixArabicLine).filter(Boolean).join("\n");
}

// Forces each German line to be laid out left-to-right (LRM + LRE ... PDF + LRM), so a player
// that sees Arabic in the same cue does not flip the whole block into right-to-left order.
function germanLtr(text) {
  const lines = compactLines(text.split("\n").filter((l) => l.trim()));
  return lines
    .map((l) => styled(`\u200E\u202A${l.replace(BIDI, "")}\u202C\u200E`, ""))
    .join("\n");
}

// Removes SDH noise from the German track: [Musik], (Leute jubeln), {..}, music lines, and
// ALL-CAPS speaker labels such as "MAMA:". Cues that end up empty are dropped.
function cleanSdh(cues) {
  const out = [];
  for (const c of cues) {
    const lines = c.text
      .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, "")
      .split("\n")
      .filter((l) => !/[♪♫]/.test(l) && !/^\s*#.*#?\s*$/.test(l))
      .map((l) => l
        .replace(/^(\s*(?:<[^>]+>)*\s*-?\s*(?:<[^>]+>)*\s*)[A-Z\u00C4\u00D6\u00DC][A-Z\u00C4\u00D6\u00DC0-9 .'\-]{1,24}:\s*(?:<\/[a-z]+>)?\s*/, "$1")
        .replace(/<(\w+)[^>]*>\s*<\/\1>/g, "")
        .replace(/\s{2,}/g, " ")
        .replace(/<(i|b|u)>|<\/(i|b|u)>/g, (t) => t)
        .trim())
      .map((l) => ["i", "b", "u"].reduce((x, tg) => ((x.match(new RegExp(`<${tg}>`, "g")) || []).length === (x.match(new RegExp(`</${tg}>`, "g")) || []).length ? x : x.replace(new RegExp(`</?${tg}>`, "g"), "")), l))
      .filter((l) => plain(l).replace(/^[-–—\s]+$/, "").trim());
    if (!lines.length) continue;
    out.push({ ...c, text: lines.join("\n") });
  }
  return out;
}

// parse + clean + glue fragments; falls back to the uncleaned text if cleaning would remove everything
function loadGerman(text) {
  const raw = parseSrt(text);
  const cleaned = cleanSdh(raw);
  return mergeFragments(cleaned.length ? cleaned : raw);
}

// Joins German cues that are one sentence cut in two (no end punctuation, tiny gap).
function mergeFragments(cues) {
  const out = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev) {
      const a = plain(prev.text).trim();
      const b = plain(c.text).trim();
      const complete = /[.?!\u2026\u061F\u00BB"'\])]$/.test(a);
      if (!complete && c.start - prev.end <= 400 && !/^[-\u2013\u2014\[(]/.test(b) && a.length + b.length <= 84) {
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
  if (SYNC_OFFSET_MS || SYNC_RATIO !== 1) {
    for (const c of cues) {
      c.start = c.start * SYNC_RATIO + SYNC_OFFSET_MS;
      c.end = c.end * SYNC_RATIO + SYNC_OFFSET_MS;
    }
  }
  return toSrt(cues);
}

function germanOnly(text) {
  const cues = loadGerman(text);
  return cues.length ? finalize(cues) : text;
}

function mergeDual(deText, arText) {
  const de = loadGerman(deText);
  const arRaw = parseSrt(arText);
  if (!de.length) return deText;
  const al = ALIGN_ARABIC ? bestAlignment(de, arRaw) : { map: (t) => t };
  const ar = arRaw
    .map((c) => ({
      start: Math.round(al.map(c.start)),
      end: Math.round(al.map(c.end)),
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
    text: attached[i].length ? `${germanLtr(d.text)}\n${attached[i].join("\n")}` : d.text
  }));
  // Arabic cues that matched no German cue are kept, so no translation is lost.
  for (const a of standalone) out.push({ start: a.start, end: a.end, text: a.text });
  return finalize(out);
}

// ===== Machine translation (German -> Arabic) ===============================
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
  const r = await fetch(`${host}/v2/translate`, {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ text: chunk, source_lang: "DE", target_lang: "AR" }),
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error(`deepl failed: ${r.status}`);
  const j = await r.json();
  return (j.translations || []).map((t) => t.text);
}

async function googleRaw(lines) {
  const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=de&tl=ar&dt=t", {
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

// texts[i] -> Arabic text (or "" when it could not be translated)
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

const trCache = new Map();

// German SDH on top, its own Arabic translation underneath: same cue, same timing.
async function translatedDual(deText) {
  const de = loadGerman(deText);
  if (!de.length) return deText;
  const src = de.map((c) => plain(c.text).replace(/\s+/g, " ").trim());
  let tr;
  try { tr = await translateTexts(src); } catch (e) { console.error(e); return germanOnly(deText); }
  if (!tr.some(Boolean)) return germanOnly(deText);
  return finalize(de.map((d, i) => {
    const ar = tr[i] ? arabicBlock(tr[i]) : "";
    return { start: d.start, end: d.end, text: ar ? `${germanLtr(d.text)}\n${ar}` : d.text };
  }));
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

    // /debug/<type>/<imdb[:season:episode]>  -> shows what each source returned (no keys shown)
    if (parts[0] === "debug" && parts.length >= 3) {
      const type = parts[1];
      const id = parts[2];
      const run = async (name, fn) => {
        try { const l = await fn(); return { name, count: l.length, sample: l.slice(0, 2).map((c) => c.release) }; }
        catch (e) { return { name, error: String(e.message || e) }; }
      };
      const out = await Promise.all([
        run("os-de-sdh", () => searchLang(type, id, {}, "de", "only", { ai_translated: "exclude", machine_translated: "exclude" })),
        run("os-ar", () => searchLang(type, id, {}, "ar", ARABIC_SDH_ONLY ? "only" : "include")),
        run("wyzie-de-sdh", () => searchWyzie(type, id, "de", true)),
        run("wyzie-ar", () => searchWyzie(type, id, "ar", ARABIC_SDH_ONLY))
      ]);
      return sendJson(res, 200, { wyzieKeySet: !!process.env.WYZIE_KEY, osKeySet: !!process.env.OS_API_KEY, results: out });
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
        const [deOs, arOs, deWy, arWy] = await Promise.all([
          safe(searchLang(type, id, extra, "de", "only", { ai_translated: "exclude", machine_translated: "exclude" })),
          ARABIC_MODE === "files" ? safe(searchLang(type, id, extra, "ar", ARABIC_SDH_ONLY ? "only" : "include")) : Promise.resolve([]),
          safe(searchWyzie(type, id, "de", true)),
          ARABIC_MODE === "files" ? safe(searchWyzie(type, id, "ar", ARABIC_SDH_ONLY)) : Promise.resolve([])
        ]);
        const de = rank([...deOs, ...deWy], fileTokens);
        const ar = rank([...arOs, ...arWy], fileTokens);

        // Dual choices: best German on top + best Arabic underneath first, then the other
        // top-German x top-Arabic combinations, so you can compare and keep the one that fits.
        if (ARABIC_MODE === "translate") {
          de.slice(0, DUAL_OPTIONS).forEach((d, i) => {
            subtitles.push({ id: `dual-tr-${i + 1}-${shortId(d.ref)}`, url: `${base}/tr/${d.ref}.v${CACHE_V}.srt`, lang: "ger" });
          });
        } else if (ar.length) {
          const combos = [];
          for (let i = 0; i < Math.min(3, de.length); i++)
            for (let j = 0; j < Math.min(3, ar.length); j++) combos.push({ i, j });
          combos.sort((x, y) => (x.i + x.j) - (y.i + y.j) || x.i - y.i);
          combos.slice(0, DUAL_OPTIONS).forEach(({ i, j }, n) => {
            const d = de[i], a = ar[j];
            subtitles.push({
              id: `dual-${n + 1}-${shortId(d.ref)}-${shortId(a.ref)}`,
              url: `${base}/dual/${d.ref}~${a.ref}.v${CACHE_V}.srt`,
              lang: "ger"
            });
          });
        }
        // Plain German SDH alternatives, in case a dual one is off for your video.
        de.slice(0, GERMAN_ONLY_OPTIONS).forEach((d, i) => {
          subtitles.push({ id: `de-sdh-${i + 1}-${shortId(d.ref)}`, url: `${base}/dl/${d.ref}.v${CACHE_V}.srt`, lang: "ger" });
        });
      }
      return sendJson(res, 200, { subtitles }, "public, s-maxage=3600");
    }

    if (parts[0] === "tr" && parts[1]) {
      const ref = parts[1].replace(/(?:\.v\d+)?\.srt$/, "");
      if (!/^[\w-]+$/.test(ref)) {
        res.statusCode = 400;
        return res.end("Bad id");
      }
      if (!trCache.has(ref)) {
        if (!token && !ref.startsWith("w")) await login();
        trCache.set(ref, await translatedDual(await download(ref)));
        if (trCache.size > 20) trCache.delete(trCache.keys().next().value);
      }
      return sendSrt(res, trCache.get(ref));
    }

    if (parts[0] === "dual" && parts[1]) {
      const m = parts[1].match(/^([\w-]+)~([\w-]+)(?:\.v\d+)?\.srt$/);
      if (!m) {
        res.statusCode = 400;
        return res.end("Bad id");
      }
      if (!token) await login();
      const [deText, arText] = await Promise.all([
        download(m[1]),
        download(m[2]).catch((e) => { console.error(e); return null; })
      ]);
      return sendSrt(res, arText ? mergeDual(deText, arText) : germanOnly(deText));
    }

    if (parts[0] === "dl" && parts[1]) {
      const ref = parts[1].replace(/(?:\.v\d+)?\.srt$/, "");
      if (!/^[\w-]+$/.test(ref)) {
        res.statusCode = 400;
        return res.end("Bad id");
      }
      return sendSrt(res, germanOnly(await download(ref)));
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
