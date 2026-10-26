# DSH 余额 · dsh-balance

DeepSeek Harness（DSH）客户端插件：右下角一颗常驻的**余额悬浮球**，点开是明细卡片。

> 名字取的「简约」：只做一件事——让你一眼知道**还剩多少钱、今天花了多少、还能撑多久**，不塞别的。

当前版本 **0.2.0**（`package.json`）· 包名 `@local/ds-balance` · MIT

## 功能

**悬浮球**

- 常驻显示余额，可拖动，位置存本地（`localStorage`）
- 四种状态一眼分辨：正常（蓝紫）/ 余额低（黄）/ **有任务在等你确认**（黄 + 数字角标）/ 读不到数据（红 + `!`）
- 键盘可达：Tab 聚焦后 Enter / Space 开合；全局快捷键 `Alt+B` 开关卡片（在输入框里打字时不抢键）

**明细卡片**

- 总余额 / 现金 / 赠送：金额用整数「分」（`BigInt`）相加，不碰浮点；**现金或赠送为 0 时那一行不显示**
- 当前时段：高峰期（全价）/ 低峰期（5 折）
- 今日用量：调用次数、输入 / 输出 / 推理 token、统计日
- 花费：这一小时 / 今天——**按余额下降推算**，不查价格表（价格表算不准峰谷价、缓存价、模型差价）；
  采样覆盖不足时数字带 `*`，下面注明「余额采样自 HH:MM 起，更早的消费未计入」
- **24 小时余额曲线** + 「还能撑 X 天 / X 小时」，按最近 6 小时的真实消耗速度推；采样不足 30 分钟或没有消耗时显示「几乎没消耗」
- `is_available=false` 时提示「余额不足以继续调用」；底部有「充值 / 用量」链接、当前数据源与更新时间
- 「刷新」按钮手动拉一次（10 秒内连点只算一次）；点卡片外面或按 Esc 收起；拖标题栏可移动整张卡片
- 低余额提醒：低于阈值（默认 ¥2）球变黄；跌破阈值时响一次 `Windows Error.wav`，回到阈值以上才重新武装

**任务完成提醒**（不给桌宠，只要一个声音）

- 主会话每轮任务结束响一声（`notify.wav`），出错换 `Windows Error.wav`
- **短任务不打扰**：本轮 < 8 秒不响；主动中断不响；结束状态是 blocked 时只闪任务栏、不出声
- 只跟主会话，子代理（subagent）的轮次不参与
- 连续提醒至少隔 800 ms 合并一次，不会连环响
- 提示音音量 0–100 可调，`试听` 不看开关状态
- 窗口不在前台时同时**闪任务栏**（`FlashWindowEx`），前台则不闪

**等待确认**

- agent 卡在审批时，球变黄并显示数字；卡片里列出「在等什么工具 + 哪个会话」（最多显示前 2 条）
- **点一下直接跳到那个会话**（`uiWorkspace.openSession`，取不到服务就退化成不可点）
- 等待记录只在内存里：服务端最多返回 5 条，30 分钟自动作废

**中 / 英切换**

- 底部 `[EN]` / `[中]` 小胶囊，语言存本地
- 英文术语对齐官方文档：Peak / Off-peak、topped-up / granted balance

## 峰谷规则（官方）

