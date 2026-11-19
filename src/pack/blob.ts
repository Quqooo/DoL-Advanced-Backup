import type { ManifestBlob } from '../core/manifest';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** `crypto.subtle` 在 file:// 与部分 WebView 上不可用，这里保留一份纯 JS 实现 */
function sha256Fallback(bytes: Uint8Array): Uint8Array {
  const length = bytes.length;
  const blocks = ((length + 8) >>> 6) + 1;
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, (length * 8) >>> 0, false);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 0x100000000), false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let block = 0; block < blocks; block++) {
    const base = block * 64;
    for (let index = 0; index < 16; index++) w[index] = view.getUint32(base + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[index] + w[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  hash.forEach((word, index) => outView.setUint32(index * 4, word, false));
  return out;
}

function toHex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      // TS 把 Uint8Array 默认成带 SharedArrayBuffer 的泛型，BufferSource 只接受 ArrayBuffer 视图
      return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes as unknown as BufferSource)));
    } catch {
      /* 落到纯 JS 实现 */
    }
  }
  return toHex(sha256Fallback(bytes));
}

/** 打包块的文件名：所有 data URL 图片按出现顺序拼进这一条 */
const PACKED_FILE = 'data/images.bin';

export type PackedRange = [offset: number, length: number];

const EMPTY = new Uint8Array(0);

/**
 * 打包在一起的数据块（目前只有 data URL 图片）。
 *
 * 逐条拆分为独立数据块会有两项开销：每条各占一份 zip 头，且各自压缩（32 KB 窗口），
 * 跨图冗余全丢。实测 7,349 张图单独压是 37.6 MB，拼成一条流压完 18.8 MB。
 * 所以按出现顺序拼进同一个文件，引用只记偏移与长度；相同内容按哈希去重。
 */
class PackedStore {
  readonly file = PACKED_FILE;
  private chunks: Uint8Array[] = [];
  /** 与 chunks 一一对应的块哈希，按同一顺序参与块表摘要 */
  private hashes: Uint8Array[] = [];
  private seen = new Map<string, PackedRange>();
  bytes = 0;

  async add(bytes: Uint8Array): Promise<PackedRange> {
    const sha256 = await sha256Hex(bytes);
    const hit = this.seen.get(sha256);
    if (hit) return hit;
    const range: PackedRange = [this.bytes, bytes.length];
    this.seen.set(sha256, range);
    this.chunks.push(bytes);
    this.hashes.push(hexToBytes(sha256));
    this.bytes += bytes.length;
    return range;
  }

  /** 在序列化前回收死亡区间；共享的 range 元组让存活引用同步得到新偏移 */
  retain(live: ReadonlySet<PackedRange>): void {
    let read = 0;
    let write = 0;
    let offset = 0;
    for (const [hash, range] of this.seen) {
      const chunk = this.chunks[read];
      const digest = this.hashes[read];
      read += 1;
      if (!live.has(range)) {
        this.seen.delete(hash);
        continue;
      }
      range[0] = offset;
      this.chunks[write] = chunk;
      this.hashes[write] = digest;
      write += 1;
      offset += chunk.length;
    }
    this.chunks.length = write;
    this.hashes.length = write;
    this.bytes = offset;
  }

  /**
   * 分块视图：写包时按顺序送进压缩流。
   *
   * 拼成一条缓冲会多占一整份与打包块等长的内存（存活字节 × 2），而这批字节本来
   * 就是逐张图片解码出来的，顺序即可。
   */
  get parts(): readonly Uint8Array[] {
    return this.chunks;
  }

  /**
   * 块表摘要：按顺序拼接各块 SHA-256 后再取一次 SHA-256。
   *
   * 打包块的内容由「哪些块、按什么顺序」完全决定（每条 `$ab:range` 都落在块上），
   * 所以这个摘要同样唯一标识整块；真正的逐字节哈希要 37 MB 连续缓冲，
   * 而恢复侧只用 `bytes` 与 zip CRC 校验，这个值不参与校验。
   */
  async digest(): Promise<string> {
    return sha256Hex(concatHashes(this.hashes));
  }

