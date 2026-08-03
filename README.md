# Muncher

A lightweight Electron desktop launcher for organizing and launching your games.

## Features

- Scan and add games from local folders or Steam
- Custom game banners/artwork
- Playtime tracking
- Global show/hide shortcut (`Ctrl+Shift+M`)

## Install

1. Download the installer (`Muncher Setup x.x.x.exe`) from [Releases](../../releases).
2. Run it. Since the app isn't code-signed, Windows SmartScreen will likely show a **"Windows protected your PC"** warning.
3. Click **More info**, then **Run anyway**.
4. Follow the installer prompts.

> This warning is expected for unsigned apps and doesn't mean anything is wrong — it just means the publisher hasn't paid for a code-signing certificate.

## Dev

```bash
npm install
npm start
```

## Build

```bash
npm run dist
```

## Auto-updates

Muncher checks GitHub for a newer version a few seconds after startup, and any
time via **Settings → Check for updates**. If one is found, it shows a dialog
with the version number and a changelog, and asks **Install now** or **Later**
— nothing downloads or installs without that confirmation. If you pick
"Later," it'll ask again next launch. Once downloaded, you get a second
prompt to restart immediately or let it install automatically on your next quit.

The changelog shown is the GitHub Release's notes, which GitHub generates
automatically from the commits and merged PRs since the previous release —
there's no separate changelog file to maintain by hand.

### One-time setup (before your first release)

1. In `package.json`, replace `YOUR_GITHUB_USERNAME` (in `repository.url` and
   `build.publish`) with your actual GitHub username, and update the `repo`
   name if it isn't `muncher`.
2. Push this repo to GitHub. No extra secrets are needed — the workflow uses
   the repo's built-in `GITHUB_TOKEN`.

### Shipping a release

1. Bump `"version"` in `package.json` (e.g. `1.0.0` → `1.0.1`).
2. Commit, then tag and push:
   ```bash
   git commit -am "Release 1.0.1"
   git tag v1.0.1
   git push && git push --tags
   ```
3. Pushing the tag triggers `.github/workflows/release.yml`, which builds the
   Windows installer, publishes it as a GitHub Release, and auto-generates
   the changelog from commits since the last release. Installed copies of
   Muncher will pick it up automatically.

You can also do this manually from your machine instead of CI: run
`npm run dist -- --publish always` with a `GH_TOKEN` environment variable
set to a GitHub personal access token with `repo` scope.