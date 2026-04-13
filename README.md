# Codex Linux Builder

This repository builds an unofficial Linux `x64` AppImage for Codex from the official macOS DMG and publishes it through GitHub Releases.

## What the repository does

- downloads the official macOS DMG from `https://persistent.oaistatic.com/codex-app-prod/Codex.dmg`
- extracts the packaged Electron app payload from that DMG
- downloads the matching Linux Electron runtime
- renames the Linux runtime executable to a packaged app binary so Electron starts in production mode
- discovers native Node modules from `app.asar.unpacked` and rebuilds them for Linux
- bundles Linux `codex` and `rg` from `@openai/codex`
- assembles `AppDir`, builds an AppImage, runs a startup smoke test, and publishes the result to GitHub Releases

## What it does not do

- provide upstream-quality Linux support
- preserve the macOS updater flow
- support `arm64`
- build from the original app source tree
- sign releases

## Repository layout

- `.github/workflows/release.yml`: scheduled and manual GitHub Actions release pipeline
- `scripts/build.mjs`: AppImage assembly entrypoint
- `scripts/metadata.mjs`: reads upstream version metadata from a DMG
- `scripts/smoke.mjs`: validates packaged startup and rejects the `localhost:5175` renderer path

## GitHub workflow behavior

The `Build and Release Codex Linux` workflow runs:

- daily on a schedule
- manually through `workflow_dispatch`

Workflow behavior:

- downloads the official Codex DMG
- extracts the upstream app version from `app.asar`
- skips the build if a GitHub Release tag `v<version>` already exists, unless manual dispatch sets `force=true`
- installs `@openai/codex@latest` on the runner and passes explicit Linux `codex` and `rg` paths into the build
- publishes:
  - `Codex-<version>-linux-x64.AppImage`
  - `SHA256SUMS.txt`

Optional GitHub repository variable:

- `CODEX_DMG_URL`: overrides the default official DMG URL if OpenAI changes the download location

## Local usage

Prerequisites:

- Linux `x64`
- `node`, `npm`, `7z`, `gcc`, `g++`, `make`, `python3`
- `imagemagick`
- `xvfb-run` if you want the runtime smoke test locally
- a local Linux Codex CLI install, unless you pass explicit tool paths

Build with explicit inputs:

```bash
cd /path/to/codex-linux-builder
CODEX_DMG_PATH=/absolute/path/Codex.dmg \
CODEX_LINUX_BINARY=/absolute/path/to/codex \
RG_LINUX_BINARY=/absolute/path/to/rg \
npm run build
```

Read upstream metadata from a DMG:

```bash
cd /path/to/codex-linux-builder
npm run metadata -- --dmg /absolute/path/Codex.dmg
```

Resolve Linux `codex` and `rg` from an npm install prefix:

```bash
cd /path/to/codex-linux-builder
npm run resolve-installed-tools -- --prefix /tmp/codex-tools
```

Run the smoke test against the already-built `AppDir`:

```bash
cd /path/to/codex-linux-builder
npm run smoke
```

The smoke test fails if startup logs contain `packaged=false`, `localhost:5175`, or `ERR_CONNECTION_REFUSED`.

## Notes

- `Codex.dmg`, `dist/`, `work/`, and caches are intentionally gitignored.
- Releases are community-maintained and are not an official OpenAI Linux distribution.
