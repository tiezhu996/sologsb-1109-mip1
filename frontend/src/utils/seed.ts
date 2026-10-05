import { db } from './db';
import { HERB_ORIGINS, type HerbMaterial } from '../types/herb-material';
import { METHOD_NAMES, type ProcessingMethod } from '../types/processing-method';
import type { ProcessBatch } from '../types/process-batch';
import type { PotRound } from '../types/pot-round';
import { CABINETS, type RetainSample } from '../types/retain-sample';
import { judgeDegree, expectedYieldOf } from './degree';
import { buildRoundsFromBatches, buildPotRoundNo, freezePlan } from './pot-backfill';
import { uid } from './id';

/** 首次打开时写入的示例台账，便于直接查看各页面效果 */
export const SEED_HERBS: HerbMaterial[] = [
  { id: 'herb-001', name: '白术', origin: '植物', part: '根', batchNo: 'BT-2401', feedKg: 120, receivedAt: '2025-08-02T09:00:00.000Z', remark: '浙江磐安产' },
  { id: 'herb-002', name: '白芍', origin: '植物', part: '根', batchNo: 'BS-2402', feedKg: 80, receivedAt: '2025-08-05T09:00:00.000Z' },
  { id: 'herb-003', name: '当归', origin: '植物', part: '根', batchNo: 'DG-2403', feedKg: 60, receivedAt: '2025-08-06T09:00:00.000Z', remark: '甘肃岷县产' },
  { id: 'herb-004', name: '陈皮', origin: '植物', part: '果实', batchNo: 'CP-2404', feedKg: 45, receivedAt: '2025-08-08T09:00:00.000Z' },
  { id: 'herb-005', name: '黄芪', origin: '植物', part: '根', batchNo: 'HQ-2405', feedKg: 200, receivedAt: '2025-08-11T09:00:00.000Z' },
  { id: 'herb-006', name: '牡蛎', origin: '矿物', part: '果实', batchNo: 'ML-2406', feedKg: 150, receivedAt: '2025-08-12T09:00:00.000Z', remark: '煅用' },
  { id: 'herb-007', name: '全蝎', origin: '动物', part: '茎', batchNo: 'QX-2407', feedKg: 12, receivedAt: '2025-08-14T09:00:00.000Z' },
  { id: 'herb-008', name: '杜仲', origin: '植物', part: '茎', batchNo: 'DZ-2408', feedKg: 90, receivedAt: '2025-08-15T09:00:00.000Z', remark: '盐炙用' },
  { id: 'herb-009', name: '桑叶', origin: '植物', part: '叶', batchNo: 'SY-2409', feedKg: 55, receivedAt: '2025-08-18T09:00:00.000Z' },
  { id: 'herb-010', name: '甘草', origin: '植物', part: '根', batchNo: 'GC-2410', feedKg: 130, receivedAt: '2025-08-20T09:00:00.000Z' },
];

