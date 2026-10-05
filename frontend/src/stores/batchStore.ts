import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { broadcastChange, emitLocal } from '../utils/crossTab';
import type { FireLevel } from '../types/processing-method';
import type { ProcessBatch, ProcessDegree } from '../types/process-batch';
import type { WokBatch } from '../types/wok-batch';

export interface BatchInput {
  batchNo: string;
  herbId: string;
  methodId: string;
  feedKg: number;
  auxUsedKg: number;
  fireLevel: FireLevel;
  startedAt: string;
  endedAt: string;
  yieldRate: number;
  degree: ProcessDegree;
  operator: string;
  remark?: string;
}

interface BatchState {
  batches: ProcessBatch[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  createBatch: (input: BatchInput, lock?: boolean) => Promise<ProcessBatch>;
  updateBatch: (id: string, patch: Partial<BatchInput>, force?: boolean) => Promise<boolean>;
  removeBatch: (id: string) => Promise<void>;
  /** 提交得率与程度判定后锁定该批 */
  lockBatch: (id: string) => Promise<void>;
  /** 质检员放行/改判：仅质检员可解锁 */
  unlockAsQc: (id: string, qcBy: string) => Promise<void>;
  degreeCount: () => Record<ProcessDegree, number>;
  pendingBatches: () => ProcessBatch[];
  batchesOfHerb: (herbId: string) => ProcessBatch[];
}

export const useBatchStore = create<BatchState>()((set, get) => ({
  batches: [],
  hydrated: false,

  hydrate: async () => {
    const batches = await db.batches.orderBy('startedAt').reverse().toArray();
    set({ batches, hydrated: true });
  },

  createBatch: async (input, lock = false) => {
    const batch: ProcessBatch = {
      id: uid('batch'),
      batchNo: input.batchNo.trim(),
      herbId: input.herbId,
      methodId: input.methodId,
      feedKg: Number(input.feedKg) || 0,
      auxUsedKg: Number(input.auxUsedKg) || 0,
      fireLevel: input.fireLevel,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      yieldRate: Number(input.yieldRate) || 0,
      degree: input.degree,
      operator: input.operator.trim(),
      locked: lock,
      lockedAt: lock ? new Date().toISOString() : undefined,
      remark: input.remark?.trim() || undefined,
    };
    await db.batches.put(batch);
    set({ batches: [batch, ...get().batches] });
    broadcastChange('batches');
    return batch;
  },

  updateBatch: async (id, patch, force = false) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return false;
    }
    if (current.locked && !force) {
      return false;
    }
    const next: ProcessBatch = { ...current, ...patch };
    if (force) {
      next.qcBy = next.qcBy ?? '质检员 · 赵敏';
    }
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });

    // 收锅生成的工序记录：质检改判同步回锅次，保证工序记录与锅次台账一致
    if (current.wokId && (patch.degree !== undefined || patch.yieldRate !== undefined || patch.auxUsedKg !== undefined)) {
      await syncBatchToWok(current.wokId, next);
    }

    broadcastChange('batches');
    return true;
  },

  removeBatch: async (id) => {
    const current = get().batches.find((b) => b.id === id);
    // 收锅生成的工序记录不能直接删除：应到锅次交接页作废锅次（已留样的还禁止作废）
    if (current?.wokId) {
      throw new Error('该工序记录由收锅生成，请在锅次交接页处理，不能单独删除');
    }
    await db.batches.delete(id);
    set({ batches: get().batches.filter((b) => b.id !== id) });
    broadcastChange('batches');
  },

  lockBatch: async (id) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return;
    }
    const next: ProcessBatch = { ...current, locked: true, lockedAt: new Date().toISOString() };
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
    if (current.wokId) {
      await syncBatchToWok(current.wokId, next);
    }
    broadcastChange('batches');
  },

  unlockAsQc: async (id, qcBy) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return;
    }
    const next: ProcessBatch = { ...current, locked: false, qcBy };
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
    if (current.wokId) {
      await syncBatchToWok(current.wokId, next);
    }
    broadcastChange('batches');
  },

  degreeCount: () => {
    const result: Record<ProcessDegree, number> = { 不及: 0, 适中: 0, 太过: 0 };
    get().batches.forEach((b) => {
      result[b.degree] += 1;
    });
    return result;
  },

  pendingBatches: () => get().batches.filter((b) => !b.locked),

  batchesOfHerb: (herbId) => get().batches.filter((b) => b.herbId === herbId),
}));

/**
 * 将工序记录的质检改判/锁定状态同步到对应锅次（不改修订号与交接链，
 * 属于收锅后质检台账层面的同步；开工冻结字段与交接记录不允许通过此入口改动）。
 */
async function syncBatchToWok(wokId: string, batch: ProcessBatch): Promise<void> {
  const wok = await db.wokBatches.get(wokId);
  if (!wok) {
    return;
  }
  const patch: Partial<WokBatch> = {
    degree: batch.degree,
    yieldRate: batch.yieldRate,
    auxUsedKg: batch.auxUsedKg,
    locked: batch.locked,
  };
  const next: WokBatch = { ...wok, ...patch };
  await db.wokBatches.put(next);
  emitLocal('woks');
  broadcastChange('woks');
}