来源：[Models & Pricing · DeepSeek API Docs](https://api-docs.deepseek.com/quick_start/pricing)

- 高峰：UTC 01:00–04:00 与 06:00–10:00，周一至周五 → 北京时间 **09:00–12:00 / 14:00–18:00**
- 其余时间（含周末、中国法定节假日全天）为低峰，价格是高峰的 **5 折**
- 节假日表内置 2026 年安排，**只参与时段判断，不在界面显示节假日名称**

## 安装

这是一个 DSH 客户端插件（host + client 两半）。目前按本地 `link:` 方式使用：

1. 把本目录放到任意位置，例如 `C:\Users\<you>\dsh-balance`
2. 在 DSH profile 的 `package.json` 里加依赖，并在原有 `bundles` 数组**末尾追加**（别覆盖已有的项）：

```json
{
  "dependencies": {
    "@local/ds-balance": "link:C:/Users/<you>/dsh-balance"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/ds-balance"]
    }
  }
}
```

3. 重启桌面 App（加载 host 半），刷新页面（加载 client 半）

> 包名保持 `@local/ds-balance`：`@local/` 是本机 link 安装用的 scope，没有发到 npm。
> 想改名发布到 npm 需要同时改 profile 里的 bundle 引用。

## 数据来源

- 余额：DSH 内置账户服务 `deepseekAccount.getBalance()`；失败时回退官方 `/user/balance`（读 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`，key 只在进程内使用）
- 用量：拦截 `llm/stream` 的 usage 帧，按日存 `~/.dsh/storages/ds-balance-usage.json`，跨日归零；界面上的「输入 token」= 缓存命中 + 未命中（DSH 的 `inputTokens` 只含未命中部分）
- 花费：每 60 秒采一次余额（前端拉数据时也顺手补一个采样点），按区间内**余额下降**累加；采样存 `~/.dsh/storages/ds-balance-samples.json`，保留 26 小时 / 最多 2000 点，曲线最多画 60 个点
- 提醒：开关状态是 `~/.dsh/storages/ds-balance-chime.off` 标记文件（存在 = 静音）；提示音日志 `ds-balance-chime.log`，通知脚本 `ds-balance-notify.ps1`，按音量预衰减的 WAV 缓存在 `ds-balance-chime-cache/`

### 配置

| 项 | 默认 | 存在哪 | 怎么改 |
| --- | --- | --- | --- |
| 提示音开关 | 开 | `~/.dsh/storages/ds-balance-chime.off`（存在即静音） | 卡片上的开关 |
| 音量 | 60 | `ds-balance-chime.json` → `volume` | 卡片滑块（0–100） |
| 最短轮次 | 8000 ms | `ds-balance-chime.json` → `minTurnMs` | 直接改 JSON |
| 低余额阈值 | 2 元 | `ds-balance-chime.json` → `lowThreshold` | 直接改 JSON |

### 刷新与缓存

- 余额缓存 10 秒（失败只缓存 5 秒），避免打爆官方接口
- 前端轮询：卡片开着 5 秒 / 卡片收起 20 秒 / 窗口最小化 120 秒
- 「刷新」按钮走 `?refresh=1` 跳过缓存，但 10 秒内只放行一次
- 采样和卡片开不开无关，进程在跑就每 60 秒记一次

接口（仅本机同源，跨源 403）：

```
GET  /api/ds-balance           余额 + 用量 + 花费 + 状态（?refresh=1 跳过缓存）
GET  /api/ds-balance/chime     提醒配置（也接受 ?enabled=0|1&volume=N）
POST /api/ds-balance/chime     {enabled} | {volume} | {play}
```

## 开发

```bash
npm test           # host 契约 36 项 + client 渲染 9 组用例，不联网、不碰真实账本
npm run test:spend # 花费推算回归（临时 HOME + 假余额序列）
npm run test:live  # 打正在运行的 DSH：DSH_BASE=http://127.0.0.1:<port> npm run test:live
```

测试用**临时 HOME** 和**假账户服务**：不会写你真实的 `~/.dsh/storages`，也不会消耗真实余额。
client 测试自带一个最小 hook 模拟器，把组件渲染成对象树，不需要装 React 或浏览器。
仓库受版本控制的文件共 **14 个**（`git ls-files`）：主要就 `index.js`（host）+ `client.js`（client）两个。

## 已知限制

- 节假日表只覆盖 2026 年；2027 年起「节假日全天低峰」会静默失效
- 用量只统计 DSH 内的调用；用同一个 Key 在别处产生的消费不会进「今日用量」，只体现在余额下降里
- 「还能撑几天」需要最近 6 小时里至少 30 分钟采样；不足时不给天数，卡片显示「几乎没消耗」
- `minTurnMs` / `lowThreshold` 只能改 JSON，界面上没有入口
- client 半改动后需要刷新页面（host 半热加载即可）

## License

MIT
