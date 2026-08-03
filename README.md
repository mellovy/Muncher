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
