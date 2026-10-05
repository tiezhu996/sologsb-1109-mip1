/**
 * 锅次数据跨页签同步：
 * 纯本地 IndexedDB 在同源页签间共享，但 Zustand 内存状态各自独立。
 * 任一写操作提交后广播变更，其余页签收到即重新装载锅次；
 * 页面重新获得焦点时也做一次兜底刷新，保证「两个页面同时操作」时后到页面看到先写入的一笔。
 */
const CHANNEL_NAME = 'gbherbprocess-pot-changes';

export type PotChangeKind = 'start' | 'handover' | 'close' | 'anomaly' | 'void' | 'sample-linked';

export interface PotChangeMessage {
  kind: PotChangeKind;
  potRoundId?: string;
  at: string;
}

let channel: BroadcastChannel | undefined;
try {
  channel = new BroadcastChannel(CHANNEL_NAME);
} catch {
  channel = undefined;
}

export function broadcastPotChange(message: Omit<PotChangeMessage, 'at'>): void {
  const payload: PotChangeMessage = { ...message, at: new Date().toISOString() };
  channel?.postMessage(payload);
}

/** 订阅其他页签的锅次变更；返回取消订阅函数 */
export function subscribePotChanges(handler: (message: PotChangeMessage) => void): () => void {
  if (!channel) {
    return () => undefined;
  }
  const listener = (event: MessageEvent<PotChangeMessage>) => handler(event.data);
  channel.addEventListener('message', listener);

  let pageVisible = document.visibilityState === 'visible';
  const onVisibility = () => {
    if (document.visibilityState === 'visible' && !pageVisible) {
      handler({ kind: 'close', at: new Date().toISOString() });
    }
    pageVisible = document.visibilityState === 'visible';
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    channel?.removeEventListener('message', listener);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
