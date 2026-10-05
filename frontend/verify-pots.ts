// 锅次交接核心规则的 Node 验证（fake-indexeddb，模拟两个页面同时提交/重开恢复）
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const idbFactory = new IDBFactory();
(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = idbFactory;
(globalThis as unknown as { IDBKeyRange: typeof IDBKeyRange }).IDBKeyRange = IDBKeyRange;
class BroadcastChannelSham {
  name: string;
  onmessage: ((e: MessageEvent) => void) | null = null;
  static channels = new Map<string, BroadcastChannelSham[]>();
  constructor(name: string) {
    this.name = name;
    const list = BroadcastChannelSham.channels.get(name) ?? [];
    list.push(this);
    BroadcastChannelSham.channels.set(name, list);
  }
  postMessage(data: unknown) {
    for (const c of BroadcastChannelSham.channels.get(this.name) ?? []) {
      if (c !== this) {
        queueMicrotask(() => c.onmessage?.({ data } as MessageEvent));
      }
    }
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}
(globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel =
  BroadcastChannelSham as unknown as typeof BroadcastChannel;
(globalThis as unknown as { localStorage: Storage }).localStorage = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
})();

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${msg}`);
  }
}

async function main() {
  const { db } = await import('./src/utils/db');
  const { usePotStore } = await import('./src/stores/potStore');
  const { useHerbStore } = await import('./src/stores/herbStore');
  const { useMethodStore } = await import('./src/stores/methodStore');
  const { useSampleStore } = await import('./src/stores/sampleStore');
  const { PotConflictError } = await import('./src/utils/pot-conflict');
  const { uid } = await import('./src/utils/id');

  const herb = await useHerbStore.getState().addHerb({ name: '测试白术', origin: '植物', part: '根', batchNo: 'T-001', feedKg: 100 });
  await useMethodStore.getState().hydrate();
  if (!useMethodStore.getState().methods.length) {
    await useMethodStore.getState().addMethod({
      name: '麸炒',
      auxiliary: '麦麸',
      auxRatio: 10,
      fireLevel: '中火',
      tempRange: [130, 160],
      duration: 10,
      criterion: '色转深黄、无焦斑',
      criterionDimension: '色泽',
      applicable: '测试药材',
    });
  }
  const methodId = useMethodStore.getState().methods[0].id;

  console.log('\n① 开工占用锅位并冻结方法/投料');
  const start = await usePotStore.getState().startRound({
    potNo: '1号锅',
    herbId: herb.id,
    batchNo: 'PZ-T-1',
    methodId,
    feedKg: 100,
    startOperator: '甲班',
    startedAt: new Date().toISOString(),
    potTemp: 130,
  });
  assert(start.status === '在锅', `锅次状态在锅（${start.potRoundNo}）`);
  assert(start.activePot === '1号锅#active', 'activePot 占用标记已写入唯一索引');
  assert(start.frozen.feedKg === 100, `投料量冻结为 100kg（实际 ${start.frozen.feedKg}）`);
  assert(Math.abs(start.frozen.auxPlannedKg - 10) < 0.001, `辅料计划按开工时比例冻结 10kg（实际 ${start.frozen.auxPlannedKg}）`);

  console.log('\n② 两个页面同时开工抢同一锅位：只认先写入的一笔');
  // 改方法台账的比例，验证锅次快照不随后续改动变化
  const originalRatio = useMethodStore.getState().methods.find((x) => x.id === methodId)!.auxRatio;
  await useMethodStore.getState().updateMethod(methodId, { auxRatio: 99 });
  assert(usePotStore.getState().roundById(start.id)!.frozen.auxRatio === originalRatio, '方法台账改动后，已冻结锅次快照不变');
  await useMethodStore.getState().updateMethod(methodId, { auxRatio: originalRatio });

  const dupResults = await Promise.allSettled([
    usePotStore.getState().startRound({
      potNo: '2号锅',
      herbId: herb.id,
      batchNo: 'DUP-A',
      methodId,
      feedKg: 50,
      startOperator: '抢锅页A',
      startedAt: new Date().toISOString(),
      potTemp: 100,
    }),
    usePotStore.getState().startRound({
      potNo: '2号锅',
      herbId: herb.id,
      batchNo: 'DUP-B',
      methodId,
      feedKg: 60,
      startOperator: '抢锅页B',
      startedAt: new Date().toISOString(),
      potTemp: 100,
    }),
  ]);
  const rejectedStarts = dupResults.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  rejectedStarts.forEach((r) => {
    const e = r.reason as { code?: string; message?: string };
    console.log('   被拒原因：', e.code ?? (r.reason as Error)?.name, e.message ?? '');
  });
  assert(rejectedStarts.length === 1, `并发两笔只有一笔被拒（被拒 ${rejectedStarts.length} 笔）`);
  const loser = rejectedStarts[0]?.reason;
  assert(loser instanceof PotConflictError && (loser as PotConflictError).code === 'POT_OCCUPIED', '后到页面收到 POT_OCCUPIED 冲突错误');
  const activeOnPot2 = (await db.potRounds.where('activePot').equals('2号锅#active').toArray()).length;
  assert(activeOnPot2 === 1, '库里 2 号锅只落入一口在锅锅次（先写入的一笔）');

  console.log('\n③ 换班接手只追加，且并发接手只认先写入的一笔');
  await usePotStore.getState().handover(start.id, {
    fromOperator: '甲班',
    toOperator: '乙班',
    at: new Date().toISOString(),
    potTemp: 140,
    fireLevel: '中火',
    note: '正常交接',
    basedOnVersion: 1,
  });
  const afterHandover = usePotStore.getState().roundById(start.id)!;
  assert(afterHandover.version === 2, `接手后版本 1→2（实际 v${afterHandover.version}）`);
  assert(afterHandover.handovers.length === 2 && afterHandover.handovers[1].toOperator === '乙班', '接手记录已追加为第 2 条');
  assert(afterHandover.frozen.feedKg === 100, '追加接手未改动冻结投料');

  const clashResults = await Promise.allSettled([
    usePotStore.getState().handover(start.id, {
      fromOperator: '乙班',
      toOperator: '丙班X',
      at: new Date().toISOString(),
      potTemp: 145,
      fireLevel: '中火',
      note: '页面X的接手',
      basedOnVersion: 2,
    }),
    usePotStore.getState().handover(start.id, {
      fromOperator: '乙班',
      toOperator: '丙班Y',
      at: new Date().toISOString(),
      potTemp: 148,
      fireLevel: '中火',
      note: '页面Y的接手',
      basedOnVersion: 2,
    }),
  ]);
  const handoverRejected = clashResults.filter((r) => r.status === 'rejected');
  assert(handoverRejected.length === 1, `两页同时接手只成功一笔（被拒 ${handoverRejected.length} 笔）`);
  const reason = (handoverRejected[0] as PromiseRejectedResult).reason;
  assert(reason instanceof PotConflictError && reason.code === 'VERSION_STALE', '后到页面收到 VERSION_STALE（保留草稿、显示冲突）');
  const finalRound = usePotStore.getState().roundById(start.id)!;
  assert(finalRound.version === 3 && finalRound.handovers.length === 3, `先写入的一笔生效（v${finalRound.version}, 记录 ${finalRound.handovers.length} 条）`);

  console.log('\n④ 收锅释放锅位、生成已锁定工序记录；旧版本收锅冲突');
  const staleClose = usePotStore
    .getState()
    .closeRound(start.id, {
      operator: '丙班',
      endedAt: new Date().toISOString(),
      outputKg: 95,
      temp: 150,
      duration: 10,
      auxUsedKg: 10,
      degree: '适中',
      basedOnVersion: 2,
    })
    .then(
      () => 'resolved',
      (e: unknown) => (e instanceof PotConflictError ? e.code : 'other'),
    );
  assert((await staleClose) === 'VERSION_STALE', '基于旧版本的收锅被拒为 VERSION_STALE');

  const closed = await usePotStore.getState().closeRound(start.id, {
    operator: finalRound.handovers[finalRound.handovers.length - 1].toOperator,
    endedAt: new Date().toISOString(),
    outputKg: 95,
    temp: 150,
    duration: 10,
    auxUsedKg: 10,
    degree: '适中',
    basedOnVersion: 3,
  });
  assert(closed.status === '已收锅' && closed.activePot === undefined && closed.potNo === undefined, '收锅后 activePot/potNo 清除（锅位释放）');
  assert(Boolean(closed.batchRecordId), '收锅生成了工序记录 id');
  const batch = await db.batches.get(closed.batchRecordId!);
  assert(Boolean(batch?.locked), '工序记录已锁定（定稿）');
  assert(batch?.potRoundNo === closed.potRoundNo && batch?.potRoundId === closed.id, '工序记录带同一锅次号');
  const stillFree = (await db.potRounds.where('activePot').equals('1号锅#active').toArray()).length;
  assert(stillFree === 0, '1号锅可重新开工');

  console.log('\n⑤ 已收锅锅次不能再接手；已产生留样的锅次不能作废，只能登记异常');
  const lateHandover = await usePotStore
    .getState()
    .handover(start.id, {
      fromOperator: 'x',
      toOperator: 'y',
      at: new Date().toISOString(),
      potTemp: 1,
      fireLevel: '文火',
      note: '收锅后的接手',
      basedOnVersion: closed.version,
    })
    .then(
      () => 'resolved',
      (e: unknown) => (e instanceof PotConflictError ? e.code : 'other'),
    );
  assert(lateHandover === 'ROUND_NOT_ACTIVE', '收锅后的接手被拒为 ROUND_NOT_ACTIVE');

  await useSampleStore.getState().createSample({
    sampleNo: 'LY-T-1',
    batchId: batch!.id,
    potRoundId: closed.id,
    potRoundNo: closed.potRoundNo,
    amountG: 300,
    retainMonths: 12,
    cabinet: 'A-01',
  });
  const withSample = usePotStore.getState().roundById(start.id)!;
  assert(withSample.sampleIds.length === 1, '留样已回挂到锅次');
  const voidAttempt = await usePotStore
    .getState()
    .voidRound(start.id, { operator: '丙班', reason: '想作废', basedOnVersion: withSample.version })
    .then(
      () => 'resolved',
      (e: Error) => e.message,
    );
  assert(String(voidAttempt).includes('不能作废'), `有留样锅次的作废被拒（${voidAttempt}）`);
  await usePotStore.getState().reportAnomaly(start.id, {
    operator: '质检员',
    reason: '留样观察色泽偏深',
    action: '继续观察并加检',
    basedOnVersion: withSample.version,
  });
  const afterAnomaly = usePotStore.getState().roundById(start.id)!;
  assert(afterAnomaly.anomalies.length === 1 && afterAnomaly.status === '已收锅', '异常原因只追加，锅次仍为已收锅');
  const sampleRow = await db.samples.where('potRoundNo').equals(closed.potRoundNo).first();
  assert(sampleRow?.potRoundNo === closed.potRoundNo, '留样台账按同一锅次号可查到留样');

  console.log('\n⑥ 无留样的在锅锅次可作废并释放锅位');
  const r2 = await usePotStore.getState().startRound({
    potNo: '4号锅',
    herbId: herb.id,
    batchNo: 'PZ-T-2',
    methodId,
    feedKg: 40,
    startOperator: '丁班',
    startedAt: new Date().toISOString(),
    potTemp: 130,
  });
  await usePotStore.getState().voidRound(r2.id, { operator: '丁班', reason: '药材变质中止', basedOnVersion: 1 });
  const voided = usePotStore.getState().roundById(r2.id)!;
  assert(voided.status === '已作废' && voided.activePot === undefined, '作废后状态变更且锅位释放');
  assert(Boolean(voided.void?.reason), '作废原因已记录');

  console.log('\n⑦ 浏览器重开：从 IndexedDB 恢复未完成锅次与锅位占用');
  const r3 = await usePotStore.getState().startRound({
    potNo: '3号锅',
    herbId: herb.id,
    batchNo: 'PZ-T-3',
    methodId,
    feedKg: 70,
    startOperator: '戊班',
    startedAt: new Date().toISOString(),
    potTemp: 135,
  });
  // 模拟重开：新库连接 + 全新 store hydration（store 单例清内存）
  usePotStore.setState({ rounds: [], hydrated: false });
  await usePotStore.getState().hydrate();
  const restored = usePotStore.getState().roundById(r3.id);
  assert(Boolean(restored) && restored!.status === '在锅' && restored!.potNo === '3号锅', '重开后未完成锅次恢复且仍占用 3 号锅');
  const occ = (await db.potRounds.where('activePot').equals('3号锅#active').count());
  assert(occ === 1, '锅位占用在重开后仍可从库中查到');

  console.log(`\n${failures === 0 ? '🎉 全部通过' : `⚠️ ${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
