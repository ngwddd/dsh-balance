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

    const POLL_MS = 5000;
    const POS_KEY = 'dsh.ds-balance.pos';
    const SIZE = 46;

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
      const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(String(s == null ? '' : s).trim());
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
        label: peak ? '高峰期 · 全价' : '低峰期 · 5 折',
        hint: '工作日 09:00–12:00 / 14:00–18:00（北京时间）',
      };
    }

    function clampPos(x, y) {
      const maxX = Math.max(0, window.innerWidth - SIZE - 8);
      const maxY = Math.max(0, window.innerHeight - SIZE - 8);
      return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
    }

    // ── 主组件 ────────────────────────────────────────────
    function BalanceBall() {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [open, setOpen] = useState(false);
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
      const pull = useCallback(async (force) => {
        try {
          const r = await fetch('/api/ds-balance' + (force ? '?refresh=1' : ''), {
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

      // 轮询
      useEffect(() => {
        let alive = true;
        pull(false);
        const id = setInterval(() => {
          if (alive) pull(false);
        }, POLL_MS);
        return () => {
          alive = false;
          clearInterval(id);
        };
      }, [pull]);

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

      const ball = h(
        'div',
        {
          style: { ...ballStyle(drag.current.active, open),
                   left: pos.x + 'px', top: pos.y + 'px',
                   // ★ 关键：shell.overlay 这一层是 click-through，
                   //   占位元素必须自己 opt-in 指针事件，否则点不到
                   pointerEvents: 'auto' },
          title: data
            ? `DeepSeek 余额 ${money(cur, total)}（点击看明细）`
            : 'DeepSeek 余额',
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          role: 'button',
          tabIndex: 0,
          'aria-label': 'DeepSeek 余额',
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
            ['总余额', money(cur, total), true],
            ...(hasTopped ? [['现金', money(cur, data.toppedUp), false]] : []),
            ...(hasGranted ? [['赠送', money(cur, data.granted), false]] : []),
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
            title: '按住拖动这张卡片',
          },
          h('span', { style: { fontWeight: 600, fontSize: 12 } }, 'DeepSeek 余额'),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              onClick: () => pull(true),
              title: '刷新',
              style: {
                background: 'transparent', border: 'none', color: 'var(--dsw-alias-label-secondary, #9aa4ff)',
                cursor: 'pointer', fontSize: 11, padding: '2px 4px',
              },
            },
            '刷新',
          ),
          h(
            'button',
            {
              onClick: () => setOpen(false),
              title: '收起',
              style: {
                background: 'transparent', border: 'none', color: 'var(--dsw-alias-label-secondary, #9aa4ff)',
                cursor: 'pointer', fontSize: 11, padding: '2px 4px',
              },
            },
            '✕',
          ),
        ),

        error && !data
          ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #ff9a9a)', fontSize: 11 } },
              '读不到余额：' + error)
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

        (() => {
          const st = peakStatus();
          return h(
            'div',
            { style: { marginTop: 7, paddingTop: 6,
                       borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.06))' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
              h('span', { style: { opacity: 0.68, fontSize: 10.5 } }, '当前时段'),
              h('span', { style: { fontSize: 10.5, fontWeight: 550,
                                   color: st.peak ? '#ffcf6b' : '#3ddc84' } }, st.label),
            ),
            h('div', { style: { marginTop: 2, opacity: 0.45, fontSize: 9.5 } },
              st.hint + ' · 节假日全天低峰'),
          );
        })(),

        low
          ? h('div', { style: { marginTop: 6, color: 'var(--dsw-alias-state-warn-primary, #ffcf6b)', fontSize: 11 } },
              '⚠ 余额不足以继续调用')
          : null,

        // ★★★ 今日用量（本地统计：拦 llm/stream 的 usage 帧）
        (() => {
          const u = data && data.usage;
          if (!u) return null;
          const hit = u.cacheHitRate;
          const miss = u.cacheMissRate;
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
              '今日用量' + (u.calls ? ' · ' + u.calls + ' 次调用' : ''),
            ),
            // ★ 花费两行（按余额下降推算，不用价格表）
            sp && sp.lastHour != null
              ? line('这一小时花费' + (sp.hourFull === false ? '*' : ''),
                     money(cur2, sp.lastHour))
              : null,
            sp && sp.today != null
              ? line('今天花费' + (sp.todayFull === false ? '*' : ''),
                     money(cur2, sp.today), false)
              : null,
            sp && (sp.hourFull === false || sp.todayFull === false)
              ? h('div', { style: { fontSize: 9.5, opacity: 0.5, marginTop: 1 } },
                  '*' + ' 余额采样自 ' + (() => {
                    try {
                      const d = new Date(sp.coveredSince);
                      const p2 = (n) => String(n).padStart(2, '0');
                      return p2(d.getHours()) + ':' + p2(d.getMinutes());
                    } catch { return '—'; }
                  })() + ' 起，更早的消费未计入')
              : null,
            sp
              ? h('div', { style: { height: 4 } })
              : null,
            // 缓存命中 / 未命中，带一条小比例条
            h(
              'div',
              { style: { marginBottom: 4 } },
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10.5, marginBottom: 2 } },
                h('span', { style: { opacity: 0.68 } }, '缓存命中'),
                h('span', { style: { fontWeight: 600 } },
                  hit == null ? '—' : hit.toFixed(1) + '%'),
              ),
              h(
                'div',
                {
                  style: {
                    height: 3,
                    borderRadius: 2,
                    background: 'var(--dsw-alias-border-l2, rgba(255,255,255,.14))',
                    overflow: 'hidden',
                  },
                },
                h('span', {
                  style: {
                    display: 'block',
                    height: '100%',
                    width: Math.max(0, Math.min(100, hit || 0)) + '%',
                    background: (hit || 0) >= 60
                      ? 'var(--dsw-alias-state-business-primary, #4fb3ff)'
                      : 'var(--dsw-alias-state-warn-primary, #ffcf6b)',
                  },
                }),
              ),
            ),
            line('未命中', miss == null ? '—' : miss.toFixed(1) + '%', true),
            line('输入 token', kfmt(u.inputTokens)),
            line('输出 token', kfmt(u.outputTokens)),
            u.reasoningTokens
              ? line('推理 token（不计费）', kfmt(u.reasoningTokens), true)
              : null,
            line(u.date ? '统计日 ' + u.date : '合计 token', kfmt(u.totalTokens)),
          );
        })(),

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
          ['按住标题栏拖动'],
        ),

        data && data.source
          ? h('div', { style: { marginTop: 7, opacity: 0.5, fontSize: 10.5 } },
              (data.source === 'account' ? '数据源：DSH 账户服务' : '数据源：官方 API') +
                (data.at ? ' · ' + localTime(data.at) : ''))
          : null,

        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 9 } },
          data && data.links && data.links.topUpUrl
            ? h('a', {
                href: data.links.topUpUrl, target: '_blank', rel: 'noreferrer',
                style: { color: 'var(--dsw-alias-label-secondary, #9aa4ff)', fontSize: 11, textDecoration: 'none' },
              }, '充值')
            : null,
          data && data.links && data.links.usageUrl
            ? h('a', {
                href: data.links.usageUrl, target: '_blank', rel: 'noreferrer',
                style: { color: 'var(--dsw-alias-label-secondary, #9aa4ff)', fontSize: 11, textDecoration: 'none' },
              }, '用量')
            : null,
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
