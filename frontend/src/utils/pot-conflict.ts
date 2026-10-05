/**
 * 锅次写入冲突：两个页面（或两个页签）同时提交同一笔操作时，
 * 只有先写入的一笔成功，后到的页面收到此错误，表单保留为草稿并提示冲突。
 */
export type PotConflictCode =
  | 'POT_OCCUPIED' // 开工抢锅：锅位已被在锅锅次占用
  | 'VERSION_STALE' // 接手/收锅：提交基于旧版本，期间已有别人写入
  | 'ROUND_NOT_ACTIVE' // 锅次已被收锅/作废
  | 'ROUND_NO_DUP'; // 锅次号撞号（兜底）

export class PotConflictError extends Error {
  code: PotConflictCode;
  /** 冲突对象（锅位号 / 锅次号 / 锅次 id） */
  target: string;
  /** 冲突时的最新版本（VERSION_STALE 时存在） */
  latestVersion?: number;

  constructor(code: PotConflictCode, target: string, latestVersion?: number, message?: string) {
    super(message ?? defaultMessage(code, target));
    this.name = 'PotConflictError';
    this.code = code;
    this.target = target;
    this.latestVersion = latestVersion;
  }
}

function defaultMessage(code: PotConflictCode, target: string): string {
  switch (code) {
    case 'POT_OCCUPIED':
      return `锅位 ${target} 已被另一口在锅锅次占用，只有先写入的开工生效，本次内容已保留为草稿`;
    case 'VERSION_STALE':
      return `该锅次刚有新的交接写入（目标：${target}），请按最新记录核对后再提交，本次内容已保留为草稿`;
    case 'ROUND_NOT_ACTIVE':
      return `锅次 ${target} 已收锅或已作废，不能再写入交接/收锅记录，本次内容已保留为草稿`;
    case 'ROUND_NO_DUP':
      return `锅次号 ${target} 已存在，请换一个锅次号后重试`;
  }
}

/** 判断是否为唯一索引冲突（IndexedDB ConstraintError，Dexie 包装） */
export function isConstraintError(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name;
  return name === 'ConstraintError' || (error as { inner?: { name?: string } })?.inner?.name === 'ConstraintError';
}
