# CFData-WEB 多源 TXT 聚合与清洗服务 (Cloudflare Worker)

专为 [CFData-WEB](https://github.com/PoemMisty/CFData-WEB) 等优选工具设计的轻量级多源 TXT 实时聚合服务。通过 Cloudflare Workers + KV 驱动，将数十个分散的优选 IP/域名 TXT 链接合并为**单一聚合链接**，支持网页可视化增删源、智能去重、防网页污染及按标签/类型动态筛选。

---

## 一、 核心特性

1. **纯 `/admin` 网页驱动（零代码维护）**：代码内无任何写死的默认源，所有 TXT 链接均通过 `/admin` 网页后台粘贴管理，随改随存、即时生效。
2. **原生支持跨域 (CORS)**：内置完整跨域响应头，完美支持 `CFData-WEB` 等纯前端工具在浏览器中直接拉取。
3. **防污染与严格格式清洗**：
   - 自动剥离 Windows 文本常见的 UTF-8 BOM 头（`\uFEFF`）。
   - 自动识别并拦截失效源返回的 HTML 网页（如 404 页、域名过期页、Cloudflare 质询页）或 JSON 报错，防止脏数据混入测速列表。
   - 严格校验并分类 `IPv4`、`IPv6`、`CIDR`、`Domain` 四种合法格式及端口号（1~65535），兼容空格或逗号分隔端口的写法。
4. **智能去重与备注保留**：
   - 提取 `#` 号前的核心地址（忽略大小写差异）作为去重依据，防止同一 IP 在不同源中因备注不同而被重复测速。
   - **择优保留**：若同一 IP 在 A 源无备注、在 B 源带有 `#备注`，合并时优先保留带有详细备注的那一条。
   - **自动补标签**：若上游源为纯 IP 无备注，自动根据你在后台配置的 `@标签` 补全为 `IP#标签`（如 `1.2.3.4#JP`）。
5. **单源抽样与超时熔断**：
   - 支持对上千行的大源设置 `*100`（随机抽样 100 条）或 `+100`（截取前 100 条），避免大源拖慢整体测速。
   - 单源独立 `6秒` 全链路超时保护，个别上游源挂掉或卡死绝不影响整体返回。

---

## 二、 完整部署步骤

### 第一步：创建 KV 命名空间
1. 登录 Cloudflare 控制台，左侧菜单进入 **存储和数据库 (Storage & Databases)** -> **KV**。
2. 点击 **Create a namespace (创建命名空间)**，名称随意填写（例如 `cfdata-txt-kv`），点击确认创建。

### 第二步：创建 Worker 并部署代码
1. 左侧菜单进入 **Workers 和 Pages** -> 点击 **Create (创建)** -> 选择 **Create Worker**。
2. 输入服务名称（例如 `cf-txt-merge`），点击 **Deploy (部署)**。
3. 点击右上角 **Edit code (编辑代码)**，清空原有默认代码，将项目中的 `worker.js` 完整粘贴进去，点击右上角 **Deploy** 保存。

### 第三步：绑定 KV 数据库（必做）
1. 返回该 Worker 的管理页，点击顶部 **Settings (设置)** -> **Bindings (绑定)**。
2. 点击 **Add (添加)** -> 选择 **KV Namespace**。
3. 按以下要求填写后保存部署：
   - **Variable name (变量名称)**：必须严格填写为 `TXT_KV`（全大写）。
   - **KV namespace**：选择第一步创建的 `cfdata-txt-kv`。

### 第四步：设置安全密码（推荐）
1. 在 Worker 的 **Settings (设置)** 页面中，找到 **Variables and Secrets (变量和机密)**。
2. 点击 **Add (添加)**，选择纯文本（Text）类型，按需添加：
   - `ADMIN_PWD`（推荐）：设置 `/admin` 网页管理后台的解锁与保存密码。
   - `TOKEN`（可选）：设置拉取 TXT 时的接口密码。若设置了此项（如 `123456`），在 `CFData-WEB` 拉取时需在 URL 末尾加上 `?token=123456`。自用图省事可不设 `TOKEN`，仅设 `ADMIN_PWD` 即可。

### 第五步：绑定自定义域名（必做）
1. 在 Worker 的 **Settings (设置)** 页面中，找到 **Domains & Routes (域和路由)**。
2. 点击 **Add (添加)** -> 选择 **Custom Domain (自定义域)**。
3. 输入已托管在 Cloudflare 的二级域名（例如 `txt.example.com`），保存并等待证书生效。

---

## 三、 `/admin` 后台管理与配置语法

在浏览器访问 `https://txt.example.com/admin` 即可打开可视化管理面板。

### 1. 面板操作流程
1. 若设置了 `ADMIN_PWD`，先在底部密码框输入密码，点击 **「读取配置」** 解锁当前列表。
2. 在文本框中粘贴或修改 TXT 源链接（每行一个）。
3. 点击 **「在线测试当前源状态」**，下方会实时输出每个链接的响应耗时与有效节点数，验证无误后点击 **「保存配置」** 即可生效。

### 2. 配置编写语法
每行一条规则，各参数之间用**空格**分隔：
`https://数据源链接 [@分类标签] [*随机抽样数 或 +截取前N条]`

```text
# === 1. 基础写法：链接 + 空格 + @标签名 ===
[https://bestcf.pages.dev/domain/all.txt](https://bestcf.pages.dev/domain/all.txt) @DOMAIN
[https://bestcf.pages.dev/vps789/top100.txt](https://bestcf.pages.dev/vps789/top100.txt) @TOP100
[https://bestcf.pages.dev/tiancheng/all.txt](https://bestcf.pages.dev/tiancheng/all.txt) @TIANCHENG

# === 2. 临时停用：行首加 # 号即可注释停用，无需删除链接 ===
# [https://bestcf.pages.dev/random-region/KR/all.txt](https://bestcf.pages.dev/random-region/KR/all.txt) @KR

# === 3. 随机抽样 (*数量)：从该源随机抽 N 条，防止几千行的大源测速过慢 ===
[https://bestcf.pages.dev/random-region/JP/all.txt](https://bestcf.pages.dev/random-region/JP/all.txt) @JP *150
[https://bestcf.pages.dev/random-region/HK/all.txt](https://bestcf.pages.dev/random-region/HK/all.txt) @HK *150

# === 4. 顺序截取 (+数量)：固定截取该源前 N 条 ===
[https://bestcf.pages.dev/random-region/SG/all.txt](https://bestcf.pages.dev/random-region/SG/all.txt) @SG +100
[https://bestcf.pages.dev/random-region/TW/all.txt](https://bestcf.pages.dev/random-region/TW/all.txt) @TW +100
```

---

## 四、 URL 参数说明与 `CFData-WEB` 调用方法

基础聚合链接（直接填入 `CFData-WEB` 即可拉取全部启用的源）：
`https://txt.example.com/`

如需按条件筛选或控制节点数量，可在链接后拼接以下查询参数（支持多个参数用 `&` 自由组合）：

| 参数名称 | 示例写法 | 功能说明 |
| :--- | :--- | :--- |
| `tag` | `?tag=HK,JP,SG` | **只拉取指定标签**：仅合并后台配置了 `@HK`、`@JP`、`@SG` 的源（不区分大小写） |
| `exclude` | `?exclude=KR,DOMAIN` | **排除指定标签**：拉取除了 `@KR` 和 `@DOMAIN` 以外的所有源 |
| `type` | `?type=ipv4` | **按地址类型过滤**：可选值 `ipv4`、`ipv6`、`domain`、`cidr`（可逗号组合，如 `?type=ipv4,domain`） |
| `limit` | `?limit=300` | **限制最终输出总数**：合并去重后，最多只输出前 N 条节点给测速工具 |
| `shuffle` | `?shuffle=1` | **全局随机打乱**：将所有合并去重后的节点顺序彻底洗牌（常与 `limit` 搭配使用） |
| `norm_port` | `?norm_port=1` | **443 端口归一化去重**：将不带端口的 `1.2.3.4` 与 `1.2.3.4:443` 视为同一地址去重 |
| `prefix_tag` | `?prefix_tag=1` | **强制追加标签前缀**：给自带备注的节点也加上标签前缀，如 `#[HK] 原备注` |
| `autotag` | `?autotag=0` | **关闭自动补备注**：默认开启（`1`），传 `0` 则对无备注的纯 IP 保持原样输出 |
| `nocache` | `?nocache=1` | **跳过边缘缓存**：绕过默认的 5 分钟缓存，强制 Worker 立即重新请求所有上游源 |
| `token` | `?token=你的密码` | **访问鉴权**：仅当在 Worker 环境变量中设置了 `TOKEN` 时需要携带 |

### 常用组合示例

- **日常全量优选**：
  `https://txt.example.com/`
- **只测香港、台湾、新加坡的纯 IPv4 节点**：
  `https://txt.example.com/?tag=HK,TW,SG&type=ipv4`
- **排除域名源，全局随机抽取 300 个节点进行极速优选**：
  `https://txt.example.com/?exclude=DOMAIN&shuffle=1&limit=300`

---

## 五、 状态诊断与注意事项

1. **查看各源存活状态 (`/status`)**：
   浏览器直接访问 `https://txt.example.com/status`（或带参数 `?status=1`），可查看所有已配置 TXT 源的 HTTP 状态、拉取耗时（ms）、有效节点条数及报错原因。
2. **上游源数量上限（49 个）**：
   Cloudflare Workers 免费版限制**单次执行最多发起 50 个子请求 (Subrequests)**。除去请求自身外，你在 `/admin` 中同时启用的（未加 `#` 注释的）TXT 链接最多不要超过 **49 个**。你目前粘贴的 20 个源完全在安全范围内。