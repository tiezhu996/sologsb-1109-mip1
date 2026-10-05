/**
 * 锅次交接草稿（localStorage）：
 * - 后到的并发提交冲突时，表单内容保留为草稿并显示冲突；
 * - 写入失败（含浏览器被关掉）后重新打开，从草稿恢复未完成的接手/收锅/异常登记；
 * - 开工记录也持久化：恢复时连同 IndexedDB 中已经落库的锅位占用一起还原现场。
 */
export type PotDraftType = 'start' | 'handover' | 'close' | 'anomaly';

export interface PotDraft<T = unknown> {
  id: string;
  type: PotDraftType;
  /** start 草稿无关联锅次；其余为 potRoundId */
  potRoundId?: string;
  /** 冲突标记：因并发落败而保留的草稿，恢复时醒目提示冲突 */
  conflict?: boolean;
  conflictMessage?: string;
  savedAt: string;
  payload: T;
}

const STORAGE_KEY = 'gbherbprocess-pot-drafts';

function readAll(): PotDraft[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PotDraft[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(drafts: PotDraft[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
}

export function saveDraft<T>(draft: PotDraft<T>): void {
  const drafts = readAll().filter((d) => d.id !== draft.id);
  drafts.push(draft as PotDraft);
  writeAll(drafts);
}

export function removeDraft(id: string): void {
  writeAll(readAll().filter((d) => d.id !== id));
}

/** 冲突后「载入最新锅次重提」：保留草稿内容，仅清除冲突标记 */
export function clearDraftConflict(id: string): PotDraft | undefined {
  const drafts = readAll();
  const target = drafts.find((d) => d.id === id);
  if (!target) return undefined;
  const cleared: PotDraft = { ...target, conflict: false, conflictMessage: undefined };
  writeAll(drafts.map((d) => (d.id === id ? cleared : d)));
  return cleared;
}

export function listDrafts(): PotDraft[] {
  return readAll().sort((a, b) => a.savedAt.localeCompare(b.savedAt));
}

/** 某口锅次（或开工）当前保留的草稿 */
export function draftsFor(type: PotDraftType, potRoundId?: string): PotDraft[] {
  return readAll().filter((d) => d.type === type && d.potRoundId === potRoundId);
}

/** 开工草稿固定 id，同一时刻只保留一份 */
export const START_DRAFT_ID = 'draft-start';

export function startDraft(): PotDraft | undefined {
  return readAll().find((d) => d.id === START_DRAFT_ID);
}

/** 某口锅次最近一份冲突草稿（恢复时弹冲突提示） */
export function latestConflictDraft(): PotDraft | undefined {
  return readAll()
    .filter((d) => d.conflict)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0];
}
