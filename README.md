# ApiPost MCP

基于 MCP 协议和 [ApiPost 官方 OpenAPI](https://docs.apipost.net/docs/detail/2a37986cbc64000?target_id=23796913b176e1) 实现的 API 管理工具。

## 功能

- **连接测试** - 一键验证MCP服务器状态和配置
- **工作空间管理** - 查看、切换团队和项目工作空间
- **目录管理** - 创建API文档目录，支持层级结构
- **API接口管理** - 创建、查看、修改、删除接口文档
- **增量更新** - 支持字段级别的精确更新和删除
- **层级搜索** - 强化的目录层级搜索和父子关系定位
- **递归浏览** - 递归搜索子目录，支持深度限制
- **多维筛选** - 多维度搜索和批量操作
- **结构化显示** - 树形结构和分组显示
- **路径导航** - 完整路径显示，快速定位
- **权限管理** - 多种安全模式，灵活的操作权限控制

## 安装

### 环境要求

在开始安装之前，请确保您的系统已安装以下环境：

| 环境 | 版本要求 | 说明 |
|------|---------|------|
| **Node.js** | >= 18.0.0 | JavaScript 运行环境（MCP SDK 官方最低要求） |
| **npm** | >= 8.0.0 | Node.js 包管理器（通常随 Node.js 一起安装） |

#### 环境安装指南

**Node.js 安装：**
- 访问 [Node.js 官网](https://nodejs.org/) 下载 LTS 版本
- 或使用包管理器：
  ```bash
  # macOS (使用 Homebrew)
  sudo brew install node
  
  # Ubuntu/Debian
  sudo apt update && sudo apt install nodejs npm
  
  # CentOS/RHEL
  sudo yum install nodejs npm
  ```

**验证安装：**
```bash
node --version   # 应显示 v18.0.0 或更高版本
npm --version    # 应显示 8.0.0 或更高版本
```

### 开始安装

```bash
git clone https://github.com/jlcodes99/apipost-mcp.git
cd apipost-mcp
npm install && npm run build
```

## 配置

在 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "apipost": {
      "command": "node",
      "args": ["/absolute/path/to/apipost-mcp/dist/index.js"],
      "env": {
        "APIPOST_TOKEN": "your_access_token_here",
        "APIPOST_HOST": "https://open.apipost.net",
        "APIPOST_SECURITY_MODE": "limited",
        "APIPOST_DEFAULT_TEAM_NAME": "你的团队名称",
        "APIPOST_DEFAULT_PROJECT_NAME": "你的项目名称",
        "APIPOST_URL_PREFIX": "接口前缀可定义常量比如{{host}}"
      }
    }
  }
}

```

### 环境变量

| 变量名 | 是否必需 | 说明 |
|--------|------|------|
| `APIPOST_TOKEN` | 是 | API访问令牌 |
| `APIPOST_SECURITY_MODE` | 否 | 安全模式：`readonly`, `limited`, `full` |
| `APIPOST_DEFAULT_TEAM_NAME` | 否 | 默认团队名称 |
| `APIPOST_DEFAULT_PROJECT_NAME` | 否 | 默认项目名称 |
| `APIPOST_URL_PREFIX` | 否 | 接口URL前缀，自动拼接到所有新建/修改的接口路径，如 `{{host}}` |

### 安全模式说明

| 模式 | 权限 | 说明 |
|------|------|------|
| `readonly` | 只读 | 仅允许查看接口列表和详情，禁止创建、修改、删除 |
| `limited` | 读写 | 允许查看、创建、修改接口，禁止删除操作 |
| `full` | 完全访问 | 允许所有操作，包括查看、创建、修改、删除 |


## 可用工具

| 工具 | 功能 | 主要参数 |
|------|------|---------|
| `apipost_test_connection` | 连接测试 | `random_string` |
| `apipost_workspace` | 工作空间管理 | `action` (必需) |
| `apipost_create_folder` | 创建目录 | `name`, `parent_id` |
| `apipost_smart_create` | 创建接口 | `method`, `url`, `name` |
| `apipost_list` | 强化列表搜索 | `search`, `parent_id`, `target_type`, `show_structure`, `recursive`, `group_by_folder` |
| `apipost_details` | 批量完整详情及内容指纹 | `target_ids`（1～100个） |
| `apipost_detail` | 单接口详情，默认摘要 | `target_id`, `format: "json"` 获取完整内容 |
| `apipost_update` | 增量修改接口 | `target_id`, `expected_fingerprint`, 其他可选 |
| `apipost_delete` | 删除接口 | `api_ids` |

### apipost_test_connection 说明

**快速诊断工具**，适合首次使用或故障排查：
- ✅ 验证MCP服务器连接状态
- 🔧 检查环境变量配置
- 🏢 显示当前工作空间信息  
- 🛠️ 检查操作权限和安全模式
- 📊 提供系统环境详情

### apipost_workspace 说明

**统一的工作空间管理工具**，支持以下操作：

| Action | 功能 | 主要参数 | 说明 |
|--------|------|---------|------|
| `current` | 查看当前工作空间 | `show_all` | 显示当前团队、项目信息，可选显示所有可用选项 |
| `list_teams` | 列出团队 | `show_details` | 显示所有可用团队，标识当前团队 |
| `list_projects` | 列出项目 | `team_id`, `show_details` | 显示指定团队的项目列表 |
| `switch` | 切换工作空间 | `team_id`, `project_id` 或 `team_name`, `project_name` | 切换到指定的团队和项目 |

**使用示例：**
```
# 查看当前工作空间
apipost_workspace action: "current"