export const SEED_METHODS: ProcessingMethod[] = [
  { id: 'method-001', name: '清炒', auxiliary: '无', auxRatio: 0, fireLevel: '文火', tempRange: [90, 120], duration: 12, criterion: '表面微黄、气香、断面颜色加深', criterionDimension: '色泽', applicable: '白术、桑叶、陈皮' },
  { id: 'method-002', name: '麸炒', auxiliary: '麦麸', auxRatio: 10, fireLevel: '中火', tempRange: [130, 160], duration: 10, criterion: '色转深黄、麸皮焦香、无焦斑', criterionDimension: '色泽', applicable: '白术、黄芪、甘草' },
  { id: 'method-003', name: '酒炙', auxiliary: '黄酒', auxRatio: 10, fireLevel: '文火', tempRange: [100, 130], duration: 15, criterion: '色泽加深、酒气尽、断面棕黄', criterionDimension: '气味', applicable: '当归、白芍、黄芪' },
  { id: 'method-004', name: '醋炙', auxiliary: '米醋', auxRatio: 15, fireLevel: '文火', tempRange: [100, 130], duration: 14, criterion: '表面微亮、醋气尽、无焦糊', criterionDimension: '气味', applicable: '柴胡、延胡索' },
  { id: 'method-005', name: '盐炙', auxiliary: '食盐', auxRatio: 2, fireLevel: '文火', tempRange: [110, 140], duration: 12, criterion: '色泽加深、咸味均匀、断面油润', criterionDimension: '断面', applicable: '杜仲、黄柏' },
  { id: 'method-006', name: '蜜炙', auxiliary: '蜂蜜', auxRatio: 25, fireLevel: '中火', tempRange: [120, 150], duration: 16, criterion: '表面金黄有光泽、不粘手、蜜气香', criterionDimension: '色泽', applicable: '甘草、黄芪、桑叶' },
  { id: 'method-007', name: '蒸', auxiliary: '黄酒', auxRatio: 20, fireLevel: '武火', tempRange: [100, 110], duration: 120, criterion: '内外均呈黑褐色、断面油润光亮', criterionDimension: '断面', applicable: '何首乌、地黄' },
  { id: 'method-008', name: '煮', auxiliary: '米醋', auxRatio: 20, fireLevel: '中火', tempRange: [95, 100], duration: 60, criterion: '无白心、断面角质样、有醋香', criterionDimension: '断面', applicable: '延胡索、乌头' },
  { id: 'method-009', name: '燀', auxiliary: '无', auxRatio: 0, fireLevel: '武火', tempRange: [95, 100], duration: 5, criterion: '种皮易脱落、仁无白心', criterionDimension: '断面', applicable: '苦杏仁、桃仁' },
  { id: 'method-010', name: '煅', auxiliary: '无', auxRatio: 0, fireLevel: '武火', tempRange: [300, 500], duration: 45, criterion: '质酥脆、无光泽、断面灰白', criterionDimension: '断面', applicable: '牡蛎、龙骨' },
  { id: 'method-011', name: '麸炒', auxiliary: '麦麸', auxRatio: 12, fireLevel: '文火', tempRange: [120, 150], duration: 9, criterion: '色黄、麸香明显、无焦斑', criterionDimension: '色泽', applicable: '苍术（派生）', derivedFrom: 'method-002' },
  { id: 'method-012', name: '酒炙', auxiliary: '黄酒', auxRatio: 15, fireLevel: '文火', tempRange: [100, 130], duration: 18, criterion: '酒气尽、断面棕褐、色泽均匀', criterionDimension: '断面', applicable: '川芎（派生）', derivedFrom: 'method-003' },
];

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function buildSeedBatches(): ProcessBatch[] {
  const plan: Array<[string, string, string, number, number, number, string, string, string]> = [
    // batchNo, herbId, methodId, feedKg, auxUsedKg, durationMin, fireLevel, operator, remark
    ['PZ-25081', 'herb-001', 'method-002', 120, 12, 10, '中火', '陈玉兰', '麸炒白术'],
    ['PZ-25082', 'herb-002', 'method-003', 80, 8, 15, '文火', '陈玉兰', '酒炙白芍'],
    ['PZ-25083', 'herb-003', 'method-003', 60, 6, 15, '文火', '刘建国', '酒炙当归'],
    ['PZ-25084', 'herb-004', 'method-001', 45, 0, 12, '文火', '刘建国', '清炒陈皮'],
    ['PZ-25085', 'herb-005', 'method-006', 200, 50, 16, '中火', '王丽', '蜜炙黄芪'],
    ['PZ-25086', 'herb-006', 'method-010', 150, 0, 45, '武火', '王丽', '煅牡蛎'],
    ['PZ-25087', 'herb-008', 'method-005', 90, 1.8, 12, '文火', '陈玉兰', '盐炙杜仲'],
    ['PZ-25088', 'herb-009', 'method-001', 55, 0, 12, '文火', '刘建国', '清炒桑叶'],
    ['PZ-25089', 'herb-010', 'method-006', 130, 32.5, 16, '中火', '王丽', '蜜炙甘草'],
    ['PZ-25090', 'herb-007', 'method-002', 12, 1.2, 10, '中火', '王丽', '麸炒全蝎'],
  ];

  return plan.map(([batchNo, herbId, methodId, feedKg, auxUsedKg, duration, fireLevel, operator, remark], index) => {
    const method = SEED_METHODS.find((m) => m.id === methodId)!;
    const endedAt = isoMinutesAgo(45 * (index + 1));
    const startedAt = new Date(new Date(endedAt).getTime() - duration * 60_000).toISOString();
    const yieldRate = Number((expectedYieldOf(method) + ((index % 5) - 2) * 0.8).toFixed(1));
    const verdict = judgeDegree({
      method,
      fireLevel: fireLevel as ProcessBatch['fireLevel'],
      duration,
      temp: Math.round((method.tempRange[0] + method.tempRange[1]) / 2),
      yieldRate,
    });
    const locked = index >= 2;
    return {
      id: `batch-${String(index + 1).padStart(3, '0')}`,
      batchNo,
      herbId,
      methodId,
      feedKg,
      auxUsedKg,
      fireLevel: fireLevel as ProcessBatch['fireLevel'],
      startedAt,
      endedAt,
      yieldRate,
      degree: verdict.degree,
      operator,
      locked,
      lockedAt: locked ? new Date(new Date(endedAt).getTime() + 30 * 60_000).toISOString() : undefined,
      qcBy: locked ? '质检员 · 赵敏' : undefined,
      remark,
    };
  });
}

