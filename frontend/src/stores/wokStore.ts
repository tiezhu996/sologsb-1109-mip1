import { create } from 'zustand';
import dayjs from 'dayjs';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { broadcastChange, emitLocal } from '../utils/crossTab';
import type { AbnormalRecord, HandoverRecord, WokBatch, WokDraft, WokPot } from '../types/wok-batch';
import type { FireLevel } from '../types/processing-method';
import type { ProcessBatch, ProcessDegree } from '../types/process-batch';

/** 冲突原因码：后到页面据此保留草稿并显示冲突 */
export type WokConflictCode = 'pot-occupied' | 'conflict' | 'not-found' | 'not-running' | 'has-samples' | 'voided' | 'invalid-method';

export class WokMutationError extends Error {
  code: WokConflictCode;
  /** 先写入后锅次的最新状态（冲突页面据此刷新展示） */
  current?: WokBatch;

  constructor(code: WokConflictCode, message: string, current?: WokBatch) {
    super(message);
    this.name = 'WokMutationError';
    this.code = code;
    this.current = current;
  }
}

export interface StartWokInput {
  pot: WokPot;
  herbId: string;
  methodId: string;
  feedKg: number;
  startOperator: string;
  startTeam?: string;
  startedAt: string;
}

export interface TakeoverInput {
  wokId: string;
  /** 打开接手弹窗时的修订号，提交时不一致即冲突 */
  expectedRevision: number;
  fromOperator: string;
  toOperator: string;
  fromTeam?: string;
  toTeam?: string;
  note?: string;
}

export interface FinishWokInput {
  wokId: string;
  expectedRevision: number;
  endedAt: string;
  outputKg: number;
  auxUsedKg: number;
  degree: ProcessDegree;
  finishOperator: string;
  finishNote?: string;
}

export interface AbnormalInput {
  wokId: string;
  reason: string;
  operator: string;
}

export interface VoidWokInput {
  wokId: string;
  operator: string;
  reason: string;
}

export type DraftUpsert = Pick<WokDraft, 'kind' | 'payload'> & {
  wokId?: string;
  pot?: WokPot;
  baseRevision?: number;
  /** 不传则覆盖当前会话同槽位草稿 */
  id?: string;
};

