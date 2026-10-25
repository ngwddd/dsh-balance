// 对「正在运行的 DSH」做一次接口契约检查：只读，不改任何状态。
//   用法： DSH_BASE=http://127.0.0.1:58691 node test/live-api.mjs
//   端口每次重启都会变，所以从环境变量取；连不上就直接 SKIP（退出码 0）。
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:58691';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { failures += 1; console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

let payload;
try {
  const res = await fetch(BASE + '/api/ds-balance', { headers: { accept: 'application/json' } });
  payload = await res.json();
} catch (e) {
  console.log('SKIP 连不上 ' + BASE + '（' + (e && e.message) + '）');
  process.exit(0);
}

console.log('LIVE API ' + BASE);
check('ok 字段存在', typeof payload.ok === 'boolean');
check('links 两个链接都在（含兜底）',
  payload.links && typeof payload.links.topUpUrl === 'string' && typeof payload.links.usageUrl === 'string',
  JSON.stringify(payload.links));
check('chime 配置齐全',
  payload.chime && typeof payload.chime.enabled === 'boolean'
  && typeof payload.chime.volume === 'number'
  && typeof payload.chime.minTurnMs === 'number'
  && typeof payload.chime.lowThreshold === 'number',
  JSON.stringify(payload.chime));
check('status.waitingList 是数组',
  payload.status && Array.isArray(payload.status.waitingList),
  JSON.stringify(payload.status));
check('waitingList 条目形状正确',
  (payload.status.waitingList || []).every((w) => w && typeof w.sessionId === 'string' && typeof w.tool === 'string'),
  JSON.stringify(payload.status.waitingList));
check('spend.series 是数组', Array.isArray(payload.spend && payload.spend.series));
check('spend.daysLeft 是数字或 null',
  payload.spend && (payload.spend.daysLeft === null || typeof payload.spend.daysLeft === 'number'),
  String(payload.spend && payload.spend.daysLeft));
check('warn.threshold 是数字', payload.warn && typeof payload.warn.threshold === 'number');

console.log(failures === 0 ? 'LIVE OK' : 'LIVE FAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);
