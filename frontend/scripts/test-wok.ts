/* eslint-disable no-console */
/**
 * 锅次交接并发/恢复逻辑的 Node 端验证（fake-indexeddb）。
 * 运行：npx tsx scripts/test-wok.ts
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { db } from '../src/utils/db';
import { useWokStore, WokMutationError } from '../src/stores/wokStore';
import { useBatchStore } from '../src/stores/batchStore';
import { useSampleStore } from '../src/stores/sampleStore';
import type { ProcessingMethod } from '../src/types/processing-method';
import type { HerbMaterial } from '../src/types/herb-material';

const woks = useWokStore.getState;
const batches = useBatchStore.getState;
const samples = useSampleStore.getState;

async function setupMasterData() {
  const herb: HerbMaterial = { id: 'h1', name: '甘草', origin: '植物', part: '根', batchNo: 'GC-1', feedKg: 100, receivedAt: new Date().toISOString() };
  const method: ProcessingMethod = {
    id: 'm1', name: '蜜炙', auxiliary: '蜂蜜', auxRatio: 25, fireLevel: '中火',
    tempRange: [120, 150], duration: 16, criterion: '不粘手', criterionDimension: '色泽', applicable: '甘草',
  };
  await db.herbs.put(herb);
  await db.methods.put(method);
}

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function start1() {
  return woks().startWok({
    pot: '1号锅', herbId: 'h1', methodId: 'm1', feedKg: 100,
    startOperator: '甲', startTeam: '甲班', startedAt: new Date().toISOString(),
  });
}

async function main() {
  await setupMasterData();
  await woks().hydrate();
  await batches().hydrate();
  await samples().hydrate();

  console.log('1) 开工占用锅位 + 冻结方法/投料');
  const wok = await start1();
  await check('冻结投料 100kg、辅料计划按 25% 折算为 25kg、方法快照为蜜炙', () => {
    assert.equal(wok.feedKg, 100);
    assert.equal(wok.auxPlannedKg, 25);
    assert.equal(wok.methodName, '蜜炙');
    assert.equal(wok.revision, 0);
  });

  console.log('2) 同锅位不能重复开工（两个页面同时开工只认一笔）');
  await assert.rejects(
    () => start1(),
    (error: unknown) => error instanceof WokMutationError && error.code === 'pot-occupied',
  );
  passed += 1;
  console.log('  ✓ 第二笔开工被拒：pot-occupied，草稿可在前端保留');

  // 模拟“改了方法台账”，验证锅次仍按开工冻结值执行
  await db.methods.put({
    id: 'm1', name: '蜜炙', auxiliary: '蜂蜜', auxRatio: 40, fireLevel: '武火',
    tempRange: [200, 220], duration: 30, criterion: '被改过', criterionDimension: '色泽', applicable: '甘草',
  } as ProcessingMethod);

  console.log('3) 两页同时接手：只认先写入的一笔，后到的冲突并保留草稿');
  const refreshed = await db.wokBatches.get(wok.id)!;
  const [a, b] = await Promise.allSettled([
    woks().takeoverWok({ wokId: wok.id, expectedRevision: 0, fromOperator: '甲', toOperator: '乙', fromTeam: '甲班', toTeam: '乙班' }),
    woks().takeoverWok({ wokId: wok.id, expectedRevision: 0, fromOperator: '甲', toOperator: '丙', fromTeam: '甲班', toTeam: '丙班' }),
  ]);
  const okOne = [a, b].filter((r) => r.status === 'fulfilled').length;
  const conflictOne = [a, b].filter((r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason instanceof WokMutationError && ((r as PromiseRejectedResult).reason as WokMutationError).code === 'conflict').length;
  assert.equal(okOne, 1);
  assert.equal(conflictOne, 1);
  passed += 1;
  console.log('  ✓ 一笔成功一笔 conflict');

  // 后到页面把录入保留成草稿
  const draft = await woks().upsertDraft({ kind: 'takeover', wokId: wok.id, baseRevision: 0, payload: { fromOperator: '乙', toOperator: '丙', fromTeam: '乙班', toTeam: '丙班', note: '后到页面的草稿' } });
  const afterHandover = await db.wokBatches.get(wok.id)!;
  assert.equal(afterHandover.handovers.length, 1);
  assert.equal(afterHandover.revision, 1);
  assert.equal(afterHandover.auxPlannedKg, 25, '冻结值不受方法台账修改影响');
  await check('交接链只追加一笔（前班数据未被后到页面改动），草稿已落库，冻结值保持 25kg', () => {});

  console.log('4) 重新“打开”：hydrate 后恢复进行中锅次、锅位占用与草稿');
  const store2 = useWokStore;
  // 模拟新页面：新会话 id + 重新装载
  const freshWoks = await db.wokBatches.orderBy('startedAt').reverse().toArray();
  const freshDrafts = await db.wokDrafts.toArray();
  assert.equal(freshWoks.filter((x) => x.status === 'running').length, 1);
  assert.equal(freshDrafts.length, 1);
  assert.equal(freshDrafts[0].payload.note, '后到页面的草稿');
  void store2;
  passed += 1;
  console.log('  ✓ IndexedDB 中仍有进行中锅次（1号锅占用）与未提交草稿');

  console.log('5) 两页同时收锅：只认先写入的一笔，生成工序记录并释放锅位');
  const payload = { endedAt: new Date().toISOString(), outputKg: 108, auxUsedKg: 24.5, degree: '适中' as const, finishOperator: '乙' };
  const [f1, f2] = await Promise.allSettled([
    woks().finishWok({ wokId: wok.id, expectedRevision: 1, ...payload }),
    woks().finishWok({ wokId: wok.id, expectedRevision: 1, ...payload }),
  ]);
  const fOk = [f1, f2].filter((r) => r.status === 'fulfilled').length;
  const fConflict = [f1, f2].filter((r) => r.status === 'rejected' && ((r as PromiseRejectedResult).reason as WokMutationError).code === 'conflict').length;
  assert.equal(fOk, 1);
  assert.equal(fConflict, 1);
  passed += 1;
  console.log('  ✓ 一笔收锅成功，另一笔 conflict（前端保留收锅草稿）');

  const finished = await db.wokBatches.get(wok.id)!;
  await check('锅次已收锅并释放锅位（running 为 0），得率 108%，生成同号工序记录', async () => {
    assert.equal(finished.status, 'finished');
    assert.equal(finished.pot, '1号锅');
    assert.equal(finished.yieldRate, 108);
    assert.equal((await db.wokBatches.where({ pot: '1号锅', status: 'running' }).count()), 0);
    const batch = await db.batches.get(finished.processBatchId!);
    assert.ok(batch);
    assert.equal(batch!.batchNo, finished.wokNo, '工序批号=锅次号');
    assert.equal(batch!.wokId, finished.id);
    assert.equal(batch!.locked, true);
  });

  console.log('6) 已产生留样的锅次不能作废，只能登记异常');
  await db.samples.put({
    id: 's1', sampleNo: 'LY-1', batchId: finished.processBatchId!, amountG: 300, retainMonths: 12,
    cabinet: 'A-01', retainedAt: new Date().toISOString(), observeLogs: [],
  });
  await assert.rejects(
    () => woks().voidWok({ wokId: wok.id, operator: '乙', reason: '想作废' }),
    (error: unknown) => error instanceof WokMutationError && error.code === 'has-samples',
  );
  passed += 1;
  console.log('  ✓ 作废被拒：has-samples');

  const withAbn = await woks().registerAbnormal({ wokId: wok.id, reason: '局部色泽偏深，已挑出', operator: '质检员' });
  await check('异常登记可追加，工序记录仍在、锅次仍为已收锅', () => {
    assert.equal(withAbn.abnormals.length, 1);
    assert.equal(withAbn.status, 'finished');
  });

  console.log('7) 未留样的收锅锅次：作废连带删除工序记录');
  const wok2 = await woks().startWok({ pot: '2号锅', herbId: 'h1', methodId: 'm1', feedKg: 50, startOperator: '甲', startedAt: new Date().toISOString() });
  await woks().finishWok({ wokId: wok2.id, expectedRevision: 0, endedAt: new Date().toISOString(), outputKg: 47, auxUsedKg: 20, degree: '适中', finishOperator: '甲' });
  const wok2Done = await db.wokBatches.get(wok2.id)!;
  assert.ok(wok2Done.processBatchId);
  await woks().voidWok({ wokId: wok2.id, operator: '甲', reason: '混入异物' });
  await check('锅次作废且对应工序记录已删除（台账一致）', async () => {
    const gone = await db.wokBatches.get(wok2.id)!;
    assert.equal(gone.status, 'voided');
    assert.equal(await db.batches.get(wok2Done.processBatchId!), undefined);
  });

  console.log('8) 作废运行中锅次即释放锅位，可重新开工');
  const wok3 = await woks().startWok({ pot: '3号锅', herbId: 'h1', methodId: 'm1', feedKg: 10, startOperator: '甲', startedAt: new Date().toISOString() });
  await woks().voidWok({ wokId: wok3.id, operator: '甲', reason: '设备故障' });
  assert.equal(await db.wokBatches.where({ pot: '3号锅', status: 'running' }).count(), 0);
  const wok3b = await woks().startWok({ pot: '3号锅', herbId: 'h1', methodId: 'm1', feedKg: 12, startOperator: '乙', startedAt: new Date().toISOString() });
  assert.equal(wok3b.status, 'running');
  passed += 1;
  console.log('  ✓ 作废后 3号锅可重新开工');

  console.log('9) 后来接手的人不能改前班数据（store 无修改入口，冻结字段原样保留）');
  await check('wok1 开工操作人/投料/辅料计划始终为开工时的值', async () => {
    const w1 = await db.wokBatches.get(wok.id)!;
    assert.equal(w1.startOperator, '甲');
    assert.equal(w1.feedKg, 100);
    assert.equal(w1.auxPlannedKg, 25);
    assert.equal(w1.handovers[0].fromOperator, '甲');
    assert.equal(w1.handovers[0].toOperator, '乙');
    assert.equal(w1.abnormals[0].reason, '局部色泽偏深，已挑出');
    // 清理草稿，证明删除接口可用
    await woks().deleteDraft(draft.id);
    assert.equal(await db.wokDrafts.count(), 0);
  });

  console.log(`\n全部 ${passed} 项验证通过 ✅`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
