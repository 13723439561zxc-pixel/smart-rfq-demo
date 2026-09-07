# Smart RFQ Demo (V1)

本项目包含英文展示网站、RFQ 提交接口和一个受保护的轻量 RFQ 管理页面。不做 AI，不改 Avoro。

目标（当前阶段）

- 客户从页面提交 RFQ（`/api/rfq`）
- 服务端先保存到 Supabase PostgreSQL（免费方案）
- 再发送 Resend 通知邮件
- 成功返回真实 RFQ 编号：`RFQ-YYYYMMDD-XXXXXX`

## 如何运行

```bash
pnpm install
pnpm start
```

启动后访问：

- `http://127.0.0.1:3000/smart-rfq-visual-demo.html`

健康检查：

- `GET /api/health`
- 返回示例：`{ "ok": true, "databaseConnected": true, "emailConnected": true }`

## 环境变量（最小配置）

在项目根目录创建 `.env`，示例见 `.env.example`。

```ini
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_RFQ_TABLE=rfqs

RESEND_API_KEY=
RESEND_FROM=
RESEND_TO=

ADMIN_USERNAME=
ADMIN_PASSWORD=
```

说明：

- `SUPABASE_SERVICE_ROLE_KEY` 和 `RESEND_API_KEY` 只在服务端读取；前端不会拿到这些值。
- `RESEND_TO` 是通知收件人邮箱（可先填你自己的测试邮箱）。
- 未填写完整时提交后返回 `notification.status = not_configured`，RFQ 仍会保存。
- `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 只在服务端使用，用于保护 `/admin` 和管理接口。请使用独立的长密码，不要提交到 Git。

## RFQ 管理页面

- 地址：`/admin`
- 浏览器会要求输入 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。
- 页面支持查看 `rfqs` 表、按状态筛选，以及把状态更新为 `new / contacted / quoted / won / lost`。
- 所有读取和修改操作都经过服务端认证；Supabase service role key 不会发送给浏览器。
- 公网部署时必须在 Render 的服务端环境变量中设置管理账号和密码。

## Supabase（免费方案）

1. 打开 [Supabase 官网](https://supabase.com/) 注册并登录（免费额度）。
2. 新建一个项目（Free）。
3. 进入 `Settings -> API`，复制：
   - `Project URL`（填 `SUPABASE_URL`）
   - `service_role` key（填 `SUPABASE_SERVICE_ROLE_KEY`）
4. 进入 SQL Editor，执行下方建表 SQL（按 `rfqs` 表名，字段含 `status`）。

```sql
create table if not exists public.rfqs (
  id text primary key,
  created_at timestamptz not null default now(),
  name text not null,
  company text,
  email text not null,
  phone_or_whatsapp text,
  country text not null,
  product text not null,
  quantity text not null,
  specifications text,
  notes text,
  status text not null default 'new'
);

create index if not exists idx_rfqs_created_at on public.rfqs (created_at desc);
```

注意：项目里仍默认使用 `rfqs`，如你后续要改名 `inquiries`，可把 `.env` 的 `SUPABASE_RFQ_TABLE` 改为 `inquiries`。

## Resend（免费方案）

1. 打开 [Resend 官网](https://resend.com/) 注册并登录（免费额度）。
2. 先创建 API Key（建议 Full Access/Send email）。
3. `RESEND_FROM` 和 `RESEND_TO`：
   - 零成本先验证链路：可先填 `RESEND_FROM=onboarding@resend.dev`，并把 `RESEND_TO` 设为你自己的邮箱（注意该域名测试期通常只允许发往自己地址）。
   - 要发给外部客户前，请在 Resend 控制台 `Domains` 中添加并验证你自己的发送域名，再把 `RESEND_FROM` 改为该域名下地址（例如 `noreply@yourdomain.com`）。
4. 把 API Key 填入 `RESEND_API_KEY`。

## 接口流程

1. `/api/rfq` 接收提交。
2. 先写库（`rfqs`，`status = 'new'`）。
3. 再发送邮件通知。
4. 邮件发送失败不回滚数据库。

返回示例（邮件已发）：

```json
{
  "success": true,
  "data": {
    "id": "RFQ-20260905-ABC123",
    "status": "new",
    "notification": {
      "status": "sent"
    }
  }
}
```

返回示例（邮件未配置）：

```json
{
  "success": true,
  "data": {
    "notification": {
      "status": "not_configured"
    }
  }
}
```

返回示例（邮件失败）：

```json
{
  "success": true,
  "data": {
    "notification": {
      "status": "failed",
      "message": "邮件发送失败：..."
    }
  }
}
```

## 测试

```bash
pnpm test
```

覆盖场景：

- Resend mock 成功
- 数据库失败
- 邮件未配置（not_configured）
- 邮件失败但 RFQ 仍保存
- 参数错误

## 真实端到端验证（0 元）

1. 按上面的两步先配置 `SUPABASE_*` 和 `RESEND_*`（先可先只配 Supabase）
2. 启动服务：`pnpm start`
3. 访问 `http://127.0.0.1:3000/api/health`
4. 打开 `http://127.0.0.1:3000/smart-rfq-visual-demo.html` 并提交一条测试 RFQ
5. 观察返回的 `data.id` 和 `data.notification.status`
6. 在 Supabase 表 `rfqs` 查询新增记录，确认 `status` 为 `new`
7. 如果 `RESEND_FROM/RESEND_TO` 可用，确认收件箱收到通知邮件

