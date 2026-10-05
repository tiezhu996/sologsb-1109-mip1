import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { Link } from 'react-router-dom';
import { FireOutlined, ThunderboltOutlined } from '@ant-design/icons';
import WokPotGrid from '../components/common/WokPotGrid';
import EmptyPanel from '../components/common/EmptyPanel';
import { useWokStore, WokMutationError } from '../stores/wokStore';
import { useHerbStore } from '../stores/herbStore';
import { useMethodStore } from '../stores/methodStore';
import { useBatchStore } from '../stores/batchStore';
import { useSampleStore } from '../stores/sampleStore';
import { WOK_POTS, type FinishDraftPayload, type StartDraftPayload, type TakeoverDraftPayload, type WokBatch, type WokDraft, type WokPot } from '../types/wok-batch';
import type { ProcessDegree } from '../types/process-batch';
import { PROCESS_DEGREES } from '../types/process-batch';
import { judgeDegree, formatDate } from '../utils/degree';

const { Title, Paragraph, Text } = Typography;

type ModalKind = 'start' | 'takeover' | 'finish' | 'abnormal' | 'void';

interface ModalState {
  kind: ModalKind;
  wok?: WokBatch;
}

interface StartFormValues {
  pot: WokPot;
  herbId: string;
  methodId: string;
  feedKg: number;
  startOperator: string;
  startTeam?: string;
  startedAt: Dayjs;
}
interface TakeoverFormValues {
  fromOperator: string;
  toOperator: string;
  fromTeam?: string;
  toTeam?: string;
  note?: string;
}
interface FinishFormValues {
  outputKg: number;
  auxUsedKg: number;
  temp: number;
  duration: number;
  degree: ProcessDegree;
  finishOperator: string;
  endedAt: Dayjs;
  finishNote?: string;
}
interface AbnormalFormValues {
  reason: string;
  operator: string;
}
interface VoidFormValues {
  reason: string;
  operator: string;
}

const STATUS_META: Record<WokBatch['status'], { label: string; color: string }> = {
  running: { label: '进行中', color: 'orange' },
  finished: { label: '已收锅', color: 'green' },
  voided: { label: '已作废', color: 'default' },
};

const DEGREE_COLOR: Record<ProcessDegree, string> = { 不及: 'orange', 适中: 'green', 太过: 'red' };

