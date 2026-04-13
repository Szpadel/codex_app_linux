import path from "node:path";
import { cp, readFile, rename, writeFile } from "node:fs/promises";

import {
  copyExecutable,
  downloadFile,
  ensureDir,
  exists,
  logStep,
  resolveLinuxPortPath,
  rmrf,
  run,
  writeExecutable,
} from "./common.mjs";
import {
  buildNativeDependencyMap,
  discoverNativeModules,
  syncRebuiltNativeModules,
} from "./native-modules.mjs";
import { resolveBundledToolPaths } from "./tool-resolver.mjs";
import {
  extractMacPayload as extractUpstreamMacPayload,
  readPackagedMetadata,
  resolveDmgPath,
} from "./upstream-package.mjs";

const dmgPath = resolveDmgPath();
const cacheDir = resolveLinuxPortPath("cache");
const distDir = resolveLinuxPortPath("dist");
const workDir = resolveLinuxPortPath("work");
const dmgExtractDir = path.join(workDir, "dmg");
const runtimeDir = path.join(workDir, "electron-runtime");
const nativeDepsDir = path.join(workDir, "native-deps");
const appDir = path.join(workDir, "AppDir");
const packagedAppRoot = path.join(appDir, "usr", "lib", "codex");
const packagedResourcesDir = path.join(packagedAppRoot, "resources");
const appImageToolPath = path.join(cacheDir, "appimagetool-x86_64.AppImage");
const runtimeVersionFile = path.join(runtimeDir, ".electron-version");

const DEFAULT_APPIMAGETOOL_URL =
  "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage";

function deriveExecutableName(metadata) {
  const candidate = metadata.productName ?? metadata.appName ?? "Codex";
  const normalized = candidate.replace(/[\\/:*?"<>|]+/g, "-").trim();

  if (!normalized) {
    throw new Error(`Unable to derive a Linux executable name from "${candidate}"`);
  }

  return normalized;
}

async function extractPackagedResources() {
  logStep("Extracting reusable payload from Codex.dmg");
  return await extractUpstreamMacPayload({
    dmgPath,
    outputDir: dmgExtractDir,
    includeUnpacked: true,
    includeIcons: true,
  });
}

async function prepareLinuxRuntime(electronVersion) {
  const electronZipName = `electron-v${electronVersion}-linux-x64.zip`;
  const electronZipPath = path.join(cacheDir, electronZipName);
  const electronUrl = `https://github.com/electron/electron/releases/download/v${electronVersion}/${electronZipName}`;

  logStep(`Downloading Electron ${electronVersion} Linux runtime`);
  await downloadFile(electronUrl, electronZipPath);

  const runtimeExecutablePath = path.join(runtimeDir, "electron");
  const hasRuntimeExecutable = await exists(runtimeExecutablePath);
  const cachedRuntimeVersion = (await exists(runtimeVersionFile))
    ? (await readFile(runtimeVersionFile, "utf8")).trim()
    : null;

  if (hasRuntimeExecutable && cachedRuntimeVersion === electronVersion) {
    return;
  }

  await rmrf(runtimeDir);
  await ensureDir(runtimeDir);

  logStep("Extracting Electron runtime");
  await run("7z", ["x", "-y", electronZipPath, `-o${runtimeDir}`]);
  await writeFile(runtimeVersionFile, `${electronVersion}\n`);
}

async function rebuildNativeModules(electronVersion, nativeModules) {
  if (nativeModules.length === 0) {
    logStep("No native modules detected in app.asar.unpacked");
    return;
  }

  logStep("Preparing native rebuild workspace");
  await ensureDir(nativeDepsDir);
  const toolHomeDir = path.join(workDir, "tool-home");
  const electronGypDir = path.join(cacheDir, "electron-gyp");
  await ensureDir(toolHomeDir);
  await ensureDir(electronGypDir);

  const packageJsonPath = path.join(nativeDepsDir, "package.json");
  const packageJson = {
    name: "codex-linux-port-native-deps",
    private: true,
    version: "0.0.0",
    dependencies: buildNativeDependencyMap(nativeModules),
    devDependencies: {
      "@electron/rebuild": "4.0.3",
    },
  };

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  logStep("Installing rebuild dependencies");
  await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: nativeDepsDir });

  logStep("Rebuilding native modules for Electron");
  await run(
    "npx",
    [
      "--no-install",
      "@electron/rebuild",
      "--force",
      "--build-from-source",
      "--arch=x64",
      "--platform=linux",
      "--module-dir=.",
      `--version=${electronVersion}`,
      `--which-module=${nativeModules.map((nativeModule) => nativeModule.name).join(",")}`,
    ],
    {
      cwd: nativeDepsDir,
      env: {
        HOME: toolHomeDir,
        ELECTRON_GYP_DIR: electronGypDir,
        npm_config_devdir: electronGypDir,
      },
    },
  );
}

