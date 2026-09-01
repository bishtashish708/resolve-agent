'use strict';
/**
 * Minimal PNG encoder.
 *
 * GetCurrentClipThumbnailImage() returns raw RGB8 as base64 — not a file format
 * anything can open. We need real image files on disk so the vision model can
 * read them. Node has zlib built in and PNG is simple enough that a dependency
 * would be worse than 60 lines (Doc 2 E6.1 — prefer zero native modules, and
 * every dependency ships inside someone's NLE).
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {Buffer} rgb   raw RGB8, length must be width*height*3
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} a complete PNG file
 */
function encodeRGB(rgb, width, height) {
  const expected = width * height * 3;
  if (rgb.length !== expected) {
    throw new Error(`RGB buffer is ${rgb.length} bytes, expected ${expected} for ${width}x${height}`);
  }

  // PNG scanlines are each prefixed with a filter byte. 0 = None; the data is
  // already small (576x324) and zlib does the real work.
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Convert the dict returned by Timeline:GetCurrentClipThumbnailImage().
 * Verified shape (Resolve 21.0.3.7):
 *   { width: 576, height: 324, format: "RGB 8 bit", data: <base64> }
 */
function fromResolveThumbnail(thumb) {
  if (!thumb || typeof thumb !== 'object') throw new Error('no thumbnail object');
  const { width, height, format, data } = thumb;
  if (!data) throw new Error('thumbnail has no data');
  if (format && !/RGB\s*8/i.test(format)) {
    throw new Error(`unexpected thumbnail format: ${format}`);
  }
  const rgb = Buffer.from(data, 'base64');
  return encodeRGB(rgb, width, height);
}

module.exports = { encodeRGB, fromResolveThumbnail };