## 免费方案限制（当前阶段）

- Supabase Free（来源于官方定价）：
  - 50,000 MAU、500MB 数据库、5GB 外网流量、1GB 文件存储。
  - 1 周不活跃会暂停项目。
- Resend Free（来源于官方定价）：
  - 3,000 封/月，且 100 封/天
  - 可能出现：无验证发送域名/配额超限时会返回发送失败（需按官方控制台提示调整）
  - 免费阶段建议优先确认发送地址与域名验证配置

## 说明

- 目前未接入 OpenAI API，未做自动报价。
- 未引入域名购买、服务器购买、数据库套餐购买。
- 依赖项：`@supabase/supabase-js`。

## 部署（建议 Render）

目标：公网同时支持静态页面、`GET /api/health`、`POST /api/rfq`，并保持现有后端逻辑不变。

建议优先选 Render（可低成本测试）：

- 与当前 `server.js` 的 `node http` 长驻服务模式直接兼容；
- 支持设置环境变量，不改代码即可注入秘密（`SUPABASE_SERVICE_ROLE_KEY`、`RESEND_API_KEY`）；
- 无需改造前端或 API，直接发布原有单仓库项目；
- 适合先做公网 Demo 验证。

部署时请在平台环境变量中填写：

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_RFQ_TABLE`（默认 `rfqs`）
- `RESEND_API_KEY`
- `RESEND_FROM`
  - `RESEND_TO`
  - `ADMIN_USERNAME`
  - `ADMIN_PASSWORD`
- `CORS_ORIGINS`（你将访问的公网域名，例如 `https://your-demo.onrender.com`）
- `SECURITY_HEADERS_ENABLED`（可选，默认 `true`）

部署前确认：

- `.env` 仅用于本地，不提交；`data/` 不在前端读取关键业务，页面使用本地文件服务；
- 运行命令使用仓库现有：`pnpm install`、`pnpm start`。

部署完成后验证：

1. 访问公网 URL（根路径）打开页面；
2. 访问 `GET /api/health`，确认 `ok: true`；
3. 提交一条测试 RFQ，返回 `data.id`（格式 `RFQ-YYYYMMDD-XXXXXX`）；
4. 到 Supabase 表 `rfqs` 确认新增一条状态为 `new` 的记录；
5. 到接收邮箱确认 `New RFQ | ...` 通知邮件已到达。

### 使用 Render 蓝图（推荐）

本仓库已新增 `render.yaml`，包含服务启动与健康检查配置。你可直接在 Render 选择 **New → Blueprint**（或手动新建 Web Service）：

1. 连接本仓库；
2. 识别到 `render.yaml` 后会自动创建 `smart-rfq-demo` 服务；
3. 在环境变量中只需补齐：
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_RFQ_TABLE`
   - `RESEND_API_KEY`
   - `RESEND_FROM`
   - `RESEND_TO`
   - （可选）`CORS_ORIGINS`
4. 点击 Deploy。

蓝图里 `CORS_ORIGINS` 的默认值写的是 `https://RENDER_SERVICE_NAME.onrender.com`，部署后请按你的真实地址修改（必须在 Render 的环境变量里覆盖）。