/** 锅次交接台：开工占锅位并冻结方法投料；换班只追加接手；收锅释放锅位 */
export default function WokHandover() {
  const { message, modal } = AntApp.useApp();
  const woks = useWokStore((s) => s.woks);
  const drafts = useWokStore((s) => s.drafts);
  const sessionId = useWokStore((s) => s.sessionId);
  const startWok = useWokStore((s) => s.startWok);
  const takeoverWok = useWokStore((s) => s.takeoverWok);
  const finishWok = useWokStore((s) => s.finishWok);
  const registerAbnormal = useWokStore((s) => s.registerAbnormal);
  const voidWok = useWokStore((s) => s.voidWok);
  const upsertDraft = useWokStore((s) => s.upsertDraft);
  const deleteDraft = useWokStore((s) => s.deleteDraft);

  const herbs = useHerbStore((s) => s.herbs);
  const methods = useMethodStore((s) => s.methods);
  const batches = useBatchStore((s) => s.batches);
  const samples = useSampleStore((s) => s.samples);

  const [modalState, setModalState] = useState<ModalState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [detail, setDetail] = useState<WokBatch | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  /** 打开弹窗时锅次的修订号，提交时做乐观锁校验 */
  const [baseRevision, setBaseRevision] = useState<number | undefined>(undefined);

  const [startForm] = Form.useForm<StartFormValues>();
  const [takeoverForm] = Form.useForm<TakeoverFormValues>();
  const [finishForm] = Form.useForm<FinishFormValues>();
  const [abnormalForm] = Form.useForm<AbnormalFormValues>();
  const [voidForm] = Form.useForm<VoidFormValues>();

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const herbName = (id: string) => herbs.find((h) => h.id === id)?.name ?? '未知药材';
  const methodOf = (id: string) => methods.find((m) => m.id === id);

  const running = useMemo(() => woks.filter((w) => w.status === 'running'), [woks]);
  const occupiedPots = useMemo(() => new Set(running.map((w) => w.pot)), [running]);
  const sampleCountOf = (wok: WokBatch) => (wok.processBatchId ? samples.filter((s) => s.batchId === wok.processBatchId).length : 0);

  // 抽屉/弹窗展示的锅次要跟随 store 刷新（其他页面先写入后立即看到最新交接链）
  useEffect(() => {
    if (detail) {
      const latest = woks.find((w) => w.id === detail.id);
      if (latest && latest !== detail) {
        setDetail(latest);
      }
    }
    if (modalState?.wok) {
      const latest = woks.find((w) => w.id === modalState.wok!.id);
      if (latest && latest !== modalState.wok) {
        setModalState((prev) => (prev ? { ...prev, wok: latest } : prev));
        setBaseRevision(latest.revision);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [woks]);

  // —— 草稿自动保存（冲突后后到页面保留录入；关掉浏览器也已落 IndexedDB） ——
  const scheduleAutosave = (saver: () => Promise<unknown>) => {
    if (autosaveTimer.current) {
      clearTimeout(autosaveTimer.current);
    }
    autosaveTimer.current = setTimeout(() => {
      void saver();
    }, 300);
  };

  useEffect(
    () => () => {
      if (autosaveTimer.current) {
        clearTimeout(autosaveTimer.current);
      }
    },
    [],
  );

  const watchedStart = Form.useWatch([], startForm) as Partial<StartFormValues> | undefined;
  const watchedFinish = Form.useWatch([], finishForm) as Partial<FinishFormValues> | undefined;
  const startMethod = methods.find((m) => m.id === watchedStart?.methodId);
  const finishWokData = modalState?.wok;
  const finishMethod = finishWokData ? methodOf(finishWokData.methodId) : undefined;
  const liveOutput = Number(watchedFinish?.outputKg) || 0;
  const liveYield = finishWokData && finishWokData.feedKg > 0 ? Number(((liveOutput / finishWokData.feedKg) * 100).toFixed(1)) : 0;
  const liveVerdict = useMemo(() => {
    if (!finishMethod) {
      return undefined;
    }
    return judgeDegree({
      method: finishMethod,
      fireLevel: finishWokData?.fireLevel ?? finishMethod.fireLevel,
      duration: Number(watchedFinish?.duration) || finishWokData?.methodDuration || finishMethod.duration,
      temp: Number(watchedFinish?.temp) || Math.round((finishMethod.tempRange[0] + finishMethod.tempRange[1]) / 2),
      yieldRate: liveYield,
    });
  }, [finishMethod, finishWokData, watchedFinish?.duration, watchedFinish?.temp, liveYield]);

  // —— 打开各弹窗 ——
  const openStart = (draft?: WokDraft) => {
    setConflict(null);
    setBaseRevision(undefined);
    startForm.resetFields();
    const payload = draft?.payload as StartDraftPayload | undefined;
    const firstHerb = herbs[0];
    const firstMethod = methods[0];
    startForm.setFieldsValue({
      pot: (payload?.pot as WokPot) ?? (WOK_POTS.find((p) => !occupiedPots.has(p)) ?? WOK_POTS[0]),
      herbId: payload?.herbId ?? firstHerb?.id,
      methodId: payload?.methodId ?? firstMethod?.id,
      feedKg: payload?.feedKg ?? firstHerb?.feedKg ?? 100,
      startOperator: payload?.startOperator ?? '陈玉兰',
      startTeam: payload?.startTeam ?? '甲班',
      startedAt: payload?.startedAt ? dayjs(payload.startedAt) : dayjs(),
    });
    setModalState({ kind: 'start' });
  };

  const openTakeover = (wok: WokBatch) => {
    setConflict(null);
    setBaseRevision(wok.revision);
    takeoverForm.resetFields();
    const lastTo = wok.handovers.length ? wok.handovers[wok.handovers.length - 1].toOperator : wok.startOperator;
    const lastTeam = wok.handovers.length ? wok.handovers[wok.handovers.length - 1].toTeam : wok.startTeam;
    takeoverForm.setFieldsValue({
      fromOperator: lastTo,
      fromTeam: lastTeam,
      toOperator: '王丽',
      toTeam: lastTeam === '甲班' ? '乙班' : '甲班',
    });
    setModalState({ kind: 'takeover', wok });
  };

  const openFinish = (wok: WokBatch, draft?: WokDraft) => {
    setConflict(null);
    setBaseRevision(wok.revision);
    finishForm.resetFields();
    const method = methodOf(wok.methodId);
    const expectedOutput = Number((wok.feedKg * (method?.name === '蜜炙' ? 1.08 : 0.94)).toFixed(1));
    const payload = draft?.payload as FinishDraftPayload | undefined;
    finishForm.setFieldsValue({
      outputKg: payload?.outputKg ?? expectedOutput,
      auxUsedKg: payload?.auxUsedKg ?? wok.auxPlannedKg,
      temp: method ? Math.round((method.tempRange[0] + method.tempRange[1]) / 2) : 100,
      duration: wok.methodDuration,
      degree: payload?.degree ?? '适中',
      finishOperator: payload?.finishOperator ?? (wok.handovers.length ? wok.handovers[wok.handovers.length - 1].toOperator : wok.startOperator),
      endedAt: payload?.endedAt ? dayjs(payload.endedAt) : dayjs(),
      finishNote: payload?.finishNote,
    });
    setModalState({ kind: 'finish', wok });
  };

  const openAbnormal = (wok: WokBatch) => {
    setConflict(null);
    setBaseRevision(undefined);
    abnormalForm.resetFields();
    abnormalForm.setFieldsValue({ operator: '陈玉兰', reason: '' });
    setModalState({ kind: 'abnormal', wok });
  };

  const openVoid = (wok: WokBatch) => {
    setConflict(null);
    setBaseRevision(undefined);
    voidForm.resetFields();
    voidForm.setFieldsValue({ operator: '陈玉兰', reason: '' });
    setModalState({ kind: 'void', wok });
  };

  const closeModal = () => {
    setModalState(null);
    setConflict(null);
    setBaseRevision(undefined);
  };

  // —— 提交处理：冲突只拦后到页面，弹窗与表单（草稿）保留并显示冲突 ——
  const handleError = (error: unknown): boolean => {
    if (error instanceof WokMutationError) {
      setConflict(error.message);
      if (error.current) {
        setBaseRevision(error.current.revision);
      }
      return true;
    }
    message.error(`提交失败：${(error as Error).message}`);
    return false;
  };

  const submitStart = async () => {
    const values = await startForm.validateFields();
    setSubmitting(true);
    try {
      const wok = await startWok({
        pot: values.pot,
        herbId: values.herbId,
        methodId: values.methodId,
        feedKg: Number(values.feedKg) || 0,
        startOperator: values.startOperator,
        startTeam: values.startTeam,
        startedAt: values.startedAt.toISOString(),
      });
      await deleteDraft(`draft-${sessionId}-start-${values.pot}`);
      message.success(`${wok.wokNo} 已在 ${wok.pot} 开工，方法与投料量已冻结`);
      closeModal();
    } catch (error) {
      handleError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const submitTakeover = async () => {
    if (!modalState?.wok || baseRevision === undefined) {
      return;
    }
    const values = await takeoverForm.validateFields();
    setSubmitting(true);
    try {
      const wok = await takeoverWok({
        wokId: modalState.wok.id,
        expectedRevision: baseRevision,
        fromOperator: values.fromOperator,
        toOperator: values.toOperator,
        fromTeam: values.fromTeam,
        toTeam: values.toTeam,
        note: values.note,
      });
      await deleteDraft(`draft-${sessionId}-takeover-${modalState.wok.id}`);
      message.success(`接手已追加到 ${wok.wokNo}，当前操作人：${values.toOperator}`);
      closeModal();
    } catch (error) {
      handleError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const submitFinish = async () => {
    if (!modalState?.wok || baseRevision === undefined) {
      return;
    }
    const values = await finishForm.validateFields();
    setSubmitting(true);
    try {
      const { wok } = await finishWok({
        wokId: modalState.wok.id,
        expectedRevision: baseRevision,
        endedAt: values.endedAt.toISOString(),
        outputKg: Number(values.outputKg) || 0,
        auxUsedKg: Number(values.auxUsedKg) || 0,
        degree: values.degree,
        finishOperator: values.finishOperator,
        finishNote: values.finishNote,
      });
      await deleteDraft(`draft-${sessionId}-finish-${modalState.wok.id}`);
      message.success(`${wok.wokNo} 已收锅，${wok.pot} 已释放，工序记录与留样台账显示同一锅次`);
      closeModal();
    } catch (error) {
      handleError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const submitAbnormal = async () => {
    if (!modalState?.wok) {
      return;
    }
    const values = await abnormalForm.validateFields();
    setSubmitting(true);
    try {
      await registerAbnormal({ wokId: modalState.wok.id, reason: values.reason, operator: values.operator });
      message.success('异常原因已登记并追加到锅次记录');
      closeModal();
    } catch (error) {
      handleError(error);
    } finally {
      setSubmitting(false);
    }
  };

  const submitVoid = async () => {
    if (!modalState?.wok) {
      return;
    }
    const values = await voidForm.validateFields();
    setSubmitting(true);
    try {
      const wok = await voidWok({ wokId: modalState.wok.id, operator: values.operator, reason: values.reason });
      message.success(wok.status === 'voided' ? `${wok.wokNo} 已作废，锅位已释放` : '已作废');
      closeModal();
    } catch (error) {
      handleError(error);
    } finally {
      setSubmitting(false);
    }
  };

  // —— 草稿恢复 ——
  const myDrafts = useMemo(() => drafts.filter((d) => d.sessionId === sessionId), [drafts, sessionId]);
  const otherDrafts = useMemo(() => drafts.filter((d) => d.sessionId !== sessionId), [drafts, sessionId]);

  const resumeDraft = (draft: WokDraft) => {
    if (draft.kind === 'start') {
      openStart(draft);
      return;
    }
    const wok = woks.find((w) => w.id === draft.wokId);
    if (!wok) {
      message.warning('该草稿对应的锅次已不存在');
      void deleteDraft(draft.id);
      return;
    }
    if (wok.status !== 'running') {
      modal.warning({
        title: `锅次 ${wok.wokNo} 已${wok.status === 'finished' ? '收锅' : '作废'}`,
        content: '未提交的草稿无法继续使用，将删除该草稿。',
        onOk: () => deleteDraft(draft.id),
      });
      return;
    }
    if (draft.kind === 'takeover') {
      setConflict(null);
      setBaseRevision(wok.revision);
      takeoverForm.resetFields();
      const payload = draft.payload as TakeoverDraftPayload;
      takeoverForm.setFieldsValue(payload);
      setModalState({ kind: 'takeover', wok });
      if (draft.baseRevision !== undefined && draft.baseRevision !== wok.revision) {
        setConflict(`恢复的草稿基于修订 ${draft.baseRevision}，该锅次此后已有新记录（当前修订 ${wok.revision}），请核对后再提交。`);
      }
    } else if (draft.kind === 'finish') {
      openFinish(wok, draft);
      if (draft.baseRevision !== undefined && draft.baseRevision !== wok.revision) {
        setConflict(`恢复的草稿基于修订 ${draft.baseRevision}，该锅次此后已有新交接/异常（当前修订 ${wok.revision}），请核对后再收锅。`);
      }
    }
  };

  // —— 表格 ——
  const columns: TableColumnsType<WokBatch> = [
    {
      title: '锅次号',
      dataIndex: 'wokNo',
      width: 130,
      render: (v: string, record) => (
        <Space size={4}>
          <Text strong>{v}</Text>
          <Tag color="geekblue">{record.pot}</Tag>
        </Space>
      ),
    },
    { title: '药材', dataIndex: 'herbId', width: 90, render: (id: string) => herbName(id) },
    { title: '方法（冻结）', dataIndex: 'methodName', width: 110 },
    { title: '投料(kg)', dataIndex: 'feedKg', width: 90, align: 'right' },
    { title: '辅料计划(kg)', dataIndex: 'auxPlannedKg', width: 110, align: 'right' },
    { title: '开工时间', dataIndex: 'startedAt', width: 110, render: (v: string) => formatDate(v) },
    {
      title: '交接',
      dataIndex: 'handovers',
      width: 80,
      align: 'right',
      render: (list: WokBatch['handovers']) => (list.length ? <Tag color="blue">{list.length} 次</Tag> : <Tag>0</Tag>),
    },
    {
      title: '异常',
      dataIndex: 'abnormals',
      width: 80,
      align: 'right',
      render: (list: WokBatch['abnormals']) => (list.length ? <Tag color="red">{list.length}</Tag> : <Tag>0</Tag>),
    },
    {
      title: '得率/程度',
      width: 120,
      render: (_, record) =>
        record.status === 'finished' ? (
          <Space size={4}>
            <Text>{record.yieldRate}%</Text>
            <Tag color={DEGREE_COLOR[record.degree ?? '适中']}>{record.degree}</Tag>
          </Space>
        ) : record.status === 'voided' ? (
          <Tag>已作废</Tag>
        ) : (
          <Text type="secondary">收锅后填写</Text>
        ),
    },
    {
      title: '留样',
      width: 70,
      align: 'right',
      render: (_, record) => {
        const count = sampleCountOf(record);
        return count > 0 ? <Tag color="purple">{count} 份</Tag> : <Tag>0</Tag>;
      },
    },
    { title: '状态', dataIndex: 'status', width: 90, render: (status: WokBatch['status']) => <Tag color={STATUS_META[status].color}>{STATUS_META[status].label}</Tag> },
    {
      title: '操作',
      width: 260,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2} wrap>
          <Button size="small" type="link" onClick={() => setDetail(record)}>
            详情
          </Button>
          {record.status === 'running' ? (
            <>
              <Button size="small" type="link" onClick={() => openTakeover(record)}>
                班组接手
              </Button>
              <Button size="small" type="link" onClick={() => openFinish(record)}>
                收锅
              </Button>
              <Button size="small" type="link" onClick={() => openAbnormal(record)}>
                异常登记
              </Button>
              <Button
                size="small"
                type="link"
                danger
                onClick={() =>
                  modal.confirm({
                    title: `作废锅次 ${record.wokNo}？`,
                    content: '作废后释放锅位，本锅次不再参与收锅。请在表单中填写作废原因。',
                    onOk: () => openVoid(record),
                    okText: '去填写作废原因',
                    cancelText: '取消',
                  })
                }
              >
                作废
              </Button>
            </>
          ) : (
            <>
              <Button size="small" type="link" onClick={() => openAbnormal(record)} disabled={record.status === 'voided'}>
                异常登记
              </Button>
              {record.processBatchId && (
                <Link to="/batches">
                  <Button size="small" type="link">
                    查看工序记录
                  </Button>
                </Link>
              )}
              {record.status === 'finished' ? (
                <Button
                  size="small"
                  type="link"
                  danger
                  disabled={sampleCountOf(record) > 0}
                  title={sampleCountOf(record) > 0 ? '已产生留样，不能作废，只能登记异常原因' : undefined}
                  onClick={() => openVoid(record)}
                >
                  作废
                </Button>
              ) : null}
            </>
          )}
        </Space>
      ),
    },
  ];

  const currentOperator = (wok: WokBatch) => (wok.handovers.length ? wok.handovers[wok.handovers.length - 1].toOperator : wok.startOperator);

  const draftKindLabel: Record<WokDraft['kind'], string> = { start: '开工', takeover: '班组接手', finish: '收锅' };

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        锅次交接
      </Title>
      <Paragraph type="secondary">
        开工先占用锅位并冻住当时的炮制方法与投料量；换班只追加接手记录，后来接手的人不能改前班数据；两个页面同时提交接手或收锅时只认先写入的一笔，后到页面保留草稿并显示冲突；已产生留样的锅次不能作废，只能登记异常原因；收锅后释放锅位，工序记录与留样台账显示同一锅次。
      </Paragraph>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="锅位占用" value={running.length} suffix={`/ ${WOK_POTS.length}`} prefix={<ThunderboltOutlined />} valueStyle={{ color: running.length ? '#d48806' : '#3f8600' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="进行中锅次" value={running.length} suffix="锅" prefix={<FireOutlined />} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="已收锅" value={woks.filter((w) => w.status === 'finished').length} suffix="锅" valueStyle={{ color: '#3f8600' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="本页未提交草稿" value={myDrafts.length} suffix="份" valueStyle={{ color: myDrafts.length ? '#cf1322' : undefined }} />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="锅位占用" style={{ marginBottom: 16 }} extra={<Button type="primary" onClick={() => openStart()}>开工占用锅位</Button>}>
        <WokPotGrid woks={woks} herbName={herbName} />
      </Card>

      {myDrafts.length > 0 || otherDrafts.length > 0 ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="有未提交的草稿（写入冲突后保留，或浏览器关闭前未提交；重开后可恢复未完成锅次）"
          description={
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {myDrafts.map((draft) => (
                <Space key={draft.id} wrap>
                  <Badge status="processing" text={`本页 · ${draftKindLabel[draft.kind]}${draft.pot ? ` · ${draft.pot}` : ''}${draft.wokId ? ` · ${woks.find((w) => w.id === draft.wokId)?.wokNo ?? '锅次已不存在'}` : ''}（${formatDate(draft.updatedAt)}）`} />
                  <Button size="small" type="link" onClick={() => resumeDraft(draft)}>
                    恢复草稿
                  </Button>
                  <Button size="small" type="link" danger onClick={() => void deleteDraft(draft.id)}>
                    丢弃
                  </Button>
                </Space>
              ))}
              {otherDrafts.map((draft) => (
                <Space key={draft.id} wrap>
                  <Badge status="warning" text={`其他页面 · ${draftKindLabel[draft.kind]}${draft.pot ? ` · ${draft.pot}` : ''}${draft.wokId ? ` · ${woks.find((w) => w.id === draft.wokId)?.wokNo ?? '锅次已不存在'}` : ''}（${formatDate(draft.updatedAt)}）`} />
                  <Button size="small" type="link" onClick={() => resumeDraft(draft)}>
                    查看并接管
                  </Button>
                  <Button size="small" type="link" danger onClick={() => void deleteDraft(draft.id)}>
                    丢弃
                  </Button>
                </Space>
              ))}
            </Space>
          }
        />
      ) : null}

      <Card size="small" title="锅次记录（进行中在前）" style={{ marginBottom: 16 }}>
        {woks.length === 0 ? (
          <EmptyPanel description="还没有锅次，开工即占用锅位" actionText="开工占用锅位" onAction={() => openStart()} />
        ) : (
          <Table
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={[...running, ...woks.filter((w) => w.status !== 'running')]}
            pagination={{ pageSize: 10 }}
            scroll={{ x: 1500 }}
          />
        )}
      </Card>

      {/* 锅次详情抽屉：交接链 / 异常记录只追加展示，前班数据只读 */}
      <Drawer width={640} open={Boolean(detail)} title={detail ? `锅次 · ${detail.wokNo}（${detail.pot}）` : ''} onClose={() => setDetail(null)}>
        {detail ? (
          <>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_META[detail.status].color}>{STATUS_META[detail.status].label}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="当前修订">{detail.revision}</Descriptions.Item>
              <Descriptions.Item label="药材">{herbName(detail.herbId)}</Descriptions.Item>
              <Descriptions.Item label="当前操作人">{currentOperator(detail)}</Descriptions.Item>
              <Descriptions.Item label="冻结方法" span={2}>
                {detail.methodName} · {detail.methodAuxiliary} {detail.auxRatio}kg/100kg · {detail.fireLevel} · {detail.methodDuration}min
              </Descriptions.Item>
              <Descriptions.Item label="投料量（冻结）">{detail.feedKg} kg</Descriptions.Item>
              <Descriptions.Item label="辅料计划（冻结）">{detail.auxPlannedKg} kg</Descriptions.Item>
              <Descriptions.Item label="判断标准" span={2}>
                {detail.criterion}（{detail.criterionDimension}）
              </Descriptions.Item>
              <Descriptions.Item label="开工时间">{formatDate(detail.startedAt)}</Descriptions.Item>
              <Descriptions.Item label="开工操作人">
                {detail.startOperator}
                {detail.startTeam ? ` · ${detail.startTeam}` : ''}
              </Descriptions.Item>
              {detail.status === 'finished' ? (
                <>
                  <Descriptions.Item label="收锅时间">{detail.endedAt ? formatDate(detail.endedAt) : '-'}</Descriptions.Item>
                  <Descriptions.Item label="收锅操作人">{detail.finishOperator}</Descriptions.Item>
                  <Descriptions.Item label="炮制后重量">{detail.outputKg} kg</Descriptions.Item>
                  <Descriptions.Item label="辅料实际">{detail.auxUsedKg} kg</Descriptions.Item>
                  <Descriptions.Item label="得率">{detail.yieldRate}%</Descriptions.Item>
                  <Descriptions.Item label="程度">
                    <Tag color={DEGREE_COLOR[detail.degree ?? '适中']}>{detail.degree}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="留样">{sampleCountOf(detail)} 份（留样台账与本锅次一致）</Descriptions.Item>
                  <Descriptions.Item label="工序记录">{batches.find((b) => b.id === detail.processBatchId)?.batchNo ?? '-'}</Descriptions.Item>
                </>
              ) : null}
              {detail.status === 'voided' ? (
                <>
                  <Descriptions.Item label="作废时间">{detail.voidedAt ? formatDate(detail.voidedAt) : '-'}</Descriptions.Item>
                  <Descriptions.Item label="作废操作人">{detail.voidOperator}</Descriptions.Item>
                  <Descriptions.Item label="作废原因" span={2}>
                    {detail.voidReason ?? '-'}
                  </Descriptions.Item>
                </>
              ) : null}
            </Descriptions>

            <Divider orientation="left" orientationMargin={0}>
              班组交接记录（只追加，前班不可改）
            </Divider>
            {detail.handovers.length === 0 ? (
              <Text type="secondary">尚未换班，开工操作人：{detail.startOperator}</Text>
            ) : (
              <Timeline
                items={[
                  {
                    color: 'green',
                    children: (
                      <div>
                        <Text strong>开工 · {detail.startOperator}</Text>
                        {detail.startTeam ? ` · ${detail.startTeam}` : ''}
                        <div style={{ fontSize: 12, color: '#8c9a90' }}>{formatDate(detail.startedAt)}</div>
                      </div>
                    ),
                  },
                  ...detail.handovers.map((hand) => ({
                    key: hand.id,
                    color: 'blue',
                    children: (
                      <div>
                        <Text strong>
                          {hand.fromOperator}
                          {hand.fromTeam ? `（${hand.fromTeam}）` : ''} → {hand.toOperator}
                          {hand.toTeam ? `（${hand.toTeam}）` : ''}
                        </Text>
                        <div style={{ fontSize: 12, color: '#8c9a90' }}>{formatDate(hand.at)}</div>
                        {hand.note ? <div style={{ fontSize: 12 }}>交接说明：{hand.note}</div> : null}
                      </div>
                    ),
                  })),
                ]}
              />
            )}

            <Divider orientation="left" orientationMargin={0}>
              异常登记（只追加）
            </Divider>
            {detail.abnormals.length === 0 ? (
              <Text type="secondary">无异常记录</Text>
            ) : (
              <Timeline
                items={detail.abnormals.map((abn) => ({
                  key: abn.id,
                  color: 'red',
                  children: (
                    <div>
                      <Text strong>{abn.reason}</Text>
                      <div style={{ fontSize: 12, color: '#8c9a90' }}>
                        {formatDate(abn.at)} · 登记人 {abn.operator}
                      </div>
                    </div>
                  ),
                }))}
              />
            )}

            {detail.status === 'running' ? (
              <Space style={{ marginTop: 16 }}>
                <Button type="primary" onClick={() => { setDetail(null); openTakeover(detail); }}>
                  班组接手
                </Button>
                <Button onClick={() => { setDetail(null); openFinish(detail); }}>收锅</Button>
                <Button danger onClick={() => { setDetail(null); openAbnormal(detail); }}>
                  异常登记
                </Button>
              </Space>
            ) : null}
          </>
        ) : null}
      </Drawer>

      {/* —— 开工弹窗 —— */}
      <ModalShell
        open={modalState?.kind === 'start'}
        title="开工占用锅位"
        onCancel={closeModal}
        submitting={submitting}
        conflict={conflict}
        okText="开工并冻结"
        onOk={submitStart}
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="提交后锅位立即占用，当时的炮制方法、辅料比例与投料量一并冻结，后续换班不得修改前班数据。" />
        <Form
          form={startForm}
          layout="vertical"
          onValuesChange={() => {
            const valuesNow = startForm.getFieldsValue();
            scheduleAutosave(() =>
              upsertDraft({
                kind: 'start',
                pot: valuesNow.pot,
                payload: {
                  pot: (valuesNow.pot ?? WOK_POTS[0]) as WokPot,
                  herbId: valuesNow.herbId ?? '',
                  methodId: valuesNow.methodId ?? '',
                  feedKg: Number(valuesNow.feedKg) || 0,
                  startOperator: valuesNow.startOperator ?? '',
                  startTeam: valuesNow.startTeam,
                  startedAt: valuesNow.startedAt ? valuesNow.startedAt.toISOString() : new Date().toISOString(),
                },
              }),
            );
          }}
        >
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="pot" label="锅位" rules={[{ required: true, message: '请选择锅位' }]} style={{ flex: 1 }}>
              <Select options={WOK_POTS.map((p) => ({ label: `${p}${occupiedPots.has(p) ? '（占用中）' : '（空闲）'}`, value: p, disabled: occupiedPots.has(p) }))} />
            </Form.Item>
            <Form.Item name="startedAt" label="开工时间" rules={[{ required: true, message: '请选择开工时间' }]} style={{ flex: 1 }}>
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="herbId" label="药材批次" rules={[{ required: true, message: '请选择药材' }]} style={{ flex: 1 }}>
              <Select showSearch optionFilterProp="label" options={herbs.map((h) => ({ label: `${h.name} · ${h.batchNo}（${h.feedKg}kg）`, value: h.id }))} />
            </Form.Item>
            <Form.Item name="methodId" label="炮制方法" rules={[{ required: true, message: '请选择方法' }]} style={{ flex: 1 }}>
              <Select showSearch optionFilterProp="label" options={methods.map((m) => ({ label: `${m.name} · ${m.auxiliary} ${m.auxRatio}kg/100kg`, value: m.id }))} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="feedKg" label="投料量(kg)" rules={[{ required: true, message: '请输入投料量' }]} style={{ flex: 1 }}>
              <InputNumber min={0} step={1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="startOperator" label="开工操作人" rules={[{ required: true, message: '请输入操作人' }]} style={{ flex: 1 }}>
              <Input maxLength={16} />
            </Form.Item>
            <Form.Item name="startTeam" label="班组" style={{ flex: 1 }}>
              <Select allowClear options={['甲班', '乙班', '丙班'].map((t) => ({ label: t, value: t }))} />
            </Form.Item>
          </Space>
          {startMethod ? (
            <Alert
              type="success"
              showIcon
              message={`冻结内容：${startMethod.name} · ${startMethod.auxiliary} ${startMethod.auxRatio}kg/100kg · ${startMethod.fireLevel} · 标准 ${startMethod.duration}min`}
              description={`按当时比例折算辅料计划用量：${(((Number(watchedStart?.feedKg) || 0) * startMethod.auxRatio) / 100).toFixed(2)}kg；判断标准：${startMethod.criterion}`}
            />
          ) : null}
        </Form>
      </ModalShell>

      {/* —— 接手弹窗 —— */}
      <ModalShell
        open={modalState?.kind === 'takeover'}
        title={finishWokData && modalState?.kind === 'takeover' ? `班组接手 · ${finishWokData.wokNo}（${finishWokData.pot}）` : '班组接手'}
        onCancel={closeModal}
        submitting={submitting}
        conflict={conflict}
        okText="确认接手（只追加）"
        onOk={submitTakeover}
        conflictActions={
          conflict
            ? [
                <Button
                  key="retry"
                  type="primary"
                  onClick={() => {
                    if (modalState?.wok) {
                      setBaseRevision(modalState.wok.revision);
                      setConflict(null);
                      message.info('已按最新锅次刷新，再次提交将作为新一笔接手记录追加');
                    }
                  }}
                >
                  我知道了，仍追加我的接手
                </Button>,
                <Button key="close" onClick={closeModal}>
                  放弃并关闭（草稿已保留）
                </Button>,
              ]
            : undefined
        }
      >
        {finishWokData ? (
          <>
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="接手记录只能追加，前班已冻结的方法、投料量与交接记录不可修改。" />
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }}>
              <Descriptions.Item label="锅次号">{finishWokData.wokNo}</Descriptions.Item>
              <Descriptions.Item label="当前修订">{finishWokData.revision}</Descriptions.Item>
              <Descriptions.Item label="药材 / 方法">{`${herbName(finishWokData.herbId)} / ${finishWokData.methodName}`}</Descriptions.Item>
              <Descriptions.Item label="投料（冻结）">{finishWokData.feedKg}kg</Descriptions.Item>
              <Descriptions.Item label="当前操作人">{currentOperator(finishWokData)}</Descriptions.Item>
              <Descriptions.Item label="已交接次数">{finishWokData.handovers.length}</Descriptions.Item>
            </Descriptions>
            <Form
              form={takeoverForm}
              layout="vertical"
              onValuesChange={() => {
                const valuesNow = takeoverForm.getFieldsValue();
                const wokId = finishWokData.id;
                const rev = baseRevision;
                scheduleAutosave(() =>
                  upsertDraft({
                    kind: 'takeover',
                    wokId,
                    baseRevision: rev,
                    payload: {
                      fromOperator: valuesNow.fromOperator ?? '',
                      toOperator: valuesNow.toOperator ?? '',
                      fromTeam: valuesNow.fromTeam,
                      toTeam: valuesNow.toTeam,
                      note: valuesNow.note,
                    },
                  }),
                );
              }}
            >
              <Space size={12} style={{ display: 'flex' }} align="start">
                <Form.Item name="fromOperator" label="交班操作人" rules={[{ required: true, message: '请输入交班人' }]} style={{ flex: 1 }}>
                  <Input maxLength={16} />
                </Form.Item>
                <Form.Item name="fromTeam" label="交班班组" style={{ flex: 1 }}>
                  <Select allowClear options={['甲班', '乙班', '丙班'].map((t) => ({ label: t, value: t }))} />
                </Form.Item>
              </Space>
              <Space size={12} style={{ display: 'flex' }} align="start">
                <Form.Item name="toOperator" label="接班操作人" rules={[{ required: true, message: '请输入接班人' }]} style={{ flex: 1 }}>
                  <Input maxLength={16} />
                </Form.Item>
                <Form.Item name="toTeam" label="接班班组" style={{ flex: 1 }}>
                  <Select allowClear options={['甲班', '乙班', '丙班'].map((t) => ({ label: t, value: t }))} />
                </Form.Item>
              </Space>
              <Form.Item name="note" label="交接说明（锅上状态、辅料余料等）">
                <Input.TextArea rows={3} maxLength={120} placeholder="只追加到交接链，不改动前班数据" />
              </Form.Item>
            </Form>
          </>
        ) : null}
      </ModalShell>

      {/* —— 收锅弹窗 —— */}
      <ModalShell
        open={modalState?.kind === 'finish'}
        title={finishWokData && modalState?.kind === 'finish' ? `收锅 · ${finishWokData.wokNo}（${finishWokData.pot}）` : '收锅'}
        onCancel={closeModal}
        submitting={submitting}
        conflict={conflict}
        okText="收锅并释放锅位"
        onOk={submitFinish}
        width={680}
      >
        {finishWokData ? (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="收锅后写入得率与程度、生成同一锅次号的工序记录并释放锅位；若另一页面已先接手/收锅，本页提交将被拦下并保留草稿。"
            />
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }}>
              <Descriptions.Item label="锅次号">{finishWokData.wokNo}</Descriptions.Item>
              <Descriptions.Item label="药材 / 方法">{`${herbName(finishWokData.herbId)} / ${finishWokData.methodName}`}</Descriptions.Item>
              <Descriptions.Item label="投料（冻结）">{finishWokData.feedKg}kg</Descriptions.Item>
              <Descriptions.Item label="辅料计划（冻结）">{finishWokData.auxPlannedKg}kg</Descriptions.Item>
              <Descriptions.Item label="当前操作人">{currentOperator(finishWokData)}</Descriptions.Item>
              <Descriptions.Item label="当前修订">{finishWokData.revision}</Descriptions.Item>
            </Descriptions>
            <Form
              form={finishForm}
              layout="vertical"
              onValuesChange={(changed) => {
                if (liveVerdict && ('temp' in changed || 'duration' in changed || 'outputKg' in changed)) {
                  finishForm.setFieldValue('degree', liveVerdict.degree);
                }
                const valuesNow = finishForm.getFieldsValue();
                const wok = finishWokData;
                const rev = baseRevision;
                scheduleAutosave(() =>
                  upsertDraft({
                    kind: 'finish',
                    wokId: wok.id,
                    baseRevision: rev,
                    payload: {
                      endedAt: valuesNow.endedAt ? valuesNow.endedAt.toISOString() : new Date().toISOString(),
                      outputKg: Number(valuesNow.outputKg) || 0,
                      auxUsedKg: Number(valuesNow.auxUsedKg) || 0,
                      degree: (valuesNow.degree ?? '适中') as ProcessDegree,
                      finishOperator: valuesNow.finishOperator ?? '',
                      finishNote: valuesNow.finishNote,
                    },
                  }),
                );
              }}
            >
              <Space size={12} style={{ display: 'flex' }} align="start">
                <Form.Item name="outputKg" label="炮制后重量(kg)" rules={[{ required: true, message: '请输入炮制后重量' }]}>
                  <InputNumber min={0} step={0.5} style={{ width: 150 }} />
                </Form.Item>
                <Form.Item name="auxUsedKg" label="辅料实际(kg)" rules={[{ required: true, message: '请输入辅料实际用量' }]}>
                  <InputNumber min={0} step={0.1} style={{ width: 140 }} />
                </Form.Item>
                <Form.Item name="temp" label="实际锅温(℃)" rules={[{ required: true, message: '请输入实际锅温' }]}>
                  <InputNumber min={0} max={800} style={{ width: 130 }} />
                </Form.Item>
                <Form.Item name="duration" label="炮制时长(min)" rules={[{ required: true, message: '请输入时长' }]}>
                  <InputNumber min={0} style={{ width: 130 }} />
                </Form.Item>
              </Space>
              <Alert
                type={liveVerdict?.degree === '适中' ? 'success' : liveVerdict?.degree === '太过' ? 'error' : 'warning'}
                showIcon
                style={{ marginBottom: 12 }}
                message={`实时得率 ${liveYield}%；系统判定：${liveVerdict?.degree ?? '待录入'}（预期 ${liveVerdict?.expectedYield ?? '-'}%）`}
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {(liveVerdict?.reasons ?? ['录入炮制后重量、锅温与时长后自动判定']).map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                }
              />
              <Form.Item name="degree" label="程度判定（可复核后修改）" rules={[{ required: true, message: '请选择程度' }]}>
                <Select options={PROCESS_DEGREES.map((v) => ({ label: v, value: v }))} />
              </Form.Item>
              <Space size={12} style={{ display: 'flex' }} align="start">
                <Form.Item name="endedAt" label="收锅时间" rules={[{ required: true, message: '请选择收锅时间' }]}>
                  <DatePicker showTime style={{ width: 200 }} />
                </Form.Item>
                <Form.Item name="finishOperator" label="收锅操作人" rules={[{ required: true, message: '请输入操作人' }]}>
                  <Input style={{ width: 160 }} maxLength={16} />
                </Form.Item>
              </Space>
              <Form.Item name="finishNote" label="收锅备注">
                <Input.TextArea rows={2} maxLength={100} />
              </Form.Item>
            </Form>
          </>
        ) : null}
      </ModalShell>

      {/* —— 异常登记弹窗 —— */}
      <ModalShell open={modalState?.kind === 'abnormal'} title="异常原因登记" onCancel={closeModal} submitting={submitting} conflict={conflict} okText="登记异常" onOk={submitAbnormal}>
        {finishWokData ? (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12}}
            message={sampleCountOf(finishWokData) > 0 ? `锅次 ${finishWokData.wokNo} 已产生 ${sampleCountOf(finishWokData)} 份留样，不能作废，只能在此登记异常原因` : '异常原因将追加到锅次记录，不改动冻结数据与交接链'}
          />
        ) : null}
        <Form form={abnormalForm} layout="vertical">
          <Form.Item name="reason" label="异常原因" rules={[{ required: true, message: '请填写异常原因' }]}>
            <Input.TextArea rows={4} maxLength={200} placeholder="如：局部温度偏高、辅料称量偏差、设备异常等" />
          </Form.Item>
          <Form.Item name="operator" label="登记人" rules={[{ required: true, message: '请输入登记人' }]}>
            <Input maxLength={16} />
          </Form.Item>
        </Form>
      </ModalShell>

      {/* —— 作废弹窗 —— */}
      <ModalShell open={modalState?.kind === 'void'} title="作废锅次" onCancel={closeModal} submitting={submitting} conflict={conflict} okText="确认作废" onOk={submitVoid}>
        {finishWokData && sampleCountOf(finishWokData) > 0 ? (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} message={`该锅次已产生 ${sampleCountOf(finishWokData)} 份留样，不能作废，请关闭后改用「异常登记」。`} />
        ) : (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={finishWokData?.status === 'running' ? '作废后锅位立即释放，本锅次不再收锅。' : '收锅后未留样的锅次作废，将一并删除其工序记录；已留样的锅次不能作废。'} />
        )}
        <Form form={voidForm} layout="vertical">
          <Form.Item name="reason" label="作废原因" rules={[{ required: true, message: '请填写作废原因' }]}>
            <Input.TextArea rows={3} maxLength={120} />
          </Form.Item>
          <Form.Item name="operator" label="操作人" rules={[{ required: true, message: '请输入操作人' }]}>
            <Input maxLength={16} />
          </Form.Item>
        </Form>
      </ModalShell>
    </div>
  );
}

/** 统一弹窗外壳：冲突条置顶；冲突时由页面提供专门的冲突动作 */
function ModalShell(props: {
  open: boolean;
  title: string;
  onCancel: () => void;
  onOk: () => void;
  okText: string;
  submitting: boolean;
  conflict: string | null;
  children: React.ReactNode;
  width?: number;
  conflictActions?: React.ReactNode[];
}) {
  const { open, title, onCancel, onOk, okText, submitting, conflict, children, width = 560, conflictActions } = props;
  return (
    <Modal
      open={open}
      title={title}
      onCancel={onCancel}
      width={width}
      maskClosable={false}
      footer={
        conflict && conflictActions
          ? conflictActions
          : [
              <Button key="cancel" onClick={onCancel}>
                {conflict ? '关闭（草稿保留）' : '取消'}
              </Button>,
              <Button key="ok" type="primary" loading={submitting} onClick={onOk} danger={title.includes('作废')}>
                {okText}
              </Button>,
            ]
      }
    >
      {conflict ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="提交冲突：另一页面已先写入"
          description={conflict}
        />
      ) : null}
      {children}
    </Modal>
  );
}
