import { throwIfAborted } from '../core/error';
import { groupOf } from '../core/group';
import { entriesOfMods, list as mappingList, type MappingEntry } from '../core/mapping';
import { packMappingOf } from '../core/mapping/pack';
import { readBootMeta } from '../core/bootmeta';
import { RESTORE_MOD_NAME, SELF_PACK_INNER } from '../core/constants';
import { base64ToBytes, formatCompactStamp, hex32 } from '../core/format';
import { stringifyJson } from '../core/json';
import { createManifest, type ManifestSection } from '../core/manifest';
import { injectedModName } from '../core/naming';
import { writeModPackTo } from '../core/modpack';
import type { ProgressPhase } from '../core/progress';
import type { ByteSink } from '../core/sink';
import { injectedValues } from '../host/modloader';
import { openModReader } from '../store/mods';
import { BlobTable, sha256Hex } from './blob';
import { encodeEntry, encodeStream } from './codec';
import { planMods, assertModUnchanged, readMod, type ModPlan } from './mods';
import { readmeText } from './readme';
import { buildSections } from './sections';
import { selfFiles } from './selfboot';
import type { PackHooks, PackMeta, PackOptions, PackOutcome, PendingItem } from './types';
import { crc32, zipPlanSize, ZipWriter, type ZipEntry } from './zip';

/**
 * 包名与 manifest 的时间戳同源。
 * 导出侧要在压缩之前把名字交给保存对话框（选择器要用户手势），所以名字得能先算出来。
 * `suffix` 由调用方按同一份选项给出：套容器的自恢复包带 `-modpack`，扩展名恒为 .zip。
 */
/**
 * 包内出现的模组数据所属的映射条目。
 *
 * 恢复页用本地映射给地址分组：目标机器没装那个模组、或它没有注册映射时，这些数据会落到
 * 「其他」。包内带一份最小表，读包前先装上，分组与显示名才对得上。
 */
export function mappingEntriesOf(selected: ReadonlySet<string>): MappingEntry[] {
  const ctx = { mapping: mappingList() };
  const mods = new Set<string>();
  for (const addr of selected) {
    const group = groupOf(addr, ctx);
    if (group?.startsWith('moddata/')) mods.add(group.slice('moddata/'.length));
  }
  return entriesOfMods(mods);
}

export function packName(at: Date, suffix = ''): string {
  return `AdvancedBackup-${formatCompactStamp(at)}${suffix}.zip`;
}

/**
 * 已选地址 → 成品 zip（或套好容器的 ModPack），边拼边写进 `sink`。
 *
 * 分区在采集阶段就地序列化并压缩（`onSection`），不再合并成一整条字节串；清单里的
 * `sections[].bytes` 用压缩流报回的未压缩长度，与包内实际内容同源。
 * 装配段也不再先分配整包缓冲：本地头与中央目录逐条写给 sink。
 */
