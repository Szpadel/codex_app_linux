import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

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

function readAsarHeader(buffer) {
  const headerLength = buffer.readUInt32LE(12);
  const headerSize = buffer.readUInt32LE(4);
  const headerStart = 16;
  const headerEnd = headerStart + headerLength;
  const header = JSON.parse(buffer.subarray(headerStart, headerEnd).toString("utf8"));

  return {
    header,
    headerLength,
    headerSize,
    headerStart,
    headerEnd,
  };
}

function computeAsarIntegrity(buffer, blockSize = 4 * 1024 * 1024) {
  const blocks = [];

  for (let offset = 0; offset < buffer.length; offset += blockSize) {
    const block = buffer.subarray(offset, Math.min(offset + blockSize, buffer.length));
    blocks.push(createHash("sha256").update(block).digest("hex"));
  }

  return {
    algorithm: "SHA256",
    hash: createHash("sha256").update(buffer).digest("hex"),
    blockSize,
    blocks,
  };
}

export async function readAsarFile(asarPath, relativePath) {
  const buffer = await readFile(asarPath);
  const { header, headerSize } = readAsarHeader(buffer);
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

export async function patchAsarTextFileInPlace({ asarPath, relativePath, transform }) {
  const asarBuffer = await readFile(asarPath);
  const { header, headerLength, headerStart, headerEnd, headerSize } = readAsarHeader(asarBuffer);
  const entry = getAsarEntry(header, relativePath);

  if (entry.unpacked) {
    throw new Error(`Cannot patch unpacked ASAR entry in place: ${relativePath}`);
  }

  const fileStart = 8 + headerSize + Number(entry.offset ?? 0);
  const fileEnd = fileStart + Number(entry.size ?? 0);
  const currentFileBuffer = asarBuffer.subarray(fileStart, fileEnd);
  const nextText = transform(currentFileBuffer.toString("utf8"));
  const nextFileBuffer = Buffer.from(nextText, "utf8");

  if (nextFileBuffer.length !== currentFileBuffer.length) {
    throw new Error(
      `In-place ASAR patch changed size for ${relativePath}: ${currentFileBuffer.length} -> ${nextFileBuffer.length}`,
    );
  }

  entry.integrity = computeAsarIntegrity(
    nextFileBuffer,
    typeof entry.integrity?.blockSize === "number" ? entry.integrity.blockSize : undefined,
  );

  const nextHeaderBuffer = Buffer.from(JSON.stringify(header), "utf8");

  if (nextHeaderBuffer.length !== headerLength) {
    throw new Error(
      `In-place ASAR patch changed header size for ${relativePath}: ${headerLength} -> ${nextHeaderBuffer.length}`,
    );
  }

  const nextAsarBuffer = Buffer.from(asarBuffer);
  nextHeaderBuffer.copy(nextAsarBuffer, headerStart);
  nextFileBuffer.copy(nextAsarBuffer, fileStart);

  // The ASAR header region must remain byte-for-byte aligned with the original header area.
  if (headerStart + nextHeaderBuffer.length !== headerEnd) {
    throw new Error(`In-place ASAR patch misaligned the header for ${relativePath}`);
  }

  await writeFile(asarPath, nextAsarBuffer);
}

export function unpackedPathFor(relativePath) {
  return path.join("app.asar.unpacked", relativePath);
}
