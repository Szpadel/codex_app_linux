import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const linuxPortRoot = path.resolve(__dirname, "..");

export function resolveLinuxPortPath(...parts) {
  return path.join(linuxPortRoot, ...parts);
}

export async function exists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath) {
  await mkdir(targetPath, { recursive: true });
}

export async function rmrf(targetPath) {
  await rm(targetPath, { recursive: true, force: true });
}

export async function copyExecutable(sourcePath, destinationPath) {
  await ensureDir(path.dirname(destinationPath));
  await copyFile(sourcePath, destinationPath);
  await chmod(destinationPath, 0o755);
}

export async function writeExecutable(destinationPath, contents) {
  await ensureDir(path.dirname(destinationPath));
  await writeFile(destinationPath, contents);
  await chmod(destinationPath, 0o755);
}

export async function downloadFile(url, destinationPath) {
  if (await exists(destinationPath)) {
    return destinationPath;
  }

  await ensureDir(path.dirname(destinationPath));
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed for ${url}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destinationPath, buffer);
  return destinationPath;
}

export async function readJson(targetPath) {
  return JSON.parse(await readFile(targetPath, "utf8"));
}

export function stripSemverRange(version) {
  const match = version?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  if (!match) {
    throw new Error(`Unable to parse semver from "${version}"`);
  }
  return match[0];
}

export function logStep(message) {
  console.log(`\n==> ${message}`);
}

export async function run(command, args, options = {}) {
  const { cwd, env, capture = false, check = true } = options;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (check && code !== 0) {
        const details = capture ? `\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}` : "";
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}${details}`));
        return;
      }

      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}
