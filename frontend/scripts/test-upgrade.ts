import 'fake-indexeddb/auto';
import Dexie, { type Table } from 'dexie';
import assert from 'node:assert/strict';
import { db, DB_NAME } from '../src/utils/db';
import type { ProcessBatch } from '../src/types/process-batch';

// 1) 先用“旧应用”的 v2 schema 建库并写入历史批次
interface OldDB extends Dexie {
  herbs: Table; methods: Table; batches: Table<ProcessBatch, string>; samples: Table; meta: Table;
}
const old = new Dexie(DB_NAME) as OldDB;
old.version(1).stores({
  herbs: 'id', methods: 'id', batches: 'id, batchNo, herbId, methodId, degree, startedAt', samples: 'id', meta: 'key',
});
old.version(2).stores({
  herbs: 'id', methods: 'id', batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked', samples: 'id', meta: 'key',
});
await old.batches.put({
  id: 'old-1', batchNo: 'PZ-OLD-1', herbId: 'h', methodId: 'm', feedKg: 10, auxUsedKg: 1,
  fireLevel: '文火', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
  yieldRate: 94, degree: '适中', operator: '甲', locked: true,
} as ProcessBatch);
await old.close();

// 2) 用当前应用的 db 打开同一库，触发 v2 -> v3 自动升级
const rows = await db.batches.toArray();
assert.equal(rows.length, 1, '历史批次保留');
assert.equal(rows[0].batchNo, 'PZ-OLD-1');
assert.equal(rows[0].wokId, undefined, '历史批次无 wokId 不回填');
assert.equal(await db.wokBatches.count(), 0, '锅次表已新建为空');
assert.equal(await db.wokDrafts.count(), 0, '草稿表已新建为空');

// 3) 升级后锅次功能可正常使用
const wok = await db.wokBatches.put({
  id: 'w1', wokNo: 'PZ-NEW-01', pot: '1号锅', herbId: 'h', methodId: 'm',
  methodName: '清炒', methodAuxiliary: '无', auxRatio: 0, fireLevel: '文火', methodDuration: 12,
  tempRange: [90, 120], criterion: 'x', criterionDimension: '色泽',
  feedKg: 10, auxPlannedKg: 0, startedAt: new Date().toISOString(), startOperator: '乙',
  status: 'running', revision: 0, handovers: [], abnormals: [],
});
assert.equal(await db.wokBatches.where({ pot: '1号锅', status: 'running' }).count(), 1);
void wok;
console.log('✅ v2 -> v3 升级：历史数据保留、新表与 [pot+status] 复合索引可用');
process.exit(0);
