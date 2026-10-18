/**
 * @local/ds-balance — Host 半
 *
 * 提供 GET /api/ds-balance，返回 DeepSeek 余额快照。
 *
 * ★ 双数据源（按优先级）：
 *   A. ctx.get('deepseekAccount').getBalance()  —— DSH 内置账户服务，不碰 Key
 *   B. 读 ~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY + 打官方接口
 *      （A 不可用 / 返回 null 时兜底；Key 只在进程内使用，绝不记录、绝不回传）
 *
 * ★ 缓存 10s：余额变化很慢，避免打爆官方接口。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const API_URL = 'https://api.deepseek.com/user/balance';
const TTL_MS = 10_000;
const TIMEOUT_MS = 15_000;

let cache = { at: 0, data: null };

// ══════════════════════════════════════════════════════════════
//  今日用量账本
//
//  ★ 官方没有用量接口（只有 /user/balance 和 /models），
//    所以用量只能**本地统计**：拦 llm/stream 事件，读其中的
//    { type: 'usage', usage: TokenUsage } 帧。
//
//  TokenUsage 字段：
//    inputTokens / outputTokens / totalTokens? /
//    cacheReadTokens?(命中) / cacheWriteTokens?(写入) / reasoningTokens?(不计费)
//
//  账本按日存 ~/.dsh/storages/ds-balance-usage.json，跨日自动归零。
// ══════════════════════════════════════════════════════════════

const USAGE_FILE = () => join(homedir(), '.dsh', 'storages', 'ds-balance-usage.json');
const SAMPLES_FILE = () => join(homedir(), '.dsh', 'storages', 'ds-balance-samples.json');

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyDay(date) {
  return {
    date: date || todayKey(),
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    byModel: {},
  };
}

let usage = null;          // 内存里的今日账本
let saveTimer = null;

// ══════════════════════════════════════════════════════════════
//  余额采样账本（用来算「花了多少钱」）
//
//  ★ 为什么不用 token 乘价格：DeepSeek 有峰谷价、缓存价、模型差价，
//    自己算一定对不上官方账单。
//  ★ 所以直接记**余额变化**：每 60 秒采一次 total_balance，
//    「今天/这一小时花了多少」= 区间内**余额下降的累加**。
//    加钱（充值/赠送到账）不会算成消费 ✓
//  ★ 采样点按时间升序存在 samples 里，最多保留 26 小时。
// ══════════════════════════════════════════════════════════════

const SAMPLE_MS = 60_000;        // 采样间隔
const KEEP_MS = 26 * 3600_000;   // 保留 26 小时
let samples = [];                // [{ t: epochMs, v: number, s: source }]
let sampler = null;
let balanceForSample = null;     // 最近一次采到的余额（数值）

function pruneSamples(now) {
  const cut = now - KEEP_MS;
  while (samples.length && samples[0].t < cut) samples.shift();
}

/** 加一个采样点（同一毫秒去重） */
function addSample(t, v, source) {
  const num = Number(v);
  if (!Number.isFinite(num)) return;
  const last = samples[samples.length - 1];
  if (last && t - last.t < 5000 && last.s === source && Math.abs(last.v - num) < 1e-9) return;
  samples.push({ t, v: num, s: source || 'unknown' });
  pruneSamples(t);
  scheduleSamplesSave();
}

let samplesSaveTimer = null;
function scheduleSamplesSave() {
  if (samplesSaveTimer) return;
  samplesSaveTimer = setTimeout(async () => {
    samplesSaveTimer = null;
    try {
      const p = SAMPLES_FILE();
      await mkdir(dirname(p), { recursive: true });
      // 26h at one sample/minute is ~1560 points; cap defensively.
      await writeFile(p, JSON.stringify(samples.slice(-2000)), 'utf8');
    } catch {
      /* 采样落盘失败不影响功能 */
    }
  }, 2000);
}

