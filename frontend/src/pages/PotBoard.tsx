import { useEffect, useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Popconfirm, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { FireOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import PotGrid from '../components/common/PotGrid';
import PotRoundDrawer from '../components/pot/PotRoundDrawer';
import { StartPotModal, HandoverModal, CloseModal, AnomalyModal, VoidModal } from '../components/pot/PotRoundModals';
import StatBadge from '../components/common/StatBadge';
import { usePotStore } from '../stores/potStore';
import { useHerbStore } from '../stores/herbStore';
import { useMethodStore } from '../stores/methodStore';
import { useSampleStore } from '../stores/sampleStore';
import { subscribePotChanges } from '../utils/pot-sync';
import { listDrafts, removeDraft, clearDraftConflict, type PotDraft, type PotDraftType } from '../utils/pot-draft';
import { PotConflictError } from '../utils/pot-conflict';
import { POT_STATUS_COLOR } from '../types/pot-round';
import type { PotRound } from '../types/pot-round';

const { Title, Paragraph, Text } = Typography;

type ModalKind = 'start' | 'handover' | 'close' | 'anomaly' | 'void';
type RoundFilter = '在锅' | '已收锅' | '已作废' | '全部';

/** 锅次交接：锅位占用、冻结开工、换班追加接手、收锅释放、冲突草稿与崩溃恢复 */
export default function PotBoard() {
  const { message, modal } = AntApp.useApp();
  const rounds = usePotStore((s) => s.rounds);
  const hydrate = usePotStore((s) => s.hydrate);
  const voidRound = usePotStore((s) => s.voidRound);
  const herbs = useHerbStore((s) => s.herbs);
  const methods = useMethodStore((s) => s.methods);
  const samples = useSampleStore((s) => s.samples);

  const [filter, setFilter] = useState<RoundFilter>('在锅');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [modalKind, setModalKind] = useState<ModalKind | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [startPot, setStartPot] = useState<string | undefined>();
  const [resumeDraft, setResumeDraft] = useState<PotDraft | undefined>();
  const [drafts, setDrafts] = useState<PotDraft[]>([]);
  const [recoverNotice, setRecoverNotice] = useState<string | undefined>();

  const [voidTarget, setVoidTarget] = useState<PotRound | null>(null);

  const refreshDrafts = () => setDrafts(listDrafts());

  // 其他页签提交后（或本页重新可见时）重新装载，保证只认先写入的一笔
  useEffect(() => subscribePotChanges(() => { void hydrate(); }), [hydrate]);

  // 首次进入：恢复未完成锅次现场（IndexedDB 中的锅位占用）+ 未提交草稿（localStorage）
  useEffect(() => {
    refreshDrafts();
    const all = listDrafts();
    const conflict = all.find((d) => d.conflict);
    if (conflict) {
      setRecoverNotice(conflict.conflictMessage ?? '检测到上次因并发冲突保留的草稿，已恢复。');
    } else if (all.length > 0) {
      setRecoverNotice(`检测到 ${all.length} 份未提交的锅次操作草稿（关浏览器前未完成），已随锅位占用一起恢复。`);
    }
  }, []);

  const occupied = useMemo(() => {
    const map = new Map<string, PotRound>();
    rounds.filter((r) => r.status === '在锅' && r.potNo).forEach((r) => map.set(r.potNo as string, r));
    return map;
  }, [rounds]);

  const drawerRound = useMemo(() => rounds.find((r) => r.id === drawerId) ?? null, [rounds, drawerId]);
  const targetRound = useMemo(() => rounds.find((r) => r.id === targetId) ?? null, [rounds, targetId]);
  const visibleRounds = useMemo(() => (filter === '全部' ? rounds : rounds.filter((r) => r.status === filter)), [rounds, filter]);

  const herbName = (id: string) => herbs.find((h) => h.id === id)?.name ?? '未知药材';
  const hasSamples = (r: PotRound) => r.sampleIds.length > 0 || samples.some((s) => s.potRoundId === r.id);

  const openModal = (kind: ModalKind, round?: PotRound, defaultPot?: string, draft?: PotDraft) => {
    setModalKind(kind);
    setTargetId(round?.id ?? null);
    setStartPot(defaultPot);
    setResumeDraft(draft);
  };

  const closeModal = () => {
    setModalKind(null);
    setTargetId(null);
    setStartPot(undefined);
    setResumeDraft(undefined);
    refreshDrafts();
  };

  const resumeById = (draft: PotDraft) => {
    setRecoverNotice(undefined);
    if (draft.type === 'start') {
      openModal('start', undefined, (draft.payload as { potNo?: string }).potNo, draft);
      return;
    }
    const round = rounds.find((r) => r.id === draft.potRoundId);
    if (!round) {
      message.warning('草稿关联的锅次已不存在，将丢弃该草稿');
      removeDraft(draft.id);
      refreshDrafts();
      return;
    }
    if (draft.type === 'handover' || draft.type === 'close' || draft.type === 'anomaly') {
      if (round.status !== '在锅' && draft.type !== 'anomaly') {
        modal.warning({
          title: `锅次 ${round.potRoundNo} 已${round.status}`,
          content: '该草稿对应的锅次已被另一页面收锅或作废，不能再提交；表单内容仍可查看，请放弃草稿或转登记异常。',
          okText: '知道了',
        });
      }
      openModal(draft.type, round, undefined, draft);
    }
  };

  // 冲突后重提：从库重读最新锅次，并找回那份未提交草稿（内容不变，清掉旧冲突标记、基准版本刷新）
  const reloadWithDraft = (kind: ModalKind, roundId: string, draftId: string) => {
    const latest = usePotStore.getState().roundById(roundId);
    if (!latest) return;
    const draft = clearDraftConflict(draftId) ?? listDrafts().find((d) => d.id === draftId);
    setTargetId(null);
    setResumeDraft(undefined);
    setModalKind(null);
    requestAnimationFrame(() => openModal(kind, latest, undefined, draft));
  };

  const handleVoidSubmit = async (round: PotRound, values: { operator: string; reason: string }) => {
    try {
      await voidRound(round.id, { operator: values.operator, reason: values.reason, basedOnVersion: round.version });
      message.success(`锅次 ${round.potRoundNo} 已作废，${round.potNo} 已释放`);
      setVoidTarget(null);
      setDrawerId(null);
    } catch (error) {
      if (error instanceof PotConflictError) {
        message.error(error.message);
        void hydrate();
        setVoidTarget(null);
      } else {
        message.error(`作废失败：${(error as Error).message}`);
        throw error;
      }
    }
  };

  const draftTypeLabel: Record<PotDraftType, string> = { start: '开工', handover: '接手', close: '收锅', anomaly: '异常' };

  const columns: TableColumnsType<PotRound> = [
    {
      title: '锅次号',
      dataIndex: 'potRoundNo',
      width: 150,
      fixed: 'left',
      render: (v: string, r) => (
        <Space direction="vertical" size={0}>
          <Text strong>{v}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{r.batchNo}</Text>
        </Space>
      ),
    },
    { title: '锅位', dataIndex: 'potNo', width: 90, render: (v?: string) => (v ? <Tag color="red">{v}</Tag> : <Tag>已释放</Tag>) },
    { title: '药材', dataIndex: 'herbId', width: 90, render: (id: string) => herbName(id) },
    {
      title: '冻结方法/投料',
      width: 180,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <span>{r.frozen.methodName} · {r.frozen.fireLevel}</span>
          <Text type="secondary" style={{ fontSize: 12 }}>
            投料 {r.frozen.feedKg}kg / 辅料计划 {r.frozen.auxPlannedKg}kg
          </Text>
        </Space>
      ),
    },
    { title: '开班人', dataIndex: 'startOperator', width: 90 },
    {
      title: '现班组',
      width: 110,
      render: (_, r) => {
        const last = r.handovers[r.handovers.length - 1];
        return (
          <Space direction="vertical" size={0}>
            <Text strong>{last?.toOperator ?? r.startOperator}</Text>
            {r.handovers.length > 1 ? <Text type="secondary" style={{ fontSize: 12 }}>交接 {r.handovers.length - 1} 次</Text> : null}
          </Space>
        );
      },
    },
    {
      title: '留样',
      dataIndex: 'sampleIds',
      width: 80,
      align: 'center',
      render: (ids: string[]) => (ids.length > 0 ? <Tag color="purple">{ids.length} 份</Tag> : <Tag>无</Tag>),
    },
    {
      title: '版本',
      dataIndex: 'version',
      width: 70,
      align: 'center',
      render: (v: number) => (
        <Tooltip title="每追加一笔记录 +1；并发提交按版本号判定先后，只认先写入的一笔">
          <Tag>v{v}</Tag>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: PotRound['status']) => <Tag color={POT_STATUS_COLOR[s]}>{s}</Tag>,
    },
    { title: '开工时间', dataIndex: 'startedAt', width: 150, render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
    {
      title: '结果',
      width: 130,
      render: (_, r) =>
        r.close ? (
          <span>
            <Tag color={r.close.degree === '适中' ? 'green' : r.close.degree === '太过' ? 'red' : 'orange'}>{r.close.degree}</Tag>
            {r.close.yieldRate}%
          </span>
        ) : r.void ? (
          <Tag>已作废</Tag>
        ) : (
          <Text type="secondary">在锅进行中</Text>
        ),
    },
    {
      title: '操作',
      width: 220,
      fixed: 'right',
      render: (_, r) => (
        <Space size={2} wrap>
          <Button size="small" type="link" onClick={() => setDrawerId(r.id)}>
            明细
          </Button>
          {r.status === '在锅' ? (
            <>
              <Button size="small" type="link" onClick={() => openModal('handover', r)}>
                接手
              </Button>
              <Button size="small" type="link" onClick={() => openModal('close', r)}>
                收锅
              </Button>
              <Tooltip title={hasSamples(r) ? '已产生留样的锅次不能作废，只能登记异常原因' : undefined}>
                <Button
                  size="small"
                  type="link"
                  danger
                  disabled={hasSamples(r)}
                  onClick={() => setVoidTarget(r)}
                >
                  作废
                </Button>
              </Tooltip>
            </>
          ) : (
            <Button size="small" type="link" onClick={() => openModal('anomaly', r)}>
              异常登记
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const activeCount = rounds.filter((r) => r.status === '在锅').length;
  const sampledCount = rounds.filter((r) => r.sampleIds.length > 0).length;

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        锅次交接台
      </Title>
      <Paragraph type="secondary">
        开工先占用锅位并冻住当时方法与投料量；换班只追加接手记录，后来接手的人不能改前班数据。两个页面同时接手或收锅时只认先写入的一笔，后到页面保留草稿并显示冲突；写入失败或关掉浏览器后重开，自动恢复未完成锅次与锅位占用。已产生留样的锅次不能作废，只能登记异常原因；收锅后释放锅位，工序记录与留样台账显示同一锅次。
      </Paragraph>

      {recoverNotice || drafts.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="未完成现场 / 冲突草稿"
          description={
            <Space direction="vertical" size={6}>
              <span>{recoverNotice ?? `当前保留 ${drafts.length} 份未提交草稿。`}</span>
              <Space wrap>
                {drafts.map((d) => (
                  <Popconfirm
                    key={d.id}
                    title="放弃这份草稿？"
                    description="放弃后不可恢复。"
                    onConfirm={() => {
                      removeDraft(d.id);
                      refreshDrafts();
                      if (drafts.length <= 1) setRecoverNotice(undefined);
                    }}
                    cancelText="保留"
                    okText="放弃草稿"
                  >
                    <Button
                      size="small"
                      type={d.conflict ? 'primary' : 'default'}
                      danger={Boolean(d.conflict)}
                      onClick={(e) => {
                        e.stopPropagation();
                        resumeById(d);
                      }}
                    >
                      {d.conflict ? '冲突草稿 · ' : '草稿 · '}
                      {draftTypeLabel[d.type]}
                      {d.type !== 'start' ? `（${rounds.find((r) => r.id === d.potRoundId)?.potRoundNo ?? '锅次已不存在'}）` : ''}
                    </Button>
                  </Popconfirm>
                ))}
              </Space>
            </Space>
          }
          action={
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => {
                void hydrate();
                refreshDrafts();
              }}
            >
              刷新占用与草稿
            </Button>
          }
        />
      ) : null}

      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" icon={<FireOutlined />} onClick={() => openModal('start', undefined, startPot)}>
          占用锅位开工
        </Button>
        <Segmented value={filter} onChange={(v) => setFilter(v as RoundFilter)} options={['在锅', '已收锅', '已作废', '全部']} />
      </Space>

      <Space style={{ marginBottom: 12 }} wrap size={12}>
        <StatBadge label="在锅锅次 / 占用锅位" value={`${activeCount} / 4`} status={activeCount ? 'warning' : 'success'} />
        <StatBadge label="锅次总数" value={rounds.length} unit="口" />
        <StatBadge label="已留样锅次" value={sampledCount} unit="口" status="success" hint="已留样锅次不能作废，只能登记异常" />
      </Space>

      <Card size="small" title="锅位占用看板" style={{ marginBottom: 16 }}>
        <PotGrid
          occupied={occupied}
          herbName={herbName}
          selectedPot={startPot}
          onSelect={(potNo) => {
            setStartPot(potNo);
            const r = occupied.get(potNo);
            if (r) setDrawerId(r.id);
            else openModal('start', undefined, potNo);
          }}
        />
      </Card>

      <Table rowKey="id" size="small" columns={columns} dataSource={visibleRounds} pagination={{ pageSize: 10 }} scroll={{ x: 1500 }} />

      <PotRoundDrawer
        round={drawerRound}
        herbName={herbName}
        hasSamples={hasSamples}
        onClose={() => setDrawerId(null)}
        onHandover={(r) => openModal('handover', r)}
        onFinish={(r) => openModal('close', r)}
        onAnomaly={(r) => openModal('anomaly', r)}
        onVoid={(r) => setVoidTarget(r)}
      />

      {modalKind === 'start' ? (
        <StartPotModal
          open
          defaultPotNo={startPot}
          resume={resumeDraft}
          herbs={herbs}
          methods={methods}
          occupiedPots={new Set(Array.from(occupied.keys()))}
          onClose={closeModal}
          onStarted={closeModal}
        />
      ) : null}
      {modalKind === 'handover' && targetRound ? (
        <HandoverModal
          key={`handover-${targetRound.id}-${targetRound.version}`}
          open
          round={targetRound}
          resume={resumeDraft}
          onClose={closeModal}
          onDone={closeModal}
          onConflictReload={() => reloadWithDraft('handover', targetRound.id, `draft-handover-${targetRound.id}`)}
        />
      ) : null}
      {modalKind === 'close' && targetRound ? (
        <CloseModal
          key={`close-${targetRound.id}-${targetRound.version}`}
          open
          round={targetRound}
          resume={resumeDraft}
          onClose={closeModal}
          onDone={closeModal}
          onConflictReload={() => {
            const latest = usePotStore.getState().roundById(targetRound.id);
            reloadWithDraft(latest && latest.status !== '在锅' ? 'anomaly' : 'close', targetRound.id, `draft-close-${targetRound.id}`);
          }}
        />
      ) : null}
      {modalKind === 'anomaly' && targetRound ? (
        <AnomalyModal
          key={`anomaly-${targetRound.id}-${targetRound.version}`}
          open
          round={targetRound}
          resume={resumeDraft}
          onClose={closeModal}
          onDone={closeModal}
          onConflictReload={() => reloadWithDraft('anomaly', targetRound.id, `draft-anomaly-${targetRound.id}`)}
        />
      ) : null}
      {voidTarget ? (
        <VoidModal
          key={`void-${voidTarget.id}-${voidTarget.version}`}
          open
          round={voidTarget}
          onClose={() => setVoidTarget(null)}
          onConfirm={handleVoidSubmit}
        />
      ) : null}
    </div>
  );
}
