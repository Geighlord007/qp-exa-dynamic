# dsh-web-search-exa-dynamic

[English](README.md) | 简体中文

[Exa](https://exa.ai) 支撑的 `WebSearchProvider`，接入
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `ctx.web` seam。
**默认开启 Exa Dynamic Highlights**，并提供 `/exa` 命令，在运行时改高亮、检索类型和返回条数。

```sh
dsh plugin --profile web add dsh-web-search-exa-dynamic
```

## 为什么需要它

官方的 `@deepseek-ai/dsh-web-search-exa` 够不到 Dynamic Highlights，是两处**互相独立**的硬伤：

1. **请求体写死。** 它发的是 `contents.highlights.highlightsPerUrl`，配置里没有任何字段能影响到
   `dynamic`。
2. **Dynamic Highlights 是 beta 能力，需要请求头。** 每个设了 `dynamic: true` 的请求都必须同时带上
   `Exa-Beta: dynamic-highlights-2026-08-28`。那个提供方只发 `authorization`、`content-type`、
   `accept`、`user-agent`——没有 `Exa-Beta`。缺了它 Exa 直接回 HTTP 400（实测）：

   ```json
   {"error":"'highlights.dynamic' is in beta. Send the 'Exa-Beta: dynamic-highlights-2026-08-28' request header to use it.","tag":"INVALID_REQUEST"}
   ```

本插件两样都发，并且彻底去掉了 `highlightsPerUrl`——对着真实 API 实测，Exa 已经忽略这个参数，
传 1 和传 5 返回**逐字节相同**的结果。改用 `maxCharacters`，那才是关掉动态高亮时真正生效的旋钮。

## 实测数据

真实 `/search` 调用，同一个查询，8 条结果：

| 配置 | 高亮字符数 |
| --- | --- |
| 官方提供方的默认值（无可用旋钮） | 51,152 |
| 本插件 `dynamicHighlights: false` + `highlightsMaxCharacters: 1500` | 10,973 |
| 本插件 `dynamicHighlights: true`（默认） | 12,716 |

Dynamic Highlights 不是一刀切截断：它把所有召回文档拼成一条输入、只做一次前向，在**全局范围**分配
共享预算——好内容多给，冗余的不给。

## 安装

```sh
dsh plugin --profile web add dsh-web-search-exa-dynamic
```

包自带 `dsh.bundle` 清单，安装后 bundle patch 会**自动插入 provider 行**，不需要手写。

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里覆盖 `web` 那一行来选中它：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: exa
    fetchProvider: http
```

> patch 是**整块替换**目标行的 `config`、不做合并，所以 `fetchProvider: http` 必须一起重写，
> 否则抓取提供方会丢。

然后给密钥，两种方式。写进插件配置：

```yaml
- id: web-search-exa-dynamic
  name: dsh-web-search-exa-dynamic
  config:
    apiKey: '你的 Exa 密钥'
```

或者走环境变量。`apiKey` 标了 `role('secret')`，不会出现在任何 `describe()` 响应里——但明文配置文件
终究是明文配置文件，能用环境变量就尽量用。

> **关于 `$DSH_HOME/.env`。** 插件通过 harness 的启动环境快照读取 `apiKeyEnv`（默认 `EXA_API_KEY`），
> 该快照按文档会查阅继承环境、调用目录的 `.env` 与 Harness 主目录的 `.env`。这在有的部署里有效、
> 有的无效——在一台 Windows 机器上，文件内容正确但快照里就是没有这个变量，最后靠上面的
> `apiKey` 配置解决。如果你的 provider 报 `registered but unavailable`，就是密钥没送到，直接写
> `apiKey`。

改环境变量后要重启 `dsh web`。`cordis.patch.yml` 本身是热加载的，所以配置改动不用重启。

## 配置字段

全部有安全默认值，通常只需要提供密钥。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `providerId` | `exa` | 注册 id。只在需要与另一个 Exa 提供方共存时改。 |
| `apiKey` | 未设置 | 字面密钥；不设则回退到 `apiKeyEnv`。 |
| `apiKeyEnv` | `EXA_API_KEY` | `apiKey` 未设时读取的环境变量名。 |
| `baseURL` | `https://api.exa.ai` | Exa 端点；会追加 `/search`。 |
| `searchType` | `auto` | 检索类型，见下。可用 `/exa type` 运行时改。 |
| `numResults` | `8` | 来源上限。可用 `/exa results` 运行时改。 |
| `dynamicHighlights` | `true` | 默认开；开启时自动带上必需的 `Exa-Beta` 头。可用 `/exa` 运行时改。 |
| `highlightsMaxCharacters` | 未设置 | 每页高亮上限，**仅**在 `dynamicHighlights` 为 false 时生效。 |

`dynamicHighlights` **不会**和 `highlightsMaxCharacters` 同时发——动态开启时共享预算由 Exa 自行分配，
官方文档也明确警告两者不要并用。

## `/exa` 命令

敲在输入框里。它直接对界面执行，**不产生模型消息**。

| 命令 | 作用 |
| --- | --- |
| `/exa` | 切换 Dynamic Highlights |
| `/exa on` / `/exa off` | 明确设置 |
| `/exa type` | 列出可用的检索类型 |
| `/exa type deep` | 设置检索类型 |
| `/exa results` | 报告来源上限 |
| `/exa results 3` | 设置来源上限 |
| `/exa status` | 一次报全，含真实天花板 |

写入落在 `web-search-exa-dynamic` settings 命名空间的**用户层**，跨重启保留。清掉那一节即回到插件
配置的默认值。

实测同一个 provider 实例、同一个查询：关掉动态高亮让同一次搜索从 12,716 字符变成 57,958 字符——
差 4.6 倍，**下一次搜索即刻生效**。

## 检索类型

Exa 的 `type` 就是延迟／质量的旋钮。**8 种全部对着真实 API 验证过**；同一查询、8 条结果的实测耗时：

| 类型 | 实测 | 用途 |
| --- | --- | --- |
| `keyword` | 464 ms | 纯关键词，最快 |
| `neural` | 737 ms | 语义检索 |
| `fast` | 798 ms | 快，质量损失极小 |
| `instant` | 856 ms | 实时场景（对话、语音） |
| `auto` | 1,914 ms | **默认** |
| `deep-lite` | 3,116 ms | 轻量综合输出 |
| `deep` | 5,282 ms | 多步推理 |
| `deep-reasoning` | 18,278 ms | 最难的研究任务 |

官方提供方的 schema 只列了 `auto`、`keyword`、`neural` 三种——那套已经过时。本插件全部开放。

### `deep*` 在这个 seam 下有折扣

用本插件自己的类实测，同一查询，动态高亮开启：

| 类型 | 耗时 | 返回来源数 |
| --- | --- | --- |
| `fast` | 718 ms | 8 |
| `auto` | 215 ms | 8 |
| `deep` | 6,891 ms | 3 |
| `deep-reasoning` | 14,776 ms | 4 |

原始 API 对 `deep` 是返回 8 条的；其余几条**没有非空白高亮，被整个丢弃了**——seam 没有别的字段能当
snippet，编造一个会让 seam 说谎。而 `deep*` 真正值钱的是跨来源综合出的 `output`，`WebSearchSource`
里没有字段承载它。所以在这个 seam 下，实用区间是 `keyword`、`neural`、`fast`、`instant`、`auto`。

## 返回条数归 `dsh-tool-web` 管

这一条容易误解，说清楚：

- 模型侧 `web_search` 工具的参数**只有 `queries`**——模型无法要求条数。
- 天花板归 `dsh-tool-web`：`searchMaxResults`，默认 8。它自己的注释：
  *"The consumer owns the returned-context limit; providers and models do not."*
- 工具**每次调用都会传 `maxResults`**，seam 再按它截断结果——所以**任何提供方都不可能超过天花板**。

于是本插件的 `numResults` 是**单向的**：能拉低，拉不高。

| 你设的 | 工具天花板 | 实际发给 Exa |
| --- | --- | --- |
| 3 | 8 | 3 |
| 12 | 8 | 8（夹取） |
| 20 | 8 | 8（夹取） |

`/exa status` 和 `/exa results` 会报出 provider **观测到的真实天花板**，所以被夹取时是明说而不是
静默生效。要抬天花板本身，改一次 `tool-web` 那一行：

```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    searchMaxResults: 20
```

抬一次之后，上面那些就都变成运行时的 `/exa results` 决定了。注意这抬的是**当前生效的那个提供方**的
上限，所以切回 DeepSeek 时同样受影响。

## 已知限制

- **Exa 的 beta 接口可能变。** `dynamic-highlights-2026-08-28` 是 research preview，Exa 改版后需要
  更新 `DYNAMIC_BETA_VALUE`。
- **没有高亮的结果会被整条丢弃**，这是 seam 的规则。动态高亮下实测 8/8 条都带高亮，所以很少触发。
- **没有 `category`、域名/日期过滤，也没有全文。** 这些 Exa 能力本插件尚未暴露。
- **本插件与官方 Exa 提供方每个 profile 只能选一个。** 两者默认都注册 provider id `exa`；要共存需给
  其中一个设不同的 `providerId`。
- **仅测过 dsh `0.1.5-rc.1`**，peer 范围也锁在这条线上。
- **没有 settings 服务时 `/exa` 只改内存。** provider 本身照常工作；没有命令注册表时就没有 `/exa`。

## 开发

```sh
node test/index.test.js    # 32 个单元测试，不需要密钥
EXA_API_KEY=... node test/live.mjs   # 打真 API，会消耗额度
```

请**直接运行测试文件**，不要用 `node --test`：后者的 runner 会为每个文件 spawn 子进程，在受限沙箱下
会以 `spawn EPERM` 失败。

## 卸载

```sh
dsh plugin --profile web remove dsh-web-search-exa-dynamic
```

把 `cordis.patch.yml` 里的 `web` 覆盖删掉即回到内置的 DeepSeek 搜索。那个改动是热加载的，立刻生效。

## 许可

MIT
