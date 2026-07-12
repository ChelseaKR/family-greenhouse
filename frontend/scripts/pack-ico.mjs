#!/usr/bin/env node

/** Pack PNG frames into a multi-resolution ICO without a third-party package. */
import { readFileSync, writeFileSync } from 'node:fs';

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length === 0) {
  console.error('Usage: node pack-ico.mjs OUTPUT.ico FRAME.png [FRAME.png ...]');
  process.exit(1);
}

const frames = inputs.map((path) => {
  const data = readFileSync(path);
  const pngSignature = '89504e470d0a1a0a';
  if (data.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error(`${path} is not a PNG`);
  }
  return {
    data,
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
});

const headerSize = 6 + frames.length * 16;
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(frames.length, 4);

let offset = headerSize;
frames.forEach((frame, index) => {
  const entry = 6 + index * 16;
  header.writeUInt8(frame.width >= 256 ? 0 : frame.width, entry);
  header.writeUInt8(frame.height >= 256 ? 0 : frame.height, entry + 1);
  header.writeUInt8(0, entry + 2); // palette colors
  header.writeUInt8(0, entry + 3); // reserved
  header.writeUInt16LE(1, entry + 4); // planes
  header.writeUInt16LE(32, entry + 6); // bits per pixel
  header.writeUInt32LE(frame.data.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += frame.data.length;
});

writeFileSync(output, Buffer.concat([header, ...frames.map((frame) => frame.data)]));
