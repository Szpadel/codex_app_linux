import path from "node:path";
import { cp, readdir } from "node:fs/promises";

import { readAsarJson } from "./asar.mjs";
import { ensureDir, exists, readJson, rmrf, stripSemverRange } from "./common.mjs";

const LINUX_TARGET = {
  os: "linux",
  cpu: "x64",
};

function moduleNameToPathSegments(moduleName) {
  return moduleName.split("/");
}

async function listTopLevelModuleNames(nodeModulesRoot) {
  const modules = [];
  const entries = await readdir(nodeModulesRoot, { withFileTypes: true });

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (!entry.name.startsWith("@")) {
      modules.push(entry.name);
      continue;
    }

    const scopeRoot = path.join(nodeModulesRoot, entry.name);
    const scopedEntries = await readdir(scopeRoot, { withFileTypes: true });

    for (const scopedEntry of scopedEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (scopedEntry.isDirectory()) {
        modules.push(`${entry.name}/${scopedEntry.name}`);
      }
    }
  }

  return modules;
}

async function directoryContainsNativeBinary(rootDir) {
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isFile() && entry.name.endsWith(".node")) {
        return true;
      }

      if (entry.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }

  return false;
}

function packageListAllows(value, targetValue) {
  if (value == null) {
    return true;
  }

  const entries = (Array.isArray(value) ? value : [value]).filter(
    (entry) => typeof entry === "string" && entry.length > 0,
  );
  const denied = entries
    .filter((entry) => entry.startsWith("!"))
    .map((entry) => entry.slice(1));

  if (denied.includes(targetValue)) {
    return false;
  }

  const allowed = entries.filter((entry) => !entry.startsWith("!"));
  return allowed.length === 0 || allowed.includes(targetValue);
}

export function isPackageCompatibleWithTarget(packageManifest, target = LINUX_TARGET) {
  return (
    packageListAllows(packageManifest?.os, target.os) &&
    packageListAllows(packageManifest?.cpu, target.cpu)
  );
}

async function readModuleManifest({ appAsarPath, moduleName, moduleRoot }) {
  const moduleManifestPath = path.join(moduleRoot, "package.json");

  if (await exists(moduleManifestPath)) {
    return await readJson(moduleManifestPath);
  }

  if (!appAsarPath) {
    return null;
  }

  try {
    return await readAsarJson(
      appAsarPath,
      path.join("node_modules", ...moduleNameToPathSegments(moduleName), "package.json"),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Missing ASAR entry:")) {
      return null;
    }

    throw error;
  }
}

async function resolveModuleVersion(packagedManifest, moduleName, moduleManifest) {
  const version =
    moduleManifest?.version ??
    packagedManifest.dependencies?.[moduleName] ??
    packagedManifest.optionalDependencies?.[moduleName] ??
    packagedManifest.peerDependencies?.[moduleName];

  if (!version) {
    throw new Error(`Unable to resolve packaged version for native module "${moduleName}"`);
  }

  return stripSemverRange(version);
}

export async function discoverNativeModules({ appAsarPath, appAsarUnpackedPath, packagedManifest }) {
  const nodeModulesRoot = path.join(appAsarUnpackedPath, "node_modules");

  if (!(await exists(nodeModulesRoot))) {
    return [];
  }

  const nativeModules = [];
  const moduleNames = await listTopLevelModuleNames(nodeModulesRoot);

  for (const moduleName of moduleNames) {
    const moduleRoot = path.join(nodeModulesRoot, ...moduleNameToPathSegments(moduleName));

    if (!(await directoryContainsNativeBinary(moduleRoot))) {
      continue;
    }

    const moduleManifest = await readModuleManifest({
      appAsarPath,
      moduleName,
      moduleRoot,
    });

    if (moduleManifest && !isPackageCompatibleWithTarget(moduleManifest)) {
      continue;
    }

    nativeModules.push({
      name: moduleName,
      version: await resolveModuleVersion(packagedManifest, moduleName, moduleManifest),
    });
  }

  return nativeModules;
}

export function buildNativeDependencyMap(nativeModules) {
  return Object.fromEntries(nativeModules.map((nativeModule) => [nativeModule.name, nativeModule.version]));
}

export async function syncRebuiltNativeModules({ nativeDepsDir, packagedResourcesDir, nativeModules }) {
  const rebuiltNodeModulesRoot = path.join(nativeDepsDir, "node_modules");
  const packagedNodeModulesRoot = path.join(packagedResourcesDir, "app.asar.unpacked", "node_modules");

  for (const nativeModule of nativeModules) {
    const modulePathSegments = moduleNameToPathSegments(nativeModule.name);
    const rebuiltModuleRoot = path.join(rebuiltNodeModulesRoot, ...modulePathSegments);
    const packagedModuleRoot = path.join(packagedNodeModulesRoot, ...modulePathSegments);

    if (!(await exists(rebuiltModuleRoot))) {
      throw new Error(`Missing rebuilt native module payload for "${nativeModule.name}"`);
    }

    await rmrf(packagedModuleRoot);
    await ensureDir(path.dirname(packagedModuleRoot));
    await cp(rebuiltModuleRoot, packagedModuleRoot, { recursive: true });
  }
}
