# 简约 · DSH 余额

DeepSeek 余额悬浮球：右下角常驻显示 API 余额，点开看现金/赠送/总额、今日用量、这一小时与今天的消费，以及当前是高峰还是低峰时段。

> 名字取「简约」：只做一件事——让你一眼知道余额和今天花了多少，不塞别的。

## 功能

- **悬浮球**：显示当前余额，可拖动，位置存本地
- **明细卡片**：总余额 / 现金 / 赠送；今日调用次数、缓存命中率、输入/输出 token
- **花费**：按余额下降推算（不用价格表，避开峰谷价、缓存价、模型差价）
- **当前时段**：高峰期（全价）/ 低峰期（5 折）

## 峰谷规则（官方）

来源：[Models & Pricing · DeepSeek API Docs](https://api-docs.deepseek.com/quick_start/pricing)

- 高峰：UTC 01:00–04:00 与 06:00–10:00，周一至周五
  → 北京时间 **09:00–12:00 / 14:00–18:00**
- 其余时间（含周末、中国法定节假日全天）为低峰，价格是高峰的 **5 折**
- 节假日表内置 2026 年安排（国办发明电〔2025〕7 号），**只参与时段判断，不在界面显示节假日名称**

## 安装

这是一个 DSH 客户端插件（host + client 两半）。

1. 把本目录放到任意位置，例如 `C:\Users\<you>\dsh-balance`
2. 在 DSH profile 的 `package.json` 里加依赖：

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

3. 重启桌面 App（host 半加载），刷新页面（client 半加载）

## 数据来源

- 余额：DSH 内置账户服务 `deepseekAccount.getBalance()`；失败时回退官方 `/user/balance`
- 用量：拦截 `llm/stream` 的 usage 帧，按日存 `~/.dsh/storages/ds-balance-usage.json`
- 花费：每 60 秒采一次余额，按区间内余额下降累加；采样存 `~/.dsh/storages/ds-balance-samples.json`

## 开发

```bash
node --check index.js
node --check client.js
npm test          # 花费计算的隔离测试（临时 HOME，不碰真实账本）
```

## License

MIT
