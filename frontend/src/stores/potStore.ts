import { create } from 'zustand';
import dayjs from 'dayjs';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { PotConflictError, isConstraintError } from '../utils/pot-conflict';
import { broadcastPotChange } from '../utils/pot-sync';
import { freezePlan, buildPotRoundNo } from '../utils/pot-backfill';
import type { PotRound, AnomalyRecord, HandoverRecord, PotCloseDegree } from '../types/pot-round';
import type { FireLevel } from '../types/processing-method';
import type { ProcessBatch } from '../types/process-batch';

/** 开工入参：先占用锅位，并冻住当时方法与投料量 */
export interface StartRoundInput {
  potNo: string;
  herbId: string;
  batchNo: string;
  methodId: string;
  feedKg: number;
  /** 开班操作人（第一班） */
  startOperator: string;
  startedAt: string;
  /** 开班锅温（℃） */
  potTemp: number;
  note?: string;
}

/** 换班接手入参：只追加，不改前班数据 */
export interface HandoverInput {
  fromOperator: string;
  toOperator: string;
  at: string;
  potTemp: number;
  fireLevel: FireLevel;
  note: string;
  /** 打开接手表单时锅次版本；提交时不一致即冲突 */
  basedOnVersion: number;
}

/** 收锅入参 */
export interface CloseRoundInput {
  operator: string;
  endedAt: string;
  outputKg: number;
  temp: number;
  duration: number;
  auxUsedKg: number;
  degree: PotCloseDegree;
  remark?: string;
  basedOnVersion: number;
}

/** 异常登记入参（已产生留样的锅次不能作废，只能登记异常原因） */
export interface AnomalyInput {
  operator: string;
  reason: string;
  action: string;
  basedOnVersion: number;
}

export interface VoidRoundInput {
  operator: string;
  reason: string;
  basedOnVersion: number;
}

