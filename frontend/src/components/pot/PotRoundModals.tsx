import { useEffect, useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Tag, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { FIRE_LEVELS, type FireLevel, type ProcessingMethod } from '../../types/processing-method';
import type { HerbMaterial } from '../../types/herb-material';
import type { PotRound } from '../../types/pot-round';
import { usePotStore, type StartRoundInput, type HandoverInput, type CloseRoundInput, type AnomalyInput } from '../../stores/potStore';
import { PotConflictError } from '../../utils/pot-conflict';
import { usePotDraft } from '../../hooks/usePotDraft';
import { judgeDegree } from '../../utils/degree';
import type { PotDraft } from '../../utils/pot-draft';
import { POTS } from '../../types/pot-round';
import type { PotCloseDegree } from '../../types/pot-round';

const { Text } = Typography;

/** 开工弹窗表单：占用锅位 + 冻结方法与投料量 */
interface StartFormValues {
  potNo: string;
  herbId: string;
  batchNo: string;
  methodId: string;
  feedKg: number;
  startOperator: string;
  startedAt: Dayjs;
  potTemp: number;
  note?: string;
}

/** 开工草稿（时间序列化为 ISO 存储） */
export interface StartPayload extends Omit<StartFormValues, 'startedAt'> {
  startedAt: string;
}

interface StartModalProps {
  open: boolean;
  defaultPotNo?: string;
  resume?: PotDraft;
  herbs: HerbMaterial[];
  methods: ProcessingMethod[];
  occupiedPots: Set<string>;
  onClose: () => void;
  onStarted: () => void;
}

export function StartPotModal({ open, defaultPotNo, resume, herbs, methods, occupiedPots, onClose, onStarted }: StartModalProps) {
  const { message } = AntApp.useApp();
  const startRound = usePotStore((s) => s.startRound);
  const [form] = Form.useForm<StartFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<string | undefined>();

  const watched = Form.useWatch([], form) as Partial<StartFormValues> | undefined;
  const selectedHerb = herbs.find((h) => h.id === watched?.herbId);
  const selectedMethod = methods.find((m) => m.id === watched?.methodId);
  const auxPlanned = useMemo(() => {
    const feed = Number(watched?.feedKg) || 0;
    return Number(((feed * (selectedMethod?.auxRatio ?? 0)) / 100).toFixed(2));
  }, [watched?.feedKg, selectedMethod]);

  // 打开（含崩溃后恢复草稿）时还原表单
  useEffect(() => {
    if (!open) return;
    const p = resume?.payload as StartPayload | undefined;
    const firstFreePot = POTS.find((x) => !occupiedPots.has(x)) ?? POTS[0];
    form.setFieldsValue({
      potNo: p?.potNo ?? defaultPotNo ?? firstFreePot,
      herbId: p?.herbId ?? herbs[0]?.id,
      batchNo: p?.batchNo ?? `PZ-${dayjs().format('YYMMDD')}-${String(Math.floor(Math.random() * 90) + 10)}`,
      methodId: p?.methodId ?? methods[0]?.id,
      feedKg: p?.feedKg ?? herbs[0]?.feedKg ?? 100,
      startOperator: p?.startOperator ?? '陈玉兰',
      startedAt: dayjs(p?.startedAt ?? new Date()),
      potTemp: p?.potTemp ?? methods[0]?.tempRange[0] ?? 90,
      note: p?.note,
    });
    setConflict(resume?.conflict ? resume.conflictMessage : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const draft = usePotDraft<StartPayload>({
    draftId: resume?.id ?? 'draft-start',
    type: 'start',
    getPayload: () => {
      if (!open) return undefined;
      const v = form.getFieldsValue();
      return {
        potNo: v.potNo,
        herbId: v.herbId,
        batchNo: v.batchNo,
        methodId: v.methodId,
        feedKg: v.feedKg,
        startOperator: v.startOperator,
        startedAt: (v.startedAt ?? dayjs()).toISOString(),
        potTemp: v.potTemp,
        note: v.note,
      };
    },
  });

  const submit = async () => {
    const v = await form.validateFields();
    if (occupiedPots.has(v.potNo)) {
      setConflict(`锅位 ${v.potNo} 此刻已被占用，提交将只保留草稿。请换一个空闲锅位。`);
      return;
    }
    const payload: StartRoundInput = {
      potNo: v.potNo,
      herbId: v.herbId,
      batchNo: v.batchNo,
      methodId: v.methodId,
      feedKg: v.feedKg,
      startOperator: v.startOperator,
      startedAt: v.startedAt.toISOString(),
      potTemp: v.potTemp,
      note: v.note,
    };
    setSubmitting(true);
    try {
      const round = await startRound(payload);
      draft.discard();
      message.success(`已占用 ${v.potNo} 开工 ${round.potRoundNo}，方法与投料量已冻结`);
      onStarted();
    } catch (error) {
      if (error instanceof PotConflictError) {
        draft.markConflict(error.message);
        setConflict(error.message);
      } else {
        message.error(`开工写入失败（已保留草稿，重开可恢复）：${(error as Error).message}`);
        draft.schedulePersist();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="开班 · 占用锅位开工"
      onCancel={() => {
        draft.discard();
        onClose();
      }}
      onOk={submit}
      confirmLoading={submitting}
      okText="占用锅位并冻结开工"
      cancelText="取消（不保留）"
      width={680}
      maskClosable={false}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="开工即占用锅位，并冻住当时的炮制方法与投料量；之后换班只能追加接手记录，不能改动冻结数据。"
      />
      {conflict ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message="开工冲突" description={conflict} /> : null}

      <Form
        form={form}
        layout="vertical"
        onValuesChange={(changed) => {
          draft.schedulePersist();
          if ('methodId' in changed) {
            const m = methods.find((x) => x.id === changed.methodId);
            if (m) form.setFieldsValue({ potTemp: m.tempRange[0] });
          }
        }}
      >
        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item name="potNo" label="锅位" rules={[{ required: true, message: '请选择锅位' }]} style={{ flex: 1 }}>
            <Select
              options={POTS.map((p) => ({
                label: occupiedPots.has(p) ? `${p}（占用中）` : `${p}（空闲）`,
                value: p,
                disabled: occupiedPots.has(p),
              }))}
            />
          </Form.Item>
          <Form.Item name="startOperator" label="开班操作人" rules={[{ required: true, message: '请输入开班操作人' }]} style={{ flex: 1 }}>
            <Input maxLength={16} />
          </Form.Item>
          <Form.Item name="startedAt" label="开工时间" rules={[{ required: true, message: '请选择开工时间' }]}>
            <DatePicker showTime style={{ width: 190 }} />
          </Form.Item>
        </Space>

        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item name="herbId" label="药材批次" rules={[{ required: true, message: '请选择药材批次' }]} style={{ flex: 1 }}>
            <Select showSearch optionFilterProp="label" options={herbs.map((h) => ({ label: `${h.name} · ${h.batchNo}（${h.feedKg}kg）`, value: h.id }))} />
          </Form.Item>
          <Form.Item name="batchNo" label="生产批号" rules={[{ required: true, message: '请输入生产批号' }]} style={{ flex: 1 }}>
            <Input maxLength={24} />
          </Form.Item>
          <Form.Item name="methodId" label="炮制方法" rules={[{ required: true, message: '请选择炮制方法' }]} style={{ flex: 1 }}>
            <Select options={methods.map((m) => ({ label: `${m.name} · ${m.auxiliary} ${m.auxRatio}kg/100kg`, value: m.id }))} />
          </Form.Item>
        </Space>

        {selectedMethod ? (
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 12 }}
            message={
              <Space wrap size={8}>
                <Tag color="orange">冻结火候 {selectedMethod.fireLevel}</Tag>
                <Tag>辅料 {selectedMethod.auxiliary} {selectedMethod.auxRatio}kg/100kg</Tag>
                <Tag>标准 {selectedMethod.tempRange[0]}~{selectedMethod.tempRange[1]}℃ / {selectedMethod.duration}min</Tag>
                <Tag>{selectedMethod.criterionDimension}</Tag>
              </Space>
            }
            description={`判断标准：${selectedMethod.criterion}`}
          />
        ) : null}

        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item name="feedKg" label="投料量(kg) · 开工冻住" rules={[{ required: true, message: '请输入投料量' }]} style={{ flex: 1 }}>
            <InputNumber min={0} step={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="potTemp" label="开班锅温(℃)" rules={[{ required: true, message: '请输入开班锅温' }]} style={{ flex: 1 }}>
            <InputNumber min={0} max={800} style={{ width: '100%' }} />
          </Form.Item>
        </Space>

        <div style={{ marginBottom: 12 }}>
          <Text type="secondary">
            冻结辅料计划用量：<Text strong>{auxPlanned} kg</Text>（{selectedMethod?.auxiliary ?? '辅料'}，按 {selectedMethod?.auxRatio ?? 0}kg/100kg ×{' '}
            {Number(watched?.feedKg) || 0}kg 折算）；药材台账投料量参考 {selectedHerb?.feedKg ?? '-'}kg
          </Text>
        </div>

        <Form.Item name="note" label="开班备注">
          <Input.TextArea rows={2} maxLength={120} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 换班接手表单 */
interface HandoverFormValues {
  fromOperator: string;
  toOperator: string;
  at: Dayjs;
  potTemp: number;
  fireLevel: FireLevel;
  note: string;
}

export interface HandoverPayload extends Omit<HandoverFormValues, 'at'> {
  at: string;
}

interface HandoverModalProps {
  open: boolean;
  round: PotRound;
  resume?: PotDraft;
  onClose: () => void;
  onDone: () => void;
  /** 冲突后刷新：父组件从库中重读最新锅次并以新版本重挂载弹窗 */
  onConflictReload?: () => void;
}

export function HandoverModal({ open, round, resume, onClose, onDone, onConflictReload }: HandoverModalProps) {
  const { message } = AntApp.useApp();
  const handover = usePotStore((s) => s.handover);
  const [form] = Form.useForm<HandoverFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<string | undefined>();
  const current = round.handovers[round.handovers.length - 1];

  useEffect(() => {
    if (!open) return;
    const p = resume?.payload as HandoverPayload | undefined;
    form.setFieldsValue({
      fromOperator: p?.fromOperator ?? current?.toOperator,
      toOperator: p?.toOperator ?? '',
      at: dayjs(p?.at ?? new Date()),
      potTemp: p?.potTemp ?? current?.potTemp ?? round.frozen.tempRange[0],
      fireLevel: p?.fireLevel ?? current?.fireLevel ?? round.frozen.fireLevel,
      note: p?.note ?? '',
    });
    setConflict(resume?.conflict ? resume.conflictMessage : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const draft = usePotDraft<HandoverPayload>({
    draftId: resume?.id ?? `draft-handover-${round.id}`,
    type: 'handover',
    potRoundId: round.id,
    getPayload: () => {
      if (!open) return undefined;
      const v = form.getFieldsValue();
      return {
        fromOperator: v.fromOperator,
        toOperator: v.toOperator,
        at: (v.at ?? dayjs()).toISOString(),
        potTemp: v.potTemp,
        fireLevel: v.fireLevel,
        note: v.note,
      };
    },
  });

  const submit = async () => {
    const v = await form.validateFields();
    const payload: HandoverInput = {
      fromOperator: v.fromOperator,
      toOperator: v.toOperator,
      at: v.at.toISOString(),
      potTemp: v.potTemp,
      fireLevel: v.fireLevel,
      note: v.note,
      basedOnVersion: round.version,
    };
    setSubmitting(true);
    try {
      await handover(round.id, payload);
      draft.discard();
      message.success(`接手记录已追加，${v.toOperator} 成为现班组（冻结数据未改动）`);
      onDone();
    } catch (error) {
      if (error instanceof PotConflictError) {
        draft.markConflict(error.message);
        setConflict(error.message);
        void usePotStore.getState().hydrate();
      } else {
        message.error(`接手写入失败（已保留草稿）：${(error as Error).message}`);
        draft.schedulePersist();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`换班接手 · ${round.potRoundNo}（${round.potNo}）`}
      onCancel={() => {
        draft.discard();
        onClose();
      }}
      onOk={submit}
      confirmLoading={submitting}
      okText="只追加接手记录"
      cancelText="取消（不保留）"
      width={620}
      maskClosable={false}
    >
      <FrozenNotice round={round} />
      {conflict ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="接手冲突：已有另一个页面先写入"
          description={
            <Space direction="vertical" size={4}>
              <span>{conflict}</span>
              <span>表单内容已保留为草稿；请查看锅次明细中的最新接手记录后，再决定是否重提。</span>
              {onConflictReload ? (
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    setConflict(undefined);
                    onConflictReload();
                  }}
                >
                  载入最新锅次后重提（草稿内容不变）
                </Button>
              ) : null}
            </Space>
          }
        />
      ) : null}
      <Form form={form} layout="vertical" onValuesChange={draft.schedulePersist}>
        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item name="fromOperator" label="交出班组" rules={[{ required: true, message: '请填写交出班组' }]} style={{ flex: 1 }}>
            <Input maxLength={16} />
          </Form.Item>
          <Form.Item name="toOperator" label="接手班组" rules={[{ required: true, message: '请填写接手班组' }]} style={{ flex: 1 }}>
            <Input maxLength={16} placeholder="如：夜班 · 刘建国" />
          </Form.Item>
          <Form.Item name="at" label="接手时间" rules={[{ required: true }]}>
            <DatePicker showTime style={{ width: 190 }} />
          </Form.Item>
        </Space>
        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item name="potTemp" label="交接时锅温(℃)" rules={[{ required: true }]} style={{ flex: 1 }}>
            <InputNumber min={0} max={800} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="fireLevel" label="交接时火候" rules={[{ required: true }]} style={{ flex: 1 }}>
            <Select options={FIRE_LEVELS.map((v) => ({ label: v, value: v }))} />
          </Form.Item>
        </Space>
        <Form.Item name="note" label="锅内状态与交接注意事项" rules={[{ required: true, message: '请填写交接说明' }]}>
          <Input.TextArea rows={3} maxLength={200} placeholder="如：麸皮已下过半，保持中火勤翻，约还需 6 分钟" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 收锅表单 */
interface CloseFormValues {
  operator: string;
  endedAt: Dayjs;
  outputKg: number;
  temp: number;
  duration: number;
  auxUsedKg: number;
  degree: PotCloseDegree;
  remark?: string;
}

export interface ClosePayload extends Omit<CloseFormValues, 'endedAt'> {
  endedAt: string;
}

interface CloseModalProps {
  open: boolean;
  round: PotRound;
  resume?: PotDraft;
  onClose: () => void;
  onDone: () => void;
  onConflictReload?: () => void;
}

export function CloseModal({ open, round, resume, onClose, onDone, onConflictReload }: CloseModalProps) {
  const { message } = AntApp.useApp();
  const closeRound = usePotStore((s) => s.closeRound);
  const [form] = Form.useForm<CloseFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<string | undefined>();
  const current = round.handovers[round.handovers.length - 1];

  const watched = Form.useWatch([], form) as Partial<CloseFormValues> | undefined;
  const yieldRate = useMemo(() => {
    const out = Number(watched?.outputKg) || 0;
    return round.frozen.feedKg > 0 ? Number(((out / round.frozen.feedKg) * 100).toFixed(1)) : 0;
  }, [watched?.outputKg, round.frozen.feedKg]);

  const verdict = useMemo(() => {
    const method: ProcessingMethod = {
      id: round.frozen.methodId,
      name: round.frozen.methodName as ProcessingMethod['name'],
      auxiliary: round.frozen.auxiliary as ProcessingMethod['auxiliary'],
      auxRatio: round.frozen.auxRatio,
      fireLevel: round.frozen.fireLevel,
      tempRange: [...round.frozen.tempRange] as [number, number],
      duration: round.frozen.duration,
      criterion: round.frozen.criterion,
      criterionDimension: round.frozen.criterionDimension as ProcessingMethod['criterionDimension'],
      applicable: '',
    };
    if (!open) return undefined;
    return judgeDegree({
      method,
      fireLevel: current?.fireLevel ?? round.frozen.fireLevel,
      duration: Number(watched?.duration) || round.frozen.duration,
      temp: Number(watched?.temp) || round.frozen.tempRange[0],
      yieldRate,
    });
  }, [open, round, watched?.duration, watched?.temp, yieldRate, current]);

  useEffect(() => {
    if (!open) return;
    const p = resume?.payload as ClosePayload | undefined;
    const defaultOut = Number((round.frozen.feedKg * (round.frozen.methodName === '蜜炙' ? 1.08 : 0.94)).toFixed(1));
    form.setFieldsValue({
      operator: p?.operator ?? current?.toOperator ?? round.startOperator,
      endedAt: dayjs(p?.endedAt ?? new Date()),
      outputKg: p?.outputKg ?? defaultOut,
      temp: p?.temp ?? round.frozen.tempRange[1],
      duration: p?.duration ?? round.frozen.duration,
      auxUsedKg: p?.auxUsedKg ?? round.frozen.auxPlannedKg,
      degree: p?.degree ?? '适中',
      remark: p?.remark,
    });
    setConflict(resume?.conflict ? resume.conflictMessage : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const draft = usePotDraft<ClosePayload>({
    draftId: resume?.id ?? `draft-close-${round.id}`,
    type: 'close',
    potRoundId: round.id,
    getPayload: () => {
      if (!open) return undefined;
      const v = form.getFieldsValue();
      return {
        operator: v.operator,
        endedAt: (v.endedAt ?? dayjs()).toISOString(),
        outputKg: v.outputKg,
        temp: v.temp,
        duration: v.duration,
        auxUsedKg: v.auxUsedKg,
        degree: v.degree,
        remark: v.remark,
      };
    },
  });

  const submit = async () => {
    const v = await form.validateFields();
    const payload: CloseRoundInput = {
      operator: v.operator,
      endedAt: v.endedAt.toISOString(),
      outputKg: v.outputKg,
      temp: v.temp,
      duration: v.duration,
      auxUsedKg: v.auxUsedKg,
      degree: v.degree,
      remark: v.remark,
      basedOnVersion: round.version,
    };
    setSubmitting(true);
    try {
      await closeRound(round.id, payload);
      draft.discard();
      message.success(`已收锅 ${round.potRoundNo}，锅位已释放，工序记录已生成并锁定`);
      onDone();
    } catch (error) {
      if (error instanceof PotConflictError) {
        draft.markConflict(error.message);
        setConflict(error.message);
        void usePotStore.getState().hydrate();
      } else {
        message.error(`收锅写入失败（已保留草稿，重开可恢复）：${(error as Error).message}`);
        draft.schedulePersist();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`收锅 · ${round.potRoundNo}（${round.potNo}）`}
      onCancel={() => {
        draft.discard();
        onClose();
      }}
      onOk={submit}
      confirmLoading={submitting}
      okText="收锅并释放锅位"
      cancelText="取消（不保留）"
      width={680}
      maskClosable={false}
    >
      <FrozenNotice round={round} />
      {conflict ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="收锅冲突：已有另一个页面先完成写入"
          description={
            <Space direction="vertical" size={4}>
              <span>{conflict}</span>
              {onConflictReload ? (
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    setConflict(undefined);
                    onConflictReload();
                  }}
                >
                  载入最新锅次后重提（草稿内容不变）
                </Button>
              ) : null}
            </Space>
          }
        />
      ) : null}
      <Form
        form={form}
        layout="vertical"
        onValuesChange={(changed) => {
          draft.schedulePersist();
          if (verdict && ('temp' in changed || 'duration' in changed || 'outputKg' in changed)) {
            form.setFieldValue('degree', verdict.degree);
          }
        }}
      >
        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item name="operator" label="收锅操作人（现班组）" rules={[{ required: true }]} style={{ flex: 1 }}>
            <Input maxLength={16} />
          </Form.Item>
          <Form.Item name="endedAt" label="收锅时间" rules={[{ required: true }]} style={{ flex: 1 }}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Space>
        <Space size={12} style={{ display: 'flex' }} align="start">
          <Form.Item name="outputKg" label="炮制后重量(kg)" rules={[{ required: true }]} style={{ flex: 1 }}>
            <InputNumber min={0} step={0.5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="temp" label="收锅锅温(℃)" rules={[{ required: true }]} style={{ flex: 1 }}>
            <InputNumber min={0} max={800} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="duration" label="本锅总时长(min)" rules={[{ required: true }]} style={{ flex: 1 }}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="auxUsedKg" label="辅料实耗(kg)" rules={[{ required: true }]} style={{ flex: 1 }}>
            <InputNumber min={0} step={0.1} style={{ width: '100%' }} />
          </Form.Item>
        </Space>

        <Alert
          type={verdict?.degree === '适中' ? 'success' : verdict?.degree === '太过' ? 'error' : 'warning'}
          showIcon
          style={{ marginBottom: 12 }}
          message={`得率 ${yieldRate}%（投料冻结 ${round.frozen.feedKg}kg）；系统判定：${verdict?.degree ?? '-'}，预期 ${verdict?.expectedYield ?? '-'}%`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {(verdict?.reasons ?? []).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          }
        />

        <Form.Item name="degree" label="程度判定" rules={[{ required: true }]}>
          <Select options={['不及', '适中', '太过'].map((v) => ({ label: v, value: v }))} />
        </Form.Item>
        <Form.Item name="remark" label="收锅备注">
          <Input.TextArea rows={2} maxLength={120} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 异常登记表单 */
interface AnomalyFormValues {
  operator: string;
  reason: string;
  action: string;
}

export type AnomalyPayload = AnomalyFormValues;

/** 作废表单 */
interface VoidFormValues {
  operator: string;
  reason: string;
}

export type VoidPayload = VoidFormValues;

interface VoidModalProps {
  open: boolean;
  round: PotRound;
  onClose: () => void;
  /** 提交作废（父组件按当前版本调用 store） */
  onConfirm: (round: PotRound, values: VoidFormValues) => Promise<void> | void;
}

export function VoidModal({ open, round, onClose, onConfirm }: VoidModalProps) {
  const [form] = Form.useForm<VoidFormValues>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      operator: round.handovers[round.handovers.length - 1]?.toOperator ?? round.startOperator,
      reason: '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    const v = await form.validateFields();
    setSubmitting(true);
    try {
      await onConfirm(round, v);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`作废锅次 · ${round.potRoundNo}（${round.potNo}）`}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={submitting}
      okText="确认作废并释放锅位"
      cancelText="取消"
      width={520}
      okButtonProps={{ danger: true }}
      maskClosable={false}
    >
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 12 }}
        message="作废后释放锅位，且该锅次不能再写入任何记录"
        description="如只是炮制异常（色泽不及、中途停电等），请改用「异常登记」。"
      />
      <Form form={form} layout="vertical">
        <Form.Item name="operator" label="操作人" rules={[{ required: true }]}>
          <Input maxLength={16} />
        </Form.Item>
        <Form.Item name="reason" label="作废原因" rules={[{ required: true, message: '请填写作废原因' }]}>
          <Input.TextArea rows={3} maxLength={200} placeholder="如：药材发现变质，整锅中止" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface AnomalyModalProps {
  open: boolean;
  round: PotRound;
  resume?: PotDraft;
  onClose: () => void;
  onDone: () => void;
  onConflictReload?: () => void;
}

export function AnomalyModal({ open, round, resume, onClose, onDone, onConflictReload }: AnomalyModalProps) {
  const { message } = AntApp.useApp();
  const reportAnomaly = usePotStore((s) => s.reportAnomaly);
  const [form] = Form.useForm<AnomalyFormValues>();
  const [submitting, setSubmitting] = useState(false);
  const [conflict, setConflict] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    const p = resume?.payload as AnomalyPayload | undefined;
    form.setFieldsValue({
      operator: p?.operator ?? round.handovers[round.handovers.length - 1]?.toOperator ?? round.startOperator,
      reason: p?.reason ?? '',
      action: p?.action ?? '',
    });
    setConflict(resume?.conflict ? resume.conflictMessage : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const draft = usePotDraft<AnomalyPayload>({
    draftId: resume?.id ?? `draft-anomaly-${round.id}`,
    type: 'anomaly',
    potRoundId: round.id,
    getPayload: () => (open ? (form.getFieldsValue() as AnomalyPayload) : undefined),
  });

  const submit = async () => {
    const v = await form.validateFields();
    const payload: AnomalyInput = { ...v, basedOnVersion: round.version };
    setSubmitting(true);
    try {
      await reportAnomaly(round.id, payload);
      draft.discard();
      message.success('异常原因已登记（只追加，不改动既有记录）');
      onDone();
    } catch (error) {
      if (error instanceof PotConflictError) {
        draft.markConflict(error.message);
        setConflict(error.message);
        void usePotStore.getState().hydrate();
      } else {
        message.error(`登记失败（已保留草稿）：${(error as Error).message}`);
        draft.schedulePersist();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`异常登记 · ${round.potRoundNo}`}
      onCancel={() => {
        draft.discard();
        onClose();
      }}
      onOk={submit}
      confirmLoading={submitting}
      okText="追加异常登记"
      cancelText="取消（不保留）"
      width={560}
      maskClosable={false}
    >
      {round.sampleIds.length > 0 ? (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="该锅次已产生留样，不能作废；只能在此登记异常原因与处置措施。" />
      ) : null}
      {conflict ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="写入冲突"
          description={
            <Space direction="vertical" size={4}>
              <span>{conflict}</span>
              {onConflictReload ? (
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    setConflict(undefined);
                    onConflictReload();
                  }}
                >
                  载入最新锅次后重提（草稿内容不变）
                </Button>
              ) : null}
            </Space>
          }
        />
      ) : null}
      <Form form={form} layout="vertical" onValuesChange={draft.schedulePersist}>
        <Form.Item name="operator" label="登记人" rules={[{ required: true }]}>
          <Input maxLength={16} />
        </Form.Item>
        <Form.Item name="reason" label="异常原因" rules={[{ required: true, message: '请填写异常原因' }]}>
          <Input.TextArea rows={3} maxLength={200} placeholder="如：中途停电 12 分钟，锅温回落，断面判定不及" />
        </Form.Item>
        <Form.Item name="action" label="处置措施" rules={[{ required: true, message: '请填写处置措施' }]}>
          <Input.TextArea rows={2} maxLength={200} placeholder="如：转延续加工复炒，单独码放并报质检" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 冻结数据只读提示 */
function FrozenNotice({ round }: { round: PotRound }) {
  const f = round.frozen;
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 12 }}
      message="开工冻结数据（任何接手班组均不可改）"
      description={
        <Space wrap size={8}>
          <Tag color="orange">{f.methodName} · {f.fireLevel}</Tag>
          <Tag>投料 {f.feedKg}kg</Tag>
          <Tag>
            {f.auxiliary} 计划 {f.auxPlannedKg}kg（{f.auxRatio}kg/100kg）
          </Tag>
          <Tag>
            标准 {f.tempRange[0]}~{f.tempRange[1]}℃ / {f.duration}min
          </Tag>
        </Space>
      }
    />
  );
}
