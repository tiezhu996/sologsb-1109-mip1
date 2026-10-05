import type { ReactNode } from 'react';
import { Alert, Button, Descriptions, Drawer, Empty, Space, Table, Tag, Timeline, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { AnomalyRecord, HandoverRecord, PotRound } from '../../types/pot-round';
import { POT_STATUS_COLOR } from '../../types/pot-round';

const { Text, Title } = Typography;

interface PotRoundDrawerProps {
  round: PotRound | null;
  herbName: (id: string) => string;
  hasSamples: (round: PotRound) => boolean;
  onClose: () => void;
  onHandover: (round: PotRound) => void;
  onFinish: (round: PotRound) => void;
  onAnomaly: (round: PotRound) => void;
  /** 作废（父组件弹原因框后按版本提交） */
  onVoid: (round: PotRound) => void;
}

function fullTime(iso: string): string {
  return dayjs(iso).format('YYYY-MM-DD HH:mm');
}

/** 锅次明细：冻结数据只读、接手记录只追加、收锅/作废/异常入口 */
export default function PotRoundDrawer({ round, herbName, hasSamples, onClose, onHandover, onFinish, onAnomaly, onVoid }: PotRoundDrawerProps) {
  if (!round) {
    return <Drawer open={false} onClose={onClose} width={720} />;
  }
  const f = round.frozen;
  const active = round.status === '在锅';
  const sampled = hasSamples(round);

  const anomalyColumns: TableColumnsType<AnomalyRecord> = [
    { title: '登记时间', dataIndex: 'at', width: 150, render: (v: string) => fullTime(v) },
    { title: '登记人', dataIndex: 'operator', width: 100 },
    { title: '异常原因', dataIndex: 'reason' },
    { title: '处置措施', dataIndex: 'action', width: 220 },
  ];

  return (
    <Drawer
      open={Boolean(round)}
      onClose={onClose}
      width={760}
      title={
        <Space wrap>
          <Text strong>{round.potRoundNo}</Text>
          <Tag color={POT_STATUS_COLOR[round.status]}>{round.status}</Tag>
          {round.potNo ? <Tag color="red">{round.potNo} 占用中</Tag> : <Tag color="green">锅位已释放</Tag>}
          {sampled ? <Tag color="purple">已留样 {round.sampleIds.length} 份</Tag> : null}
        </Space>
      }
      extra={
        active ? (
          <Space wrap>
            <Button type="primary" onClick={() => onHandover(round)}>
              换班接手
            </Button>
            <Button type="primary" ghost onClick={() => onFinish(round)}>
              收锅
            </Button>
            <Button onClick={() => onAnomaly(round)}>异常登记</Button>
            <Tooltip title={sampled ? '已产生留样的锅次不能作废，只能登记异常原因' : undefined}>
              <Button danger disabled={sampled} onClick={() => onVoid(round)}>
                作废
              </Button>
            </Tooltip>
          </Space>
        ) : (
          <Button onClick={() => onAnomaly(round)}>追加异常登记</Button>
        )
      }
    >
      {sampled && !active ? (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="该锅次已产生留样，不能作废，只能登记异常原因。" />
      ) : null}

      <Title level={5}>开工冻结数据（只读）</Title>
      <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="药材批次">{herbName(round.herbId)}</Descriptions.Item>
        <Descriptions.Item label="生产批号">{round.batchNo}</Descriptions.Item>
        <Descriptions.Item label="炮制方法">
          {f.methodName}（{f.auxiliary}）
        </Descriptions.Item>
        <Descriptions.Item label="冻结火候">
          <Tag color="orange">{f.fireLevel}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="投料量（冻住）">
          <Text strong>{f.feedKg} kg</Text>
        </Descriptions.Item>
        <Descriptions.Item label="辅料计划（冻住）">
          {f.auxPlannedKg} kg（{f.auxRatio}kg/100kg）
        </Descriptions.Item>
        <Descriptions.Item label="温度标准" span={2}>
          {f.tempRange[0]}~{f.tempRange[1]}℃ · 标准时长 {f.duration}min · 判断维度 {f.criterionDimension}
        </Descriptions.Item>
        <Descriptions.Item label="判断标准" span={2}>
          {f.criterion}
        </Descriptions.Item>
      </Descriptions>

      <Title level={5}>
        <ClockCircleOutlined /> 换班接手记录（只追加，不可改前班数据）
      </Title>
      <Timeline
        style={{ marginBottom: 16 }}
        items={round.handovers.map<{ color: string; children: ReactNode }>((h: HandoverRecord) => ({
          color: h.seq === 1 ? 'green' : 'blue',
          children: (
            <div>
              <Space wrap size={6}>
                <Tag color={h.seq === 1 ? 'green' : 'blue'}>第 {h.seq} 次{h.seq === 1 ? '（开班）' : '接手'}</Tag>
                <Text strong>
                  {h.fromOperator} → {h.toOperator}
                </Text>
                <Text type="secondary">{fullTime(h.at)}</Text>
              </Space>
              <div style={{ fontSize: 13, color: '#4b5a50' }}>
                锅温 {h.potTemp}℃ · {h.fireLevel} · {h.note}
              </div>
            </div>
          ),
        }))}
      />

      {round.close ? (
        <>
          <Title level={5}>收锅记录（锅位已释放）</Title>
          <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
            <Descriptions.Item label="收锅时间">{fullTime(round.close.at)}</Descriptions.Item>
            <Descriptions.Item label="收锅人">{round.close.operator}</Descriptions.Item>
            <Descriptions.Item label="炮制后重量">{round.close.outputKg} kg</Descriptions.Item>
            <Descriptions.Item label="得率">
              <Text strong>{round.close.yieldRate}%</Text>
            </Descriptions.Item>
            <Descriptions.Item label="程度">
              <Tag color={round.close.degree === '适中' ? 'green' : round.close.degree === '太过' ? 'red' : 'orange'}>{round.close.degree}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="辅料实耗">{round.close.auxUsedKg} kg</Descriptions.Item>
            <Descriptions.Item label="收锅锅温 / 时长" span={2}>
              {round.close.temp}℃ · {round.close.duration}min
            </Descriptions.Item>
            {round.close.remark ? (
              <Descriptions.Item label="收锅备注" span={2}>
                {round.close.remark}
              </Descriptions.Item>
            ) : null}
          </Descriptions>
        </>
      ) : null}

      {round.void ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={`已作废 · ${fullTime(round.void.at)} · ${round.void.operator}`}
          description={`作废原因：${round.void.reason}`}
        />
      ) : null}

      <Title level={5}>异常登记（只追加）</Title>
      {round.anomalies.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无异常登记" style={{ marginBottom: 12 }} />
      ) : (
        <Table rowKey="id" size="small" style={{ marginBottom: 12 }} columns={anomalyColumns} dataSource={round.anomalies} pagination={false} />
      )}
    </Drawer>
  );
}
