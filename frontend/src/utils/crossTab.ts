/**
 * 跨标签页数据变更通知。
 *
 * 锅次交接场景下常有两个页面同时操作：A 页先写入后，B 页必须立刻看到
 * 最新的锅位占用、修订号与交接链，否则会基于过期数据继续提交。
 * 首选 BroadcastChannel（同源多标签页），不支持时退化为 localStorage storage 事件。
 */
export type StoreChangeKind = 'woks' | 'batches' | 'samples';

const CHANNEL_NAME = 'gbherbprocess-store-changes';
const STORAGE_KEY = 'gbherbprocess-store-changes';

interface ChangeMessage {
  kind: StoreChangeKind;
  at: number;
}

type Listener = (kind: StoreChangeKind) => void;

let channel: BroadcastChannel | null = null;
const listeners = new Set<Listener>();
/** 本标签页刚发出的消息标记，避免 storage 事件回环（storage 事件本页不触发，仅作兜底） */
let lastSent = 0;

function notify(kind: StoreChangeKind): void {
  listeners.forEach((listener) => listener(kind));
}

if (typeof window !== 'undefined') {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<ChangeMessage>) => {
      notify(event.data.kind);
    };
  } else {
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) {
        return;
      }
      try {
        const message = JSON.parse(event.newValue) as ChangeMessage;
        notify(message.kind);
      } catch {
        // 忽略无法解析的兜底消息
      }
    });
  }
}

/** 广播本标签页发生了一次写入，让其他标签页重新装载对应数据 */
export function broadcastChange(kind: StoreChangeKind): void {
  lastSent = Date.now();
  const message: ChangeMessage = { kind, at: lastSent };
  if (channel) {
    channel.postMessage(message);
    return;
  }
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(message));
  }
}

/**
 * 通知本标签页的其他 store 重新装载。
 * 例如锅次收锅在同一事务写入了工序记录，batchStore 需要立即刷新，
 * 而 BroadcastChannel 消息不会回送本页、storage 事件本页也不触发。
 */
export function emitLocal(kind: StoreChangeKind): void {
  notify(kind);
}

/** 订阅其他标签页的写入通知（返回取消订阅函数） */
export function subscribeStoreChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 页面重新可见时也应核对一次（兜底 BroadcastChannel 丢失的极端情况） */
export function onVisible(callback: () => void): () => void {
  if (typeof document === 'undefined') {
    return () => undefined;
  }
  const handler = () => {
    if (!document.hidden) {
      callback();
    }
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}
