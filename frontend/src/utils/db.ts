import Dexie, { type Table } from 'dexie';
import type { HerbMaterial } from '../types/herb-material';
import type { ProcessingMethod } from '../types/processing-method';
import type { ProcessBatch } from '../types/process-batch';
import type { RetainSample } from '../types/retain-sample';
import type { WokBatch, WokDraft } from '../types/wok-batch';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbherbprocess-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class HerbProcessDB extends Dexie {
  herbs!: Table<HerbMaterial, string>;
  methods!: Table<ProcessingMethod, string>;
  batches!: Table<ProcessBatch, string>;
  samples!: Table<RetainSample, string>;
  /** 锅次：开工占锅位、交接只追加、收锅释放锅位 */
  wokBatches!: Table<WokBatch, string>;
  /** 未提交草稿（冲突保留 / 关浏览器后恢复） */
  wokDrafts!: Table<WokDraft, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      herbs: 'id, name, origin, part, batchNo, receivedAt',
      methods: 'id, name, auxiliary, fireLevel',
      batches: 'id, batchNo, herbId, methodId, degree, startedAt',
      samples: 'id, sampleNo, batchId, cabinet, retainedAt',
      meta: 'key',
    });

    // v2：批次表增加 locked 索引（锁定/质检放行查询更快），并回填历史数据的 locked 字段。
    // 升级前请在「导出备份」中导出 JSON。
    this.version(2)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('batches')
          .toCollection()
          .modify((row: ProcessBatch) => {
            if (typeof row.locked !== 'boolean') {
              row.locked = false;
            }
          });
      });

    // v3：锅次交接。
    // - wokBatches：[pot+status] 复合索引保证“同锅位只能有一个进行中锅次”的占用判断；
    //   revision 乐观锁，接手/收锅只认先写入的一笔。
    // - wokDrafts：冲突后保留后到页面的录入，重开浏览器恢复未完成锅次与锅位占用。
    // - batches 增加 wokId 索引：收锅生成的工序记录与锅次、留样台账互相对应。
    this.version(3).stores({
      herbs: 'id, name, origin, part, batchNo, receivedAt',
      methods: 'id, name, auxiliary, fireLevel',
      batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked, wokId',
      samples: 'id, sampleNo, batchId, cabinet, retainedAt',
      wokBatches: 'id, wokNo, pot, status, startedAt, [pot+status], revision',
      wokDrafts: 'id, kind, wokId, pot, sessionId, updatedAt',
      meta: 'key',
    });
  }
}

export const db = new HerbProcessDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
