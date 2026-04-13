import path from "node:path";
import { cp, readdir } from "node:fs/promises";

import { ensureDir, exists, readJson, rmrf, stripSemverRange } from "./common.mjs";

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

async function resolveModuleVersion(packagedManifest, moduleName, moduleRoot) {
  const moduleManifestPath = path.join(moduleRoot, "package.json");
  const moduleManifest = (await exists(moduleManifestPath))
    ? await readJson(moduleManifestPath)
    : null;
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

export async function discoverNativeModules({ appAsarUnpackedPath, packagedManifest }) {
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

    nativeModules.push({
      name: moduleName,
      version: await resolveModuleVersion(packagedManifest, moduleName, moduleRoot),
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
