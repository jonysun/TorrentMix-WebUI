## Why

`Loader`、`Sidecar` 和手动 `Dist` 安装都依赖同一套发布产物契约，但这套契约目前主要散落在脚本和文档里，缺少明确的规格与自动化校验。现在在四种模式继续扩展之前，需要先把 `latest.json`、`manifest.json`、`loader.html` 和 `dist.zip` 的约束固定下来，避免一次发布回归同时打坏多种分发路径。

## What Changes

- 明确 `pnpm build:publish` 生成的发布产物契约，包括必需文件、相对路径语义、校验字段和压缩包布局。
- 明确 `Loader` 与 `Sidecar` 消费发布产物时的版本解析、资源定位、校验和失败处理行为。
- 为共享分发链补充自动化 smoke 测试，让 CI 能在发布前捕获跨模式回归。
- 更新部署文档，统一 `Loader`、`Sidecar` 和 `Dist` 三种模式对发布产物的预期。

## Capabilities

### New Capabilities
- `distribution-release-contract`: 约束 `build:publish` 生成的 `latest.json`、`manifest.json`、`loader.html` 与 `dist.zip` 产物及其不变量。
- `distribution-consumers`: 约束 `Loader` 与 `Sidecar` 如何解析、校验并消费发布产物。

### Modified Capabilities
- None.

## Impact

- Affected code: `scripts/release/build-publish.mjs`, `deploy/sidecar/updater.mjs`, `README.md`, `README.zh-CN.md`, `.github/workflows/release.yml`, `tests/*`.
- Affected artifacts/APIs: `latest.json` schema, `manifest.json` 文件记录与入口字段, `loader.html` 启动行为, `dist.zip` 根目录布局。
- Systems: `Loader`, `Sidecar`, `Dist`, 以及发布到 `gh-pages` 的共享产物链。
- Dependencies: 优先复用现有 Node 测试栈；只有在 `Loader` 行为无法被现有测试手段可靠覆盖时，才再评估是否引入额外浏览器测试依赖。
