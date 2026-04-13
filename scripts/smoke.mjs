import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";

import { exists, resolveLinuxPortPath, run } from "./common.mjs";

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

function assertPackagedStartup(logOutput) {
  const requiredMarkers = ["packaged=true"];
  const forbiddenMarkers = ["packaged=false", "localhost:5175", "ERR_CONNECTION_REFUSED"];

  for (const marker of requiredMarkers) {
    if (!logOutput.includes(marker)) {
      throw new Error(`Smoke test log is missing required marker "${marker}"\n${logOutput}`);
    }
  }

  for (const marker of forbiddenMarkers) {
    if (logOutput.includes(marker)) {
      throw new Error(`Smoke test log contains forbidden marker "${marker}"\n${logOutput}`);
    }
  }
}

async function main() {
  await validateLauncherLayout();

  const xvfbAvailable = (await run("bash", ["-lc", "command -v xvfb-run >/dev/null"], { check: false }))
    .code === 0;

  if (!xvfbAvailable) {
    console.log("Skipping runtime smoke test because xvfb-run is not installed.");
    return;
  }

  const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-linux-port-home-"));
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "codex-linux-port-cache-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "codex-linux-port-config-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "codex-linux-port-state-"));

  // GitHub-hosted runners cannot provide a root-owned setuid chrome-sandbox inside the build artifact.
  const command = [
    "timeout",
    "20s",
    "xvfb-run",
    "-a",
    appRunPath,
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
  ];

  const result = await run(command[0], command.slice(1), {
    env: {
      ELECTRON_ENABLE_LOGGING: "1",
      HOME: homeDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_CONFIG_HOME: configDir,
      XDG_STATE_HOME: stateDir,
    },
    capture: true,
    check: false,
  });

  if (result.code !== 0 && result.code !== 124) {
    throw new Error(
      `Smoke test failed with code ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
    );
  }

  assertPackagedStartup(`${result.stdout}\n${result.stderr}`);

  console.log("Smoke test passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