# 列出所有团队
apipost_workspace action: "list_teams" show_details: true

# 列出项目
apipost_workspace action: "list_projects" team_id: "your_team_id"

# 切换工作空间（支持按名称或ID）
apipost_workspace action: "switch" team_name: "团队名" project_name: "项目名"
```

### apipost_create_folder 说明

**API文档目录创建工具**，支持在指定父目录下创建新的文件夹：

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 目录名称 |
| `parent_id` | string | 否 | 父目录ID，使用"0"表示根目录，默认为"0" |
| `description` | string | 否 | 目录描述（可选） |

**使用示例：**
```
# 在根目录创建目录
apipost_create_folder name: "用户管理" description: "用户相关接口"

# 在指定目录下创建子目录
apipost_create_folder name: "认证接口" parent_id: "folder_123" description: "用户认证相关接口"
```

### apipost_list 参数说明

| 参数 | 类型 | 说明 |
|------|------|------|
| `search` | string | 搜索关键词（接口名称、URL、方法、ID、描述） |
| `parent_id` | string | 父目录ID，精确查找子项目。"0"为根目录 |
| `target_type` | string | 类型筛选：`api`(仅接口)、`folder`(仅目录)、`all`(全部) |
| `show_structure` | boolean | 显示树形结构，默认false为列表模式 |
| `show_path` | boolean | 显示完整路径，默认false |
| `recursive` | boolean | 递归搜索子目录，默认false |
| `depth` | number | 深度限制（配合recursive），默认无限制 |
| `group_by_folder` | boolean | 按目录分组显示，默认false |
| `limit` | number | 显示数量限制（默认50，最大200） |
| `show_all` | boolean | 显示全部（忽略limit限制） |

### apipost_smart_create 说明（字段列表驱动）

规则（强制）：
- 字段定义负责说明，真实示例独立传入：`responses` 使用 `fields` + 完整真实 `data`，也支持完整原生 `raw`、`expect.mock`、`expect.schema` 透传。同一组不混用两种格式；字段（含父级）填写 `desc`。
- headers/query/body/cookies 用字段列表字符串，嵌套用 `.`，数组用 `[]`（如 `meta.flags.debug`、`items[].id`），example 填真实值，不要放 JSON 字符串。
- 父级需显式声明并写 `desc`，示例：`{"key":"data","type":"object","desc":"返回体"},{"key":"data.user","type":"object","desc":"用户"},{"key":"data.user.id","type":"integer","example":1,"desc":"用户ID"}`。
- `required` 为 boolean，true/false 对应 ApiPost `not_null=1/-1`；未指定默认为选填。显式 null、false、0 和空字符串保留原值。
- `bodyRaw` 直接接收完整真实 JSON 请求字符串，不从参数表字符串 value 重建请求。更新只传 body 字段说明时保留已有 JSON 原文，只传 bodyRaw 时保留字段说明；明确 `body:"[]"` 且不传 bodyRaw 会清空请求体。
- 响应字段可用 `schema` 指定可空类型、数组元素及枚举，或用整个响应的 `schema` 描述复杂结构。
- 可选 `APIPOST_INLINE_COMMENTS=true` 时，raw 会按 `desc` 生成行内注释（mock 始终为纯 JSON）。
- 可选 `APIPOST_URL_PREFIX={{ajllxa}}` 时，创建或更新接口时会将前缀自动拼接到 URL（避免手动重复填写路由常量）。

必填：`method`、`url`、`name`。其他字段（均为字符串化 JSON 数组/对象）：
- headers/query/body/cookies：`[{"key":"X-Request-ID","type":"string","required":true,"example":"req-1","desc":"说明"}]`
- bodyRaw：完整请求 JSON 字符串。
- responses：`[{"name":"成功","status":200,"data":{"success":true},"fields":[{"key":"success","type":"boolean","desc":"是否成功"}]}]`
- auth：`{"type":"bearer","bearer":{"key":"your_token"}}`
  
字段类型：`string`/`integer`/`number`/`boolean`/`object`/`array`/`null`

示例（展示参数格式，业务值应取自实际请求及响应）：
```json
{
  "body": "[{\"key\":\"remark\",\"type\":\"string\",\"required\":false,\"desc\":\"备注，可为空\"}]",
  "bodyRaw": "{\"remark\":null}",
  "responses": "[{\"name\":\"成功\",\"status\":200,\"data\":{\"success\":true},\"fields\":[{\"key\":\"success\",\"type\":\"boolean\",\"desc\":\"是否成功\"}]}]"
}
```

### 完整回读与增量修改

`apipost_details({target_ids:[...]})` 一次请求返回 `list`、`fingerprints`、`missing_ids`；请求原文、全部响应和 schema 均不截断。单接口可用 `apipost_detail({target_id,format:"json"})`，默认 text 仅为浏览摘要，不用于合并或完整示例验收。

更新以完整回读为底合并本次字段组，携带 `expected_fingerprint: fingerprints[target_id]`。MCP 内部最新读取发现内容变化时不写入；该检查不保证内部读取到写入之间的原子性。未传字段组保留原值，传入字段组整体替换，非法 JSON 不转换为空数组写入。最终版本以写后完整回读为准。

完整数据可在工具编排中程序比较，仅输出差异摘要，避免大型示例反复进入模型上下文。HTTP 耗时日志只记录方法、路径、状态和耗时，不记录凭据及请求响应正文。新工具需要客户端重新连接 MCP 后发现。

### 本地验证

运行 `npm test`，先构建，再通过真实 MCP stdio 协议连接本机模拟 ApiPost，覆盖完整批量回读、选填、示例保真、增量修改及指纹冲突；测试不读取个人配置或连接真实 ApiPost。

## 获取 Token

1. [ApiPost OpenApi官方文档查看](https://docs.apipost.net/docs/detail/2a37986cbc64000?target_id=0)
2. 用户api_token。获取方式：Apipost客户端>工作台>项目设置>对外能力>open API

## 📝 更新日志

查看 [CHANGELOG.md](CHANGELOG.md) 了解版本更新信息。

---

💡 **提示**：这是一个专注于API接口管理的MCP工具，简化了接口创建和管理流程，提高团队协作效率。

## 联系方式

- 📧 邮箱: jlcodes@163.com
- 🐛 问题反馈: [GitHub Issues](https://github.com/jlcodes99/apipost-mcp/issues)
- 🌟 项目主页: [GitHub Repository](https://github.com/jlcodes99/apipost-mcp)

## 相关链接

- [ApiPost OpenAPI 文档](https://docs.apipost.net/docs/detail/2a37986cbc64000?target_id=23796913b176e1)
- [MCP 协议说明](https://github.com/modelcontextprotocol/specification)


⭐ 如果这个项目对你有帮助，请给我们一个星标！

---

## Fork 修改说明

本仓库 fork 自 [jlcodes99/apipost-mcp](https://github.com/jlcodes99/apipost-mcp)，在原项目基础上增加了以下功能：

### 1. 新增 RESTful 路径参数（restful）支持

- `apipost_smart_create` 和 `apipost_update` 两个工具新增 `restful` 参数，支持定义 URL 中的路径变量（如 `:id`、`:userId`）
- 格式与其他参数字段保持一致：`[{"key":"id","desc":"用户ID","type":"string","required":true,"example":"12345"}]`

### 2. URL 路径变量自动转换

- 自动将 OpenAPI 风格的 `{变量名}` 转换为 ApiPost 要求的 `:变量名` 格式
- 无论是否配置 `APIPOST_URL_PREFIX`，转换均会生效

### 3. apipost_detail 增加路径参数展示

- 查看接口详情时，输出中增加"路径参数"区域，展示已定义的 RESTful 路径变量及其描述、类型、示例值
