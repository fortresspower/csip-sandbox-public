/* Fortress CSIP Console — app shell (Console layout), tweaks, mount. */
(function () {
  const { useState, useEffect } = React;
  const U = window.UI, T = window.TABS, h = U.h;
  const useConsole = window.useConsole;
  const { useTweaks, TweaksPanel, TweakSection, TweakColor, TweakRadio, TweakToggle } = window;

  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "accent": "#1B9E4B",
    "density": "regular",
    "typeface": "grotesk",
    "monoData": true
  }/*EDITMODE-END*/;

  function Logo() {
    return h('div', { className: 'logo' },
      h('img', { className: 'logo-mark', src: '/fortress-logo.png', width: 32, height: 32, alt: 'Fortress Power' }),
      h('div', { className: 'logo-tx' },
        h('div', { className: 'logo-1' }, 'FORTRESS POWER'),
        h('div', { className: 'logo-2' }, 'CSIP Sandbox Console')));
  }

  // Console layout: top nav (the 2030.5 wire is a persistent right-hand rail, not a tab).
  const NAV = [
    { id: 'guide', label: 'Guide', icon: 'doc' },
    { id: 'dispatch', label: 'Dispatch', icon: 'bolt' },
    { id: 'telemetry', label: 'Telemetry', icon: 'wave' },
    { id: 'config', label: 'Config', icon: 'gear' },
  ];

  function ModePill({ c }) {
    return h('div', { className: 'modepill', 'data-mode': c.mode },
      h(U.StatusDot, { ok: c.mode === 'live', pulse: true }),
      h('span', { className: 'mp-t' }, c.mode === 'live' ? 'LIVE' : 'SIM'),
      h('span', { className: 'mp-d' }, c.mode === 'live' ? 'sandbox connected' : 'in-browser loop'));
  }

  function App() {
    const c = useConsole();
    const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
    // Deep-linkable tabs via the URL hash (e.g. /#telemetry). Base path (no hash) → dispatch.
    const tabFromHash = () => { const id = (window.location.hash || '').replace(/^#/, ''); return NAV.some((n) => n.id === id) ? id : 'dispatch'; };
    const [tab, setTab] = useState(tabFromHash);
    const [railW, setRailW] = useState(384);   // resizable 2030.5 wire rail

    const startRailDrag = (e) => {
      e.preventDefault();
      const move = (ev) => setRailW(Math.min(820, Math.max(300, window.innerWidth - ev.clientX)));
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.userSelect = ''; };
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    };

    useEffect(() => {
      const r = document.documentElement;
      r.style.setProperty('--c-accent', t.accent);
      r.setAttribute('data-density', t.density);
      r.setAttribute('data-type', t.typeface);
      r.setAttribute('data-mono', t.monoData ? 'on' : 'off');
    }, [t]);

    // Keep the active tab in sync with the URL hash (deep links, back/forward, manual edits).
    useEffect(() => {
      const onHash = () => setTab(tabFromHash());
      window.addEventListener('hashchange', onHash);
      return () => window.removeEventListener('hashchange', onHash);
    }, []);

    const TabView = { guide: T.GuideTab, dispatch: T.DispatchTab, telemetry: T.TelemetryTab, config: T.ConfigTab }[tab];

    const navEl = h('nav', { className: 'nav nav-top' },
      NAV.map((n) => h('button', { key: n.id, className: 'nav-i' + (tab === n.id ? ' on' : ''), onClick: () => { window.location.hash = n.id; } },
        h(U.Icon, { name: n.icon, size: 17 }), h('span', null, n.label))));

    const header = h('header', { className: 'topbar' },
      h(Logo, null),
      h('div', { className: 'tb-spacer' }),
      navEl,
      h('div', { className: 'tb-right' },
        h('div', { className: 'sitechip' }, h(U.Icon, { name: 'battery', size: 15 }), h('span', { className: 'mono' }, c.fixture.lFDI)),
        h(ModePill, { c })));

    const content = h('main', { className: 'content' }, h(TabView, { c }));

    const tweaks = h(TweaksPanel, null,
      h(TweakSection, { label: 'Brand' }),
      h(TweakColor, { label: 'Accent', value: t.accent, options: ['#1B9E4B', '#0E7A3A', '#15A88C', '#2A6FDB', '#475569'], onChange: (v) => setTweak('accent', v) }),
      h(TweakSection, { label: 'Layout' }),
      h(TweakRadio, { label: 'Density', value: t.density, options: ['compact', 'regular', 'comfy'], onChange: (v) => setTweak('density', v) }),
      h(TweakRadio, { label: 'Type', value: t.typeface, options: ['grotesk', 'system'], onChange: (v) => setTweak('typeface', v) }),
      h(TweakToggle, { label: 'Monospace data', value: t.monoData, onChange: (v) => setTweak('monoData', v) }));

    return h('div', { className: 'app', 'data-direction': 'console' },
      header,
      h('div', { className: 'shell' },
        content,
        h('div', { className: 'rail-grip', onMouseDown: startRailDrag, title: 'Drag to resize', role: 'separator', 'aria-orientation': 'vertical' }),
        h('aside', { className: 'wirerail', style: { width: railW + 'px' } },
          h('div', { className: 'wr-head' }, h(U.Icon, { name: 'doc', size: 15 }), '2030.5 wire'),
          h(T.WireLog, { c, compact: true }))),
      tweaks);
  }

  ReactDOM.createRoot(document.getElementById('root')).render(h(App, null));
})();
