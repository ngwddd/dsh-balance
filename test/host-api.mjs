// Host 半边兼容性测试：用假 ctx 跑真实模块，不碰真实会话总线。
// 覆盖：事件订阅、turn 时长判定、审批计数、HTTP 两个端点、响应字段形状。
import { writeFileSync, existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// ★ 临时 HOME：测试写出来的日志 / 配置 / 通知脚本都落在临时目录，
//   绝不污染真实的 ~/.dsh/storages（2026-10-26 加，之前测试往真实日志里写了 4 条假记录）。
const HOME = mkdtempSync(join(tmpdir(), 'dsbal-host-'));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
mkdirSync(join(HOME, '.dsh', 'storages'), { recursive: true });

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js').replace(/\\\\/g, '/');
const STOR = join(homedir(), '.dsh', 'storages');
const OFF = join(STOR, 'ds-balance-chime.off');
const CFG = join(STOR, 'ds-balance-chime.json');
const PS1 = join(STOR, 'ds-balance-notify.ps1');

const cfgBackup = existsSync(CFG) ? readFileSync(CFG, 'utf8') : null;
const offBackup = existsSync(OFF);

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { failures += 1; console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

const mod = await import('file:///' + PLUGIN);

const handlers = new Map();
const registered = [];
const effects = [];
const ctx = {
  webServer: { register: (r) => { registered.push(r); return () => {}; } },
  effect(fn) { const d = fn(); effects.push(d); return d; },
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(fn);
    return () => handlers.get(name).delete(fn);
  },
  inject(deps, cb) {
    cb({
      effect: (fn) => { const d = fn(); effects.push(d); return d; },
      webServer: { register: (r) => { registered.push(r); return () => {}; } },
    });
  },
  // 固定账户服务：不联网、不读真实凭据，结果可重复
  get(name) {
    if (name !== 'deepseekAccount') return undefined;
    return {
      getState: async () => ({ status: 'ready', links: null }),
      getBalance: async () => ({
        status: 'ready',
        value: [{ currency: 'CNY', balance: '7.89' }],
        bonusWallets: [{ currency: 'CNY', balance: '72.64' }],
      }),
    };
  },
};

mod.apply(ctx);

function emit(type, session, data) {
  const set = handlers.get('session/event');
  if (!set) throw new Error('没有订阅 session/event');
  for (const fn of set) fn(session, { type, data, seq: 1 });
}

function callHandler(path, { method = 'GET', body = null, headers = {} } = {}) {
  const reg = registered.find((r) => r.path === path);
  if (!reg) throw new Error('未注册路由: ' + path);
  const req = {
    url: path,
    method,
    headers: Object.assign({ host: '127.0.0.1:63283' }, headers),
    socket: { remoteAddress: '127.0.0.1' },
    on(ev, cb) {
      if (ev === 'data' && body != null) setImmediate(() => cb(Buffer.from(body)));
      if (ev === 'end') setImmediate(() => cb());
      return req;
    },
  };
  let out = null;
  const res = {
    statusCode: 0,
    setHeader() {},
    writeHead() {},
    end(payload) { out = payload; },
  };
  return Promise.resolve(reg.handler(req, res)).then(() => out);
}

console.log('HOST CHECKS');

// 1) 路由注册
check('注册 /api/ds-balance', registered.some((r) => r.path === '/api/ds-balance'));
check('注册 /api/ds-balance/chime', registered.some((r) => r.path === '/api/ds-balance/chime'));
check('订阅 session/event', handlers.has('session/event'));

// 2) 短任务不该打扰（< 8s）：以提示音日志行数为准（脚本文件可能早就存在）
const LOG = join(STOR, 'ds-balance-chime.log');
const logBefore = existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0;
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const session = { header: { id: 'test-session', title: '测试' } };
emit('turn/start', session);
clock += 1000;
emit('turn/end', session, { reason: { kind: 'completed' } });
await new Promise((r) => setTimeout(r, 300));
const logAfterShort = existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0;
check('短任务没有触发提示音', logAfterShort === logBefore, `${logBefore} -> ${logAfterShort}`);

// 3) 长任务会触发通知
clock += 12000;
emit('turn/start', session);
clock += 9000;
emit('turn/end', session, { reason: { kind: 'completed' } });
await new Promise((r) => setTimeout(r, 600));
const logAfterLong = existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0;
check('长任务触发提示音（日志 +1）', logAfterLong === logAfterShort + 1, `${logAfterShort} -> ${logAfterLong}`);
check('长任务生成通知脚本', existsSync(PS1));
check('通知脚本带 -Flash 分支', existsSync(PS1) && readFileSync(PS1, 'utf8').includes('FlashWindowEx'));

// 4) 审批计数（按会话去重：两个会话同时等，应该计 2）
const sessionB = { header: { id: 'test-session-b', title: '测试B' } };
emit('approval/asked', session, { toolName: 'Bash' });
emit('approval/asked', sessionB, { toolName: 'Write' });
const body1 = JSON.parse(await callHandler('/api/ds-balance'));
check('两个会话等待确认 = 2', body1.status && body1.status.waiting === 2, JSON.stringify(body1.status));
check('waitingList 带工具名', Array.isArray(body1.status.waitingList)
  && body1.status.waitingList.some((w) => w.tool === 'Bash')
  && body1.status.waitingList.some((w) => w.tool === 'Write'), JSON.stringify(body1.status.waitingList));
check('waitingList 带 sessionId', body1.status.waitingList.every((w) => typeof w.sessionId === 'string' && w.sessionId), JSON.stringify(body1.status.waitingList));
check('lastTurn 记录成功状态', body1.status && body1.status.last && body1.status.last.status === 'success', JSON.stringify(body1.status && body1.status.last));
check('lastTurn 时长 >= 9000', body1.status && body1.status.last && body1.status.last.durationMs >= 9000);
emit('approval/decided', session, {});
const body2 = JSON.parse(await callHandler('/api/ds-balance'));
check('审批完成后回落 = 1', body2.status && body2.status.waiting === 1, JSON.stringify(body2.status && body2.status.waiting));

// 5) 响应形状（前端依赖这些字段）
check('保留 ok/available/currency', 'ok' in body2 && 'currency' in body2);
check('chime 带 minTurnMs/lowThreshold', body2.chime && body2.chime.minTurnMs === 8000 && typeof body2.chime.lowThreshold === 'number', JSON.stringify(body2.chime));
check('spend.series 是数组', Array.isArray(body2.spend && body2.spend.series), typeof (body2.spend && body2.spend.series));
check('spend.daysLeft 是数字或 null', body2.spend && (body2.spend.daysLeft === null || typeof body2.spend.daysLeft === 'number'), String(body2.spend && body2.spend.daysLeft));
check('warn.low 是布尔', body2.warn && typeof body2.warn.low === 'boolean', JSON.stringify(body2.warn));
check('usage 仍然存在', body2.usage && typeof body2.usage.calls === 'number');

// 5b) 只有 turn/end、没有 turn/start（插件热重载后的第一轮）：时长未知，也必须提醒。
//     放在这里做，避免覆盖上面 lastTurn 的时长断言。
clock += 5000;                                   // 越过 800ms 防抖（Date.now 是假时钟）
emit('turn/end', { header: { id: 'reload-turn', title: '重载后第一轮' } }, { reason: { kind: 'completed' } });
await new Promise((r) => setTimeout(r, 600));
const logAfterUnknown = existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0;
check('时长未知（重载后）也会提醒', logAfterUnknown === logAfterLong + 1, `${logAfterLong} -> ${logAfterUnknown}`);

// 6) 开关端点
const offBody = JSON.parse(await callHandler('/api/ds-balance/chime', { method: 'POST', body: JSON.stringify({ enabled: false }) }));
check('关闭后 enabled=false', offBody.chime && offBody.chime.enabled === false, JSON.stringify(offBody.chime));
check('关闭后标记文件存在', existsSync(OFF));
const onBody = JSON.parse(await callHandler('/api/ds-balance/chime', { method: 'POST', body: JSON.stringify({ enabled: true }) }));
check('开启后 enabled=true', onBody.chime && onBody.chime.enabled === true);
check('开启后标记文件删除', !existsSync(OFF));

// 7) 音量端点
const volBody = JSON.parse(await callHandler('/api/ds-balance/chime', { method: 'POST', body: JSON.stringify({ volume: 40 }) }));
check('音量写入 40', volBody.chime && volBody.chime.volume === 40, JSON.stringify(volBody.chime));
const vol2 = JSON.parse(await callHandler('/api/ds-balance/chime', { method: 'POST', body: JSON.stringify({ volume: 30 }) }));
check('音量恢复 30', vol2.chime && vol2.chime.volume === 30);

// 7b) 改音量不能把同一份配置里的其它项冲掉（旧实现写死 { volume }）
writeFileSync(CFG, JSON.stringify({ volume: 20, minTurnMs: 3000, lowThreshold: 5 }), 'utf8');
await callHandler('/api/ds-balance/chime', { method: 'POST', body: JSON.stringify({ volume: 45 }) });
const cfgAfter = JSON.parse(readFileSync(CFG, 'utf8'));
check('改音量后 minTurnMs 没被冲掉', cfgAfter.minTurnMs === 3000, JSON.stringify(cfgAfter));
check('改音量后 lowThreshold 没被冲掉', cfgAfter.lowThreshold === 5, JSON.stringify(cfgAfter));
check('音量确实写成 45', cfgAfter.volume === 45, JSON.stringify(cfgAfter));

// 8) 试听：删掉通知脚本后调用，应该重建脚本并返回 ok。
//    旧代码这里调的是已改名的 playChime() → 500 → 「试听键失效」，用这条钉死。
try { unlinkSync(PS1); } catch { /* ignore */ }
const playBody = JSON.parse(await callHandler('/api/ds-balance/chime', { method: 'POST', body: JSON.stringify({ play: true }) }));
check('试听返回 ok', playBody && playBody.ok === true, JSON.stringify(playBody));
check('试听真的走到通知脚本', existsSync(PS1));
// 开关关着也要能试听
await callHandler('/api/ds-balance/chime', { method: 'POST', body: JSON.stringify({ enabled: false }) });
try { unlinkSync(PS1); } catch { /* ignore */ }
const playMuted = JSON.parse(await callHandler('/api/ds-balance/chime', { method: 'POST', body: JSON.stringify({ play: true }) }));
check('静音状态下试听仍然出声', playMuted && playMuted.ok === true && existsSync(PS1), JSON.stringify(playMuted));

// 9) 只接受本机同源请求（接口默认无鉴权）
const cross = JSON.parse(await callHandler('/api/ds-balance', { headers: { origin: 'https://evil.example' } }));
check('跨源读余额被拒', cross && cross.reason === 'local-only', JSON.stringify(cross));
const sameOrigin = JSON.parse(await callHandler('/api/ds-balance', { headers: { origin: 'http://127.0.0.1:63283' } }));
check('同源请求放行', sameOrigin && sameOrigin.ok === true, JSON.stringify(sameOrigin && sameOrigin.reason));
try { unlinkSync(OFF); } catch { /* ignore */ }
const crossChime = JSON.parse(await callHandler('/api/ds-balance/chime', {
  method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ enabled: false }),
}));
check('跨源改开关被拒', crossChime && crossChime.reason === 'local-only', JSON.stringify(crossChime));
check('跨源改开关没有副作用', !existsSync(OFF));

Date.now = realNow;

// 临时 HOME 整个删掉，不需要逐项还原
try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0 ? 'HOST OK' : 'HOST FAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);
