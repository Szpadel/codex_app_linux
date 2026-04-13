import { resolveInstalledToolPaths } from "./tool-resolver.mjs";

function parseArgs(argv) {
  const args = {
    format: "json",
    installPrefix: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--prefix") {
      args.installPrefix = argv[index + 1];
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

  if (!args.installPrefix) {
    throw new Error("Missing required argument: --prefix <install-prefix>");
  }

  if (!["json", "github-output"].includes(args.format)) {
    throw new Error(`Unsupported format: ${args.format}`);
  }

  return args;
}

function formatOutput(toolPaths, format) {
  if (format === "github-output") {
    return [
      `codexBinaryPath=${toolPaths.codexBinaryPath}`,
      `ripgrepBinaryPath=${toolPaths.ripgrepBinaryPath}`,
    ].join("\n");
  }

  return JSON.stringify(toolPaths, null, 2);
}

async function main() {
  const { format, installPrefix } = parseArgs(process.argv.slice(2));
  const toolPaths = resolveInstalledToolPaths(installPrefix);
  process.stdout.write(`${formatOutput(toolPaths, format)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
