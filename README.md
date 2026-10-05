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
| 路由 | React Router 6（5 条路由） |
| 状态 | Zustand（herbStore / methodStore / batchStore / sampleStore / wokStore） |
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
│   └── src/
│       ├── types/             # herb-material / processing-method / process-batch / retain-sample / wok-batch
│       ├── stores/            # herbStore / methodStore / batchStore / sampleStore / wokStore
│       ├── components/common/ # RatioCalculator / FireLevelTag / CabinetGrid / WokPotGrid / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── hooks/             # useHerbFilter / useRatio
│       ├── pages/             # ProcessBoard / HerbList / MethodList / WokHandover / BatchBoard / SampleLedger
│       ├── router/index.tsx   # 路由表
│       └── utils/             # db.ts / degree.ts / export.ts / crossTab.ts / seed.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 首页总览 | 锅位占用与锅上进行中锅次、留样到期提示、最近工序时间线、平均得率 |
| `/herbs` | 药材台账 | 药材与批次登记，按基原/药用部位筛选，按药材分组汇总 |
| `/methods` | 炮制方法 | 辅料比例、火力与判断标准维护，辅料折算台与复制派生 |
| `/woks` | 锅次交接 | 开工占锅位并冻结方法投料；换班只追加接手；收锅释放锅位 |
| `/batches` | 工序记录台 | 选方法自动带出辅料比例/火候/判断标准，录入火候与得率并判定程度 |
| `/samples` | 留样台账 | 柜位网格、到期提醒、按日期追加观察记录 |

## 锅次交接并发规则

- **开工即占锅位、冻结数据**：`wokBatches` 表以 `[pot+status]` 复合索引在同一 IndexedDB 事务内判定锅位占用，并把当时的方法参数、辅料比例、投料量与辅料计划用量快照到锅次上；同锅位存在进行中锅次时拒绝开工。
- **换班只追加**：交接记录与异常记录只能向数组追加，前班冻结字段与历史交接不可改；后班在详情页只能看到只读的交接链。
- **并发只认先写入的一笔**：锅次带 `revision` 乐观锁，两个页面同时接手或收锅时，事务内重新读取并比对修订号，后到的一笔报冲突、不写入；页面保留录入草稿并显示冲突条（接手可在刷新后仍追加为新一笔，收锅需核对后重提）。
- **草稿与恢复**：开工/接手/收锅录入自动存到 `wokDrafts`（按标签页会话隔离）；写入失败或浏览器关掉再打开，重新装载未完成锅次、锅位占用与草稿，可一键恢复。
- **留样保护**：收锅生成的工序记录批号即锅次号（`batches.wokId` 双向关联），留样台账按此显示同一锅次；已产生留样的锅次作废时在事务内拦截，只能登记异常原因；收锅后未留样作废会连带删除其工序记录。
- **多标签页同步**：`utils/crossTab.ts` 通过 BroadcastChannel（不支持时回退 storage 事件）广播写入，其他页面立即重新装载；页面重新可见时再兜底刷新。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbherbprocess-db`），表：`herbs`、`methods`、`batches`、`samples`、`wokBatches`、`wokDrafts`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为 `batches` 增加 `locked` 索引并回填；`db.version(3)` 增加锅次/草稿表并为 `batches` 增加 `wokId` 索引（新增表无需回填）。升级前可用顶栏「导出备份」导出全量 JSON（备份含锅次，不含未提交草稿）。
- 并发逻辑的 Node 端验证：`cd frontend && npx tsx scripts/test-wok.ts`（fake-indexeddb，覆盖占锅、并发接手/收锅、留样保护、作废一致性与草稿恢复）。
- 首次打开且表为空时写入一批示例台账（`src/utils/seed.ts`），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