function buildSeedSamples(batches: ProcessBatch[]): RetainSample[] {
  const logs = (date: string, color: string, odor: string, mold: string, observer: string): RetainSample['observeLogs'][number] => ({
    id: `log-${date}-${Math.random().toString(36).slice(2, 7)}`,
    date,
    color,
    odor,
    mold,
    observer,
  });

  return batches.slice(0, 6).map((batch, index) => {
    const retainMonths = [6, 12, 18, 24][index % 4];
    const retainedAt = new Date(Date.now() - (index * 37 + 8) * 86_400_000).toISOString();
    return {
      id: `sample-${String(index + 1).padStart(3, '0')}`,
      sampleNo: `LY-${batch.batchNo}`,
      batchId: batch.id,
      amountG: [200, 300, 500][index % 3],
      retainMonths,
      cabinet: CABINETS[(index * 5) % CABINETS.length],
      retainedAt,
      observeLogs: [
        logs(new Date(retainedAt).toISOString().slice(0, 10), '色泽符合标准', '气味正常', '无霉变', '赵敏'),
        logs(new Date(Date.now() - (index * 11 + 2) * 86_400_000).toISOString().slice(0, 10), '色泽略深', '气味正常', '无霉变', '赵敏'),
      ],
    };
  });
}

/** 首次打开（表内无数据）时写入示例数据；已有数据则不动 */
export async function seedIfEmpty(): Promise<void> {
  const flag = await db.meta.get('seeded');
  if (flag) {
    return;
  }
  const herbCount = await db.herbs.count();
  const methodCount = await db.methods.count();
  const batchCount = await db.batches.count();
  const sampleCount = await db.samples.count();
  const potCount = await db.potRounds.count();

  await db.transaction('rw', [db.herbs, db.methods, db.batches, db.samples, db.potRounds, db.meta], async () => {
    if (herbCount === 0) {
      await db.herbs.bulkPut(SEED_HERBS.filter((h) => HERB_ORIGINS.includes(h.origin)));
    }
    if (methodCount === 0) {
      await db.methods.bulkPut(SEED_METHODS.filter((m) => METHOD_NAMES.includes(m.name)));
    }
    const seedBatches = buildSeedBatches();
    const batches = batchCount === 0 ? seedBatches : await db.batches.toArray();
    const methods = await db.methods.toArray();

    // 历史工序批次回填为「已收锅」锅次，并回写批次/留样的锅次关联
    let seedSamples: RetainSample[] = [];
    if (sampleCount === 0 && batchCount === 0) {
      seedSamples = buildSeedSamples(seedBatches);
    } else if (sampleCount === 0) {
      seedSamples = [];
    } else {
      seedSamples = await db.samples.toArray();
    }

    if (potCount === 0) {
      const derived = buildRoundsFromBatches({ batches, methods, samples: seedSamples, idPrefix: 'pot-seed' });

      // 回写锅次关联后再入库，使工序记录与留样台账显示同一锅次
      derived.batchPatches.forEach((patch, id) => {
        const b = batches.find((x) => x.id === id);
        if (b) {
          b.potRoundId = patch.potRoundId;
          b.potRoundNo = patch.potRoundNo;
        }
      });
      derived.samplePatches.forEach((patch, id) => {
        const s = seedSamples.find((x) => x.id === id);
        if (s) {
          s.potRoundId = patch.potRoundId;
          s.potRoundNo = patch.potRoundNo;
        }
      });

      const running = buildSeedRunningRound({ methods, seqOfDay: derived.rounds.length + 1 });
      await db.potRounds.bulkPut([...derived.rounds, running]);
    }

    if (batchCount === 0) {
      await db.batches.bulkPut(batches);
    }
    if (sampleCount === 0) {
      await db.samples.bulkPut(seedSamples);
    }
    await db.meta.put({ key: 'seeded', value: new Date().toISOString() });
  });
}

