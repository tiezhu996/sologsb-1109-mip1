import { Card, Col, Row, Tag, Typography } from 'antd';
import { FireFilled } from '@ant-design/icons';
import type { PotRound } from '../../types/pot-round';
import { POTS } from '../../types/pot-round';
import { formatDate } from '../../utils/degree';

const { Text } = Typography;

interface PotGridProps {
  /** 锅位 → 在锅锅次 */
  occupied: Map<string, PotRound>;
  herbName: (id: string) => string;
  selectedPot?: string;
  onSelect?: (potNo: string) => void;
}

/** 锅位占用看板：开工即占用、收锅/作废后释放 */
export default function PotGrid({ occupied, herbName, selectedPot, onSelect }: PotGridProps) {
  return (
    <Row gutter={[10, 10]}>
      {POTS.map((potNo) => {
        const round = occupied.get(potNo);
        const active = Boolean(round);
        const selected = selectedPot === potNo;
        return (
          <Col xs={12} md={6} key={potNo}>
            <Card
              size="small"
              hoverable={Boolean(onSelect)}
              onClick={() => onSelect?.(potNo)}
              style={{
                borderColor: selected ? '#2f6b3f' : active ? '#cf1322' : undefined,
                borderWidth: selected ? 2 : 1,
                background: active ? '#fff7f6' : '#f6fbf7',
                cursor: onSelect ? 'pointer' : 'default',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text strong>{potNo}</Text>
                {active ? <Tag color="red" icon={<FireFilled />}>占用中</Tag> : <Tag color="green">空闲</Tag>}
              </div>
              {round ? (
                <div style={{ marginTop: 8, fontSize: 12, color: '#6b7a70', lineHeight: 1.8 }}>
                  <div>
                    <Text strong>{round.potRoundNo}</Text>
                  </div>
                  <div>
                    {herbName(round.herbId)} · {round.frozen.methodName}
                  </div>
                  <div>投料 {round.frozen.feedKg}kg · {round.startOperator} 开班</div>
                  <div>{formatDate(round.startedAt)} 开工</div>
                  <div>
                    已交接 {round.handovers.length - 1} 次 · 现班组：
                    {round.handovers[round.handovers.length - 1]?.toOperator}
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 8, fontSize: 12, color: '#9aa89e' }}>可在此锅位开工新锅次</div>
              )}
            </Card>
          </Col>
        );
      })}
    </Row>
  );
}