async function loadSamples() {
  try {
    const txt = await readFile(SAMPLES_FILE(), 'utf8');
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) return;
    samples = arr
      .filter((s) => s && Number.isFinite(Number(s.t)) && Number.isFinite(Number(s.v)))
      .map((s) => ({ t: Number(s.t), v: Number(s.v), s: s.s || 'unknown' }))
      .sort((a, b) => a.t - b.t);
    pruneSamples(Date.now());
  } catch {
    samples = samples || [];
  }
}

/**
 * 某段时间内**余额下降**的累加（单位：币种）
 * 只看相邻两点的差，只累加负数部分 -> 充值/赠送到账不影响
 */
function spentSince(sinceMs) {
  let out = 0;
  let prev = null;
  for (const s of samples) {
    // Start at the first sample INSIDE the window. Using the last sample
    // before it as a baseline attributed a drop that happened outside the
    // window to the window (the old "72 元 in one hour").
    if (s.t < sinceMs) continue;
    if (prev == null) { prev = s; continue; }
    // Only compare samples from the same data source: viaApiKey.total_balance
    // includes the granted wallet, viaAccount.total does not, so a source
    // switch would otherwise look like a huge spend.
    if (prev.s === s.s) {
      const d = prev.v - s.v;
      if (d > 0) out += d;
    }
    prev = s;
  }
  return Math.round(out * 1e6) / 1e6;
}

function startOfTodayMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function spendSnapshot() {
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const dayStart = startOfTodayMs();
  const first = samples.length ? samples[0].t : null;
  return {
    today: spentSince(dayStart),
    lastHour: spentSince(hourAgo),
    coveredSince: first ? new Date(first).toISOString() : null,
    todayFull: first != null && first <= dayStart,
    hourFull: first != null && first <= hourAgo,
    samples: samples.length,
    firstSampleAt: samples.length ? new Date(samples[0].t).toISOString() : null,
    lastSampleAt: samples.length ? new Date(samples[samples.length - 1].t).toISOString() : null,
    note: '按余额下降推算，不含充值',
  };
}

async function loadUsage() {
  if (usage) return usage;
  try {
    const txt = await readFile(USAGE_FILE(), 'utf8');
    const j = JSON.parse(txt);
    if (j && j.date === todayKey()) {
      usage = Object.assign(emptyDay(), j);
      usage.byModel = j.byModel || {};
      return usage;
    }
    usage = emptyDay();          // 跨日：归零
  } catch {
    usage = emptyDay();
  }
  return usage;
}

function scheduleSave() {
  if (saveTimer) return;
  // 2 秒合并写一次，别每帧都落盘
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const p = USAGE_FILE();
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, JSON.stringify(usage, null, 2), 'utf8');
    } catch {
      /* 落盘失败不影响统计 */
    }
  }, 2000);
}

function recordUsage(u, options) {
  if (!u || typeof u !== 'object') return;
  const d = usage;
  if (!d) return;
  if (d.date !== todayKey()) {
    // 跨日重置
    const fresh = emptyDay();
    for (const k of Object.keys(d)) delete d[k];
    Object.assign(d, fresh);
  }

  const inp = Number(u.inputTokens) || 0;
  const out = Number(u.outputTokens) || 0;
  const cr = Number(u.cacheReadTokens) || 0;
  const cw = Number(u.cacheWriteTokens) || 0;
  const rt = Number(u.reasoningTokens) || 0;

  d.calls += 1;
  d.inputTokens += inp;
  d.outputTokens += out;
  d.cacheReadTokens += cr;
  d.cacheWriteTokens += cw;
  d.reasoningTokens += rt;

  const model = (options && options.model) || 'unknown';
  const m = (d.byModel && d.byModel[model]) || { calls: 0, input: 0, output: 0, cacheRead: 0 };
  m.calls += 1;
  m.input += inp;
  m.output += out;
  m.cacheRead += cr;
  d.byModel[model] = m;

  scheduleSave();
}

