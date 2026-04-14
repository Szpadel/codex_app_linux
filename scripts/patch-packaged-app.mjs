import { patchAsarTextFileInPlace, readAsarFile } from "./asar.mjs";
import { logStep } from "./common.mjs";

const BOOTSTRAP_BUNDLE_PATH = ".vite/build/bootstrap.js";
const SHARED_TRANSPARENCY_OPTION = "transparent:a,hasShadow";
const OPAQUE_WINDOW_OPTION = "transparent:0,hasShadow";
const EXPECTED_AUXILIARY_APPEARANCES = [
  "browserCommentPopup",
  "avatarOverlay",
  "hotkeyWindowHome",
  "hotkeyWindowThread",
  "trayMenu",
];

export function resolveMainProcessBundlePathFromBootstrapSource(sourceText) {
  const mainBundleMatches = [...sourceText.matchAll(/require\(`\.\/(main-[^`]+\.js)`\)/g)].map(
    ([, mainBundleName]) => mainBundleName,
  );
  const mainBundleNames = [...new Set(mainBundleMatches)];

  if (mainBundleNames.length !== 1) {
    throw new Error(
      `Expected bootstrap.js to reference exactly one main-process bundle, found ${mainBundleNames.length}`,
    );
  }

  return `.vite/build/${mainBundleNames[0]}`;
}

function assertTransparencyPatchContext(sourceText) {
  if (!sourceText.includes("function Qh(")) {
    throw new Error("Main-process bundle no longer contains the shared BrowserWindow helper");
  }

  if (!sourceText.includes("function $h(")) {
    throw new Error("Main-process bundle no longer contains the window-appearance switch");
  }

  for (const appearance of EXPECTED_AUXILIARY_APPEARANCES) {
    if (!sourceText.includes(`case\`${appearance}\``)) {
      throw new Error(`Main-process bundle no longer exposes the expected ${appearance} appearance case`);
    }
  }
}

async function resolveMainProcessBundlePath(appAsarPath) {
  const bootstrapSource = (await readAsarFile(appAsarPath, BOOTSTRAP_BUNDLE_PATH)).toString("utf8");
  return resolveMainProcessBundlePathFromBootstrapSource(bootstrapSource);
}

export function disableTransparentWindowsInMainProcessBundle(sourceText) {
  assertTransparencyPatchContext(sourceText);

  const matches = sourceText.match(/transparent:a,hasShadow/g) ?? [];

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one shared transparent BrowserWindow option in the main-process bundle, found ${matches.length}`,
    );
  }

  return sourceText.replace(SHARED_TRANSPARENCY_OPTION, OPAQUE_WINDOW_OPTION);
}

export async function applyLinuxPackagedAppPatches({ appAsarPath }) {
  logStep("Patching packaged app for Linux window opacity");
  const mainProcessBundlePath = await resolveMainProcessBundlePath(appAsarPath);

  await patchAsarTextFileInPlace({
    asarPath: appAsarPath,
    relativePath: mainProcessBundlePath,
    transform: disableTransparentWindowsInMainProcessBundle,
  });

  await assertLinuxPackagedAppPatches({ appAsarPath });
}

export async function assertLinuxPackagedAppPatches({ appAsarPath }) {
  const mainProcessBundlePath = await resolveMainProcessBundlePath(appAsarPath);
  const patchedBundle = (await readAsarFile(appAsarPath, mainProcessBundlePath)).toString("utf8");

  assertTransparencyPatchContext(patchedBundle);

  if (!patchedBundle.includes(OPAQUE_WINDOW_OPTION)) {
    throw new Error("Linux transparency patch did not write the opaque window assignment");
  }

  if (patchedBundle.includes(SHARED_TRANSPARENCY_OPTION)) {
    throw new Error("Linux transparency patch left the original shared transparent window path intact");
  }
}
