# DSH 余额 · dsh-balance

DeepSeek Harness（DSH）客户端插件：右下角一颗常驻的**余额悬浮球**，点开是明细卡片。

> 名字取的「简约」：只做一件事——让你一眼知道**还剩多少钱、今天花了多少、还能撑多久**，不塞别的。

## 功能

**悬浮球**

- 常驻显示余额，可拖动，位置存本地
- 四种状态一眼分辨：正常（蓝紫）/ 余额低（黄）/ **有任务在等你确认**（黄 + 数字角标）/ 读不到数据（红 + `!`）
- 键盘可达：Tab 聚焦后 Enter / Space 开合；全局快捷键 `Alt+B` 开关卡片

**明细卡片**

- 总余额 / 现金 / 赠送（整数「分」运算，不碰浮点）
- 当前时段：高峰期（全价）/ 低峰期（5 折）
- 今日用量：调用次数、输入/输出/推理 token、统计日
- 花费：这一小时 / 今天——**按余额下降推算**，不查价格表（价格表算不准峰谷价、缓存价、模型差价）
- **24 小时余额曲线** + 「还能撑 X 天 / X 小时」，按最近 6 小时的真实消耗速度推
- 低余额提醒：低于阈值（默认 ¥2）球变黄，过阈值才报一次，回到阈值以上重新武装

**任务完成提醒**（不给桌宠，只要一个声音）

- 每轮任务结束响一声（`notify.wav`），出错换 `Windows Error.wav`
- **短任务不打扰**：本轮 < 8 秒不响；主动中断不响
- 提示音音量 0–100 可调，`试听` 不看开关状态
- 窗口不在前台时同时**闪任务栏**（`FlashWindowEx`），前台则不闪

**等待确认**

- agent 卡在审批时，球变黄并显示数字；卡片里列出「在等什么工具 + 哪个会话」
- **点一下直接跳到那个会话**（`uiWorkspace.openSession`，取不到服务就退化成不可点）

**中 / 英切换**

- 底部 `[EN]` / `[中]` 小胶囊，语言存本地
- 英文术语对齐官方文档：Peak / Off-peak、cache hit / cache miss、topped-up / granted balance

## 峰谷规则（官方）

来源：[Models & Pricing · DeepSeek API Docs](https://api-docs.deepseek.com/quick_start/pricing)

- 高峰：UTC 01:00–04:00 与 06:00–10:00，周一至周五 → 北京时间 **09:00–12:00 / 14:00–18:00**
- 其余时间（含周末、中国法定节假日全天）为低峰，价格是高峰的 **5 折**
- 节假日表内置 2026 年安排，**只参与时段判断，不在界面显示节假日名称**

## 安装

这是一个 DSH 客户端插件（host + client 两半）。目前按本地 `link:` 方式使用：

1. 把本目录放到任意位置，例如 `C:\Users\<you>\dsh-balance`
2. 在 DSH profile 的 `package.json` 里加依赖与 bundle：

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

- 余额：DSH 内置账户服务 `deepseekAccount.getBalance()`；失败时回退官方 `/user/balance`（读 `~/.dsh/.credentials.yaml` 的 refs，key 只在进程内使用）
- 用量：拦截 `llm/stream` 的 usage 帧，按日存 `~/.dsh/storages/ds-balance-usage.json`
- 花费：每 60 秒采一次余额，按区间内**余额下降**累加；采样存 `~/.dsh/storages/ds-balance-samples.json`
- 提醒配置：`~/.dsh/storages/ds-balance-chime.json`（volume / minTurnMs / lowThreshold）

接口（仅本机同源，跨源 403）：

```
GET  /api/ds-balance           余额 + 用量 + 花费 + 状态
GET  /api/ds-balance/chime     提醒配置
POST /api/ds-balance/chime     {enabled} | {volume} | {play}
```

## 开发

```bash
npm test          # host 契约(36 项) + client 渲染(7 组用例)，不联网、不碰真实账本
npm run test:live # 打正在运行的 DSH：DSH_BASE=http://127.0.0.1:<port> npm run test:live
npm run test:spend
```

测试用**临时 HOME** 和**假账户服务**：不会写你真实的 `~/.dsh/storages`，也不会消耗真实余额。
client 测试自带一个最小 hook 模拟器，把组件渲染成对象树，不需要装 React 或浏览器。

## 已知限制

- 节假日表只覆盖 2026 年；2027 年起「节假日全天低峰」会静默失效
- client 半改动后需要刷新页面（host 半热加载即可）
- 「还能撑几天」需要至少 30 分钟采样覆盖才给值，冷启动时显示 `—`

## License

MIT
