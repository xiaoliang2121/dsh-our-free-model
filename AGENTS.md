# AGENTS.md — dsh-llm-our-free-model

本目录是**从上游导入的第三方插件**（`dsh-our-free-model`，本仓库以 git 子模块收录），不在 `../AGENTS.md` 的自研插件清单里，但仓库级约定照样适用。形态是纯 ESM 的 dsh 插件：Host 半身 `index.js` 管适配器注册、探测、设置与 webServer 路由，浏览器半身是手写单文件 `client.js`，宿主接口只在 `adapter/` 接缝里出现。

**它与其余插件的最大差别是带着本地补丁**：免费车道凭据注入（见 `../docs/limitations.md` 的「dsh-llm-our-free-model（第三方子模块，含本地补丁）」）。动手前先确认要改的地方是不是补丁面——是的话，改法要能承受上游更新。

## 文档路由（先看这里）

| 我要做什么 | 读这里 |
|---|---|
| 了解它能干什么、有哪些车道 | `README.md`「亮点」 |
| 找模块位置、Host 与浏览器半身分工 | `README.md`「实现结构」 |
| 查已知边界与不支持场景 | `README.md`「已知边界」 |
| 看免费车道上游闸门现况 | `docs/free-lane-wire.md`「结论：现在的闸门」 |
| 改免费车道传输（Bun 子进程、代理、清理） | `docs/oc-free-transport.md`「Runtime prerequisite」、`src/bun-fetch.js` |
| 改凭据、身份、请求整形 | `../docs/limitations.md`「dsh-llm-our-free-model（第三方子模块，含本地补丁）」、`src/opencode-credential.js` |
| 想"恢复"渠道包的 OpenCode 账号接入 | `docs/pr97-reviewed-channels.md`「决策」 |
| 动设置、用量、凭据落盘 | `README.md`「安全与隐私」 |
| 判定一次请求算成功还是失败 | `docs/free-lane-wire.md`「判定方法」、`src/route/classify.js` |
| 打独立服务包 / 桌面包 | `PACKAGING.md`「独立服务」 |
| 发版、签名、重建 manifest | `docs/RELEASING.md`「发布新版本」 |
| 测试：改哪跑哪 | `../docs/build.md`「测试约定（全仓库通用）」、`scripts/test-all.mjs` |
| 提交前检查与提交约定 | `../docs/Contributing.md`「5. 变更与提交约定」 |
| 排查真实失败的取证方法 | `README.md`「开发」、`scripts/probes/` |

## 常用命令

```bash
node scripts/test-all.mjs --mode contributor   # 离线全量
node scripts/opencode-credential-test.mjs      # 本仓库补丁：凭据解析与产物接线
node scripts/build-legacy-payload.mjs          # 改了 src/o2a/ 后重建产物 src/o2a.js
node scripts/build-legacy-payload.mjs --check  # 校验产物与源一致
```

## 常驻铁律（违反即错）

1. **凭据只从 `src/opencode-credential.js` 取**：免费车道的 `Authorization` 必须是真实凭据；改回匿名身份，上游会用「免费额度用尽」的 429 静默拒绝。令牌不得进日志与 UI。
2. **运行时加载的是产物 `src/o2a.js`**：只改 `src/o2a/*.js` 不生效，改完必须重建并 `--check`。
3. **新增随包文件要加两处清单**：`package.json` 的 `files` 与 `scripts/pack-standalone.mjs` 的源清单；漏一处，升级与打包套件会在临时目录里 import 失败。
4. **免费车道出网必须经 `src/bun-fetch.js`**：`/inference/*` 靠 Bun 子进程过闸；换成 Node `fetch`/`undici` 的失败表现同样是 429，看起来像额度问题。
5. **渠道包关闭 OpenCode 账号接入是刻意的**：`vendor/channel-pack` 以 `disableOpencode` 挂载、RPC 拒绝 `opencode.*`，不是待修 bug。
6. **`@deepseek-ai/*` 只允许出现在 `adapter/`**：其它目录碰宿主 API 会破坏接缝，审计门禁直接失败。
7. **本目录是子模块，补丁会被上游覆盖**：`git submodule update` 或插件自更新后补丁消失、症状静默复发；改动只放在补丁面，不要散布。
8. **改整形前先取证**：上游闸门未文档化，用 `scripts/probes/` 或真实 A/B 定因，别按"看起来应该"推断。
9. **跑离线套件前清掉 `https_proxy`/`http_proxy`/`NODE_USE_ENV_PROXY`**：否则 `channel-network` 连本机代理假失败。
10. **`client.js` 的赞助区块是生成物**：`BEGIN GENERATED SPONSOR` 到 `END` 之间由 `scripts/build-sponsor.mjs` 写入，不要手改，改完跑一次它。
11. **不自行提交**：按 `../AGENTS.md` 停在改动状态，提交由用户决定。
