// 客户端冒烟测试：不装浏览器、不装 react，用最小 hook 模拟器把组件渲染成对象树。
// 目的：抓「改了 UI 之后就崩」这类问题（未定义变量、hook 顺序错、没做空值保护）。
const fs = require('node:fs');
const assert = require('node:assert');

const path = require('node:path');
const CLIENT = path.join(__dirname, '..', 'client.js');

/* ---------- 最小 React 模拟 ---------- */
const hookState = [];
let cursor = 0;
let effects = [];

const React = {
  createElement(type, props, ...children) {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
    return { type, props: Object.assign({}, props || {}, { children: kids }) };
  },
  useState(init) {
    const i = cursor++;
    if (!(i in hookState)) hookState[i] = typeof init === 'function' ? init() : init;
    const set = (v) => { hookState[i] = typeof v === 'function' ? v(hookState[i]) : v; };
    return [hookState[i], set];
  },
  useRef(init) {
    const i = cursor++;
    if (!(i in hookState)) hookState[i] = { current: init };
    return hookState[i];
  },
  useEffect(fn, deps) { const i = cursor++; effects.push({ i, fn, deps }); },
  useLayoutEffect(fn, deps) { const i = cursor++; effects.push({ i, fn, deps }); },
  useCallback(fn) { cursor++; return fn; },
  useMemo(fn) { cursor++; return fn(); },
};

/* ---------- 浏览器环境桩 ---------- */
const listeners = new Map();
const store = new Map();
const windowStub = {
  innerWidth: 1600,
  innerHeight: 900,
  devicePixelRatio: 1,
  addEventListener(type, fn) { listeners.set('w:' + type, fn); },
  removeEventListener() {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  EventSource: undefined,
  fetch: async () => ({ json: async () => ({ ok: false, reason: 'stub' }) }),
};
const documentStub = {
  hidden: false,
  activeElement: null,
  addEventListener(type, fn) { listeners.set('d:' + type, fn); },
  removeEventListener() {},
};

global.window = windowStub;
global.document = documentStub;
// 组件里用的是裸 setInterval/clearInterval（浏览器全局），Node 里会真的计时并挂住进程
global.setInterval = () => 0;
global.clearInterval = () => {};
global.setTimeout = () => 0;
global.clearTimeout = () => {};

/* ---------- 加载插件客户端 ---------- */
let registered = null;
window.__ModuleLoader__ = {
  load({ id, factory }) {
    const mod = factory((name) => {
      if (name === 'react') return React;
      throw new Error('unknown require: ' + name);
    });
    registered = { id, mod };
  },
};

const code = fs.readFileSync(CLIENT, 'utf8');
(0, eval)(code);
assert.ok(registered, '模块没有调用 __ModuleLoader__.load');
assert.strictEqual(registered.id, '@local/ds-balance');

/* ---------- 取组件 ---------- */
let Component = null;
const slotCalls = [];
const openedSessions = [];
registered.mod.apply({
  get(name) {
    if (name !== 'uiWorkspace') return undefined;
    return { openSession: (id) => openedSessions.push(id) };
  },
  slots: {
    inject(name, cb) { slotCalls.push(name); cb(); },
    register(spec, C) { Component = C; return () => {}; },
  },
});
assert.ok(Component, 'apply() 没有注册组件');

function render() {
  cursor = 0;
  effects = [];
  return Component();
}

// 渲染 + 跑一遍 effect 再渲染一次（模拟 React 的 mount → effect → 更新）
function renderSettled() {
  let tree = render();
  const pending = effects.slice();
  for (const e of pending) {
    try { const cleanup = e.fn(); void cleanup; } catch (err) { throw new Error('effect 抛错: ' + err.message); }
  }
  tree = render();
  return tree;
}

function walk(node, out) {
  if (node == null || node === false || node === true) return;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return; }
  const { props } = node;
  if (props && props.children != null) walk(props.children, out);
}
function textOf(tree) { const out = []; walk(tree, out); return out.join(' | '); }
function finds(tree, pred, acc = []) {
  if (tree == null || typeof tree !== 'object') return acc;
  if (Array.isArray(tree)) { for (const n of tree) finds(n, pred, acc); return acc; }
  if (pred(tree)) acc.push(tree);
  if (tree.props && tree.props.children != null) finds(tree.props.children, pred, acc);
  return acc;
}

