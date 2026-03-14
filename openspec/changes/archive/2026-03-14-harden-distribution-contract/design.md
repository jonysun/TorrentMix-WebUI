## Context

当前仓库已经通过 `scripts/release/build-publish.mjs` 生成 `latest.json`、`manifest.json`、`loader.html` 和版本化的 `dist.zip`。`Loader` 通过 `latest.json` 和 `manifest.json` 解析远端发布，`Sidecar` 通过 `latest.json` 中的 `distZip` 与 `distZipSha256` 完成下载和安装，而手动 `Dist` 安装则依赖压缩包解压后直接可作为后端 WebUI 根目录使用。

问题在于，这条链的关键约束还主要隐含在脚本里：字段名、相对路径语义、压缩包根目录结构、`Loader` 的固定版本优先级，以及 `Sidecar` 的失败保护都没有被系统化地定义和验证。当前已有测试更偏向前端适配层与部分 gateway 逻辑，对共享分发链几乎没有专门覆盖。

## Goals / Non-Goals

**Goals:**
- 将共享发布产物视为稳定契约，而不是脚本内部细节。
- 为 `Loader`、`Sidecar` 与 `Dist` 统一一套可验证的发布语义。
- 在 CI 中对发布产物和消费链路增加足够的 smoke 校验，尽早发现跨模式回归。
- 让文档承诺与实际实现、测试面保持一致。

**Non-Goals:**
- 不在此 change 中重做 `Standalone Service` / `Desktop` 的 gateway runtime。
- 不在此 change 中引入新的部署模式。
- 不修改与分发契约无关的前端功能、适配器行为或网关配置 API。
- 不主动设计 breaking 的发布协议升级；本次以固化和验证现有语义为主。

## Decisions

### 1. 用两个 capability 拆分“生产者契约”和“消费者行为”

将本 change 拆成 `distribution-release-contract` 与 `distribution-consumers` 两个 capability。

- 这样可以把 `build:publish` 的产物不变量与 `Loader` / `Sidecar` 的消费行为分开描述。
- `Dist` 的可安装性主要来自压缩包布局，因此归属于发布产物契约，而不是单独再开一个 capability。

备选方案：
- 单一大 spec：写起来更快，但生产者与消费者边界会混在一起，后续扩展难维护。
- 按模式各开 spec：会重复描述同一套 `latest.json` / `manifest.json` 约束。

### 2. 保持 `latest.json` 为唯一公共入口，发布路径继续使用相对 URL

`latest.json` 继续作为公共入口，`manifest.json`、`loader.html` 和 `dist.zip` 的对外路径都保持相对 `latest.json` 可解析。

- 这与当前 `Loader`、`Sidecar` 和 `gh-pages` 发布流程一致。
- 相对路径约束能继续兼容自托管发布源、`gh-pages`、以及不固定域名的镜像站点。

备选方案：
- 让 `Sidecar` 直接读取独立的 `manifest.json`：会把版本仲裁逻辑拆成两份，增加消费者差异。
- 在 `latest.json` 中写死绝对 CDN URL：会削弱自托管和镜像场景的可移植性。

### 3. 测试策略采用“契约 smoke + 消费者夹层验证”

测试分三层：

- 生产者层：直接验证 `build:publish` 的输出是否满足文件集合、路径、校验字段和压缩包布局约束。
- `Sidecar` 层：用本地 fixture 发布目录验证安装成功、重复安装短路、校验失败和坏包失败。
- `Loader` 层：优先把版本解析/资源定位这类可测试逻辑抽出或构造成可驱动的夹层验证，而不是一上来就上重量级全浏览器 E2E。

备选方案：
- 只跑 `pnpm build:publish`：能发现构建失败，但无法发现契约层回归。
- 直接上完整浏览器/container E2E：覆盖面高，但引入成本和反馈时延更大，不适合作为第一步。

### 4. 优先复用现有 Node 测试栈，把脚本变成可校验单元

仓库已经有基于 Node 自带测试运行器的测试体系，因此实现时优先复用这条链路：

- `build-publish` 侧抽取或包装关键逻辑，使其可以在测试中稳定断言。
- `Sidecar` 通过本地 HTTP fixture 或文件夹 fixture 验证安装行为。
- 只有当 `Loader` 的内联脚本行为无法被现有方法可靠覆盖时，才评估增加浏览器自动化依赖。

备选方案：
- 继续保持所有逻辑都内联在脚本字符串里，再做文本匹配式测试：太脆弱。
- 立刻引入新测试框架：收益不一定大于迁移成本。

### 5. 将分发契约校验提升为发布前置门槛

发布产物契约不是“文档约定”，而是三种模式共同依赖的运行基础。因此 CI 应该在正式发布前执行对应 smoke。

备选方案：
- 仅在本地手工验证：不够稳定，也无法阻止回归进入 tag 发布流程。

## Risks / Trade-offs

- [Risk] `Loader` 逻辑目前内联在生成的 HTML 中，测试切入点不够理想。
  -> Mitigation: 优先提取纯解析逻辑或建立可驱动的夹层测试，再决定是否需要浏览器级测试。

- [Risk] 强化契约后，可能暴露出当前依赖未文档化字段或路径的私有发布源。
  -> Mitigation: 本次以固化现有公开字段和相对路径语义为主，尽量避免无必要的字段重命名。

- [Risk] `Sidecar` 的失败保护更严格后，现有错误发布会更早暴露。
  -> Mitigation: 将失败条件文档化，并保证错误日志能明确指出是校验失败还是压缩包结构不合法。

- [Risk] 分发契约测试如果直接构建和解压真实产物，执行时间会增加。
  -> Mitigation: 区分轻量 smoke 与更深的 fixture 测试，尽量复用一次构建产物。

## Migration Plan

- 首先在不改变现有外部字段名和目录语义的前提下，引入 spec 和测试。
- 将分发契约 smoke 纳入 CI，让问题在发布前暴露，而不是在用户部署后暴露。
- 如测试收口过程中发现现有脚本必须做结构化重构，则以“不改变对外契约”为前提推进。
- 若发布门禁导致意外阻塞，可整体回退测试门禁与相关脚本修改，避免出现“契约变了但消费者没跟上”的半升级状态。

## Open Questions

- `Loader` 的验证是否能完全留在现有 Node 测试栈内，还是最终仍需要浏览器级 smoke。
- 是否需要为 `latest.json` / `manifest.json` 在文档中额外声明显式 schema version 兼容策略。
- 是否要把 `build:publish` 的部分逻辑进一步模块化到独立文件，以降低后续维护成本。
