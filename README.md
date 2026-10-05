# 中草药炮制工序记录台（gbherbprocess）

面向中药饮片厂炮制班组与质检员：登记药材批次、按炮制方法折算辅料比例与火力时间、逐批判定炮制程度、管理留样观察台账。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21809>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（6 条路由） |
| 状态 | Zustand（herbStore / methodStore / potStore / batchStore / sampleStore） |
| 存储 | IndexedDB（Dexie，库名 `gbherbprocess-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21809
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   ├── verify-pots.ts         # 锅次交接并发/冻结/恢复规则的 Node(fake-indexeddb) 验证
│   └── src/
│       ├── types/             # herb-material / processing-method / process-batch / pot-round / retain-sample
│       ├── stores/            # herbStore / methodStore / potStore / batchStore / sampleStore
│       ├── components/common/ # RatioCalculator / FireLevelTag / CabinetGrid / PotGrid / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── components/pot/    # PotRoundModals（开工/接手/收锅/异常）/ PotRoundDrawer
│       ├── hooks/             # useHerbFilter / useRatio / usePotDraft
│       ├── pages/             # ProcessBoard / HerbList / MethodList / PotBoard / BatchBoard / SampleLedger
│       ├── router/index.tsx   # 路由表
│       └── utils/             # db.ts / degree.ts / pot-backfill.ts / pot-conflict.ts / pot-draft.ts / pot-sync.ts / export.ts / seed.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 首页总览 | 在锅锅次与锅位占用、待判定记录、留样到期提示、最近工序时间线、平均得率 |
| `/herbs` | 药材台账 | 药材与批次登记，按基原/药用部位筛选，按药材分组汇总 |
| `/methods` | 炮制方法 | 辅料比例、火力与判断标准维护，辅料折算台与复制派生 |
| `/pots` | 锅次交接 | 开工占用锅位并冻结方法/投料，换班只追加接手，收锅释放锅位；并发冲突只认先写入，草稿崩溃可恢复 |
| `/batches` | 工序记录台 | 选方法自动带出辅料比例/火候/判断标准，录入火候与得率并判定程度（显示锅次号） |
| `/samples` | 留样台账 | 柜位网格、到期提醒、按日期追加观察记录（显示锅次号） |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbherbprocess-db`），表：`herbs`、`methods`、`batches`、`potRounds`、`samples`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为 `batches` 增加 `locked` 索引并回填历史数据。
- `db.version(3)` 新增锅次交接：
  - `potRounds.&activePot` 唯一索引保证同一锅位至多一笔「在锅」记录——两个页面同时开工抢锅时只有先写入的一笔落库（`POT_OCCUPIED`）；`&potRoundNo` 保证锅次号唯一。
  - 锅次记录带 `version` 乐观锁：换班接手 / 收锅 / 异常登记为「事务内重读 + 版本号比对 + 只追加」，后到提交收到 `VERSION_STALE`，表单保留为草稿并显示冲突，可载入最新锅次后重提。
  - 开工把当时炮制方法与投料量冻结进 `frozen` 快照，之后方法台账改动不影响在锅锅次；接手记录只追加，任何后续班组不能改前班数据。
  - 收锅在同一事务内删除锅位占用、写入口 `已收锅` 锅次并生成带同一 `potRoundNo` 的已锁定工序记录；留样登记回挂锅次，**已产生留样的锅次不能作废，只能登记异常原因**；无留样的在锅锅次可作废并释放锅位。
  - 锅位占用与锅次在 IndexedDB，未提交表单在 localStorage 草稿；写入失败或关掉浏览器后重开，自动恢复未完成锅次、锅位占用与草稿。
  - 同源多页签通过 BroadcastChannel（页面重新可见时兜底刷新）同步锅次变更。
  - v3 升级时历史 `batches` 自动回填为「已收锅」锅次（不占锅位），并回写 `batches` / `samples` 的锅次关联（见 `src/utils/pot-backfill.ts`）。升级前可用顶栏「导出备份」导出全量 JSON。
- 并发/冻结/恢复规则可在 Node 下验证：`npm run verify:pots`（fake-indexeddb，含双页签并发与 v2→v3 升级思路）。
- 首次打开且表为空时写入一批示例台账（`src/utils/seed.ts`，含一口占用 1 号锅、已换过班的演示锅次），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
