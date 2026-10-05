import { Card, Col, Row, Tag, Typography } from 'antd';
import { LockOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { WOK_POTS } from '../../types/wok-batch';
import type { WokBatch } from '../../types/wok-batch';
import { formatDate } from '../../utils/degree';

const { Text } = Typography;

export interface WokPotGridProps {
  /** 全部锅次（进行中用于占用展示） */
  woks: WokBatch[];
  herbName: (herbId: string) => string;
  selectedPot?: string;
  onSelect?: (pot: string) => void;
}

/** 锅位占用网格：进行中锅次占住锅位，展示锅次号、接班人与开工时间 */
export default function WokPotGrid({ woks, herbName, selectedPot, onSelect }: WokPotGridProps) {
  const runningByPot = new Map<string, WokBatch>();
  woks
    .filter((w) => w.status === 'running')
    .forEach((w) => runningByPot.set(w.pot, w));

  return (
    <Row gutter={[12, 12]}>
      {WOK_POTS.map((pot) => {
        const wok = runningByPot.get(pot);
        const occupied = Boolean(wok);
        const active = selectedPot === pot;
        const currentOperator = wok?.handovers.length
          ? wok.handovers[wok.handovers.length - 1].toOperator
          : wok?.startOperator;
        const currentTeam = wok?.handovers.length ? wok.handovers[wok.handovers.length - 1].toTeam : wok?.startTeam;
        return (
          <Col xs={12} md={6} key={pot}>
            <Card
              size="small"
              hoverable={Boolean(onSelect)}
              onClick={() => onSelect?.(pot)}
              style={{
                borderColor: active ? '#1f4d2e' : occupied ? '#d9a14a' : undefined,
                borderWidth: active ? 2 : 1,
                background: occupied ? '#fff8ec' : '#f4faf5',
                cursor: onSelect ? 'pointer' : 'default',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <Text strong>{pot}</Text>
                {occupied ? <Tag icon={<LockOutlined />} color="orange">占用中</Tag> : <Tag icon={<CheckCircleOutlined />} color="green">空闲</Tag>}
              </div>
              {wok ? (
                <div style={{ fontSize: 12, lineHeight: 1.9 }}>
                  <div>
                    <Text strong>{wok.wokNo}</Text> · {herbName(wok.herbId)} · {wok.methodName}
                  </div>
                  <div>投料 {wok.feedKg}kg（已冻结）</div>
                  <div>
                    当前 <Text strong>{currentOperator}</Text>
                    {currentTeam ? ` · ${currentTeam}` : ''}
                    {wok.handovers.length ? <Tag style={{ marginLeft: 6 }} color="blue">已交接 {wok.handovers.length} 次</Tag> : null}
                  </div>
                  <div style={{ color: '#8c9a90' }}>开工 {formatDate(wok.startedAt)}</div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#8c9a90', lineHeight: 1.9 }}>
                  <div>锅位空闲</div>
                  <div>可开工占用</div>
                </div>
              )}
            </Card>
          </Col>
        );
      })}
    </Row>
  );
}