function round1(value: number): number {
  return Number(value.toFixed(1));
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/** 锅次号：PZ-YYMMDD-NN，按开工日顺序编号；收锅后工序批号沿用同一锅次号 */
async function nextWokNo(startedAt: string): Promise<string> {
  const prefix = `PZ-${dayjs(startedAt).format('YYMMDD')}-`;
  const sameDay = await db.wokBatches.where('wokNo').startsWith(prefix).count();
  return `${prefix}${String(sameDay + 1).padStart(2, '0')}`;
}

interface WokState {
  woks: WokBatch[];
  drafts: WokDraft[];
  hydrated: boolean;
  draftsHydrated: boolean;
  /** 标签页会话 id：页面加载即分配，用于隔离两个页面同时编辑时的草稿 */
  sessionId: string;
  hydrate: () => Promise<void>;
  hydrateDrafts: () => Promise<void>;
  /** 开工：同事务占用锅位 + 冻结方法快照与投料量；锅位已被占用则拒绝 */
  startWok: (input: StartWokInput) => Promise<WokBatch>;
  /** 接手：只追加交接记录；revision 不一致时抛 WokMutationError('conflict') */
  takeoverWok: (input: TakeoverInput) => Promise<WokBatch>;
  /** 收锅：同事务写入得率程度、生成工序记录并释放锅位 */
  finishWok: (input: FinishWokInput) => Promise<{ wok: WokBatch; batch: ProcessBatch }>;
  /** 异常登记：只追加异常记录（已留样锅次不能作废时的唯一处理方式） */
  registerAbnormal: (input: AbnormalInput) => Promise<WokBatch>;
  /** 作废：已产生留样的锅次拒绝作废；运行中作废即释放锅位，收锅后作废连带删除工序记录 */
  voidWok: (input: VoidWokInput) => Promise<WokBatch>;
  /** 保存/更新未提交草稿（冲突保留、关浏览器后恢复） */
  upsertDraft: (input: DraftUpsert) => Promise<WokDraft>;
  deleteDraft: (id: string) => Promise<void>;
  getDraft: (id: string) => WokDraft | undefined;
  runningWoks: () => WokBatch[];
  occupiedPots: () => WokPot[];
}

export const useWokStore = create<WokState>()((set, get) => ({
  woks: [],
  drafts: [],
  hydrated: false,
  draftsHydrated: false,
  sessionId: uid('sess'),

  hydrate: async () => {
    const woks = await db.wokBatches.orderBy('startedAt').reverse().toArray();
    set({ woks, hydrated: true });
  },

  hydrateDrafts: async () => {
    const drafts = await db.wokDrafts.orderBy('updatedAt').reverse().toArray();
    set({ drafts, draftsHydrated: true });
  },

  startWok: async (input) => {
    const feedKg = Number(input.feedKg) || 0;
    if (feedKg <= 0) {
      throw new WokMutationError('invalid-method', '投料量必须大于 0');
    }
    const result = await db.transaction('rw', [db.wokBatches, db.methods], async () => {
      const method = await db.methods.get(input.methodId);
      if (!method) {
        throw new WokMutationError('invalid-method', '所选炮制方法不存在或已被删除');
      }
      // 锅位占用：同锅位只允许一个进行中的锅次（复合索引 [pot+status] 原子判定）
      const occupied = await db.wokBatches.where({ pot: input.pot, status: 'running' }).first();
      if (occupied) {
        throw new WokMutationError(
          'pot-occupied',
          `${input.pot} 已被锅次 ${occupied.wokNo} 占用（${occupied.startOperator} 开工），请先收锅或换锅位`,
          occupied,
        );
      }

      const startedAt = input.startedAt || new Date().toISOString();
      const wok: WokBatch = {
        id: uid('wok'),
        wokNo: await nextWokNo(startedAt),
        pot: input.pot,
        herbId: input.herbId,
        methodId: input.methodId,
        // 冻结开工当时的方法参数与判断标准
        methodName: method.name,
        methodAuxiliary: method.auxiliary,
        auxRatio: method.auxRatio,
        fireLevel: method.fireLevel,
        methodDuration: method.duration,
        tempRange: [...method.tempRange] as [number, number],
        criterion: method.criterion,
        criterionDimension: method.criterionDimension,
        // 冻结投料量与按当时比例折算的辅料计划用量
        feedKg,
        auxPlannedKg: round2((feedKg * method.auxRatio) / 100),
        startedAt,
        startOperator: input.startOperator.trim(),
        startTeam: input.startTeam?.trim() || undefined,
        status: 'running',
        revision: 0,
        handovers: [],
        abnormals: [],
      };
      await db.wokBatches.put(wok);
      return wok;
    });

    await get().hydrate();
    broadcastChange('woks');
    return result;
  },

  takeoverWok: async (input) => {
    const result = await db.transaction('rw', db.wokBatches, async () => {
      const wok = await db.wokBatches.get(input.wokId);
      if (!wok) {
        throw new WokMutationError('not-found', '锅次不存在，可能已在其他页面收锅或作废');
      }
      if (wok.status !== 'running') {
        // 与其他页面的收锅/作废并发：对方先提交，按冲突处理，后到页面保留草稿
        throw new WokMutationError(
          'conflict',
          `锅次 ${wok.wokNo} 已在其他页面${wok.status === 'finished' ? '收锅' : '作废'}，本笔接手不写入（当前修订 ${wok.revision}）`,
          wok,
        );
      }
      // 乐观锁：两个页面同时接手，只认先写入的一笔
      if (wok.revision !== input.expectedRevision) {
        throw new WokMutationError(
          'conflict',
          `锅次 ${wok.wokNo} 已被其他页面先写入新的交接记录（当前修订 ${wok.revision}，本页基于 ${input.expectedRevision}）`,
          wok,
        );
      }
      const record: HandoverRecord = {
        id: uid('hand'),
        at: new Date().toISOString(),
        fromOperator: input.fromOperator.trim(),
        toOperator: input.toOperator.trim(),
        fromTeam: input.fromTeam?.trim() || undefined,
        toTeam: input.toTeam?.trim() || undefined,
        note: input.note?.trim() || undefined,
      };
      const next: WokBatch = { ...wok, handovers: [...wok.handovers, record], revision: wok.revision + 1 };
      await db.wokBatches.put(next);
      return next;
    });

    await get().hydrate();
    broadcastChange('woks');
    return result;
  },

  finishWok: async (input) => {
    const outputKg = Number(input.outputKg) || 0;
    const result = await db.transaction('rw', [db.wokBatches, db.batches], async () => {
      const wok = await db.wokBatches.get(input.wokId);
      if (!wok) {
        throw new WokMutationError('not-found', '锅次不存在，可能已在其他页面作废');
      }
      if (wok.status !== 'running') {
        // 与其他页面的收锅/作废并发：对方先提交，按冲突处理，后到页面保留收锅草稿
        throw new WokMutationError(
          'conflict',
          `锅次 ${wok.wokNo} 已在其他页面${wok.status === 'finished' ? '收锅' : '作废'}，本页收锅不写入，请刷新查看（当前修订 ${wok.revision}）`,
          wok,
        );
      }
      // 乐观锁：两个页面同时收锅，只认先写入的一笔
      if (wok.revision !== input.expectedRevision) {
        throw new WokMutationError(
          'conflict',
          `锅次 ${wok.wokNo} 在本页打开后已有新的交接/异常（当前修订 ${wok.revision}，本页基于 ${input.expectedRevision}），请刷新后按最新情况收锅`,
          wok,
        );
      }
      if (!(wok.feedKg > 0)) {
        throw new WokMutationError('invalid-method', '冻结投料量异常，无法计算得率', wok);
      }

      const yieldRate = round1((outputKg / wok.feedKg) * 100);
      const endedAt = input.endedAt || new Date().toISOString();
      const batchId = uid('batch');
      // 收锅同事务生成工序记录：批号沿用锅次号，wokId 双向对应，留样台账据此显示同一锅次
      const batch: ProcessBatch = {
        id: batchId,
        batchNo: wok.wokNo,
        herbId: wok.herbId,
        methodId: wok.methodId,
        feedKg: wok.feedKg,
        auxUsedKg: round2(Number(input.auxUsedKg) || 0),
        fireLevel: wok.fireLevel as FireLevel,
        startedAt: wok.startedAt,
        endedAt,
        yieldRate,
        degree: input.degree,
        operator: input.finishOperator.trim(),
        locked: true,
        lockedAt: new Date().toISOString(),
        wokId: wok.id,
        remark: input.finishNote?.trim() || undefined,
      };

      const next: WokBatch = {
        ...wok,
        status: 'finished',
        revision: wok.revision + 1,
        endedAt,
        outputKg,
        auxUsedKg: round2(Number(input.auxUsedKg) || 0),
        yieldRate,
        degree: input.degree,
        finishOperator: input.finishOperator.trim(),
        finishNote: input.finishNote?.trim() || undefined,
        processBatchId: batchId,
        locked: true,
      };

      await db.batches.put(batch);
      await db.wokBatches.put(next);
      return { wok: next, batch };
    });

    await get().hydrate();
    // 工序记录同事务落库，通知本页与其他标签页刷新
    emitLocal('batches');
    broadcastChange('woks');
    broadcastChange('batches');
    return result;
  },

  registerAbnormal: async (input) => {
    const reason = input.reason.trim();
    if (!reason) {
      throw new WokMutationError('invalid-method', '请填写异常原因');
    }
    const result = await db.transaction('rw', db.wokBatches, async () => {
      const wok = await db.wokBatches.get(input.wokId);
      if (!wok) {
        throw new WokMutationError('not-found', '锅次不存在');
      }
      if (wok.status === 'voided') {
        throw new WokMutationError('voided', `锅次 ${wok.wokNo} 已作废，不能再登记异常`, wok);
      }
      // 异常登记为纯追加：并发两笔都会保留；追加后修订号 +1，打开中的收锅提交将被拦下
      const record: AbnormalRecord = { id: uid('abn'), at: new Date().toISOString(), reason, operator: input.operator.trim() };
      const next: WokBatch = { ...wok, abnormals: [...wok.abnormals, record], revision: wok.revision + 1 };
      await db.wokBatches.put(next);
      return next;
    });

    await get().hydrate();
    broadcastChange('woks');
    return result;
  },

  voidWok: async (input) => {
    const result = await db.transaction('rw', [db.wokBatches, db.batches, db.samples], async () => {
      const wok = await db.wokBatches.get(input.wokId);
      if (!wok) {
        throw new WokMutationError('not-found', '锅次不存在');
      }
      if (wok.status === 'voided') {
        throw new WokMutationError('voided', `锅次 ${wok.wokNo} 已作废`, wok);
      }
      // 留样台账按收锅生成的工序记录挂接；已产生留样则禁止作废
      if (wok.processBatchId) {
        const sampleCount = await db.samples.where('batchId').equals(wok.processBatchId).count();
        if (sampleCount > 0) {
          throw new WokMutationError(
            'has-samples',
            `锅次 ${wok.wokNo} 已产生 ${sampleCount} 份留样，不能作废，只能登记异常原因`,
            wok,
          );
        }
      }

      const at = new Date().toISOString();
      const next: WokBatch = {
        ...wok,
        status: 'voided',
        revision: wok.revision + 1,
        voidedAt: at,
        voidOperator: input.operator.trim(),
        voidReason: input.reason.trim() || undefined,
      };
      await db.wokBatches.put(next);
      // 收锅后未留样的锅次作废：连带删除收锅时生成的工序记录，保持台账一致
      if (wok.processBatchId) {
        await db.batches.delete(wok.processBatchId);
      }
      return next;
    });

    await get().hydrate();
    emitLocal('batches');
    broadcastChange('woks');
    broadcastChange('batches');
    return result;
  },

  upsertDraft: async (input) => {
    const sessionId = get().sessionId;
    // 同一会话、同一槽位（开工/某锅次接手/某锅次收锅）只有一份草稿，自动保存时覆盖
    const id = input.id ?? `draft-${sessionId}-${input.kind}-${input.wokId ?? input.pot ?? 'new'}`;
    const draft: WokDraft = {
      id,
      kind: input.kind,
      wokId: input.wokId,
      pot: input.pot,
      baseRevision: input.baseRevision,
      payload: input.payload,
      sessionId,
      updatedAt: new Date().toISOString(),
    };
    await db.wokDrafts.put(draft);
    const drafts = await db.wokDrafts.orderBy('updatedAt').reverse().toArray();
    set({ drafts });
    return draft;
  },

  deleteDraft: async (id) => {
    await db.wokDrafts.delete(id);
    set({ drafts: get().drafts.filter((d) => d.id !== id) });
  },

  getDraft: (id) => get().drafts.find((d) => d.id === id),

  runningWoks: () => get().woks.filter((w) => w.status === 'running'),

  occupiedPots: () => get().woks.filter((w) => w.status === 'running').map((w) => w.pot),
}));