/** 把账本整理成前端好用的形状 */
function usageSnapshot() {
  const d = usage || emptyDay();
  // ★★★ 关键修正（实测确认）：
  //   DeepSeek 原始字段 prompt_tokens = hit + miss（总输入），
  //   但 **DSH 归一化后的 inputTokens 对应「未命中」那部分**，
  //   命中部分单独放在 cacheReadTokens。
  //   证据：一次真实调用 inputTokens=285 而 cacheReadTokens=350720 ——
  //   若 inputTokens 是总数，不可能出现 cacheRead > inputTokens。
  //   -> 真实输入总量 = cacheReadTokens + inputTokens
  const hit = d.cacheReadTokens || 0;
  const miss = d.inputTokens || 0;
  const denom = hit + miss;
  return {
    date: d.date,
    calls: d.calls,
    cacheReadTokens: hit,           // 命中
    cacheMissTokens: miss,          // 未命中（= DSH 的 inputTokens）
    inputTokens: denom,             // ★ 真实输入总量
    outputTokens: d.outputTokens,
    totalTokens: denom + (d.outputTokens || 0),
    cacheWriteTokens: d.cacheWriteTokens,
    reasoningTokens: d.reasoningTokens,
    cacheHitRate: denom > 0 ? Math.round((hit / denom) * 1000) / 10 : null,
    cacheMissRate: denom > 0 ? Math.round((miss / denom) * 1000) / 10 : null,
    byModel: d.byModel,
  };
}


