import path from "node:path";
import { cp, readFile, rename, writeFile } from "node:fs/promises";

import {
  deriveArtifactName,
  getBuildFlavorDisplayName,
  getDesktopIdForBuildFlavor,
  resolveBuildFlavor,
} from "./build-flavor.mjs";
import {
  copyExecutable,
  downloadFile,
  ensureDir,
  exists,
  logStep,
  resolveExecutable,
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
import { applyLinuxPackagedAppPatches, assertLinuxPackagedAppPatches } from "./patch-packaged-app.mjs";
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

function parseArgs(argv) {
  const args = {
    buildFlavor: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--build-flavor") {
      args.buildFlavor = argv[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

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
  await applyLinuxPackagedAppPatches({
    appAsarPath: path.join(packagedResourcesDir, "app.asar"),
  });

  await syncRebuiltNativeModules({ nativeDepsDir, packagedResourcesDir, nativeModules });

  await copyExecutable(hostCodexBinary, path.join(packagedResourcesDir, "codex"));
  await copyExecutable(hostRipgrepBinary, path.join(packagedResourcesDir, "rg"));

  const desktopId = metadata.desktopId;
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
  const imageMagickCommand = await resolveExecutable(["magick", "convert"]);
  await ensureDir(path.dirname(shareIconFile));
  logStep("Generating Linux desktop icon");
  await run(imageMagickCommand, [iconSource, "-background", "none", "-resize", "512x512", rootIconFile]);
  await cp(rootIconFile, shareIconFile);

  const desktopContents = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${metadata.displayName}`,
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
      `  <name>${metadata.displayName}</name>`,
      "  <summary>OpenAI Codex desktop app</summary>",
      "  <metadata_license>CC0-1.0</metadata_license>",
      "  <project_license>LicenseRef-proprietary</project_license>",
      '  <developer id="com.openai">',
      "    <name>OpenAI</name>",
      "  </developer>",
      "  <description>",
      "    <p>Unofficial Linux AppImage build of the Codex desktop application assembled from the packaged macOS release.</p>",
      "  </description>",
      `  <launchable type="desktop-id">${desktopId}.desktop</launchable>`,
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
    `export BUILD_FLAVOR="\${BUILD_FLAVOR:-${metadata.buildFlavor}}"`,
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
  const expectedBuildFlavorLine = `export BUILD_FLAVOR="\${BUILD_FLAVOR:-${metadata.buildFlavor}}"`;

  if (!appRunContents.includes(expectedExecLine)) {
    throw new Error(`AppRun does not launch the packaged executable: ${appRunPath}`);
  }

  if (appRunContents.includes('exec "$APP_ROOT/electron" "$@"')) {
    throw new Error(`AppRun still launches the stock Electron binary: ${appRunPath}`);
  }

  if (!appRunContents.includes(expectedBuildFlavorLine)) {
    throw new Error(`AppRun does not export the selected build flavor: ${appRunPath}`);
  }

  await assertLinuxPackagedAppPatches({ appAsarPath: packagedAsarPath });
}

async function ensureAppImageTool() {
  const toolUrl = process.env.APPIMAGETOOL_URL ?? DEFAULT_APPIMAGETOOL_URL;
  logStep("Fetching appimagetool");
  await downloadFile(toolUrl, appImageToolPath);
  await run("chmod", ["755", appImageToolPath]);
}

async function packageAppImage(artifactName) {
  await ensureDir(distDir);
  const artifactPath = path.join(distDir, artifactName);
  const stagingArtifactPath = path.join(distDir, `.${artifactName}.tmp`);
  const previousArtifactPath = path.join(distDir, `.${artifactName}.previous`);

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
  const { buildFlavor: inputBuildFlavor } = parseArgs(process.argv.slice(2));

  if (!(await exists(dmgPath))) {
    throw new Error(`Missing source DMG: ${dmgPath}`);
  }

  await ensureDir(cacheDir);
  await ensureDir(distDir);
  await ensureDir(workDir);

  const extractedPayload = await extractPackagedResources();

  logStep("Reading packaged app metadata");
  const { packagedManifest, ...metadata } = await readPackagedMetadata(extractedPayload.appAsarPath);
  const buildFlavorSelection = resolveBuildFlavor({
    cliBuildFlavor: inputBuildFlavor,
    upstreamBuildFlavor: metadata.buildFlavor,
  });
  metadata.executableName = deriveExecutableName(metadata);
  metadata.upstreamBuildFlavor = buildFlavorSelection.upstreamBuildFlavor;
  metadata.buildFlavor = buildFlavorSelection.buildFlavor;
  metadata.displayName = getBuildFlavorDisplayName({
    productName: metadata.productName ?? metadata.appName ?? "Codex",
    buildFlavor: metadata.buildFlavor,
  });
  metadata.desktopId = getDesktopIdForBuildFlavor(metadata.buildFlavor);
  metadata.artifactName = deriveArtifactName({
    version: metadata.version,
    buildFlavor: metadata.buildFlavor,
    upstreamBuildFlavor: metadata.upstreamBuildFlavor,
  });
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
  const artifactPath = await packageAppImage(metadata.artifactName);

  console.log(`\nBuilt AppImage: ${artifactPath}`);
  console.log(`AppDir: ${appDir}`);
}

main().catch((error) => {
  console.error(`\nBuild failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