export async function packTo(
  sink: ByteSink,
  selected: ReadonlySet<string>,
  options: PackOptions,
  meta: PackMeta,
  hooks: PackHooks = {},
): Promise<PackOutcome> {
  // 阶段边界：采集连序列化与压缩一起做，占大头；encode 只剩数据块，装配段还要读模组
  const COLLECT_END = 0.6;
  const PLAN_END = 0.65;
  const ENCODE_END = 0.9;
  const emit = (phase: ProgressPhase, ratio: number, label?: string): void => {
    hooks.onProgress?.({ phase, ratio, ...(label ? { label } : {}) });
  };

  emit('collect', 0);
  const blobs = new BlobTable();
  const sectionEntries: ZipEntry[] = [];
  const sectionMeta: ManifestSection[] = [];
  const { modNames, refs, index } = await buildSections({
    selected,
    blobs,
    onProgress: (ratio, label) => emit('collect', ratio * COLLECT_END, label),
    onSection: async task => {
      throwIfAborted(hooks.signal);
      // 分区的字节直接进压缩流：小分区一次写完，整库分区边翻页边写
      const encoded = await encodeStream(task.write, { compression: options.compression });
      sectionEntries.push({
        name: task.file,
        data: encoded.data,
        method: encoded.method,
        size: encoded.size,
        crc: encoded.crc,
      });
      sectionMeta.push({
        id: task.file.replace(/\.json$/, '').replace(/\//g, ':'),
        file: task.file,
        entries: task.entries,
        bytes: encoded.size,
        // 压缩流的 CRC 就是未压缩数据的 CRC，与 zip 中央目录同源
        crc32: hex32(encoded.crc),
        ...(task.slots !== undefined ? { slots: task.slots } : {}),
        ...(task.dbs !== undefined ? { dbs: task.dbs } : {}),
      });
    },
  });
  emit('collect', COLLECT_END);

  // data URL 图片拼成一条打包块：写包时压一次，引用靠偏移定位
  const packed = blobs.packed();

  // 引用闭合：JSON 里出现的每个 blob 都得在表里，表里没人引用的不进包
  const known = new Set(blobs.list().map(item => item.blob.file));
  if (packed) known.add(packed.file);
  for (const file of refs) {
    if (!known.has(file)) throw new Error(`引用闭合失败：${file} 没有对应的数据块`);
  }
  blobs.retain(refs);

  // ZSTD 档下不内嵌恢复脚本：ModLoader 用 JSZip 读包，而 JSZip 只认 STORE / DEFLATE，
  // 含 method 93 条目的包会被它整个丢掉（面板上也因此禁用了这个勾选）
  const script = options.compression === 'zstd' ? null : options.selfScript ?? null;
  const manifest = createManifest({
    game: meta.game,
    mod: meta.mod,
    // 逐项抄：PackOptions 里的 selfScript 是字节，混进清单会被序列化成一串数字
    options: {
      compression: options.compression,
      skipCompressed: options.skipCompressed,
      selfRestore: Boolean(script),
    },
    ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
  });
  manifest.sections = sectionMeta;
  manifest.index = index;

  const reader = await openModReader();
  try {
    // 注入的模组不在任何存储层里，名字按 boot.json 现算；两趟都要用，只建一次
    let injected: Map<string, Uint8Array> | null = null;
    const injectedOf = async (): Promise<Map<string, Uint8Array>> => {
      if (injected) return injected;
      const map = new Map<string, Uint8Array>();
      for (const [index, raw] of injectedValues().entries()) {
        const bytes = base64ToBytes(raw);
        const stored = injectedModName((await readBootMeta(bytes))?.name, index);
        if (!map.has(stored)) map.set(stored, bytes);
      }
      injected = map;
      return map;
    };

    // 第一趟：只留元数据，字节读完就丢
    const planned = await planMods(modNames, reader, injectedOf, ratio =>
      emit('plan', COLLECT_END + ratio * (PLAN_END - COLLECT_END)));
    manifest.mods = { items: planned.items };
    manifest.blobs = blobs.list().map(item => item.blob);
    if (packed) {
      // 打包块也要进清单：恢复时按它把整段字节读回来，再按偏移切片
      manifest.blobs.push({ sha256: await sha256Hex(packed.bytes), file: packed.file, bytes: packed.bytes.length });
    }

    const encoder = new TextEncoder();
    // 包内出现的模组数据所属的映射条目：恢复页按本地映射建树，缺了这些条目
    // 分组会落到「其他」，显示名也退成模组名
    const mappingEntries = mappingEntriesOf(selected);
    const head: PendingItem[] = [
      { name: 'manifest.json', bytes: encoder.encode(stringifyJson(manifest, null, 2)), deflate: true },
      ...(mappingEntries.length > 0
        ? [{
            name: 'mapping.json',
            bytes: encoder.encode(stringifyJson(packMappingOf(mappingEntries), null, 2)),
            deflate: true,
          }]
        : []),
      { name: 'README.txt', bytes: encoder.encode(readmeText(manifest)), deflate: true },
    ];
    // 恢复包的两个文件排在分区前面：手点开包时第一眼就能看到它还能当模组用
    if (script) {
      for (const file of selfFiles(script, meta.mod)) head.push({ ...file, deflate: true });
    }
    // 数据块在分区之后；模组本体不在这里，写包时才逐条读
    const tail: PendingItem[] = [];
    for (const item of blobs.list()) {
      tail.push({ name: item.blob.file, bytes: item.bytes, deflate: true });
    }
    // 打包块本身是图片二进制，魔数嗅探会判成「已压缩」而存原样；它恰恰最该压（37.6 → 18.8 MB）
    if (packed) {
      tail.push({ name: packed.file, bytes: packed.bytes, deflate: true, skipCompressed: false });
    }

    // 按字节加权：整库那一条有 150 MB，按条目数算它只占 1/170，进度条会在它身上冻住三秒
    const totalBytes = [...head, ...tail].reduce((sum, item) => sum + item.bytes.length, 0);
    const encodeRatio = (bytes: number): number =>
      PLAN_END + (ENCODE_END - PLAN_END) * (totalBytes > 0 ? Math.min(bytes, totalBytes) / totalBytes : 1);
    let doneBytes = 0;

    const entries: ZipEntry[] = [];
    const encodeInto = async (item: PendingItem): Promise<void> => {
      throwIfAborted(hooks.signal);
      emit('encode', encodeRatio(doneBytes), item.name);
      const encoded = item.deflate
        ? await encodeEntry(
            item.bytes,
            { compression: options.compression, skipCompressed: item.skipCompressed ?? options.skipCompressed },
            fed => emit('encode', encodeRatio(doneBytes + fed), item.name),
          )
        : { data: item.bytes, method: 0 as const };
      entries.push({
        name: item.name,
        data: encoded.data,
        method: encoded.method,
        size: item.bytes.length,
        crc: crc32(item.bytes),
      });
      doneBytes += item.bytes.length;
      emit('encode', encodeRatio(doneBytes));
    };

    emit('encode', PLAN_END);
    for (const item of head) await encodeInto(item);
    // 分区在采集阶段已经压好，按包内顺序插在头部条目之后
    entries.push(...sectionEntries);
    for (const item of tail) await encodeInto(item);

    emit('assemble', ENCODE_END);
    // 与 manifest.createdAt 同源：导出侧提前算过同一个名字，两边不能各取一次当前时间；
    // zip 条目的 DOS 时间也取它，同一批数据重复导出得到的字节只差压缩流的块边界
    const at = new Date(manifest.createdAt);
    // 勾选 ModPack 包装的自恢复包套容器：ModLoader >=2.60 对大 Uint8Array 模组算哈希会
    // 先 toString() 成字符串再哈希，超限直接抛错丢模组（无弹窗）；容器按字节哈希，无此问题。
    // 内层仍是完整自恢复 zip，容器只多出两个引导文件，体积几乎不变。
    const wrapped = Boolean(script) && options.modpackWrap === true;
    // 装配段按写入字节推进：写文件是 I/O，整段只报首尾会让进度条在 90% 上冻住。
    // 分母含模组——长度第一趟就算出来了，字节要等写的时候才读。
    const total = zipPlanSize([
      ...entries.map(entry => ({ name: entry.name, comp: entry.data.length })),
      ...planned.plans.map((plan: ModPlan) => ({ name: plan.file, comp: plan.bytes })),
    ]);
    const report = (written: number): void =>
      emit('assemble', ENCODE_END + (1 - ENCODE_END) * (total > 0 ? Math.min(1, written / total) : 1));

    // 第二趟：模组读一条、写一条、丢一条。
    // 读回来先核对第一趟的指纹：两趟之间被改过的模组会让清单与字节不同源，
    // 那样写出的包连自己都打不开，必须在导出阶段报错而不是留下一个坏包。
    const writeZip = async (target: ByteSink): Promise<number> => {
      const writer = new ZipWriter(target, at, report);
      for (const entry of entries) await writer.add(entry);
      for (const plan of planned.plans) {
        throwIfAborted(hooks.signal);
        const found = await readMod(reader, plan.stored, injectedOf);
        if (!found) throw new Error(`模组 ${plan.stored} 在导出过程中不见了`);
        await assertModUnchanged(plan, found.bytes);
        await writer.add({ name: plan.file, data: found.bytes, method: 0 });
      }
      await writer.finish();
      return writer.bytes;
    };

    let size: number;
    if (wrapped) {
      // 容器头里的块表要先知道内层大小，而 zip 的长度可以在产出字节之前算准
      size = await writeModPackTo(
        sink,
        [
          ...selfFiles(script!, meta.mod),
          {
            name: SELF_PACK_INNER,
            length: total,
            write: async target => {
              await writeZip(target);
            },
          },
        ],
        RESTORE_MOD_NAME,
      );
    } else {
      size = await writeZip(sink);
    }
    emit('assemble', 1);

    return {
      manifest,
      wrapped,
      size,
      // 与 manifest.createdAt 同源，名字不能各取一次当前时间
      name: packName(at, wrapped ? '-modpack' : ''),
    };
  } finally {
    reader.close();
  }
}
