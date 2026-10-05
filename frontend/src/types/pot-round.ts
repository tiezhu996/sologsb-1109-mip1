import type { FireLevel } from './processing-method';

/** 锅次状态：在锅 / 已收锅 / 已作废 */
export type PotRoundStatus = '在锅' | '已收锅' | '已作废';

/**
 * 开工时冻结的方法与投料量快照。
 * 换班接手只追加记录，任何后续班组都不能修改这里的数值，
 * 即使炮制方法台账后来被改动，本锅次仍按开工时的快照执行与追溯。
 */
export interface FrozenPlanSnapshot {
  methodId: string;
  methodName: string;
  auxiliary: string;
  /** 每 100kg 药材辅料用量（kg） */
  auxRatio: number;
  fireLevel: FireLevel;
  tempRange: [number, number];
  duration: number;
  criterion: string;
  criterionDimension: string;
  /** 投料量（kg），开工冻住 */
  feedKg: number;
  /** 辅料计划用量（kg），按开工时比例与投料量折算并冻住 */
  auxPlannedKg: number;
}

/** 换班接手记录（只追加，不可改、不可删） */
export interface HandoverRecord {
  id: string;
  /** 第几次接手（开班为 1，之后每次换班 +1） */
  seq: number;
  /** 交出班组/操作人 */
  fromOperator: string;
  /** 接手班组/操作人 */
  toOperator: string;
  /** 接手时间 ISO */
  at: string;
  /** 交接时锅温（℃） */
  potTemp: number;
  /** 交接时火候 */
  fireLevel: FireLevel;
  /** 交接说明（锅内状态、注意事项） */
  note: string;
  /** 乐观锁版本：该笔接手写入时锅次的版本号，用于并发冲突判定 */
  basedOnVersion: number;
}

/** 异常登记记录（只追加） */
export interface AnomalyRecord {
  id: string;
  at: string;
  /** 登记人 */
  operator: string;
  /** 异常原因 */
  reason: string;
  /** 处置措施 */
  action: string;
}

/** 收锅记录（一口锅次最多一笔） */
export interface CloseRecord {
  at: string;
  /** 收锅操作人（最后一个接手班组） */
  operator: string;
  outputKg: number;
  yieldRate: number;
  degree: PotCloseDegree;
  temp: number;
  duration: number;
  /** 累计辅料实际用量（kg） */
  auxUsedKg: number;
  remark?: string;
}

/** 作废记录（一口锅次最多一笔），用于未收锅即中止的锅次 */
export interface VoidRecord {
  at: string;
  operator: string;
  reason: string;
}

export type PotCloseDegree = '不及' | '适中' | '太过';

/** 锅次（占用一个锅位的一次炮制过程） */
export interface PotRound {
  id: string;
  /** 锅次号，全库唯一（如 GC-261005-03） */
  potRoundNo: string;
  /** 锅位编号；收锅/作废后清空，表示锅位已释放 */
  potNo?: string;
  /**
   * 占用标记：在锅期间为 `${potNo}#active`，收锅/作废后删除该字段。
   * Dexie 对该字段建唯一索引，同一锅位存在两笔在锅记录时只有先写入的一笔能落库。
   */
  activePot?: string;

  /** 关联药材（药材台账批次） */
  herbId: string;
  /** 关联生产批号（开工登记，冗余便于展示） */
  batchNo: string;

  status: PotRoundStatus;
  /** 乐观锁版本：开工为 1，每追加一笔记录 +1；提交时版本落后即冲突 */
  version: number;

  /** 开工即冻结的方法与投料量 */
  frozen: FrozenPlanSnapshot;

  startedAt: string;
  startOperator: string;

  /** 换班接手记录（含开班第一条），按 seq 升序，只追加 */
  handovers: HandoverRecord[];
  anomalies: AnomalyRecord[];
  close?: CloseRecord;
  void?: VoidRecord;

  /** 收锅后生成的工序记录 id */
  batchRecordId?: string;
  /** 本锅次已产生的留样 id（留样后不可作废） */
  sampleIds: string[];
}

/** 锅位：4 口锅 */
export const POTS: string[] = ['1号锅', '2号锅', '3号锅', '4号锅'];

/** 锅次状态色 */
export const POT_STATUS_COLOR: Record<PotRoundStatus, string> = {
  在锅: 'processing',
  已收锅: 'success',
  已作废: 'default',
};

export function isActiveRound(round: PotRound): boolean {
  return round.status === '在锅';
}
