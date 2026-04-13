import path from "node:path";
import { readFile } from "node:fs/promises";

function getAsarEntry(header, relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  let node = header;

  for (const part of parts) {
    node = node?.files?.[part];
    if (!node) {
      throw new Error(`Missing ASAR entry: ${relativePath}`);
    }
  }

  return node;
}

export async function readAsarFile(asarPath, relativePath) {
  const buffer = await readFile(asarPath);
  const headerLength = buffer.readUInt32LE(12);
  const headerSize = buffer.readUInt32LE(4);
  const headerStart = 16;
  const headerEnd = headerStart + headerLength;
  const header = JSON.parse(buffer.subarray(headerStart, headerEnd).toString("utf8"));
  const entry = getAsarEntry(header, relativePath);

  if (entry.unpacked) {
    throw new Error(`ASAR entry is unpacked and must be read from app.asar.unpacked: ${relativePath}`);
  }

  const fileStart = 8 + headerSize + Number(entry.offset ?? 0);
  const fileEnd = fileStart + Number(entry.size ?? 0);
  return buffer.subarray(fileStart, fileEnd);
}

export async function readAsarJson(asarPath, relativePath) {
  const fileBuffer = await readAsarFile(asarPath, relativePath);
  return JSON.parse(fileBuffer.toString("utf8"));
}

export function unpackedPathFor(relativePath) {
  return path.join("app.asar.unpacked", relativePath);
}