/* ---------- 用例 1：没有数据时的球 ---------- */
hookState.length = 0;
let tree = renderSettled();
let txt = textOf(tree);
assert.ok(txt.includes('…'), '空数据时球应显示 …，实际：' + txt);

/* ---------- 用例 1b：首帧还没有数据，卡片底部也要有「充值 / 用量 / EN」---------- */
// 这条就是用户实测到的 bug：刚打开时底部只剩 [EN]，几秒后数据回来才长出两个链接。
hookState.length = 0;
hookState[0] = null;   // data
hookState[1] = null;   // error
hookState[2] = true;   // open
tree = renderSettled();
txt = textOf(tree);
assert.ok(txt.includes('充值'), '首帧缺「充值」（应走兜底链接）');
assert.ok(txt.includes('用量'), '首帧缺「用量」（应走兜底链接）');
assert.ok(txt.includes('EN'), '首帧缺 EN 切换');
const anchors = finds(tree, (n) => n.type === 'a');
assert.ok(anchors.length >= 2
  && anchors.every((a) => typeof a.props.href === 'string' && a.props.href.startsWith('https://')),
'首帧的链接 href 不合法：' + JSON.stringify(anchors.map((a) => a.props.href)));

/* ---------- 用例 1c：提示音开关的初始状态来自缓存，不该先画成「开」 ---------- */
window.localStorage.setItem('dsh.ds-balance.chime', '0');
hookState.length = 0;
hookState[0] = null;   // data 还没回来
hookState[1] = null;
hookState[2] = true;
tree = renderSettled();
const sw = finds(tree, (n) => n.props && n.props.role === 'switch')[0];
assert.ok(sw, '找不到提示音开关');
assert.strictEqual(sw.props['aria-checked'], false, '服务端关着时，首帧开关不该显示为开');
window.localStorage.removeItem('dsh.ds-balance.chime');

/* ---------- 用例 2：完整数据 + 打开卡片 ---------- */
const full = {
  ok: true,
  available: true,
  currency: 'CNY',
  total: '8.3900000',
  toppedUp: '8.39',
  granted: '0',
  source: 'account',
  at: new Date().toISOString(),
  status: {
    waiting: 2, running: 1, last: null,
    waitingList: [
      { sessionId: 's1', tool: 'Bash', title: '测试会话' },
      { sessionId: 's2', tool: 'Write', title: '另一个' },
    ],
  },
  warn: { low: true, threshold: 10 },
  chime: { enabled: true, volume: 30, minTurnMs: 8000, lowThreshold: 10 },
  usage: {
    calls: 158, inputTokens: 59, outputTokens: 1591, cacheReadTokens: 98,
    cacheHitRate: 98.5, date: '2026-10-26',
  },
  spend: {
    today: 2.75, lastHour: 1.95, series: [
      { t: 1, v: 9 }, { t: 2, v: 8.6 }, { t: 3, v: 8.4 }, { t: 4, v: 8.39 },
    ],
    ratePerDay: 3.2, daysLeft: 2.6, note: '按余额下降推算，不含充值',
  },
  links: { topUpUrl: 'https://platform.deepseek.com/top_up', usageUrl: 'https://platform.deepseek.com/usage' },
};
hookState.length = 0;
hookState[0] = full;    // data
hookState[1] = null;    // error
hookState[2] = true;    // open
tree = renderSettled();
txt = textOf(tree);
assert.ok(txt.includes('⏳ 等你确认 · 2 项'), '缺少等待确认横幅');
// 等待项要显示「在等什么」并且能点开对应会话
assert.ok(txt.includes('Bash') && txt.includes('Write'), '等待列表里应显示工具名：' + txt.slice(0, 200));
const waitRow = finds(tree, (n) => n.props && typeof n.props.onClick === 'function'
  && typeof n.props.title === 'string' && n.props.title.includes('打开该会话'))[0];
assert.ok(waitRow, '找不到可点击的等待行');
waitRow.props.onClick();
assert.deepStrictEqual(openedSessions, ['s1'], '点击应打开对应会话：' + JSON.stringify(openedSessions));
assert.ok(txt.includes('24 小时余额'), '缺少 24 小时曲线标题');
assert.ok(txt.includes('还能撑 2.6 天'), '缺少还能撑几天');
assert.ok(txt.includes('任务完成提示音'), '缺少提示音开关');
assert.ok(txt.includes('音量'), '缺少音量行');
// 2026-10-26：缓存命中 / 未命中 两行已按用户要求移除，但 token 行必须还在
assert.ok(!txt.includes('缓存命中'), '缓存命中 行应该已移除');
assert.ok(!txt.includes('未命中'), '未命中 行应该已移除');
assert.ok(txt.includes('输入 token'), '输入 token 行不该被删掉');

