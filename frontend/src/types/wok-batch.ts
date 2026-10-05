import type { Auxiliary, FireLevel, MethodName, CriterionDimension } from './processing-method';
import type { ProcessDegree } from './process-batch';

/** 炮制锅位（车间共 4 口锅） */
export const WOK_POTS = ['1号锅', '2号锅', '3号锅', '4号锅'] as const;
export type WokPot = (typeof WOK_POTS)[number];

/** 锅次状态：进行中 / 已收锅 / 已作废 */
export type WokStatus = 'running' | 'finished' | 'voided';

/** 班组交接（接手）记录：只能追加，后来接手的人不能改前班数据 */
export interface HandoverRecord {
  id: string;
  /** 接手时间 ISO */
  at: string;
  /** 交班操作人 */
  fromOperator: string;
  /** 接班操作人 */
  toOperator: string;
  /** 交班班组 */
  fromTeam?: string;
  /** 接班班组 */
  toTeam?: string;
  /** 交接备注（锅上状态、辅料余料等） */
  note?: string;
}

/** 异常登记记录：只能追加（已产生留样的锅次不能作废，只能登记异常原因） */
export interface AbnormalRecord {
  id: string;
  /** 登记时间 ISO */
  at: string;
  /** 异常原因 */
  reason: string;
  /** 登记人 */
  operator: string;
}

/**
 * 锅次：开工即占用锅位，并冻结当时的炮制方法与投料量。
 * 冻结字段（方法/辅料比例/火力/投料/计划辅料量）在整个锅次生命周期内不可修改；
 * 交接、异常只向数组追加；收锅后写入得率/程度并释放锅位。
 */
export interface WokBatch {
  id: string;
  /** 锅次号（收锅后与工序批号一致） */
  wokNo: string;
  /** 占用的锅位 */
  pot: WokPot;
  /** 关联药材 */
  herbId: string;
  /** 关联炮制方法 */
  methodId: string;

  // —— 开工时冻结的方法快照（后续即使方法台账被改，本锅次仍按冻结时执行） ——
  methodName: MethodName;
  methodAuxiliary: Auxiliary;
  /** 冻结时辅料比例 kg/100kg */
  auxRatio: number;
  /** 冻结时火力 */
  fireLevel: FireLevel;
  methodDuration: number;
  tempRange: [number, number];
  criterion: string;
  criterionDimension: CriterionDimension;

  // —— 开工时冻结的投料数据 ——
  /** 投料量（kg），开工后不可改 */
  feedKg: number;
  /** 计划辅料用量（kg），按开工时比例折算，开工后不可改 */
  auxPlannedKg: number;

  /** 开工时间 ISO */
  startedAt: string;
  /** 开工操作人（锅上第一班） */
  startOperator: string;
  /** 开工班组 */
  startTeam?: string;

  /** 锅次状态 */
  status: WokStatus;
  /**
   * 乐观锁修订号：开工为 0，每追加一次交接/异常、每次状态流转 +1。
   * 接手/收锅提交必须带打开时的修订号，不一致即冲突，只认先写入的一笔。
   */
  revision: number;

  /** 交接链（按时间顺序，只追加） */
  handovers: HandoverRecord[];
  /** 异常记录（只追加） */
  abnormals: AbnormalRecord[];

  // —— 收锅时写入 ——
  /** 收锅时间 ISO */
  endedAt?: string;
  /** 炮制后重量（kg） */
  outputKg?: number;
  /** 辅料实际用量（kg） */
  auxUsedKg?: number;
  /** 得率（%） */
  yieldRate?: number;
  /** 程度判定 */
  degree?: ProcessDegree;
  /** 收锅操作人 */
  finishOperator?: string;
  /** 收锅备注 */
  finishNote?: string;
  /** 收锅生成的工序记录 id（工序记录与留样台账凭此与锅次对应） */
  processBatchId?: string;
  /** 收锅后锁定（与工序记录锁定状态一致） */
  locked?: boolean;

  // —— 作废时写入 ——
  voidedAt?: string;
  voidOperator?: string;
  voidReason?: string;
}

/** 草稿类型：开工 / 接手 / 收锅 */
export type WokDraftKind = 'start' | 'takeover' | 'finish';

export interface StartDraftPayload {
  pot: WokPot;
  herbId: string;
  methodId: string;
  feedKg: number;
  startOperator: string;
  startTeam?: string;
  /** 开工时间 ISO */
  startedAt: string;
}

export interface TakeoverDraftPayload {
  fromOperator: string;
  toOperator: string;
  fromTeam?: string;
  toTeam?: string;
  note?: string;
}

export interface FinishDraftPayload {
  /** 收锅时间 ISO */
  endedAt: string;
  outputKg: number;
  auxUsedKg: number;
  degree: ProcessDegree;
  finishOperator: string;
  finishNote?: string;
}

/**
 * 未提交草稿：写入冲突后保留后到页面的录入，浏览器关掉再打开也能恢复。
 * 按标签页会话（sessionId）隔离，两个页面同时编辑同一锅次不会互相覆盖草稿。
 */
export interface WokDraft {
  id: string;
  kind: WokDraftKind;
  /** 接手/收锅草稿对应的锅次 */
  wokId?: string;
  /** 开工草稿预选的锅位 */
  pot?: WokPot;
  /** 接手/收锅草稿所基于的修订号（恢复后提交仍做冲突校验） */
  baseRevision?: number;
  payload: StartDraftPayload | TakeoverDraftPayload | FinishDraftPayload;
  /** 来源页面会话 id */
  sessionId: string;
  updatedAt: string;
}
