import { useCallback, useEffect, useRef } from 'react';
import { saveDraft, removeDraft, type PotDraft, type PotDraftType } from '../utils/pot-draft';

export interface UsePotDraftArgs<T> {
  draftId: string;
  type: PotDraftType;
  potRoundId?: string;
  /** 返回当前表单值；undefined 时不保存 */
  getPayload: () => T | undefined;
}

/**
 * 锅次表单草稿：
 * - 表单内容变化即写入 localStorage（防抖），浏览器被关掉也不丢；
 * - 提交成功或主动放弃时清除（discard 后即便弹窗卸载也不会再写回）；
 * - 并发冲突落败时调用 markConflict，草稿带上冲突标记，恢复后醒目提示。
 */
export function usePotDraft<T>({ draftId, type, potRoundId, getPayload }: UsePotDraftArgs<T>) {
  const timer = useRef<number | undefined>(undefined);
  const getPayloadRef = useRef(getPayload);
  const dead = useRef(false);
  getPayloadRef.current = getPayload;

  const persist = useCallback(
    (conflict?: { message: string }) => {
      if (dead.current) {
        return;
      }
      const payload = getPayloadRef.current();
      if (payload === undefined) {
        return;
      }
      const existing = readFor(draftId);
      const draft: PotDraft<T> = {
        id: draftId,
        type,
        potRoundId,
        conflict: Boolean(conflict) || existing?.conflict,
        conflictMessage: conflict ? conflict.message : existing?.conflictMessage,
        savedAt: new Date().toISOString(),
        payload,
      };
      saveDraft(draft);
    },
    [draftId, type, potRoundId],
  );

  // 打开弹窗先落一笔；卸载时再落一次（页面/浏览器突然关闭的兜底）
  useEffect(() => {
    dead.current = false;
    persist();
    return () => {
      window.clearTimeout(timer.current);
      persist();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  const schedulePersist = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => persist(), 400);
  }, [persist]);

  const markConflict = useCallback(
    (message: string) => {
      window.clearTimeout(timer.current);
      persist({ message });
    },
    [persist],
  );

  const discard = useCallback(() => {
    dead.current = true;
    window.clearTimeout(timer.current);
    removeDraft(draftId);
  }, [draftId]);

  return { schedulePersist, markConflict, discard };
}

function readFor(id: string): PotDraft | undefined {
  try {
    const raw = localStorage.getItem('gbherbprocess-pot-drafts');
    if (!raw) return undefined;
    const all = JSON.parse(raw) as PotDraft[];
    return all.find((d) => d.id === id);
  } catch {
    return undefined;
  }
}
