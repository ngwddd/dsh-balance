// 花费计算回归测试：使用临时 HOME，绝不碰真实的余额采样账本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbal-test-'));
process.env.USERPROFILE = tmp;
process.env.HOME = tmp;
fs.mkdirSync(path.join(tmp, '.dsh', 'storages'), { recursive: true });

const { apply } = await import('./index.js');

let handler = null;
let step = 0;
const balances = [
  { bal: '7.89', bonus: '72.64' },   // spendBase = 80.53
  { bal: '7.80', bonus: '72.64' },   // spent 0.09
];
const ctx = {
  effect: (fn) => { try { fn(); } catch (e) { console.error('effect err', e.message); } },
  on: () => {},
  get: (name) => name === 'deepseekAccount' ? {
    getState: async () => ({ status: 'ready', links: null }),
    getBalance: async () => {
      const b = balances[Math.min(step, balances.length - 1)];
      return {
        status: 'ready',
        value: [{ currency: 'CNY', balance: b.bal }],
        bonusWallets: [{ currency: 'CNY', balance: b.bonus }],
      };
    },
  } : null,
  webServer: { register: (r) => { handler = r.handler; } },
};

apply(ctx);
await new Promise((r) => setTimeout(r, 150));

function call(url) {
  return new Promise((resolve, reject) => {
    const res = {
      setHeader() {},
      end(body) { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } },
    };
    Promise.resolve(handler({ url }, res)).catch(reject);
  });
}

const a = await call('/api/ds-balance');
step = 1;
const b = await call('/api/ds-balance?refresh=1');

const ok = a.spendBase === '80.53'
  && b.spendBase === '80.44'
  && Math.abs(b.spend.today - 0.09) < 1e-9
  && Math.abs(b.spend.lastHour - 0.09) < 1e-9;

console.log('first :', { spendBase: a.spendBase, today: a.spend.today, samples: a.spend.samples });
console.log('second:', { spendBase: b.spendBase, today: b.spend.today, lastHour: b.spend.lastHour });
console.log(ok ? 'PASS' : 'FAIL');

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
