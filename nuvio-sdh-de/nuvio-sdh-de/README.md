# OpenSubtitles German SDH – addon for Nuvio

A small Stremio-protocol subtitle addon that returns **only German SDH** (hearing-impaired)
subtitles from OpenSubtitles, via the official REST API. Nuvio installs it with a manifest URL.

> Nuvio's GitHub `manifest.json` plugin repos (Settings → Local Scrapers) only support stream
> scrapers. Subtitles come from addons, which need a small web service. This repo is that
> service, deployed free on Vercel straight from GitHub.

## 1. Get OpenSubtitles credentials

- Free account at opensubtitles.com
- API key: https://www.opensubtitles.com/consumers
- The free tier has a daily download quota. Subtitle files are cached to save it.

## 2. Put this repo on GitHub

```
cd nuvio-sdh-de
git remote add origin https://github.com/YOUR_USER/nuvio-sdh-de.git
git push -u origin main
```

(Or create an empty repo on github.com and follow the "push an existing repository" instructions.)

## 3. Deploy on Vercel

1. vercel.com → **Add New → Project** → import your GitHub repo (free Hobby plan is enough).
2. Before deploying, add these **Environment Variables**:

| Name | Value |
|---|---|
| `OS_API_KEY` | your OpenSubtitles API key |
| `OS_USERNAME` | your OpenSubtitles username |
| `OS_PASSWORD` | your OpenSubtitles password |
| `ADDON_SECRET` | any long random string, e.g. `k9x2-your-own-random-text` |

3. Deploy. Every `git push` redeploys automatically.

`ADDON_SECRET` matters: your credentials and download quota sit behind this addon, so
every route lives under `/<secret>/`. Without it, anyone who finds the URL could burn your quota.
Don't share the final URL publicly.

## 4. Add it to Nuvio

Your manifest URL is:

```
https://YOUR-PROJECT.vercel.app/YOUR_SECRET/manifest.json
```

Open it in a browser first; you should see JSON. Then in Nuvio, open the addon settings and
add the manifest URL (menu labels vary by Nuvio version). Set German as your preferred
subtitle language in the player.

## Local testing

```
OS_API_KEY=... OS_USERNAME=... OS_PASSWORD=... ADDON_SECRET=test node server.js
curl localhost:3000/test/manifest.json
curl localhost:3000/test/subtitles/movie/tt0133093.json
```

## How it works

- `GET /<secret>/manifest.json` – addon manifest (subtitles resource, movies and series).
- `GET /<secret>/subtitles/{type}/{imdbId[:season:episode]}.json` – queries OpenSubtitles with
  `languages=de&hearing_impaired=only`, re-checks both flags, returns up to 15 results by popularity.
- `GET /<secret>/dl/{fileId}.srt` – logs in, requests the download link, returns UTF-8 SRT.
- Language is reported as `ger`. If Nuvio doesn't show the subtitles, change `lang` in `api/index.js` to `deu`.
