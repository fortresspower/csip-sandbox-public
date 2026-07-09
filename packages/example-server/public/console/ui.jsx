/* Fortress CSIP Console — shared UI kit. Exposes window.UI */
(function () {
  const { useRef, useEffect, useState } = React;
  const h = React.createElement;

  // ---- minimal stroke icons (simple geometry only) ----
  const ICONS = {
    bolt: 'M13 2 4 14h6l-1 8 9-12h-6z',
    battery: 'M3 8h14v8H3z M19 10h2v4h-2z M6 10v4 M9 10v4',
    wave: 'M3 12c2-6 4 6 6 0s4-6 6 0 4 6 6 0',
    grid: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
    list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
    gear: 'M12 9a3 3 0 100 6 3 3 0 000-6z M19 12a7 7 0 00-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 00-1.7-1l-.4-2.5H10l-.4 2.5a7 7 0 00-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 000 2l-2 1.6 2 3.4 2.4-1a7 7 0 001.7 1l.4 2.5h3.8l.4-2.5a7 7 0 001.7-1l2.4 1 2-3.4-2-1.6a7 7 0 00.1-1z',
    plug: 'M9 2v6 M15 2v6 M7 8h10v3a5 5 0 01-10 0z M12 16v6',
    refresh: 'M20 11a8 8 0 10-1 5 M20 5v6h-6',
    power: 'M12 3v9 M6.5 7a8 8 0 1011 0',
    arrowUp: 'M12 19V5 M6 11l6-6 6 6',
    arrowDown: 'M12 5v14 M6 13l6 6 6-6',
    check: 'M5 12l5 5 9-12',
    x: 'M6 6l12 12 M18 6L6 18',
    dot: 'M12 12m-4 0a4 4 0 108 0 4 4 0 10-8 0',
    chevron: 'M9 6l6 6-6 6',
    doc: 'M6 2h8l4 4v16H6z M14 2v4h4',
  };
  function Icon({ name, size = 16, className = '', style }) {
    return h('svg', { className: 'icn ' + className, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', style },
      h('path', { d: ICONS[name] || ICONS.dot }));
  }

  function Card({ title, sub, right, children, pad = true, className = '', accent }) {
    return h('section', { className: 'card ' + className, 'data-accent': accent || undefined },
      (title || right) && h('header', { className: 'card-h' },
        h('div', null,
          title && h('h3', { className: 'card-t' }, title),
          sub && h('p', { className: 'card-s' }, sub)),
        right && h('div', { className: 'card-r' }, right)),
      h('div', { className: pad ? 'card-b' : 'card-b np' }, children));
  }

  function Button({ children, onClick, variant = 'default', size = 'md', icon, disabled, type = 'button', title }) {
    return h('button', { type, className: `btn btn-${variant} btn-${size}`, onClick, disabled, title },
      icon && h(Icon, { name: icon, size: size === 'sm' ? 14 : 16 }),
      children && h('span', null, children));
  }

  function Field({ label, hint, children, htmlFor }) {
    return h('label', { className: 'field', htmlFor },
      label && h('span', { className: 'field-l' }, label),
      children,
      hint && h('span', { className: 'field-h' }, hint));
  }

  function TextInput(props) { return h('input', Object.assign({ className: 'inp' }, props)); }
  function NumberInput(props) { return h('input', Object.assign({ className: 'inp', type: 'number' }, props)); }

  function Segmented({ value, onChange, options }) {
    return h('div', { className: 'seg', role: 'tablist' },
      options.map((o) => h('button', {
        key: o.value, className: 'seg-b' + (value === o.value ? ' on' : ''), role: 'tab',
        'aria-selected': value === o.value, onClick: () => onChange(o.value),
      }, o.icon && h(Icon, { name: o.icon, size: 14 }), o.label)));
  }

  function Toggle({ checked, onChange, label }) {
    return h('button', { className: 'tgl' + (checked ? ' on' : ''), role: 'switch', 'aria-checked': checked, onClick: () => onChange(!checked) },
      h('span', { className: 'tgl-k' }),
      label && h('span', { className: 'tgl-l' }, label));
  }

  const TIER_CLASS = { 'csip-required': 'req', 'spec-optional': 'opt', 'off-spec': 'off' };
  function TierBadge({ tier }) {
    const label = (window.FP.TIERS[tier] || {}).label || tier;
    return h('span', { className: 'badge tier-' + TIER_CLASS[tier] }, label);
  }
  function Badge({ children, tone = 'neutral' }) { return h('span', { className: 'badge tone-' + tone }, children); }

  function StatusDot({ ok, pulse }) { return h('span', { className: 'sdot' + (ok ? ' ok' : ' off') + (pulse ? ' pulse' : '') }); }

  // ---- Stat readout ----
  function Stat({ label, value, unit, tone, sub, big }) {
    return h('div', { className: 'stat' + (big ? ' big' : ''), 'data-tone': tone || undefined },
      h('div', { className: 'stat-l' }, label),
      h('div', { className: 'stat-v' }, value, unit && h('span', { className: 'stat-u' }, unit)),
      sub && h('div', { className: 'stat-sub' }, sub));
  }

  // ---- canvas line chart ----
  function LineChart({ data, series, height = 160, yMin, yMax, zeroLine, fmtY }) {
    const ref = useRef(null);
    const wrapRef = useRef(null);
    const [w, setW] = useState(600);
    useEffect(() => {
      const ro = new ResizeObserver((e) => { for (const en of e) setW(en.contentRect.width); });
      if (wrapRef.current) ro.observe(wrapRef.current);
      return () => ro.disconnect();
    }, []);
    useEffect(() => {
      const cv = ref.current; if (!cv) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = w * dpr; cv.height = height * dpr;
      const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, height);
      const padL = 44, padR = 10, padT = 12, padB = 18;
      const plotW = Math.max(10, w - padL - padR), plotH = height - padT - padB;
      const css = getComputedStyle(document.documentElement);
      const grid = css.getPropertyValue('--c-border').trim() || '#e5e7eb';
      const muted = css.getPropertyValue('--c-muted').trim() || '#6b7280';
      const n = data.length;
      let lo = yMin, hi = yMax;
      if (lo === undefined || hi === undefined) {
        let mn = Infinity, mx = -Infinity;
        for (const d of data) for (const s of series) { const v = d[s.key]; if (v == null || isNaN(v)) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mn === Infinity) { mn = 0; mx = 1; }
        if (mn === mx) { mn -= 1; mx += 1; }
        const pad = (mx - mn) * 0.12; lo = yMin !== undefined ? yMin : mn - pad; hi = yMax !== undefined ? yMax : mx + pad;
      }
      const X = (i) => padL + (n <= 1 ? plotW : (i / (n - 1)) * plotW);
      const Y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;
      // gridlines + labels
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = muted; ctx.strokeStyle = grid; ctx.lineWidth = 1;
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const v = lo + (i / ticks) * (hi - lo); const y = Y(v);
        ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(fmtY ? fmtY(v) : Math.round(v), padL - 6, y);
      }
      if (zeroLine && lo < 0 && hi > 0) {
        const y = Y(0); ctx.strokeStyle = muted; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.globalAlpha = 1;
      }
      // series
      for (const s of series) {
        ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.beginPath();
        let started = false;
        data.forEach((d, i) => { const v = d[s.key]; if (v == null || isNaN(v)) return; const x = X(i), y = Y(v); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); });
        ctx.stroke();
        if (s.fill && n > 1) {
          ctx.lineTo(X(n - 1), Y(lo)); ctx.lineTo(X(0), Y(lo)); ctx.closePath();
          ctx.globalAlpha = 0.10; ctx.fillStyle = s.color; ctx.fill(); ctx.globalAlpha = 1;
        }
        // last point dot
        if (n > 0) { const last = data[n - 1][s.key]; if (last != null && !isNaN(last)) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(X(n - 1), Y(last), 3, 0, Math.PI * 2); ctx.fill(); } }
      }
    }, [data, series, w, height, yMin, yMax, zeroLine, fmtY]);
    return h('div', { className: 'chart', ref: wrapRef },
      h('canvas', { ref, style: { width: '100%', height: height + 'px', display: 'block' } }));
  }

  function Legend({ items }) {
    return h('div', { className: 'legend' }, items.map((it) => h('span', { key: it.label, className: 'legend-i' },
      h('span', { className: 'legend-s', style: { background: it.color } }), it.label)));
  }

  // ---- code block with light XML/JSON highlight ----
  function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  // Pretty-print compact XML (the wire is often one long line) into indented lines so it reads
  // cleanly and wraps vertically. Safe for the small, attribute-light 2030.5 docs we render.
  function formatXml(xml) {
    if (!xml) return '';
    const s = String(xml).trim().replace(/>\s+</g, '><');
    const lines = s.replace(/></g, '>\n<').split('\n');
    let indent = 0;
    const out = [];
    for (let raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const isDecl = /^<[!?]/.test(line);
      const isClose = /^<\//.test(line);
      const isSelf = /\/>$/.test(line);
      const inline = /^<[^/!?][^>]*>.*<\/[^>]+>$/.test(line); // <tag>text</tag> on one line
      if (isClose) indent = Math.max(0, indent - 1);
      out.push('  '.repeat(indent) + line);
      if (!isDecl && !isClose && !isSelf && !inline && /^<[^/!?]/.test(line)) indent += 1;
    }
    return out.join('\n');
  }
  function highlight(code, lang) {
    if (lang === 'xml') code = formatXml(code);
    const s = escapeHtml(code);
    if (lang === 'text') return s;
    if (lang === 'json') {
      // single guarded pass per token type; injected spans contain no digits / keywords / quotes-after-colon
      return s
        .replace(/("(?:\\.|[^"\\])*")(\s*:)/g, '<span class="t-key">$1</span>$2')
        .replace(/(:\s*)("(?:\\.|[^"\\])*")/g, '$1<span class="t-str">$2</span>')
        .replace(/\b(-?\d+\.?\d*)\b/g, '<span class="t-num">$1</span>')
        .replace(/\b(true|false|null)\b/g, '<span class="t-kw">$1</span>');
    }
    // XML: match each whole tag once and highlight INSIDE the matched substring only,
    // so later work never re-scans markup we just injected (the bug the verifier caught).
    return s.replace(/&lt;[!?\/]?[\w:.-][\s\S]*?&gt;/g, function (tag) {
      return tag
        .replace(/([\w:.-]+)=("[^"]*")/g, '<span class="t-attr">$1</span>=<span class="t-str">$2</span>')
        .replace(/^(&lt;[!?\/]?)([\w:.-]+)/, '$1<span class="t-tag">$2</span>');
    });
  }
  function Code({ code, lang = 'xml', className = '' }) {
    return h('pre', { className: 'code ' + className }, h('code', { dangerouslySetInnerHTML: { __html: highlight(code || '', lang) } }));
  }

  function Empty({ icon = 'doc', title, children }) {
    return h('div', { className: 'empty' }, h(Icon, { name: icon, size: 22 }), h('div', { className: 'empty-t' }, title), children && h('div', { className: 'empty-s' }, children));
  }

  // ---- modal (overlay + centered card); closes on backdrop click / Escape ----
  function Modal({ title, sub, onClose, children, wide }) {
    useEffect(() => {
      const k = (e) => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', k);
      return () => window.removeEventListener('keydown', k);
    }, [onClose]);
    return h('div', { className: 'modal-overlay', onClick: onClose },
      h('div', { className: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': true, onClick: (e) => e.stopPropagation() },
        h('div', { className: 'modal-h' },
          h('div', null, h('h3', { className: 'modal-t' }, title), sub && h('p', { className: 'modal-s' }, sub)),
          h('button', { className: 'modal-x', onClick: onClose, 'aria-label': 'Close' }, h(Icon, { name: 'x', size: 18 }))),
        h('div', { className: 'modal-b' }, children)));
  }

  window.UI = { h, Icon, Card, Button, Field, TextInput, NumberInput, Segmented, Toggle, TierBadge, Badge, StatusDot, Stat, LineChart, Legend, Code, Empty, Modal };
})();