// EN 切换按钮：紧挨「用量」右侧
const enBtn = finds(tree, (n) => n.type === 'button' && n.props.children === 'EN');
assert.strictEqual(enBtn.length, 1, '找不到 EN 切换按钮');
assert.ok(txt.includes('用量'), '切英文前应有「用量」链接');
enBtn[0].props.onClick({ stopPropagation() {} });
tree = renderSettled();
txt = textOf(tree);
assert.ok(txt.includes('DeepSeek Balance'), '切英文后标题不对：' + txt.slice(0, 140));
assert.ok(txt.includes('Total balance'), '缺少英文 Total balance');
assert.ok(txt.includes('Completion sound'), '缺少英文 Completion sound');
assert.ok(txt.includes('~2.6 days left'), '缺少英文剩余天数');
assert.ok(txt.includes('中'), '英文模式下切换按钮应显示「中」');
assert.ok(!txt.includes('用量'), '英文模式下不该再出现「用量」');
const svgs = finds(tree, (n) => n.type === 'svg');
assert.ok(svgs.length >= 1, '没有渲染出 svg 曲线');
const paths = finds(tree, (n) => n.type === 'path');
assert.ok(paths.length >= 1 && /^M[\d.]+,[\d.]+/.test(String(paths[0].props.d)), '曲线 path 数据不合法');
const ranges = finds(tree, (n) => n.type === 'input' && n.props.type === 'range');
assert.strictEqual(ranges.length, 1, '音量滑块缺失或重复');
assert.strictEqual(ranges[0].props.value, 30, '滑块初始值应取服务端 volume');

/* ---------- 用例 3：精简数据（老版本 host，没有 status/warn/series）---------- */
hookState.length = 0;
hookState[0] = { ok: true, available: true, currency: 'CNY', total: '8.39' };
hookState[1] = null;
hookState[2] = true;
tree = renderSettled();

/* ---------- 用例 3b：有等待数但没有 waitingList（旧 host），不能崩 ---------- */
hookState.length = 0;
hookState[0] = { ok: true, available: true, currency: 'CNY', total: '8.39', status: { waiting: 1 } };
hookState[1] = null;
hookState[2] = true;
tree = renderSettled();
txt = textOf(tree);
assert.ok(txt.includes('等你确认') || txt.includes('Awaiting'), '缺 waitingList 时横幅应仍在');
assert.ok(!txt.includes('undefined'), '缺 waitingList 时出现了 undefined');

/* ---------- 用例 3c：waitingList 里有脏数据（null / 没 title）---------- */
hookState.length = 0;
hookState[0] = {
  ok: true, available: true, currency: 'CNY', total: '8.39',
  status: { waiting: 2, waitingList: [null, { sessionId: 's9', tool: 'Bash' }] },
};
hookState[1] = null;
hookState[2] = true;
tree = renderSettled();
txt = textOf(tree);
assert.ok(txt.includes('Bash'), '脏数据里合法的条目仍应显示');
assert.ok(!txt.includes('undefined'), '脏 waitingList 出现 undefined');
txt = textOf(tree);
assert.ok(txt.includes('8.39'), '精简数据下余额没渲染');
assert.ok(!txt.includes('undefined'), '出现 undefined 文本：' + txt);

/* ---------- 用例 4：读不到余额 ---------- */
hookState.length = 0;
hookState[0] = null;
hookState[1] = 'timeout';
hookState[2] = false;
tree = renderSettled();
txt = textOf(tree);
assert.ok(txt.includes('!'), '失败时球应显示 !');

/* ---------- 用例 5：样式里出现 undefined ---------- */
hookState.length = 0;
hookState[0] = full;
hookState[1] = null;
hookState[2] = true;
tree = renderSettled();
const all = finds(tree, () => true);
for (const node of all) {
  const style = node.props && node.props.style;
  if (!style) continue;
  for (const [k, v] of Object.entries(style)) {
    assert.ok(v !== undefined, 'style.' + k + ' 是 undefined（元素 ' + node.type + '）');
  }
}

console.log('CLIENT OK');
console.log('  slot inject:', slotCalls.join(','));
console.log('  卡片文本片段:', textOf(tree).slice(0, 160));