async function prepareAppDir(
  metadata,
  extractedPayload,
  nativeModules,
  hostCodexBinary,
  hostRipgrepBinary,
) {
  await rmrf(appDir);
  await ensureDir(path.dirname(packagedAppRoot));
  logStep("Assembling AppDir");
  await cp(runtimeDir, packagedAppRoot, { recursive: true });

  const packagedExecutablePath = path.join(packagedAppRoot, metadata.executableName);
  await rename(path.join(packagedAppRoot, "electron"), packagedExecutablePath);

  await rmrf(path.join(packagedResourcesDir, "default_app.asar"));
  await cp(extractedPayload.appAsarPath, path.join(packagedResourcesDir, "app.asar"));
  await cp(extractedPayload.appAsarUnpackedPath, path.join(packagedResourcesDir, "app.asar.unpacked"), {
    recursive: true,
  });

  await syncRebuiltNativeModules({ nativeDepsDir, packagedResourcesDir, nativeModules });

  await copyExecutable(hostCodexBinary, path.join(packagedResourcesDir, "codex"));
  await copyExecutable(hostRipgrepBinary, path.join(packagedResourcesDir, "rg"));

  const desktopId = "com.openai.codex";
  const rootDesktopFile = path.join(appDir, `${desktopId}.desktop`);
  const rootIconFile = path.join(appDir, `${desktopId}.png`);
  const shareDesktopFile = path.join(appDir, "usr", "share", "applications", `${desktopId}.desktop`);
  const shareIconFile = path.join(
    appDir,
    "usr",
    "share",
    "icons",
    "hicolor",
    "512x512",
    "apps",
    `${desktopId}.png`,
  );
  const metainfoFile = path.join(
    appDir,
    "usr",
    "share",
    "metainfo",
    `${desktopId}.appdata.xml`,
  );

  const iconSource = (await exists(extractedPayload.iconPngPath))
    ? extractedPayload.iconPngPath
    : extractedPayload.fallbackIconPngPath;
  await ensureDir(path.dirname(shareIconFile));
  logStep("Generating Linux desktop icon");
  await run("magick", [iconSource, "-background", "none", "-resize", "512x512", rootIconFile]);
  await cp(rootIconFile, shareIconFile);

  const desktopContents = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${metadata.productName ?? "Codex"}`,
    "Comment=OpenAI Codex desktop app",
    "Exec=AppRun",
    `Icon=${desktopId}`,
    "Terminal=false",
    "Categories=Development;",
    "StartupWMClass=Codex",
    "",
  ].join("\n");
  await writeFile(rootDesktopFile, desktopContents);
  await ensureDir(path.dirname(shareDesktopFile));
  await writeFile(shareDesktopFile, desktopContents);
  await ensureDir(path.dirname(metainfoFile));
  await writeFile(
    metainfoFile,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<component type="desktop-application">',
      `  <id>${desktopId}.desktop</id>`,
      `  <name>${metadata.productName ?? "Codex"}</name>`,
      "  <summary>OpenAI Codex desktop app</summary>",
      "  <metadata_license>CC0-1.0</metadata_license>",
      "  <project_license>LicenseRef-proprietary</project_license>",
      '  <developer id="com.openai">',
      "    <name>OpenAI</name>",
      "  </developer>",
      "  <description>",
      "    <p>Unofficial Linux AppImage build of the Codex desktop application assembled from the packaged macOS release.</p>",
      "  </description>",
      "  <launchable type=\"desktop-id\">com.openai.codex.desktop</launchable>",
      "  <categories>",
      "    <category>Development</category>",
      "  </categories>",
      '  <content_rating type="oars-1.1" />',
      "  <url type=\"homepage\">https://developers.openai.com/codex</url>",
      "</component>",
      "",
    ].join("\n"),
  );

  const appRunContents = [
    "#!/bin/sh",
    "set -eu",
    'APPDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'APP_ROOT="$APPDIR/usr/lib/codex"',
    'RESOURCE_ROOT="$APP_ROOT/resources"',
    'export CODEX_CLI_PATH="${CODEX_CLI_PATH:-$RESOURCE_ROOT/codex}"',
    'export PATH="$RESOURCE_ROOT:${PATH}"',
    `exec "$APP_ROOT/${metadata.executableName}" "$@"`,
    "",
  ].join("\n");
  await writeExecutable(path.join(appDir, "AppRun"), appRunContents);
}

async function validateAppDir(metadata) {
  logStep("Validating packaged AppDir layout");

  const packagedExecutablePath = path.join(packagedAppRoot, metadata.executableName);
  const stockElectronPath = path.join(packagedAppRoot, "electron");
  const packagedAsarPath = path.join(packagedResourcesDir, "app.asar");
  const defaultAppAsarPath = path.join(packagedResourcesDir, "default_app.asar");
  const appRunPath = path.join(appDir, "AppRun");

  if (!(await exists(packagedExecutablePath))) {
    throw new Error(`Missing packaged executable: ${packagedExecutablePath}`);
  }

  if (await exists(stockElectronPath)) {
    throw new Error(`Unexpected stock Electron executable left in AppDir: ${stockElectronPath}`);
  }

  if (!(await exists(packagedAsarPath))) {
    throw new Error(`Missing packaged renderer bundle: ${packagedAsarPath}`);
  }

  if (await exists(defaultAppAsarPath)) {
    throw new Error(`Unexpected default_app.asar present in AppDir: ${defaultAppAsarPath}`);
  }

  const appRunContents = await readFile(appRunPath, "utf8");
  const expectedExecLine = `exec "$APP_ROOT/${metadata.executableName}" "$@"`;

  if (!appRunContents.includes(expectedExecLine)) {
    throw new Error(`AppRun does not launch the packaged executable: ${appRunPath}`);
  }

  if (appRunContents.includes('exec "$APP_ROOT/electron" "$@"')) {
    throw new Error(`AppRun still launches the stock Electron binary: ${appRunPath}`);
  }
}

async function ensureAppImageTool() {
  const toolUrl = process.env.APPIMAGETOOL_URL ?? DEFAULT_APPIMAGETOOL_URL;
  logStep("Fetching appimagetool");
  await downloadFile(toolUrl, appImageToolPath);
  await run("chmod", ["755", appImageToolPath]);
}

async function packageAppImage(version) {
  await ensureDir(distDir);
  const artifactPath = path.join(distDir, `Codex-${version}-linux-x64.AppImage`);
  const stagingArtifactPath = path.join(distDir, `.Codex-${version}-linux-x64.AppImage.tmp`);
  const previousArtifactPath = path.join(distDir, `.Codex-${version}-linux-x64.AppImage.previous`);

  logStep("Packaging AppImage");
  await rmrf(stagingArtifactPath);
  await run(appImageToolPath, [appDir, stagingArtifactPath], {
    env: {
      APPIMAGE_EXTRACT_AND_RUN: "1",
      ARCH: "x86_64",
    },
  });

  if (await exists(artifactPath)) {
    await rmrf(previousArtifactPath);
    await rename(artifactPath, previousArtifactPath);
  }

  await rename(stagingArtifactPath, artifactPath);
  await rmrf(previousArtifactPath);

  return artifactPath;
}

async function main() {
  if (!(await exists(dmgPath))) {
    throw new Error(`Missing source DMG: ${dmgPath}`);
  }

  await ensureDir(cacheDir);
  await ensureDir(distDir);
  await ensureDir(workDir);

  const extractedPayload = await extractPackagedResources();

  logStep("Reading packaged app metadata");
  const { packagedManifest, ...metadata } = await readPackagedMetadata(extractedPayload.appAsarPath);
  metadata.executableName = deriveExecutableName(metadata);
  const nativeModules = await discoverNativeModules({
    appAsarUnpackedPath: extractedPayload.appAsarUnpackedPath,
    packagedManifest,
  });

  if (nativeModules.length > 0) {
    logStep(`Discovered native modules: ${nativeModules.map((nativeModule) => nativeModule.name).join(", ")}`);
  }

  const { codexBinaryPath: hostCodexBinary, ripgrepBinaryPath: hostRipgrepBinary } =
    resolveBundledToolPaths();

  await prepareLinuxRuntime(metadata.electronVersion);
  await rebuildNativeModules(metadata.electronVersion, nativeModules);
  await prepareAppDir(
    metadata,
    extractedPayload,
    nativeModules,
    hostCodexBinary,
    hostRipgrepBinary,
  );
  await validateAppDir(metadata);
  await ensureAppImageTool();
  const artifactPath = await packageAppImage(metadata.version);

  console.log(`\nBuilt AppImage: ${artifactPath}`);
  console.log(`AppDir: ${appDir}`);
}

main().catch((error) => {
  console.error(`\nBuild failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