interface PotState {
  rounds: PotRound[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  startRound: (input: StartRoundInput) => Promise<PotRound>;
  handover: (roundId: string, input: HandoverInput) => Promise<PotRound>;
  closeRound: (roundId: string, input: CloseRoundInput) => Promise<PotRound>;
  reportAnomaly: (roundId: string, input: AnomalyInput) => Promise<PotRound>;
  voidRound: (roundId: string, input: VoidRoundInput) => Promise<PotRound>;
  activeRounds: () => PotRound[];
  activeRoundOfPot: (potNo: string) => PotRound | undefined;
  occupiedPots: () => Map<string, PotRound>;
  roundById: (id: string) => PotRound | undefined;
}

/** 从 IndexedDB 重读全部锅次（写后刷新 / 跨页签变更 / 崩溃后重开都走这里） */
async function reloadRounds(): Promise<PotRound[]> {
  return db.potRounds.orderBy('startedAt').reverse().toArray();
}

function assertActive(current: PotRound): void {
  if (current.status !== '在锅') {
    throw new PotConflictError('ROUND_NOT_ACTIVE', current.potRoundNo);
  }
}

function assertVersion(current: PotRound, basedOnVersion: number): void {
  if (current.version !== basedOnVersion) {
    throw new PotConflictError('VERSION_STALE', current.potRoundNo, current.version);
  }
}

export const usePotStore = create<PotState>()((set, get) => ({
  rounds: [],
  hydrated: false,

  hydrate: async () => {
    const rounds = await reloadRounds();
    set({ rounds, hydrated: true });
  },

  startRound: async (input) => {
    let created: PotRound;
    try {
      created = await db.transaction('rw', db.potRounds, db.methods, db.herbs, async () => {
        // 同一锅位已有在锅锅次：两个页面同时开工只认先写入的一笔
        const clash = await db.potRounds.where('activePot').equals(`${input.potNo}#active`).first();
        if (clash) {
          throw new PotConflictError('POT_OCCUPIED', input.potNo);
        }
        const method = await db.methods.get(input.methodId);
        if (!method) {
          throw new Error('所选炮制方法不存在或已被删除，请重新选择');
        }
        const herb = await db.herbs.get(input.herbId);
        if (!herb) {
          throw new Error('所选药材批次不存在，请重新选择');
        }
        const feedKg = Number(input.feedKg) || 0;
        if (feedKg <= 0) {
          throw new Error('投料量必须大于 0');
        }

        const dayPrefix = `GC-${dayjs(input.startedAt).format('YYMMDD')}-`;
        const seqOfDay = (await db.potRounds.where('potRoundNo').startsWith(dayPrefix).count()) + 1;
        const potRoundNo = buildPotRoundNo(seqOfDay, input.startedAt);
        const now = input.startedAt;

        const round: PotRound = {
          id: uid('pot'),
          potRoundNo,
          potNo: input.potNo,
          activePot: `${input.potNo}#active`, // 唯一索引：原子占用锅位
          herbId: input.herbId,
          batchNo: input.batchNo.trim(),
          status: '在锅',
          version: 1,
          frozen: freezePlan(method, feedKg),
          startedAt: now,
          startOperator: input.startOperator.trim(),
          handovers: [
            {
              id: uid('handover'),
              seq: 1,
              fromOperator: '开班',
              toOperator: input.startOperator.trim(),
              at: now,
              potTemp: Number(input.potTemp) || 0,
              fireLevel: method.fireLevel,
              note: input.note?.trim() || '开班占用锅位，方法与投料量已冻结',
              basedOnVersion: 1,
            },
          ],
          anomalies: [],
          sampleIds: [],
        };
        await db.potRounds.put(round);
        return round;
      });
    } catch (error) {
      // 唯一索引兜底：极端并发下后到的一笔在此被 IndexedDB 拒绝
      if (isConstraintError(error)) {
        throw new PotConflictError('POT_OCCUPIED', input.potNo);
      }
      throw error;
    }

    await get().hydrate();
    broadcastPotChange({ kind: 'start', potRoundId: created.id });
    return created;
  },

  handover: async (roundId, input) => {
    const next = await db.transaction('rw', db.potRounds, async () => {
      const current = await db.potRounds.get(roundId);
      if (!current) throw new Error('锅次不存在或已被删除');
      assertActive(current);
      assertVersion(current, input.basedOnVersion);

      const record: HandoverRecord = {
        id: uid('handover'),
        seq: current.handovers.length + 1,
        fromOperator: input.fromOperator.trim() || current.handovers[current.handovers.length - 1].toOperator,
        toOperator: input.toOperator.trim(),
        at: input.at,
        potTemp: Number(input.potTemp) || 0,
        fireLevel: input.fireLevel,
        note: input.note.trim(),
        basedOnVersion: current.version,
      };
      const updated: PotRound = {
        ...current,
        handovers: [...current.handovers, record],
        version: current.version + 1,
      };
      await db.potRounds.put(updated);
      return updated;
    });

    await get().hydrate();
    broadcastPotChange({ kind: 'handover', potRoundId: roundId });
    return next;
  },

  closeRound: async (roundId, input) => {
    const outputKg = Number(input.outputKg) || 0;
    const next = await db.transaction('rw', db.potRounds, db.batches, async () => {
      const current = await db.potRounds.get(roundId);
      if (!current) throw new Error('锅次不存在或已被删除');
      assertActive(current);
      assertVersion(current, input.basedOnVersion);
      if (outputKg <= 0) throw new Error('炮制后重量必须大于 0');

      const feedKg = current.frozen.feedKg;
      const yieldRate = Number(((outputKg / feedKg) * 100).toFixed(1));
      const lastHandover = current.handovers[current.handovers.length - 1];
      const batchId = uid('batch');
      const endedAt = input.endedAt;

      const record: ProcessBatch = {
        id: batchId,
        batchNo: current.batchNo,
        herbId: current.herbId,
        methodId: current.frozen.methodId,
        feedKg,
        auxUsedKg: Number(input.auxUsedKg) || 0,
        fireLevel: lastHandover?.fireLevel ?? current.frozen.fireLevel,
        startedAt: current.startedAt,
        endedAt,
        yieldRate,
        degree: input.degree,
        operator: input.operator.trim(),
        locked: true, // 收锅即定稿，工序记录锁定（仍可走质检员改判）
        lockedAt: new Date().toISOString(),
        potRoundId: current.id,
        potRoundNo: current.potRoundNo,
        remark: input.remark?.trim() || undefined,
      };

      const updated: PotRound = {
        ...current,
        status: '已收锅',
        version: current.version + 1,
        close: {
          at: endedAt,
          operator: input.operator.trim(),
          outputKg,
          yieldRate,
          degree: input.degree,
          temp: Number(input.temp) || 0,
          duration: Number(input.duration) || 0,
          auxUsedKg: Number(input.auxUsedKg) || 0,
          remark: input.remark?.trim() || undefined,
        },
        batchRecordId: batchId,
      };
      // 释放锅位：删除占用字段与锅位绑定
      delete updated.activePot;
      delete updated.potNo;

      await db.batches.put(record);
      await db.potRounds.put(updated);
      return updated;
    });

    const [{ useBatchStore }] = await Promise.all([import('./batchStore')]);
    await Promise.all([get().hydrate(), useBatchStore.getState().hydrate()]);
    broadcastPotChange({ kind: 'close', potRoundId: roundId });
    return next;
  },

  reportAnomaly: async (roundId, input) => {
    const next = await db.transaction('rw', db.potRounds, async () => {
      const current = await db.potRounds.get(roundId);
      if (!current) throw new Error('锅次不存在或已被删除');
      if (current.status === '已作废') throw new Error('已作废锅次不能再登记异常');
      assertVersion(current, input.basedOnVersion);

      const record: AnomalyRecord = {
        id: uid('anomaly'),
        at: new Date().toISOString(),
        operator: input.operator.trim(),
        reason: input.reason.trim(),
        action: input.action.trim(),
      };
      const updated: PotRound = {
        ...current,
        anomalies: [...current.anomalies, record],
        version: current.version + 1,
      };
      await db.potRounds.put(updated);
      return updated;
    });

    await get().hydrate();
    broadcastPotChange({ kind: 'anomaly', potRoundId: roundId });
    return next;
  },

  voidRound: async (roundId, input) => {
    const next = await db.transaction('rw', db.potRounds, async () => {
      const current = await db.potRounds.get(roundId);
      if (!current) throw new Error('锅次不存在或已被删除');
      if (current.sampleIds.length > 0) {
        throw new Error(`锅次 ${current.potRoundNo} 已产生留样，不能作废，只能登记异常原因`);
      }
      assertActive(current);
      assertVersion(current, input.basedOnVersion);

      const updated: PotRound = {
        ...current,
        status: '已作废',
        version: current.version + 1,
        void: {
          at: new Date().toISOString(),
          operator: input.operator.trim(),
          reason: input.reason.trim(),
        },
      };
      // 作废同样释放锅位
      delete updated.activePot;
      delete updated.potNo;
      await db.potRounds.put(updated);
      return updated;
    });

    await get().hydrate();
    broadcastPotChange({ kind: 'void', potRoundId: roundId });
    return next;
  },

  activeRounds: () => get().rounds.filter((r) => r.status === '在锅'),
  activeRoundOfPot: (potNo) => get().rounds.find((r) => r.status === '在锅' && r.potNo === potNo),
  occupiedPots: () => new Map(get().rounds.filter((r) => r.status === '在锅' && r.potNo).map((r) => [r.potNo as string, r])),
  roundById: (id) => get().rounds.find((r) => r.id === id),
}));
