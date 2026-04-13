import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";

import { resolveLinuxPortPath, rmrf } from "./common.mjs";
import { extractMacPayload, readPackagedMetadata, resolveDmgPath } from "./upstream-package.mjs";

function parseArgs(argv) {
  const args = {
    dmgPath: undefined,
    format: "json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--dmg") {
      args.dmgPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--format") {
      args.format = argv[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!["json", "github-output"].includes(args.format)) {
    throw new Error(`Unsupported format: ${args.format}`);
  }

  return args;
}

function formatMetadata(metadata, format) {
  const serializable = {
    appName: metadata.appName,
    productName: metadata.productName,
    version: metadata.version,
    electronVersion: metadata.electronVersion,
    executableName: metadata.executableName,
    artifactName: metadata.artifactName,
    releaseTag: metadata.releaseTag,
  };

  if (format === "github-output") {
    return Object.entries(serializable)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
  }

  return JSON.stringify(serializable, null, 2);
}

async function main() {
  const { dmgPath: inputDmgPath, format } = parseArgs(process.argv.slice(2));
  const dmgPath = resolveDmgPath(inputDmgPath);
  const extractDir = await mkdtemp(path.join(os.tmpdir(), "codex-linux-port-metadata-"));

  try {
    const { appAsarPath } = await extractMacPayload({
      dmgPath,
      outputDir: extractDir,
      includeUnpacked: false,
      includeIcons: false,
      quiet: true,
    });
    const metadata = await readPackagedMetadata(appAsarPath);

    metadata.executableName = metadata.productName ?? metadata.appName ?? "Codex";
    metadata.artifactName = `Codex-${metadata.version}-linux-x64.AppImage`;
    metadata.releaseTag = `v${metadata.version}`;

    process.stdout.write(`${formatMetadata(metadata, format)}\n`);
  } finally {
    await rmrf(extractDir);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