/** 从 credentials.yaml 的 refs 段读 DEEPSEEK_API_KEY（只返回 key，不记录） */
async function readApiKey() {
  const p = join(homedir(), '.dsh', '.credentials.yaml');
  let txt;
  try {
    txt = await readFile(p, 'utf8');
  } catch {
    return null;
  }
  const m = /(?:^|\n)\s*DEEPSEEK_API_KEY\s*:\s*(\S+)/.exec(txt);
  if (!m) return null;
  return m[1].replace(/^['"]|['"]$/g, '').trim() || null;
}

function clientMeta() {
  return {
    version: '0.1.0',
    locale: 'zh',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
}

/** 数据源 A：DSH 内置账户服务 */
async function viaAccount(ctx) {
  const acc = ctx.get('deepseekAccount');
  if (!acc || typeof acc.getBalance !== 'function') {
    return { ok: false, reason: 'no-account-service' };
  }
  let state = null;
  try {
    state = await acc.getState();
  } catch {
    /* 状态读不到不影响余额 */
  }
  if (state && state.status === 'signed-out') {
    return { ok: false, reason: 'signed-out' };
  }
  let bal;
  try {
    bal = await acc.getBalance(clientMeta());
  } catch (e) {
    return { ok: false, reason: 'balance-error', detail: String(e && e.message || e) };
  }
  if (!bal) return { ok: false, reason: 'signed-out' };
  if (bal.status !== 'ready') return { ok: false, reason: 'balance-failed' };

  const wallets = Array.isArray(bal.value) ? bal.value : [];
  const bonuses = Array.isArray(bal.bonusWallets) ? bal.bonusWallets : [];
  const cny = wallets.find((w) => w && w.currency === 'CNY');
  const cnyBonus = bonuses.find((w) => w && w.currency === 'CNY');
  if (!cny && !cnyBonus) return { ok: false, reason: 'no-cny-wallet' };

  return {
    ok: true,
    source: 'account',
    currency: 'CNY',
    total: cny ? String(cny.balance) : String(cnyBonus.balance),
    // cash + granted, in cents, so the sampler compares like with like.
    spendBase: ((Math.round(Number(cny ? cny.balance : 0) * 100)
      + Math.round(Number(cnyBonus ? cnyBonus.balance : 0) * 100)) / 100).toFixed(2),
    toppedUp: cny ? String(cny.balance) : '0.00',
    granted: cnyBonus ? String(cnyBonus.balance) : '0.00',
    available: true,
    links: (state && state.links) || null,
    at: new Date().toISOString(),
  };
}

/** 数据源 B：credentials + 官方接口 */
async function viaApiKey() {
  const key = await readApiKey();
  if (!key) return { ok: false, reason: 'no-api-key' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': 'dsh-ds-balance/0.1.0',
      },
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, reason: 'network', detail: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return { ok: false, reason: 'http-' + res.status };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'bad-json' };
  }

  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const cny = infos.find((b) => b && b.currency === 'CNY');
  const usd = infos.find((b) => b && b.currency === 'USD');
  const pick = cny || usd;
  if (!pick) return { ok: false, reason: 'no-wallet' };

  return {
    ok: true,
    source: 'api',
    currency: pick.currency,
    // ★ 直接用 total_balance，不要自己相加 —— 官方端有取整（实测 82.15+7.89=90.04 vs 90.05）
    // total_balance already includes the granted wallet.
    total: String(pick.total_balance),
    spendBase: String(pick.total_balance),
    toppedUp: String(pick.topped_up_balance),
    granted: String(pick.granted_balance),
    available: body.is_available === true,
    links: null,
    at: new Date().toISOString(),
  };
}

async function snapshot(ctx, force) {
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) {
    return { ...cache.data, cached: true };
  }
  let out = await viaAccount(ctx);
  if (!out.ok) out = await viaApiKey();
  out.cached = false;
  if (out.ok) {
    cache = { at: Date.now(), data: out };
  } else {
    // 失败也缓存 5s，避免连续失败时反复打接口
    cache = { at: Date.now() - TTL_MS + 5_000, data: out };
  }
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  try {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch {
    /* 连接可能已断，忽略 */
  }
}

export const inject = ['webServer'];

export function apply(ctx) {
  // ★★★ 拦截 llm/stream，从 usage 帧里记账
  //   这是 waterfall：**必须原样把每一帧 yield 出去**，
  //   否则会把模型输出打断。
  ctx.effect(() =>
    ctx.on('llm/stream', (options, next) => {
      const inner = next();
      return (async function* passThrough() {
        try {
          for await (const chunk of inner) {
            try {
              if (chunk && chunk.type === 'usage' && chunk.usage) {
                recordUsage(chunk.usage, options);
              }
            } catch {
              /* 记账失败绝不能影响模型输出 */
            }
            yield chunk;
          }
        } catch (e) {
          // 错误也要照常抛出去
          throw e;
        }
      })();
    }),
  );

  // 启动时把今天的账本读出来
  ctx.effect(() => {
    loadSamples().catch(() => {});
    loadUsage().catch(() => {});
    return () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    };
  });

  // ★★★ 余额采样器：每 60 秒记一次余额，用来算「今天/这一小时花了多少」
  //    不依赖前端是否打开卡片。
  ctx.effect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const out = await snapshot(ctx, false);   // 走缓存，不会额外打官方接口
        if (out && out.ok) {
          const v = Number(out.spendBase != null ? out.spendBase : out.total);
          if (Number.isFinite(v)) {
            balanceForSample = v;
            addSample(Date.now(), v, out.source);
          }
        }
      } catch {
        /* 采样失败无所谓，下一轮再来 */
      }
    };
    tick();                                    // 立刻采一次当基准
    sampler = setInterval(tick, SAMPLE_MS);
    return () => {
      stopped = true;
      if (sampler) { clearInterval(sampler); sampler = null; }
    };
  });

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/ds-balance',
      handler: async (req, res) => {
        const url = new URL(req.url || '/api/ds-balance', 'http://127.0.0.1');
        const force = url.searchParams.get('refresh') === '1';
        try {
          await loadUsage();
          const data = await snapshot(ctx, force);
          // ★ 顺手补一个采样点（前端刷新时也算一次）
          if (data && data.ok) {
            const v = Number(data.spendBase != null ? data.spendBase : data.total);
            if (Number.isFinite(v)) addSample(Date.now(), v, data.source);
          }
          // ★ 把今日用量 + 花费一起带上
          sendJson(res, 200, {
            ...data,
            usage: usageSnapshot(),
            spend: spendSnapshot(),
          });
        } catch (e) {
          sendJson(res, 200, {
            ok: false,
            reason: 'internal',
            detail: String(e && e.message || e),
          });
        }
      },
    }),
  );
}