  /**
   * 压缩完成后释放：字节已经进了包，源分块不必留到装配段。
   * 就地清空数组——`parts` 视图可能还指向同一个数组。
   */
  release(): void {
    this.chunks.length = 0;
    this.hashes.length = 0;
  }

  get count(): number {
    return this.seen.size;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function concatHashes(hashes: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(hashes.length * 32);
  hashes.forEach((hash, index) => out.set(hash, index * 32));
  return out;
}

/** 内容寻址：同一份字节只写一次，多条引用共用一个 data/ 文件 */
export class BlobTable {
  private items = new Map<string, { blob: ManifestBlob; bytes: Uint8Array }>();
  /** 文件名 → sha256，用来处理前缀撞车 */
  private files = new Map<string, string>();
  private packedStore: PackedStore | null = null;

  /** 前 8 字节撞车时逐字节加长，直到文件名唯一 */
  private nameOf(sha256: string): string {
    for (let chars = 16; chars < sha256.length; chars += 2) {
      const file = `data/${sha256.slice(0, chars)}.bin`;
      const owner = this.files.get(file);
      if (owner === undefined || owner === sha256) return file;
    }
    return `data/${sha256}.bin`;
  }

  async add(bytes: Uint8Array): Promise<ManifestBlob> {
    const sha256 = await sha256Hex(bytes);
    const existing = this.items.get(sha256);
    if (existing) return existing.blob;
    const file = this.nameOf(sha256);
    const blob: ManifestBlob = {
      sha256,
      file,
      bytes: bytes.length,
    };
    this.items.set(sha256, { blob, bytes });
    this.files.set(file, sha256);
    return blob;
  }

  /**
   * 收一张 data URL 图片：去重后拼进打包块，返回它在文件里的位置。
   * 调用方据此写 `$ab:blob` + `$ab:range`。
   */
  async addDataUrl(bytes: Uint8Array): Promise<{ file: string; range: PackedRange }> {
    this.packedStore ??= new PackedStore();
    const range = await this.packedStore.add(bytes);
    return { file: this.packedStore.file, range };
  }

  /** 被放弃条目的图片不进包；全部放弃时连空文件也不保留 */
  retainPacked(live: ReadonlySet<PackedRange>): void {
    this.packedStore?.retain(live);
    if (this.packedStore?.count === 0) this.packedStore = null;
  }

  /** 打包块：没有 data URL 时返回 null。分块直接交给写端，不拼整段 */
  async packed(): Promise<{
    file: string;
    parts: readonly Uint8Array[];
    bytes: number;
    count: number;
    digest: string;
  } | null> {
    const store = this.packedStore;
    if (!store) return null;
    return {
      file: store.file,
      parts: store.parts,
      bytes: store.bytes,
      count: store.count,
      digest: await store.digest(),
    };
  }

  /** 打包块已经压进包之后调用：源分块与块哈希都可以回收 */
  releasePacked(): void {
    this.packedStore?.release();
  }

  /** 数据块都已压进包之后：源字节交还，装配段只剩压缩结果 */
  release(): void {
    for (const item of this.items.values()) item.bytes = EMPTY;
  }

  /** 引用闭合的收尾：没人引用的 blob 不进包，缺引用由调用方中止导出 */
  retain(refs: ReadonlySet<string>): void {
    for (const [sha256, item] of [...this.items]) {
      if (refs.has(item.blob.file)) continue;
      this.items.delete(sha256);
      this.files.delete(item.blob.file);
    }
  }

  list(): { blob: ManifestBlob; bytes: Uint8Array }[] {
    return [...this.items.values()];
  }

  get size(): number {
    return this.items.size;
  }
}
