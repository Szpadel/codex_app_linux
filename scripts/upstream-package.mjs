import path from "node:path";

import { readAsarJson } from "./asar.mjs";
import { parseBuildFlavor } from "./build-flavor.mjs";
import { ensureDir, exists, resolveLinuxPortPath, rmrf, run, stripSemverRange } from "./common.mjs";

export const OFFICIAL_CODEX_DMG_URL = "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";

const DMG_APP_CONTENTS_PREFIX = "Codex Installer/Codex.app/Contents";
const APP_ASAR_ENTRY = `${DMG_APP_CONTENTS_PREFIX}/Resources/app.asar`;
const APP_ASAR_UNPACKED_ENTRY = `${DMG_APP_CONTENTS_PREFIX}/Resources/app.asar.unpacked/*`;
const ICON_PNG_ENTRY = `${DMG_APP_CONTENTS_PREFIX}/Resources/codexTemplate.png`;
const ICON_PNG_2X_ENTRY = `${DMG_APP_CONTENTS_PREFIX}/Resources/codexTemplate@2x.png`;

export function resolveDmgPath(inputPath) {
  if (inputPath) {
    return path.resolve(inputPath);
  }

  if (process.env.CODEX_DMG_PATH) {
    return path.resolve(process.env.CODEX_DMG_PATH);
  }

  return resolveLinuxPortPath("Codex.dmg");
}

function macBundleDirFor(outputDir) {
  return path.join(outputDir, "Codex Installer", "Codex.app", "Contents");
}

async function extractOptionalArchiveEntry(dmgPath, outputDir, entry) {
  const result = await run("7z", ["x", "-y", dmgPath, `-o${outputDir}`, entry], {
    capture: true,
    check: false,
  });

  const output = `${result.stdout}\n${result.stderr}`;

  if (result.code !== 0 && !output.includes("No files to process")) {
    throw new Error(
      `Optional archive extraction failed for "${entry}"\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }
}

export async function extractMacPayload({
  dmgPath,
  outputDir,
  includeUnpacked = true,
  includeIcons = true,
  quiet = false,
}) {
  const macBundleDir = macBundleDirFor(outputDir);
  const appResourcesDir = path.join(macBundleDir, "Resources");
  const appAsarPath = path.join(appResourcesDir, "app.asar");
  const appAsarUnpackedPath = path.join(appResourcesDir, "app.asar.unpacked");
  const iconPngPath = path.join(appResourcesDir, "codexTemplate@2x.png");
  const fallbackIconPngPath = path.join(appResourcesDir, "codexTemplate.png");

  const hasRequiredFiles =
    (await exists(appAsarPath)) &&
    (!includeUnpacked || (await exists(appAsarUnpackedPath))) &&
    (!includeIcons || (await exists(iconPngPath)) || (await exists(fallbackIconPngPath)));

  if (hasRequiredFiles) {
    return {
      macBundleDir,
      appResourcesDir,
      appAsarPath,
      appAsarUnpackedPath,
      iconPngPath,
      fallbackIconPngPath,
    };
  }

  await rmrf(outputDir);
  await ensureDir(outputDir);

  const entries = ["x", "-y", dmgPath, `-o${outputDir}`, APP_ASAR_ENTRY];

  if (includeUnpacked) {
    entries.push(APP_ASAR_UNPACKED_ENTRY);
  }

  await run("7z", entries, { capture: quiet });

  if (includeIcons) {
    await extractOptionalArchiveEntry(dmgPath, outputDir, ICON_PNG_ENTRY);
    await extractOptionalArchiveEntry(dmgPath, outputDir, ICON_PNG_2X_ENTRY);

    if (!(await exists(iconPngPath)) && !(await exists(fallbackIconPngPath))) {
      throw new Error(`Missing icon assets in DMG: ${ICON_PNG_2X_ENTRY} or ${ICON_PNG_ENTRY}`);
    }
  }

  return {
    macBundleDir,
    appResourcesDir,
    appAsarPath,
    appAsarUnpackedPath,
    iconPngPath,
    fallbackIconPngPath,
  };
}

export async function readPackagedMetadata(appAsarPath) {
  const packagedManifest = await readAsarJson(appAsarPath, "package.json");

  return {
    appName: packagedManifest.name,
    productName: packagedManifest.productName,
    version: packagedManifest.version,
    electronVersion: stripSemverRange(packagedManifest.devDependencies.electron),
    buildFlavor: parseBuildFlavor(packagedManifest.codexBuildFlavor, {
      source: "package.json codexBuildFlavor",
    }) ?? "prod",
    packagedManifest,
  };
}
