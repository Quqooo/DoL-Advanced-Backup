/**
 * CRC32（IEEE 802.3 多项式）：zip 条目与包内清单共用同一份实现。
 *
 * 放在 core 而不是 pack：读端 `core/zipread.ts` 要用它校验解出来的字节，
 * 而 core 不能引用 pack。写端 `pack/zip.ts` 从这里转出，两边的结果必然一致。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * slicing-by-8 用的 8 张表：第 k 张是第 k-1 张再迭代一次的结果。
 *
 * 表在加载期由单表展开，不写入包（节省 8 KB）。只占内存，换取大条目 CRC 约 2.5 倍吞吐。
 */
const CRC_TABLES = (() => {
  const tables = new Uint32Array(8 * 256);
  tables.set(CRC_TABLE, 0);
  for (let index = 0; index < 256; index++) {
    let value = CRC_TABLE[index];
    for (let step = 1; step < 8; step++) {
      value = CRC_TABLE[value & 0xff] ^ (value >>> 8);
      tables[step * 256 + index] = value >>> 0;
    }
  }
  return tables;
})();

/** 增量 CRC：边序列化边算，不必先把整段字节攒出来 */
export interface Crc32 {
  update(chunk: Uint8Array): void;
  digest(): number;
}

function crcStep(crc: number, bytes: Uint8Array): number {
  let value = crc;
  let index = 0;
  const end = bytes.length;
  // 一次 8 字节：前 4 字节先与 crc 混合，再查 8 张表
  for (; index + 8 <= end; index += 8) {
    const word = (value ^ (bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16) | (bytes[index + 3] << 24))) >>> 0;
    value =
      CRC_TABLES[1792 + (word & 0xff)] ^
      CRC_TABLES[1536 + ((word >>> 8) & 0xff)] ^
      CRC_TABLES[1280 + ((word >>> 16) & 0xff)] ^
      CRC_TABLES[1024 + (word >>> 24)] ^
      CRC_TABLES[768 + bytes[index + 4]] ^
      CRC_TABLES[512 + bytes[index + 5]] ^
      CRC_TABLES[256 + bytes[index + 6]] ^
      CRC_TABLES[bytes[index + 7]];
  }
  for (; index < end; index++) value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  return value;
}

export function createCrc32(): Crc32 {
  let crc = 0xffffffff;
  return {
    update(bytes) {
      crc = crcStep(crc, bytes);
    },
    digest() {
      return (crc ^ 0xffffffff) >>> 0;
    },
  };
}

export function crc32(bytes: Uint8Array): number {
  return (crcStep(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}
