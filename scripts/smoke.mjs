import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";

import { exists, resolveExecutable, resolveLinuxPortPath, rmrf } from "./common.mjs";
import {
  FORBIDDEN_STARTUP_MARKERS,
  REQUIRED_STARTUP_MARKERS,
  runRuntimeSmoke,
} from "./smoke-runtime.mjs";

const appDir = resolveLinuxPortPath("work", "AppDir");
const appRunPath = path.join(appDir, "AppRun");
const packagedAppRoot = path.join(appDir, "usr", "lib", "codex");
const packagedResourcesDir = path.join(packagedAppRoot, "resources");

async function validateLauncherLayout() {
  const appRunContents = await readFile(appRunPath, "utf8");

  if (appRunContents.includes('exec "$APP_ROOT/electron" "$@"')) {
    throw new Error(`AppRun still launches the stock Electron binary: ${appRunPath}`);
  }

  if (!(await exists(path.join(packagedResourcesDir, "app.asar")))) {
    throw new Error(`Missing packaged app bundle: ${path.join(packagedResourcesDir, "app.asar")}`);
  }
}

async function main() {
  await validateLauncherLayout();

  let xvfbRunCommand;

  try {
    xvfbRunCommand = await resolveExecutable("xvfb-run");
  } catch {
    xvfbRunCommand = null;
  }

  if (!xvfbRunCommand) {
    console.log("Skipping runtime smoke test because xvfb-run is not installed.");
    return;
  }

  const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "codex-linux-port-smoke-"));
  const homeDir = path.join(sandboxRoot, "home");
  const cacheDir = path.join(sandboxRoot, "cache");
  const configDir = path.join(sandboxRoot, "config");
  const stateDir = path.join(sandboxRoot, "state");

  // GitHub-hosted runners cannot provide a root-owned setuid chrome-sandbox inside the build artifact.
  const commandArgs = [
    "-a",
    appRunPath,
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
  ];

  try {
    console.log("Launching packaged app smoke test.");

    await runRuntimeSmoke({
      command: xvfbRunCommand,
      args: commandArgs,
      env: {
        ELECTRON_ENABLE_LOGGING: "1",
        HOME: homeDir,
        XDG_CACHE_HOME: cacheDir,
        XDG_CONFIG_HOME: configDir,
        XDG_STATE_HOME: stateDir,
      },
      requiredMarkers: REQUIRED_STARTUP_MARKERS,
      forbiddenMarkers: FORBIDDEN_STARTUP_MARKERS,
      timeoutMs: 20_000,
      shutdownGraceMs: 1_500,
      forceKillMs: 1_000,
      onStatus(event) {
        if (event.type === "required-markers-observed") {
          console.log("Observed packaged startup markers. Terminating smoke process tree.");
        }

        if (event.type === "forbidden-marker") {
          console.log(`Observed forbidden startup marker: ${event.marker}`);
        }
      },
    });

    console.log("Smoke test passed.");
  } finally {
    await rmrf(sandboxRoot);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
