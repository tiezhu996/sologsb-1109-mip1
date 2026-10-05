import type { ProcessingMethod } from '../types/processing-method';
import type { ProcessBatch } from '../types/process-batch';
import type { PotRound, FrozenPlanSnapshot, HandoverRecord, CloseRecord } from '../types/pot-round';
import type { RetainSample } from '../types/retain-sample';
import type { Transaction } from 'dexie';
import { uid } from './id';
import dayjs from 'dayjs';

export interface RoundDeriveResult {
  rounds: PotRound[];
  /** 工序记录 id → 锅次关联字段回填 */
  batchPatches: Map<string, { potRoundId: string; potRoundNo: string }>;
  /** 留样 id → 锅次关联字段回填 */
  samplePatches: Map<string, { potRoundId: string; potRoundNo: string }>;
}

/** 依据开工时的方法与投料量冻结快照（后续方法台账改动不影响本锅次） */
export function freezePlan(method: ProcessingMethod, feedKg: number): FrozenPlanSnapshot {
  return {
    methodId: method.id,
    methodName: method.name,
    auxiliary: method.auxiliary,
    auxRatio: method.auxRatio,
    fireLevel: method.fireLevel,
    tempRange: [...method.tempRange] as [number, number],
    duration: method.duration,
    criterion: method.criterion,
    criterionDimension: method.criterionDimension,
    feedKg,
    auxPlannedKg: Number(((feedKg * method.auxRatio) / 100).toFixed(2)),
  };
}

/** 锅次号：GC-年月日-当日序号 */
export function buildPotRoundNo(seqOfDay: number, at: Date | string = new Date()): string {
  return `GC-${dayjs(at).format('YYMMDD')}-${String(seqOfDay).padStart(2, '0')}`;
}

/**
 * 把历史工序批次回填为「已收锅」锅次：
 * 不再占用锅位（activePot 为空）、冻结当时方法与投料量、生成开班接手与收锅两条记录，
 * 并回写 batches / samples 的锅次关联，使工序记录与留样台账显示同一锅次号。
 * 已关联锅次的批次跳过（幂等）。
 */
export function buildRoundsFromBatches(input: {
  batches: ProcessBatch[];
  methods: ProcessingMethod[];
  samples: RetainSample[];
  idPrefix?: string;
}): RoundDeriveResult {
  const { batches, methods, samples, idPrefix = 'pot-bf' } = input;
  const batchPatches = new Map<string, { potRoundId: string; potRoundNo: string }>();
  const samplePatches = new Map<string, { potRoundId: string; potRoundNo: string }>();
  const rounds: PotRound[] = [];

  const ordered = batches
    .filter((b) => !b.potRoundId)
    .slice()
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  ordered.forEach((batch, index) => {
    const method = methods.find((m) => m.id === batch.methodId);
    if (!method) {
      return;
    }
    const id = uid(idPrefix);
    const potRoundNo = buildPotRoundNo(index + 1, batch.startedAt);
    const potTemp = Math.round((method.tempRange[0] + method.tempRange[1]) / 2);

    const opening: HandoverRecord = {
      id: uid('handover'),
      seq: 1,
      fromOperator: '开班',
      toOperator: batch.operator,
      at: batch.startedAt,
      potTemp,
      fireLevel: batch.fireLevel,
      note: '开班占用锅位（历史记录回填）',
      basedOnVersion: 1,
    };
    const close: CloseRecord = {
      at: batch.endedAt,
      operator: batch.operator,
      outputKg: Number(((batch.feedKg * batch.yieldRate) / 100).toFixed(1)),
      yieldRate: batch.yieldRate,
      degree: batch.degree,
      temp: potTemp,
      duration: method.duration,
      auxUsedKg: batch.auxUsedKg,
      remark: batch.remark,
    };
    const linkedSamples = samples.filter((s) => s.batchId === batch.id);

    const round: PotRound = {
      id,
      potRoundNo,
      // 历史锅次已收锅，锅位早已释放，不写 potNo / activePot
      herbId: batch.herbId,
      batchNo: batch.batchNo,
      status: '已收锅',
      version: 2,
      frozen: freezePlan(method, batch.feedKg),
      startedAt: batch.startedAt,
      startOperator: batch.operator,
      handovers: [opening],
      anomalies: [],
      close,
      batchRecordId: batch.id,
      sampleIds: linkedSamples.map((s) => s.id),
    };
    rounds.push(round);
    batchPatches.set(batch.id, { potRoundId: id, potRoundNo });
    linkedSamples.forEach((s) => samplePatches.set(s.id, { potRoundId: id, potRoundNo }));
  });

  return { rounds, batchPatches, samplePatches };
}

/**
 * v3 升级期：在升级事务内把历史批次回填为已收锅锅次，
 * 并同步回写 batches / samples 的锅次关联字段。已是 v3（potRounds 非空）时跳过。
 */
export async function backfillRoundsForBatches(tx: Transaction): Promise<void> {
  const potTable = tx.table<PotRound, string>('potRounds');
  if ((await potTable.count()) > 0) {
    return;
  }
  const batches = await tx.table<ProcessBatch, string>('batches').toArray();
  const methods = await tx.table<ProcessingMethod, string>('methods').toArray();
  const samples = await tx.table<RetainSample, string>('samples').toArray();

  const { rounds, batchPatches, samplePatches } = buildRoundsFromBatches({ batches, methods, samples });
  if (rounds.length > 0) {
    await potTable.bulkPut(rounds);
  }
  await Promise.all(
    Array.from(batchPatches.entries()).map(async ([id, patch]) => {
      await tx.table<ProcessBatch, string>('batches').update(id, patch);
    }),
  );
  await Promise.all(
    Array.from(samplePatches.entries()).map(async ([id, patch]) => {
      await tx.table<RetainSample, string>('samples').update(id, patch);
    }),
  );
}
