/**
 * @local/ds-balance — Client 半
 *
 * 悬浮球：显示 DeepSeek 余额；点开看明细。
 * 挂到 shell.overlay（全局浮层），可拖拽，位置存 localStorage。
 */
window.__ModuleLoader__.load({
  id: '@local/ds-balance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React;

    const POLL_OPEN_MS = 5000;      // 卡片开着：5 秒
    const POLL_IDLE_MS = 20000;     // 卡片收起：20 秒（只为红点新鲜）
    const POLL_HIDDEN_MS = 120000;  // 窗口最小化：2 分钟
    const POS_KEY = 'dsh.ds-balance.pos';
    const OPEN_KEY = 'dsh.ds-balance.open';
    const LANG_KEY = 'dsh.ds-balance.lang';
    const CHIME_KEY = 'dsh.ds-balance.chime';
    const SIZE = 46;

    // ★ 兜底链接：首帧（data 还没回来）也必须画出「充值 / 用量」，
    //   否则底部那行先只剩 [EN]，几秒后数据到了才长出来——就是用户看到的「按钮消失又出现」。
    const DEFAULT_LINKS = {
      topUpUrl: 'https://platform.deepseek.com/top_up',
      usageUrl: 'https://platform.deepseek.com/usage',
    };

    // ── 文案（中 / 英）──────────────────────────────────────
    // 英文按 DeepSeek 官方 API 文档的术语：
    //   peak / off-peak hours、cache hit / cache miss、
    //   topped-up balance / granted balance、Chinese public holidays
    //   出处：api-docs.deepseek.com/quick_start/pricing
    const STRINGS = {
      zh: {
        title: 'DeepSeek 余额',
        refresh: '刷新',
        collapse: '收起',
        dragCard: '按住拖动这张卡片',
        total: '总余额',
        topped: '现金',
        granted: '赠送',
        window: '当前时段',
        peak: '高峰期 · 全价',
        offpeak: '低峰期 · 5 折',
        windowHint: '工作日 09:00–12:00 / 14:00–18:00（北京时间） · 节假日全天低峰',
        todayUsage: '今日用量',
        calls: '次调用',
        lastHour: '这一小时花费',
        today: '今天花费',
        sampled: '余额采样自',
        sampledTail: ' 起，更早的消费未计入',
        inputTok: '输入 token',
        outputTok: '输出 token',
        reasoningTok: '推理 token（不计费）',
        statDate: '统计日',
        totalTok: '合计 token',
        trend: '24 小时余额',
        daysLeft: (v) => '还能撑 ' + v + ' 天',
        hoursLeft: (v) => '还能撑 ' + v + ' 小时',
        barely: '几乎没消耗',
        sound: '任务完成提示音',
        test: '试听',
        testTip: '试听一声',
        volume: '音量',
        volumeTip: '提示音音量',
        dragHint: '按住标题栏拖动',
        source: '数据源：',
        sourceAccount: 'DSH 账户服务',
        sourceApi: '官方 API',
        topUp: '充值',
        usage: '用量',
        waiting: (n) => '⏳ 等你确认 · ' + n + ' 项',
        openSession: '点击打开该会话',
        low: (v) => '余额低于 ' + v + '，记得充值',
        insufficient: '⚠ 余额不足以继续调用',
        cantRead: '读不到余额：',
        ballTip: (m) => 'DeepSeek 余额 ' + m,
        ballWait: (n) => ' · 有 ' + n + ' 项等你确认',
        ballHint: '（点击看明细，Alt+B 也可）',
        on: '提示音已开，点击静音',
        off: '静音中，点击开启提示音',
        langBtn: 'EN',
        langTip: 'Switch to English',
      },
      en: {
        title: 'DeepSeek Balance',
        refresh: 'Refresh',
        collapse: 'Close',
        dragCard: 'Drag to move this card',
        total: 'Total balance',
        topped: 'Topped-up',
        granted: 'Granted',
        window: 'Pricing now',
        peak: 'Peak · full rate',
        offpeak: 'Off-peak · 50% off',
        windowHint: 'Weekdays 09:00–12:00 / 14:00–18:00 (UTC+8) · off-peak all day on Chinese public holidays',
        todayUsage: "Today's usage",
        calls: 'calls',
        lastHour: 'Spent · last hour',
        today: 'Spent · today',
        sampled: 'Balance sampled from',
        sampledTail: ' — earlier spending not included',
        inputTok: 'Input tokens',
        outputTok: 'Output tokens',
        reasoningTok: 'Reasoning tokens (not billed)',
        statDate: 'Stats date',
        totalTok: 'Total tokens',
        trend: 'Balance · 24h',
        daysLeft: (v) => '~' + v + ' days left',
        hoursLeft: (v) => '~' + v + ' h left',
        barely: 'barely used',
        sound: 'Completion sound',
        test: 'Test',
        testTip: 'Play a test sound',
        volume: 'Volume',
        volumeTip: 'Sound volume',
        dragHint: 'Drag the title bar to move',
        source: 'Source: ',
        sourceAccount: 'DSH account service',
        sourceApi: 'Official API',
        topUp: 'Top up',
        usage: 'Usage',
        waiting: (n) => '⏳ Awaiting your approval · ' + n,
        openSession: 'Click to open this session',
        low: (v) => 'Below ' + v + ' — top up soon',
        insufficient: '⚠ Balance too low to keep calling',
        cantRead: 'Cannot read balance: ',
        ballTip: (m) => 'DeepSeek balance ' + m,
        ballWait: (n) => ' · ' + n + ' awaiting approval',
        ballHint: ' (click for details, Alt+B works too)',
        on: 'Sound on — click to mute',
        off: 'Muted — click to enable',
        langBtn: '中',
        langTip: '切换到中文',
      },
    };

    const ballStyle = (dragging, expanded) => ({
      position: 'fixed',
      zIndex: 2147483000,
      width: SIZE,
      height: SIZE,
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: dragging ? 'grabbing' : 'pointer',
      userSelect: 'none',
      touchAction: 'none',
      background: 'linear-gradient(135deg,#2f6bff 0%,#7b3ff2 100%)',
      color: '#fff',
      boxShadow: expanded
        ? '0 6px 22px rgba(0,0,0,.42)'
        : '0 3px 12px rgba(0,0,0,.30)',
      transition: dragging ? 'none' : 'transform .12s ease, box-shadow .12s ease',
      transform: expanded ? 'scale(1.04)' : 'none',
      fontFamily: 'inherit',
    });

    const cardStyle = {
      position: 'fixed',
      zIndex: 2147483000,
      width: 232,
      padding: '12px 14px 10px',
      borderRadius: 12,
      // ★★ 主题 token（来自 DSH 官方 slot-catalog / 社区实测）
      //    深色/浅色自动跟随，不用自己写死颜色
      background: 'var(--dsw-alias-bg-layer-2, rgba(24,24,28,.96))',
      color: 'var(--dsw-alias-label-primary, #f2f2f4)',
      boxShadow: 'var(--dsw-shadow-lv3, 0 10px 34px rgba(0,0,0,.48))',
      border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08))',
      fontSize: 12,
      lineHeight: 1.55,
      fontFamily: 'inherit',
      // ★★★ 绝对不要用 backdrop-filter / filter / transform / will-change：
      //   它们会让这个元素成为 fixed 后代的**包含块**，
      //   把浮层困在某个小容器里（社区踩过：面板被锁在 280px 侧栏内）
    };

    // ── 工具 ──────────────────────────────────────────────
    /**
     * ★★ 金额**不走浮点**（社区最佳实践：全程字符串透传）
     *
     * 输入形如 "80.3644524000000000"（后端原始精度）。
     * 用整数「分」做 BigInt 加法 + 四舍五入，避开 0.1+0.2 那类误差。
     */
    function toCents(s) {
      // ★ 空串必须返回 null：旧版把 '' 也匹配成正则（\d* 允许空），
      //   于是「只有 total、没有 toppedUp/granted」的数据会被算成 0 分，
      //   余额显示成 ¥0.00（2026-10-26 用渲染测试抓到的真实 bug）。
      const text = String(s == null ? '' : s).trim();
      if (!text) return null;
      const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
      if (!m) return null;
      const sign = m[1] === '-' ? -1n : 1n;
      const intPart = m[2] || '0';
      const frac = (m[3] || '').padEnd(3, '0'); // 取 3 位，第 3 位用于四舍五入
      const cents = BigInt(intPart) * 100n + BigInt(frac.slice(0, 2));
      const roundUp = Number(frac[2] || '0') >= 5;
      return sign * (cents + (roundUp ? 1n : 0n));
    }

    function centsToMoney(c) {
      if (c == null) return '—';
      const neg = c < 0n;
      const abs = neg ? -c : c;
      const whole = abs / 100n;
      const frac = String(abs % 100n).padStart(2, '0');
      return (neg ? '-' : '') + String(whole) + '.' + frac;
    }

    function n2(v) {
      return centsToMoney(toCents(v));
    }

    function money(cur, v) {
      const sym = cur === 'USD' ? '$' : '¥';
      return sym + (v == null || v === '' ? '—' : n2(v));
    }

    /** token 数：小于 10000 带千分位，大于等于 10000 缩写成 12.3k */
    function kfmt(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '—';
      if (v < 10000) return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      if (v < 1000000) return (v / 1000).toFixed(1) + 'k';
      return (v / 1000000).toFixed(2) + 'M';
    }

    /**
     * ★ 总余额 = 现金 + 赠送（整数分相加）
     *   出处：deepseekAccount.getBalance() 分别给 value(现金) 与 bonusWallets(赠送)，
     *   没有直接给 total；官方 /user/balance 的 total_balance 与本和可能差 1 分
     *   （官方端取整），显示时以后端合计为准。
     */
    function totalOf(d) {
      const a = toCents(d && d.toppedUp);
      const b = toCents(d && d.granted);
      if (a == null && b == null) return d && d.total;
      return centsToMoney((a == null ? 0n : a) + (b == null ? 0n : b));
    }

    /** ISO(UTC) 字符串 -> 本地 HH:mm:ss
     *  ★ 之前直接切字符串第 11~19 位，那是 UTC，会差时区（实测差 8 小时） */
    function localTime(iso) {      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleTimeString(undefined, {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    }

    /**
     * 官方峰谷时段（api-docs.deepseek.com/quick_start/pricing）：
     *   高峰 = UTC 01:00-04:00 与 06:00-10:00，周一至周五，
     *   即北京时间 09:00-12:00 与 14:00-18:00；中国法定节假日全天低峰。
     *   低峰价 = 高峰价的 5 折。
     *
     * 节假日表来自国办发明电〔2025〕7 号（2026 年放假安排）。
     * ★ 只用于判断价格时段，不在界面上显示节假日名称。
     */
    const CN_HOLIDAYS_2026 = [
      ['2026-01-01', '2026-01-03', '元旦'],
      ['2026-02-15', '2026-02-23', '春节'],
      ['2026-04-04', '2026-04-06', '清明'],
      ['2026-05-01', '2026-05-05', '劳动节'],
      ['2026-06-19', '2026-06-21', '端午'],
      ['2026-09-25', '2026-09-27', '中秋'],
      ['2026-10-01', '2026-10-07', '国庆'],
    ];

    function holidayOf(key) {
      for (const [a, b, name] of CN_HOLIDAYS_2026) {
        if (key >= a && key <= b) return name;
      }
      return null;
    }

    function peakStatus(now = new Date()) {
      const bj = new Date(now.getTime() + 8 * 3600 * 1000);
      const key = bj.toISOString().slice(0, 10);
      const day = bj.getUTCDay();                  // 0=周日
      const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
      const inWin = (a, b) => mins >= a && mins < b;
      const holiday = holidayOf(key);
      const peak = !holiday && day >= 1 && day <= 5
        && (inWin(9 * 60, 12 * 60) || inWin(14 * 60, 18 * 60));
      return {
        peak,
        holiday,                                   // 仅内部使用，不渲染
      };
    }

    function clampPos(x, y) {
      const maxX = Math.max(0, window.innerWidth - SIZE - 8);
      const maxY = Math.max(0, window.innerHeight - SIZE - 8);
      return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
    }

    /** 把 24 小时采样点画成一条迷你折线的 path（无数据返回 null） */
    function sparkPath(points, w, h) {
      if (!Array.isArray(points) || points.length < 2) return null;
      let min = Infinity;
      let max = -Infinity;
      for (const p of points) {
        const v = Number(p && p.v);
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
      const span = max - min || 1;
      const stepX = w / (points.length - 1);
      let d = '';
      for (let i = 0; i < points.length; i += 1) {
        const v = Number(points[i] && points[i].v);
        const x = i * stepX;
        const y = h - ((v - min) / span) * h;
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
      }
      return d;
    }

    // ── 主组件 ────────────────────────────────────────────
    // 「点横幅跳到那个会话」——apply() 时从 client 服务取，取不到就退化成不可点
    let openSessionPlugin = null;

    function BalanceBall() {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [open, setOpen] = useState(() => {
        try { return window.localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
      });
      useEffect(() => {
        try { window.localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* ignore */ }
      }, [open]);
      const [hidden, setHidden] = useState(
        () => typeof document !== 'undefined' && document.hidden === true,
      );
      const ballRef = useRef(null);

      // ⭐ 中 / 英切换（存 localStorage，跟系统语言无关，用户自己按）
      const [lang, setLang] = useState(() => {
        try { return window.localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
      });
      useEffect(() => {
        try { window.localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
      }, [lang]);
      const t = STRINGS[lang] || STRINGS.zh;

      // ⭐ 任务完成提示音开关（服务端为准，本地先乐观更新）
      //    初始值读上次缓存：不然数据还没回来时开关会先画成「开」，跟真实状态不一致。
      const [chime, setChime] = useState(() => {
        try {
          const raw = window.localStorage.getItem(CHIME_KEY);
          return raw === '0' ? false : raw === '1' ? true : null;
        } catch {
          return null;
        }
      });
      const rememberChime = useCallback((v) => {
        try { window.localStorage.setItem(CHIME_KEY, v ? '1' : '0'); } catch { /* ignore */ }
      }, []);
      // 接口失败不再静默：至少 console 里能看见（试听键那次的教训）
      const reportChimeError = useCallback((detail) => {
        try { console.warn('[ds-balance] chime request failed:', detail); } catch { /* ignore */ }
      }, []);
      useEffect(() => {
        if (data && data.chime && typeof data.chime.enabled === 'boolean') {
          setChime(data.chime.enabled);
          rememberChime(data.chime.enabled);
        }
      }, [data, rememberChime]);
      const toggleChime = useCallback(async (next) => {
        setChime(next);
        rememberChime(next);
        try {
          const r = await fetch('/api/ds-balance/chime', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
          });
          if (!r.ok) {
            reportChimeError('HTTP ' + r.status);
            setChime(!next);
            rememberChime(!next);
            return;
          }
          const j = await r.json();
          if (j && j.chime && typeof j.chime.enabled === 'boolean') {
            setChime(j.chime.enabled);
            rememberChime(j.chime.enabled);
          }
        } catch (err) {
          setChime(!next);
          rememberChime(!next);
          reportChimeError(err && err.message ? err.message : err);
        }
      }, [rememberChime, reportChimeError]);
      const previewChime = useCallback(async () => {
        try {
          const r = await fetch('/api/ds-balance/chime', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ play: true }),
          });
          if (!r.ok) reportChimeError('HTTP ' + r.status);
        } catch (err) {
          reportChimeError(err && err.message ? err.message : err);
        }
      }, [reportChimeError]);

      // ⭐ 提示音音量（0–100）
      //    拖的时候不让轮询把值冲掉（否则滑块会往回跳，手感很渣），
      //    松手 200ms 后才落盘，避免拖一次发一堆 POST。
      const [volume, setVolume] = useState(60);
      const volumeEditing = useRef(false);
      const volumeTouchedAt = useRef(0);
      const volumeRef = useRef(60);
      useEffect(() => { volumeRef.current = volume; }, [volume]);
      useEffect(() => {
        if (volumeEditing.current) return;
        if (Date.now() - volumeTouchedAt.current < 1500) return;
        if (data && data.chime && Number.isFinite(Number(data.chime.volume))) {
          setVolume(Number(data.chime.volume));
        }
      }, [data]);
      const saveVolume = useCallback((v) => {
        fetch('/api/ds-balance/chime', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ volume: v }),
        }).catch(() => {});
      }, []);
      const volumeTimer = useRef(0);
      const changeVolume = useCallback((next) => {
        const v = Math.max(0, Math.min(100, Math.round(next)));
        volumeTouchedAt.current = Date.now();
        setVolume(v);
        window.clearTimeout(volumeTimer.current);
        volumeTimer.current = window.setTimeout(() => saveVolume(v), 200);
      }, [saveVolume]);
      const beginVolume = useCallback(() => {
        volumeEditing.current = true;
        window.clearTimeout(volumeTimer.current);
      }, []);
      const endVolume = useCallback(() => {
        if (!volumeEditing.current) return;
        volumeEditing.current = false;
        volumeTouchedAt.current = Date.now();
        window.clearTimeout(volumeTimer.current);
        saveVolume(volumeRef.current);
      }, [saveVolume]);
      const [pos, setPos] = useState(() => {
        try {
          const raw = localStorage.getItem(POS_KEY);
          if (raw) {
            const p = JSON.parse(raw);
            if (typeof p.x === 'number' && typeof p.y === 'number') return clampPos(p.x, p.y);
          }
        } catch {
          /* ignore */
        }
        return {
          x: Math.max(8, window.innerWidth - SIZE - 24),
          y: Math.max(8, window.innerHeight - SIZE - 96),
        };
      });
      const drag = useRef({ active: false, moved: false, dx: 0, dy: 0 });

      // ★ 卡片尺寸（用来把卡片**居中**对齐到球上，而不是凭感觉写死偏移）
      const cardRef = useRef(null);
      const [cardSize, setCardSize] = useState({ w: 240, h: 260 });
      useLayoutEffect(() => {
        if (!open) return;
        const el = cardRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          setCardSize((prev) =>
            Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1
              ? prev
              : { w: r.width, h: r.height },
          );
        }
      }, [open, data, error, pos.x, pos.y]);

      // 拉数据
      // ★ 刷新节流：10 秒内连点「刷新」不重复打官方接口（force 会被降级成缓存读）
      const lastForce = useRef(0);
      const pull = useCallback(async (force) => {
        const now = Date.now();
        const wantRefresh = force === true && now - lastForce.current > 10000;
        if (wantRefresh) lastForce.current = now;
        try {
          const r = await fetch('/api/ds-balance' + (wantRefresh ? '?refresh=1' : ''), {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          const j = await r.json();
          if (j && j.ok) {
            setData(j);
            setError(null);
          } else {
            setError((j && (j.reason || 'unknown')) || 'unknown');
          }
        } catch (e) {
          setError(String((e && e.message) || e));
        }
      }, []);

      // 轮询：卡片开着 5s、收起 20s、窗口最小化 2 分钟
      useEffect(() => {
        const onVis = () => setHidden(document.hidden === true);
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
      }, []);
      useEffect(() => {
        let alive = true;
        pull(false);
        const period = hidden ? POLL_HIDDEN_MS : (open ? POLL_OPEN_MS : POLL_IDLE_MS);
        const id = setInterval(() => {
          if (alive) pull(false);
        }, period);
        return () => {
          alive = false;
          clearInterval(id);
        };
      }, [pull, open, hidden]);

      // 点卡片外面 / 按 ESC 收起
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
          const t = e.target;
          if (!t) return;
          if (cardRef.current && cardRef.current.contains(t)) return;
          if (ballRef.current && ballRef.current.contains(t)) return;
          setOpen(false);
        };
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      // Alt+B 开合卡片（输入框里打字时不抢）
      useEffect(() => {
        const onKey = (e) => {
          if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
          if (String(e.key || '').toLowerCase() !== 'b') return;
          const el = document.activeElement;
          const tag = el && el.tagName ? el.tagName.toLowerCase() : '';
          if (tag === 'input' || tag === 'textarea' || tag === 'select' || (el && el.isContentEditable)) return;
          e.preventDefault();
          setOpen((v) => !v);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

      // 窗口尺寸变化时夹回来
      useEffect(() => {
        const onResize = () => setPos((p) => clampPos(p.x, p.y));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      // 拖拽
      // ★ 三条社区实测要求：
      //   ① setPointerCapture（已用） ② stopPropagation（浮层里必须，否则事件冒到宿主）
      //   ③ 3px 阈值区分「点击」与「拖动」
      const onPointerDown = (e) => {
        if (e.button != null && e.button !== 0) return;
        e.stopPropagation();
        drag.current = {
          active: true,
          moved: false,
          dx: e.clientX - pos.x,
          dy: e.clientY - pos.y,
        };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };

      const onPointerMove = (e) => {
        const d = drag.current;
        if (!d.active) return;
        e.stopPropagation();
        const nx = e.clientX - d.dx;
        const ny = e.clientY - d.dy;
        if (Math.abs(nx - pos.x) > 3 || Math.abs(ny - pos.y) > 3) d.moved = true;
        setPos(clampPos(nx, ny));
      };

      const onPointerUp = (e) => {
        const d = drag.current;
        if (!d.active) return;
        e.stopPropagation();
        d.active = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        if (d.moved) {
          const p = clampPos(pos.x, pos.y);
          setPos(p);
          try {
            localStorage.setItem(POS_KEY, JSON.stringify(p));
          } catch {
            /* ignore */
          }
        } else {
          setOpen((v) => !v);
        }
      };

      // ★★ 卡片标题栏拖动：球被卡片盖住时，靠标题栏移动整张卡片
      // ★★ 卡片标题栏拖动：球被卡片盖住时，靠标题栏移动整张卡片
      const cardDrag = useRef({ active: false, dx: 0, dy: 0 });

      const cardDown = (e) => {
        if (e.button != null && e.button !== 0) return;
        // 别抢「刷新」「✕」「充值」「用量」这些按钮的点击
        const t = e.target;
        if (t && typeof t.closest === 'function' && t.closest('button,a')) return;
        e.stopPropagation();
        cardDrag.current = {
          active: true,
          dx: e.clientX - pos.x,
          dy: e.clientY - pos.y,
        };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };

      const cardMove = (e) => {
        if (!cardDrag.current.active) return;
        e.stopPropagation();
        setPos(clampPos(e.clientX - cardDrag.current.dx, e.clientY - cardDrag.current.dy));
      };

      const cardUp = (e) => {
        if (!cardDrag.current.active) return;
        e.stopPropagation();
        cardDrag.current.active = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        const p = clampPos(pos.x, pos.y);
        setPos(p);
        try {
          localStorage.setItem(POS_KEY, JSON.stringify(p));
        } catch {
          /* ignore */
        }
      };

      const cur = (data && data.currency) || 'CNY';
      const total = data ? totalOf(data) : null;
      const label = data ? money(cur, total) : error ? '!' : '…';
      const low = data && data.available === false;

      // ★ 球的三态：正常 / 余额低（黄）/ 等确认（黄+角标）/ 读不到（红）
      const waitingCount = Number(data && data.status && data.status.waiting) || 0;
      const waitingList = (data && data.status && Array.isArray(data.status.waitingList))
        ? data.status.waitingList
        : [];
      // 链接永远有值（服务端没给就用兜底），底部一行的宽度从第一帧起就是稳定的
      const links = Object.assign({}, DEFAULT_LINKS, (data && data.links) || {});
      const warnLow = !!(data && data.warn && data.warn.low);
      const failed = !data && !!error;
      const tone = failed ? 'error' : waitingCount > 0 ? 'waiting' : (warnLow || low) ? 'low' : 'ok';
      const toneBg = tone === 'error'
        ? 'linear-gradient(135deg,#8f2020 0%,#d13b3b 100%)'
        : tone === 'waiting'
          ? 'linear-gradient(135deg,#a86400 0%,#e0a300 100%)'
          : tone === 'low'
            ? 'linear-gradient(135deg,#a86400 0%,#d9a520 100%)'
            : 'linear-gradient(135deg,#2f6bff 0%,#7b3ff2 100%)';

      const ball = h(
        'div',
        {
          ref: ballRef,
          style: { ...ballStyle(drag.current.active, open),
                   background: toneBg,
                   left: pos.x + 'px', top: pos.y + 'px',
                   pointerEvents: 'auto' },
          title: data
            ? t.ballTip(money(cur, total))
              + (waitingCount > 0 ? t.ballWait(waitingCount) : '')
              + (waitingCount > 0 && waitingList.length
                  ? ' · ' + waitingList.slice(0, 3).map((w) => (w && w.tool) || 'approval').join(', ')
                  : '')
              + t.ballHint
            : t.title,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          role: 'button',
          tabIndex: 0,
          'aria-label': t.title,
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((v) => !v);
            }
          },
        },
        h(
          'span',
          {
            style: {
              fontSize: label.length > 5 ? 10 : 12,
              fontWeight: 600,
              letterSpacing: '.2px',
              whiteSpace: 'nowrap',
              textShadow: '0 1px 2px rgba(0,0,0,.35)',
            },
          },
          label,
        ),
        waitingCount > 0
          ? h('span', {
              style: {
                position: 'absolute', top: -3, right: -3, minWidth: 15, height: 15, padding: '0 3px',
                borderRadius: 999, background: '#e0a300', color: '#1b1b1b',
                fontSize: 9, fontWeight: 700, lineHeight: '15px', textAlign: 'center',
                boxShadow: '0 1px 3px rgba(0,0,0,.45)',
              },
            }, String(waitingCount))
          : failed
            ? h('span', {
                style: {
                  position: 'absolute', top: -3, right: -3, width: 12, height: 12,
                  borderRadius: '50%', background: '#f85149', color: '#fff',
                  fontSize: 9, fontWeight: 700, lineHeight: '12px', textAlign: 'center',
                  boxShadow: '0 0 0 2px rgba(0,0,0,.35)',
                },
              }, '!')
            : null,
      );

      if (!open) return ball;

      // ★★★ 卡片对齐规则：
      //   ① 空间够 -> **居中对齐**到球（卡片中心 = 球中心）
      //   ② 靠边放不下 -> **翻侧**：让卡片贴住球的那一侧，尽量靠近球
      //      右下角的球是最常见的情况；不翻侧的话卡片会被视口夹到很远。
      const cardW = cardSize.w || 240;
      const cardH = cardSize.h || 260;
      const M = 8;
      const cx = pos.x + SIZE / 2;
      const cy = pos.y + SIZE / 2;

      let cardLeft;
      const wantLeft = cx - cardW / 2;
      if (wantLeft >= M && wantLeft + cardW <= window.innerWidth - M) {
        cardLeft = wantLeft;                       // 居中
      } else if (cx > window.innerWidth / 2) {
        cardLeft = pos.x + SIZE - cardW;           // 贴右：右缘对齐
      } else {
        cardLeft = pos.x;                          // 贴左
      }

      let cardTop;
      const wantTop = cy - cardH / 2;
      if (wantTop >= M && wantTop + cardH <= window.innerHeight - M) {
        cardTop = wantTop;                         // 居中
      } else if (cy > window.innerHeight / 2) {
        cardTop = pos.y - cardH + SIZE;            // 上翻：底缘对齐
      } else {
        cardTop = pos.y;                           // 下翻
      }

      cardLeft = Math.min(Math.max(M, cardLeft),
                          Math.max(M, window.innerWidth - cardW - M));
      cardTop = Math.min(Math.max(M, cardTop),
                         Math.max(M, window.innerHeight - cardH - M));

      // ★ 「赠送」这一行：**金额为 0 就不显示**
      //   正常情况下赠送余额是 0，只有活动/补偿才会发，
      //   常驻一行 0 是噪声。用整数分判断，避免浮点误差。
      const grantedCents = data ? toCents(data.granted) : null;
      const hasGranted = grantedCents != null && grantedCents > 0n;
      // 现金同理：为 0 时也不用特意显示（赠送占满的情况）
      const toppedCents = data ? toCents(data.toppedUp) : null;
      const hasTopped = toppedCents != null && toppedCents !== 0n;

      const rows = data
        ? [
            [t.total, money(cur, total), true],
            ...(hasTopped ? [[t.topped, money(cur, data.toppedUp), false]] : []),
            ...(hasGranted ? [[t.granted, money(cur, data.granted), false]] : []),
          ]
        : [];

      const card = h(
        'div',
        { ref: cardRef,
          style: { ...cardStyle, left: cardLeft + 'px', top: cardTop + 'px',
                   maxHeight: Math.max(160, window.innerHeight - 24) + 'px',
                   overflowY: 'auto',
                   // 同上：浮层内也要 opt-in 指针事件
                   pointerEvents: 'auto' } },
        h(
          'div',
          {
            // ★ 标题栏 = 拖动条（球被卡片盖住时靠这个移动整张卡片）
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 6,
              cursor: 'move',
              touchAction: 'none',
              userSelect: 'none',
            },
            onPointerDown: cardDown,
            onPointerMove: cardMove,
            onPointerUp: cardUp,
            onPointerCancel: cardUp,
            title: t.dragCard,
          },
          h('span', { style: { fontWeight: 600, fontSize: 12 } }, t.title),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              onClick: () => pull(true),
              title: t.refresh,
              style: {
                background: 'transparent', border: 'none', color: 'var(--dsw-alias-label-secondary, #9aa4ff)',
                cursor: 'pointer', fontSize: 11, padding: '2px 4px',
              },
            },
            t.refresh,
          ),
          h(
            'button',
            {
              onClick: () => setOpen(false),
              title: t.collapse,
              style: {
                background: 'transparent', border: 'none', color: 'var(--dsw-alias-label-secondary, #9aa4ff)',
                cursor: 'pointer', fontSize: 11, padding: '2px 4px',
              },
            },
            '✕',
          ),
        ),

        waitingCount > 0
          ? h('div', {
              style: {
                marginTop: 6, padding: '4px 8px', borderRadius: 8,
                background: 'rgba(210,153,34,.16)',
                border: '1px solid rgba(210,153,34,.42)',
                color: '#e0a300', fontSize: 10.5, fontWeight: 600,
              },
            }, [
              h('div', null, t.waiting(waitingCount)),
              waitingList.slice(0, 2).map((w, i) => h('div', {
                key: (w && w.sessionId) || ('w' + i),
                onClick: () => { if (openSessionPlugin && w && w.sessionId) openSessionPlugin(w.sessionId); },
                title: (w && w.title ? w.title + ' — ' : '') + t.openSession,
                style: {
                  marginTop: 3, display: 'flex', gap: 6, alignItems: 'baseline',
                  fontWeight: 500, cursor: openSessionPlugin ? 'pointer' : 'default',
                },
              },
                h('span', { style: { whiteSpace: 'nowrap' } }, (w && w.tool) || 'approval'),
                w && w.title
                  ? h('span', {
                      style: {
                        opacity: 0.62, fontWeight: 400, minWidth: 0,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      },
                    }, '· ' + w.title)
                  : null,
              )),
            ])
          : null,

        error && !data
          ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #ff9a9a)', fontSize: 11 } },
              t.cantRead + error)
          : h(
              'div',
              null,
              rows.map(([k, v, big]) =>
                h(
                  'div',
                  { key: k, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
                  h('span', { style: { opacity: 0.68, fontSize: 11 } }, k),
                  h('span', { style: { fontSize: big ? 17 : 12, fontWeight: big ? 650 : 500 } }, v),
                ),
              ),
            ),

        warnLow
          ? h('div', {
              style: {
                marginTop: 6, color: 'var(--dsw-alias-state-warn-primary, #ffcf6b)', fontSize: 10.5,
              },
            }, t.low(money(cur, String((data && data.warn && data.warn.threshold) || 2))))
          : null,

        (() => {
          const st = peakStatus();
          return h(
            'div',
            { style: { marginTop: 7, paddingTop: 6,
                       borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.06))' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
              h('span', { style: { opacity: 0.68, fontSize: 10.5 } }, t.window),
              h('span', { style: { fontSize: 10.5, fontWeight: 550,
                                   color: st.peak ? '#ffcf6b' : '#3ddc84' } },
                st.peak ? t.peak : t.offpeak),
            ),
            h('div', { style: { marginTop: 2, opacity: 0.45, fontSize: 9.5 } },
              t.windowHint),
          );
        })(),

        low
          ? h('div', { style: { marginTop: 6, color: 'var(--dsw-alias-state-warn-primary, #ffcf6b)', fontSize: 11 } },
              t.insufficient)
          : null,

        // ★★★ 今日用量（本地统计：拦 llm/stream 的 usage 帧）
        (() => {
          const u = data && data.usage;
          if (!u) return null;
          const line = (k, v, dim) => h(
            'div',
            { key: k, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
            h('span', { style: { opacity: dim ? 0.55 : 0.68, fontSize: dim ? 10 : 10.5 } }, k),
            h('span', { style: { fontSize: dim ? 10 : 10.5, fontWeight: dim ? 400 : 550 } }, v),
          );
          const sp = (data && data.spend) || null;
          const cur2 = u.currency || cur;
          return h(
            'div',
            {
              style: {
                marginTop: 9,
                paddingTop: 8,
                borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08))',
              },
            },
            h(
              'div',
              { style: { fontSize: 10, opacity: 0.55, marginBottom: 3, letterSpacing: '.2px' } },
              t.todayUsage + (u.calls ? ' · ' + u.calls + ' ' + t.calls : ''),
            ),
            // ★ 花费两行（按余额下降推算，不用价格表）
            sp && sp.lastHour != null
              ? line(t.lastHour + (sp.hourFull === false ? '*' : ''),
                     money(cur2, sp.lastHour))
              : null,
            sp && sp.today != null
              ? line(t.today + (sp.todayFull === false ? '*' : ''),
                     money(cur2, sp.today), false)
              : null,
            sp && (sp.hourFull === false || sp.todayFull === false)
              ? h('div', { style: { fontSize: 9.5, opacity: 0.5, marginTop: 1 } },
                  '*' + t.sampled + ' ' + (() => {
                    try {
                      const d = new Date(sp.coveredSince);
                      const p2 = (n) => String(n).padStart(2, '0');
                      return p2(d.getHours()) + ':' + p2(d.getMinutes());
                    } catch { return '—'; }
                  })() + t.sampledTail)
              : null,
            // token 组：跟上面花费行保持同一条节奏（统一 6px 组间距），
            // 不再用零散的 4px 占位——删掉缓存命中那两行之后间距才会发飘。
            h(
              'div',
              { style: { marginTop: 6 } },
              line(t.inputTok, kfmt(u.inputTokens)),
              line(t.outputTok, kfmt(u.outputTokens)),
              u.reasoningTokens
                ? line(t.reasoningTok, kfmt(u.reasoningTokens), true)
                : null,
              line(u.date ? t.statDate + ' ' + u.date : t.totalTok, kfmt(u.totalTokens)),
            ),
          );
        })(),

        // ⭐ 24 小时余额曲线 + 还能撑几天
        (() => {
          const sp = data && data.spend;
          const path = sp && sparkPath(sp.series, 200, 28);
          if (!path) return null;
          const tail = sp.daysLeft != null
            ? (sp.daysLeft >= 1
                ? t.daysLeft(sp.daysLeft)
                : t.hoursLeft(Math.max(1, Math.round(sp.daysLeft * 24))))
            : (sp.ratePerDay > 0 ? '' : t.barely);
          return h('div', {
            style: {
              marginTop: 8, paddingTop: 7,
              borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.06))',
            },
          },
            h('div', {
              style: {
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                fontSize: 10.5, opacity: 0.68, marginBottom: 3,
              },
            },
              h('span', null, t.trend),
              tail ? h('span', null, tail) : null,
            ),
            h('svg', {
              width: 200, height: 28, viewBox: '0 0 200 28',
              style: { display: 'block', overflow: 'visible' },
            },
              h('path', {
                d: path, fill: 'none', stroke: '#4fb3ff', strokeWidth: 1.5,
                strokeLinejoin: 'round', strokeLinecap: 'round',
              }),
            ),
          );
        })(),

        // ⭐ 任务完成提示音开关（这个卡片自己的 UI）
        (() => {
          const on = chime !== false;
          return h(
            'div',
            {
              style: {
                display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, paddingTop: 7,
                borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08))',
              },
            },
            h('span', { style: { opacity: 0.68, fontSize: 10.5 } }, t.sound),
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button',
              onClick: previewChime,
              title: t.testTip,
              style: {
                background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 2px',
                fontSize: 10.5, color: 'var(--dsw-alias-label-secondary, #9aa4ff)', opacity: 0.85,
              },
            }, t.test),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': on,
              onClick: () => toggleChime(!on),
              title: on ? t.on : t.off,
              style: {
                position: 'relative', width: 30, height: 16, borderRadius: 999, cursor: 'pointer',
                border: '1px solid ' + (on ? 'rgba(79,179,255,.55)' : 'rgba(255,255,255,.16)'),
                background: on ? 'rgba(79,179,255,.34)' : 'rgba(255,255,255,.08)',
                padding: 0, transition: 'background 140ms ease',
              },
            },
              h('span', {
                style: {
                  position: 'absolute', top: 1, left: on ? 15 : 1, width: 12, height: 12,
                  borderRadius: '50%', background: on ? '#4fb3ff' : 'rgba(255,255,255,.45)',
                  transition: 'left 140ms ease',
                },
              }),
            ),
          );
        })(),

        // ⭐ 提示音音量（开关关着时也显示，只是变淡——先调好音量再决定开不开）
        h(
          'div',
          {
            style: {
              display: 'flex', alignItems: 'center', gap: 8, marginTop: 5,
              opacity: chime === false ? 0.5 : 1,
            },
          },
          h('span', { style: { opacity: 0.68, fontSize: 10.5 } }, t.volume),
          h('input', {
            type: 'range', min: 0, max: 100, step: 1, value: volume,
            onChange: (ev) => changeVolume(Number(ev.target.value)),
            onPointerDown: (ev) => { ev.stopPropagation(); beginVolume(); },
            onPointerUp: endVolume,
            onPointerCancel: endVolume,
            onBlur: endVolume,
            title: t.volumeTip,
            style: {
              flex: 1, height: 18, accentColor: '#4fb3ff', cursor: 'pointer', margin: 0,
              touchAction: 'none',
            },
          }),
          h('span', { style: { width: 28, textAlign: 'right', fontSize: 10.5, opacity: 0.8 } },
            volume + '%'),
        ),

        h(
          'div',
          {
            style: {
              marginTop: 9,
              paddingTop: 8,
              borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.08))',
              fontSize: 10.5,
              opacity: 0.45,
              userSelect: 'none',
            },
          },
          [t.dragHint],
        ),

        data && data.source
          ? h('div', { style: { marginTop: 7, opacity: 0.5, fontSize: 10.5 } },
              t.source + (data.source === 'account' ? t.sourceAccount : t.sourceApi) +
                (data.at ? ' · ' + localTime(data.at) : ''))
          : null,

        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 9, alignItems: 'center' } },
          h('a', {
            href: links.topUpUrl, target: '_blank', rel: 'noreferrer',
            style: { color: 'var(--dsw-alias-label-secondary, #9aa4ff)', fontSize: 11, textDecoration: 'none' },
          }, t.topUp),
          h('a', {
            href: links.usageUrl, target: '_blank', rel: 'noreferrer',
            style: { color: 'var(--dsw-alias-label-secondary, #9aa4ff)', fontSize: 11, textDecoration: 'none' },
          }, t.usage),
          // ⭐ 中/英切换（紧挨「用量」右侧的小胶囊，不改变这一行的行高）
          h('button', {
            type: 'button',
            onClick: (e) => { e.stopPropagation(); setLang(lang === 'zh' ? 'en' : 'zh'); },
            onPointerDown: (e) => e.stopPropagation(),
            title: t.langTip,
            style: {
              marginLeft: 2, padding: '2px 6px', borderRadius: 6, cursor: 'pointer',
              background: 'rgba(255,255,255,.06)',
              border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.18))',
              color: 'var(--dsw-alias-label-secondary, #9aa4ff)',
              font: 'inherit', fontSize: 10, lineHeight: 1.2,
            },
          }, t.langBtn),
        ),
      );

      // ★ shell.overlay 这一层是 click-through（穿透），
      //   所以：外层容器一律 pointer-events:none（绝不挡下面的输入框），
      //   只有球和卡片自己 opt-in auto。
      return h('div', { style: { pointerEvents: 'none' } }, ball, card);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // uiWorkspace 是可选服务：拿不到就只是不能点击跳转，不影响余额显示
        try {
          const ws = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : ctx.uiWorkspace;
          if (ws && typeof ws.openSession === 'function') {
            openSessionPlugin = (id) => {
              try { ws.openSession(id); } catch { /* ignore */ }
            };
          }
        } catch {
          /* ignore */
        }
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'ds-balance', order: 900 },
            BalanceBall,
          ),
        );
      },
    };
  },
});