/**
 * 演示用「在锅」锅次：占用 1 号锅、方法与投料已冻结、已换过一次班，
 * 便于直接查看锅位占用、接手记录与「收锅 / 再接手 / 异常 / 作废」入口。
 */
function buildSeedRunningRound(input: { methods: ProcessingMethod[]; seqOfDay: number }): PotRound {
  const method = input.methods.find((m) => m.id === 'method-001') ?? input.methods[0];
  const startedAt = new Date(Date.now() - 35 * 60_000).toISOString();
  const handoverAt = new Date(Date.now() - 12 * 60_000).toISOString();
  const feedKg = 100;
  return {
    id: 'pot-running-demo',
    potRoundNo: buildPotRoundNo(input.seqOfDay, startedAt),
    potNo: '1号锅',
    activePot: '1号锅#active',
    herbId: 'herb-009',
    batchNo: 'SY-DEMO-01',
    status: '在锅',
    version: 2,
    frozen: freezePlan(method, feedKg),
    startedAt,
    startOperator: '陈玉兰',
    handovers: [
      {
        id: uid('handover'),
        seq: 1,
        fromOperator: '开班',
        toOperator: '陈玉兰',
        at: startedAt,
        potTemp: method.tempRange[0],
        fireLevel: method.fireLevel,
        note: '开班清炒桑叶，锅温稳定后下药材',
        basedOnVersion: 1,
      },
      {
        id: uid('handover'),
        seq: 2,
        fromOperator: '陈玉兰',
        toOperator: '刘建国',
        at: handoverAt,
        potTemp: 112,
        fireLevel: '文火',
        note: '表面刚开始转黄，保持文火勤翻，预计再炒 5 分钟',
        basedOnVersion: 2,
      },
    ],
    anomalies: [],
    sampleIds: [],
  };
}

/** 清空全部本地数据（用于重置演示环境） */
export async function resetAll(): Promise<void> {
  await db.transaction('rw', [db.herbs, db.methods, db.batches, db.samples, db.potRounds, db.meta], async () => {
    await Promise.all([db.herbs.clear(), db.methods.clear(), db.batches.clear(), db.samples.clear(), db.potRounds.clear(), db.meta.clear()]);
  });
  await seedIfEmpty();
}
