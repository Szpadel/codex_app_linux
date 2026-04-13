import path from "node:path";
import { accessSync, constants as fsConstants } from "node:fs";
import { spawnSync } from "node:child_process";

function isReadable(targetPath) {
  try {
    accessSync(targetPath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathOverride(envName) {
  const override = process.env[envName];

  if (!override) {
    return null;
  }

  const resolvedPath = path.resolve(override);
  return isReadable(resolvedPath) ? resolvedPath : null;
}

function resolveCommandPath(commandName) {
  const result = spawnSync(
    "bash",
    ["-lc", `readlink -f "$(command -v ${commandName})"`],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    return null;
  }

  const resolvedPath = result.stdout.trim();
  return isReadable(resolvedPath) ? resolvedPath : null;
}

function resolveCodexVendorBinary(launcherPath) {
  if (!launcherPath?.endsWith("/bin/codex.js")) {
    return null;
  }

  const packageRoot = path.dirname(path.dirname(launcherPath));
  const vendorBinary = path.resolve(
    packageRoot,
    "..",
    "codex-linux-x64",
    "vendor",
    "x86_64-unknown-linux-musl",
    "codex",
    "codex",
  );

  return isReadable(vendorBinary) ? vendorBinary : null;
}

function resolveFirstReadable(toolName, candidates) {
  const attempted = [];

  for (const candidate of candidates) {
    const resolvedPath = candidate.resolve();

    if (resolvedPath) {
      return resolvedPath;
    }

    attempted.push(candidate.label);
  }

  throw new Error(`Unable to resolve a readable ${toolName} binary. Tried: ${attempted.join(", ")}`);
}

export function resolveInstalledToolPaths(installPrefix) {
  const resolvedPrefix = path.resolve(installPrefix);
  const codexBinaryPath = path.join(
    resolvedPrefix,
    "node_modules",
    "@openai",
    "codex-linux-x64",
    "vendor",
    "x86_64-unknown-linux-musl",
    "codex",
    "codex",
  );
  const ripgrepBinaryPath = path.join(
    resolvedPrefix,
    "node_modules",
    "@openai",
    "codex-linux-x64",
    "vendor",
    "x86_64-unknown-linux-musl",
    "path",
    "rg",
  );

  if (!isReadable(codexBinaryPath)) {
    throw new Error(`Unable to resolve codex binary from npm install prefix: ${codexBinaryPath}`);
  }

  if (!isReadable(ripgrepBinaryPath)) {
    throw new Error(`Unable to resolve rg binary from npm install prefix: ${ripgrepBinaryPath}`);
  }

  return {
    codexBinaryPath,
    ripgrepBinaryPath,
  };
}

export function resolveBundledToolPaths() {
  const codexLauncherPath = resolveCommandPath("codex");
  const codexBinaryPath = resolveFirstReadable("codex", [
    {
      label: "CODEX_LINUX_BINARY",
      resolve: () => resolvePathOverride("CODEX_LINUX_BINARY"),
    },
    {
      label: "codex vendor binary next to the local launcher",
      resolve: () => resolveCodexVendorBinary(codexLauncherPath),
    },
    {
      label: "resolved codex command on PATH",
      resolve: () => codexLauncherPath,
    },
  ]);

  const codexArchRoot = path.dirname(path.dirname(codexBinaryPath));
  const ripgrepBinaryPath = resolveFirstReadable("rg", [
    {
      label: "RG_LINUX_BINARY",
      resolve: () => resolvePathOverride("RG_LINUX_BINARY"),
    },
    {
      label: "vendor rg next to the resolved codex binary",
      resolve: () => {
        const vendorRipgrep = path.join(codexArchRoot, "path", "rg");
        return isReadable(vendorRipgrep) ? vendorRipgrep : null;
      },
    },
    {
      label: "resolved rg command on PATH",
      resolve: () => resolveCommandPath("rg"),
    },
  ]);

  return {
    codexBinaryPath,
    ripgrepBinaryPath,
  };
}
