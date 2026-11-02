import { capabilities, probeWasm, storageEstimate } from '../host/env';
import { dbName, idbActive, idbSettings, supportsGetAllSaves } from '../host/game';
import { injectedValues } from '../host/modloader';
import { listAddrs } from '../store/address';
import { readLocal, readSession } from '../store/local';
import { readIdbMods, readLocalMods } from '../store/mods';
import { encodingOf, readDetails, readLegacy, readSaves } from '../store/saves';
import { snapshotDbInfo } from '../store/snapshots';

/**
 * 探针：只读、不建库、不改数据，用于排查与 e2e 的现状核对。
 * 返回值直接 JSON 化，字段名保持稳定。
 */
export async function probe(): Promise<Record<string, unknown>> {
  const saves = await readSaves();
  const details = await readDetails();
  const mods = await readIdbMods();
  const localMods = readLocalMods();
  const legacy = readLegacy();
  const snapshot = await snapshotDbInfo();
  const estimate = await storageEstimate();

  return {
    capabilities: { ...capabilities(), wasm: await probeWasm() },
    idb: {
      dbName: dbName(),
      active: idbActive(),
      supportsGetAllSaves: supportsGetAllSaves(),
      settings: idbSettings(),
    },
    saves: {
      count: saves.length,
      slots: saves.map(record => record.slot),
      encodings: saves.map(record => encodingOf(record)),
      details: details.length,
      legacy: { saves: Boolean(legacy.saves), details: Boolean(legacy.details) },
    },
    mods: {
      enabled: mods.enabled.length,
      hidden: mods.hidden.length,
      values: mods.values.size,
      valueType: mods.valueType,
      local: localMods.list.length,
      localValues: localMods.values.size,
      injected: injectedValues().length,
    },
    storage: {
      local: readLocal().length,
      session: readSession().length,
      estimate,
    },
    /** 地址是识别单位：探针直接给出枚举结果，e2e 拿它与存储实际对照 */
    addresses: (await listAddrs()).map(item => item.addr),
    snapshot,
  };
}
