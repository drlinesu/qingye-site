/* ============================================================
 * 轻野 · 启程 (My Space & Trip Sketch)
 * 独立功能脚本 —— 零侵入：不修改 轻野.html 的任何计算与渲染逻辑，
 * 仅以「追加监听 + 追加 DOM + 复用页面公开全局函数」的方式工作：
 *   ① 右上角「我的」：搜索记录 / 收藏景点 / 旅行记录
 *   ② 「启程」板块：在地图上绘制线路、标注住宿点、景观并命名，保存为旅行记
 * 数据：localStorage（按登入手机号隔离），键前缀 qy_
 * 依赖：Leaflet（页面 ensureLeaflet 已加载，超时后本脚本自行兜底加载）
 * ============================================================ */
(function () {
  'use strict';
  if (window.__QY_LOADED__) return;
  window.__QY_LOADED__ = true;

  /* ---------- 基础工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'style') e.style.cssText = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return e;
  }
  function now() { return Date.now(); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function tf(t) {
    var d = new Date(t);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  // 两点球面距离（km）
  function hav(a, b) {
    var R = 6371, d = Math.PI / 180;
    var dLat = (b.lat - a.lat) * d, dLng = (b.lng - a.lng) * d;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  var _qyToastTm = 0;
  function toast(msg) {
    try { if (typeof window.toast === 'function') { window.toast(msg); return; } } catch (e) {}
    var t = $('qyToast');
    if (!t) { t = el('div', { id: 'qyToast', class: 'qy-toast' }); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(_qyToastTm);
    _qyToastTm = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }

  /* ---------- 存储（按登入手机号隔离） ---------- */
  function curPhone() {
    try {
      var cs = window.CloudShield;
      var s = cs && cs.Auth && cs.Auth.current && cs.Auth.current();
      return (s && s.phone) || 'guest';
    } catch (e) { return 'guest'; }
  }
  function maskPhone(p) { return /^1\d{10}$/.test(p) ? p.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : p; }
  function dbGet(name) {
    try { return JSON.parse(localStorage.getItem('qy_' + name + '_' + curPhone())); } catch (e) { return null; }
  }
  function dbSet(name, v) { try { localStorage.setItem('qy_' + name + '_' + curPhone(), JSON.stringify(v)); } catch (e) {} }
  function load(n) { return dbGet(n) || []; }
  function save(n, arr) { dbSet(n, arr); }

  /* ---------- 输入联动（走页面既有公开输入框，不触碰计算逻辑） ---------- */
  function fillInput(id, v) {
    var e = $(id);
    if (!e) return;
    e.value = v;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ============================================================
   * ① 我的（右上角入口：搜索记录 / 收藏景点 / 旅行记录）
   * ============================================================ */
  var myTab = 'search';

  function ensureMyBtn() {
    var bar = $('csUserBar');
    if (!bar) return false;
    if ($('qyMyBtn')) return true;
    var btn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', id: 'qyMyBtn', style: 'margin-left:auto;cursor:pointer', onclick: openMy }, ['👤 我的']);
    var last = bar.lastElementChild; // 退出按钮 → 「我的」+退出 落在右上角
    if (last) bar.insertBefore(btn, last); else bar.appendChild(btn);
    return true;
  }
  function startMyBtnObserver() {
    var mo = new MutationObserver(function () { try { ensureMyBtn(); } catch (e) {} });
    mo.observe(document.body, { childList: true, subtree: false });
    var n = 0;
    var t = setInterval(function () { if (ensureMyBtn() || ++n > 24) clearInterval(t); }, 500);
    setTimeout(function () { // 兜底：状态栏异常缺失时给悬浮入口
      if (!$('qyMyBtn') && !$('csGate') && !$('qyMyFloat')) {
        document.body.appendChild(el('button', {
          id: 'qyMyFloat', class: 'qy-mbtn', style: 'position:fixed;top:52px;right:14px;z-index:99989;box-shadow:0 4px 14px rgba(2,6,23,.18)', onclick: openMy
        }, ['👤 我的']));
      }
    }, 12000);
  }

  function openMy() {
    if ($('qyMyOv')) return;
    var ov = el('div', { class: 'qy-ov', id: 'qyMyOv', onclick: function (e) { if (e.target === ov) closeMy(); } }, [
      el('div', { class: 'qy-modal' }, [
        el('div', { class: 'qy-head' }, [
          el('span', { style: 'font-size:20px' }, ['👤']),
          el('div', {}, [
            el('div', { class: 'qy-title' }, ['我的']),
            el('div', { class: 'qy-sub' }, ['账号 ' + maskPhone(curPhone()) + ' · 数据仅保存在本机并按账号隔离'])
          ]),
          el('button', { class: 'qy-x', onclick: closeMy }, ['✕'])
        ]),
        el('div', { class: 'qy-tabs' }, [
          el('button', { class: 'qy-tab', 'data-t': 'search', onclick: function () { myTab = 'search'; renderMyTab(); } }, ['🔎 搜索记录']),
          el('button', { class: 'qy-tab', 'data-t': 'favs', onclick: function () { myTab = 'favs'; renderMyTab(); } }, ['♥ 收藏景点']),
          el('button', { class: 'qy-tab', 'data-t': 'trips', onclick: function () { myTab = 'trips'; renderMyTab(); } }, ['🧭 旅行记录'])
        ]),
        el('div', { id: 'qyMyBody' })
      ])
    ]);
    document.body.appendChild(ov);
    renderMyTab();
  }
  function closeMy() { var o = $('qyMyOv'); if (o) o.remove(); }

  function renderMyTab() {
    var body = $('qyMyBody');
    if (!body) return;
    body.innerHTML = '';
    document.querySelectorAll('.qy-tab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-t') === myTab); });
    if (myTab === 'search') renderSearchTab(body);
    else if (myTab === 'favs') renderFavTab(body);
    else renderTripTab(body);
  }

  /* --- 搜索记录 --- */
  function renderSearchTab(body) {
    var arr = load('searches');
    body.appendChild(el('div', { class: 'qy-tip' }, ['自动记录表单出发/目的城市与轻旅行搜索框的查询（本机保存，最多 30 条）。点击「使用」可快速回填。']));
    var head = el('div', { class: 'qy-row', style: 'background:#f8fafc;border-style:dashed' }, [
      el('span', { class: 'qy-txt', style: 'color:#64748b;font-weight:400' }, ['共 ' + arr.length + ' 条']),
      el('button', { class: 'qy-mini danger', onclick: function () {
        if (!arr.length) { toast('暂无搜索记录'); return; }
        if (confirm('清空全部搜索记录？')) { save('searches', []); renderMyTab(); toast('已清空搜索记录'); }
      } }, ['🗑 清空'])
    ]);
    body.appendChild(head);
    if (!arr.length) { body.appendChild(el('div', { class: 'qy-empty' }, ['还没有搜索记录 —— 填写出发/目的城市后自动记录'])); return; }
    arr.forEach(function (r, i) {
      body.appendChild(el('div', { class: 'qy-row' }, [
        el('span', { class: 'qy-chip' }, [r.type]),
        el('span', { class: 'qy-txt' }, [r.text]),
        el('span', { class: 'qy-time' }, [tf(r.t)]),
        el('button', { class: 'qy-mini', onclick: function () { useSearch(r); } }, ['使用']),
        el('button', { class: 'qy-mini danger', onclick: function () { var a = load('searches'); a.splice(i, 1); save('searches', a); renderMyTab(); } }, ['×'])
      ]));
    });
  }
  function useSearch(r) {
    if (r.type === '出发地') fillInput('fromCity', r.text);
    else if (r.type === '目的地') fillInput('toCity', r.text);
    else { fillInput('scenicCity', r.text); var c = $('scenicCard'); if (c) c.open = true; c && c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    closeMy();
    toast('已填入：' + r.text);
  }

  /* --- 收藏景点 --- */
  function renderFavTab(body) {
    var arr = load('favs');
    body.appendChild(el('div', { class: 'qy-tip' }, ['在「轻旅行推荐」的景点条目上点 ♡ 即可收藏；「定位」复用页面自带地图定位，也可一键加入启程画布。']));
    if (!arr.length) { body.appendChild(el('div', { class: 'qy-empty' }, ['还没有收藏景点 —— 展开轻旅行推荐，点景点行的 ♡ 收藏'])); return; }
    arr.forEach(function (f, i) {
      body.appendChild(el('div', { class: 'qy-row' }, [
        el('span', { style: 'color:#e11d48;font-size:14px' }, ['♥']),
        el('span', { class: 'qy-txt' }, [f.name]),
        el('span', { class: 'qy-time' }, [f.lat.toFixed(2) + ', ' + f.lng.toFixed(2)]),
        el('button', { class: 'qy-mini', onclick: function () { closeMy(); locateFav(f); } }, ['🗺 定位']),
        el('button', { class: 'qy-mini', onclick: function () { addPoint('scenery', { lat: f.lat, lng: f.lng }, f.name); closeMy(); toast('已加入启程画布：' + f.name); } }, ['➕ 启程']),
        el('button', { class: 'qy-mini danger', onclick: function () { var a = load('favs'); a.splice(i, 1); save('favs', a); renderMyTab(); syncFavBtns(); } }, ['×'])
      ]));
    });
  }
  function locateFav(f) {
    if (typeof window.focusScenic === 'function') { window.focusScenic(f.lat, f.lng); return; }
    toast('地图定位组件未就绪，请稍后重试');
  }
  // 同步轻旅行行内收藏按钮的 ♥ 状态（列表重渲后调用）
  function syncFavBtns() {
    try {
      document.querySelectorAll('.sp-row').forEach(function (row) {
        var btn = row.querySelector('.qy-favbtn');
        if (!btn) return;
        var inf = rowInfo(row);
        if (inf) btn.textContent = isFav(inf.name, inf.lat, inf.lng) ? '♥' : '♡';
      });
    } catch (e) {}
  }
  function isFav(name, lat, lng) {
    return load('favs').some(function (f) { return f.name === name && Math.abs(f.lat - lat) < 0.01 && Math.abs(f.lng - lng) < 0.01; });
  }

  /* --- 旅行记录（自动出行记录 + 自制旅行记） --- */
  function renderTripTab(body) {
    var trips = load('trips');
    var plans = load('plans');
    var h1 = el('div', { class: 'qy-sec' }, ['📌 自动出行记录（' + trips.length + '）']);
    body.appendChild(h1);
    body.appendChild(el('div', { class: 'qy-tip' }, ['出发+目的城市都填好时自动记录一条，点「重算」回填并立即出方案。']));
    if (!trips.length) body.appendChild(el('div', { class: 'qy-empty' }, ['暂无出行记录']));
    trips.forEach(function (t, i) {
      body.appendChild(el('div', { class: 'qy-row' }, [
        el('span', { class: 'qy-txt' }, [t.a + ' → ' + t.b + (t.people ? ' · ' + t.people + '人' : '')]),
        el('span', { class: 'qy-time' }, [tf(t.t)]),
        el('button', { class: 'qy-mini', onclick: function () {
          fillInput('fromCity', t.a); fillInput('toCity', t.b);
          closeMy(); window.scrollTo({ top: 0, behavior: 'smooth' }); toast('已回填 ' + t.a + ' → ' + t.b + '，正在出方案…');
        } }, ['♻ 重算']),
        el('button', { class: 'qy-mini danger', onclick: function () { var a = load('trips'); a.splice(i, 1); save('trips', a); renderMyTab(); } }, ['×'])
      ]));
    });
    var h2 = el('div', { class: 'qy-sec' }, ['🗺 自制旅行记（' + plans.length + '）']);
    body.appendChild(h2);
    body.appendChild(el('div', { class: 'qy-tip' }, ['在下方「启程」板块用地图绘制的线路，保存后集中在这里管理。']));
    if (!plans.length) body.appendChild(el('div', { class: 'qy-empty' }, ['暂无自制旅行记 —— 到「启程」板块画一条路线保存']));
    plans.forEach(function (p, i) {
      body.appendChild(el('div', { class: 'qy-row' }, [
        el('span', { style: 'font-size:14px' }, ['📄']),
        el('span', { class: 'qy-txt' }, [p.name]),
        el('span', { class: 'qy-time' }, [p.points.length + '点 · ' + (p.dist || 0) + 'km · ' + tf(p.t)]),
        el('button', { class: 'qy-mini', onclick: function () { closeMy(); loadPlan(p.id); } }, ['📖 查看']),
        el('button', { class: 'qy-mini danger', onclick: function () { deletePlan(p.id); renderMyTab(); } }, ['×'])
      ]));
    });
  }

  /* ============================================================
   * ② 启程板块（地图手作旅行记）
   * ============================================================ */
  var map = null, markers = [], line = null, mode = 'view', points = [];
  var TYPE_STYLE = {
    route:   { bg: '#0284c7', ico: '🧭', label: '线路点' },
    stay:    { bg: '#ea580c', ico: '🏨', label: '住宿点' },
    scenery: { bg: '#9333ea', ico: '📸', label: '景观' }
  };
  var TYPE_ORDER = ['route', 'stay', 'scenery'];
  var defaultCnt = { route: 0, stay: 0, scenery: 0 };

  function injectCard() {
    if ($('qyCard')) return;
    var anchor = $('scenicCard');
    if (!anchor || !anchor.parentNode) return false;
    var tool = el('div', { class: 'qy-tools' });
    TYPE_ORDER.forEach(function (t) {
      tool.appendChild(el('button', { class: 'qy-mbtn', 'data-m': t, onclick: function () { setMode(t); } }, [
        TYPE_STYLE[t].ico + ' ' + (t === 'route' ? '线路' : t === 'stay' ? '住宿' : '景观')
      ]));
    });
    tool.appendChild(el('button', { class: 'qy-mbtn', 'data-m': 'view', onclick: function () { setMode('view'); } }, ['✋ 浏览']));
    tool.appendChild(el('button', { class: 'qy-mbtn', style: 'margin-left:auto', onclick: clearCanvas }, ['🗑 清空']));

    var card = el('details', { class: 'card', id: 'qyCard' }, [
      el('summary', {}, [
        el('span', { class: 'dicon' }, ['🧭']),
        '启程 · 手作旅行记 ',
        el('span', { class: 'tag' }, ['地图绘线 · 住宿 · 景观命名'])
      ]),
      el('div', { class: 'cbody' }, [
        tool,
        el('div', { id: 'qyHint', class: 'qy-hint' }, ['选择上方模式后在地图上点击即可添加点位；拖动/缩放请用「✋ 浏览」模式。']),
        el('div', { id: 'qyMap', style: 'height:420px;border-radius:12px;border:1px solid var(--line);background:#e2e8f0;overflow:hidden' }),
        el('div', { id: 'qyStats', class: 'qy-hint', style: 'margin-top:8px' }, ['地图将在展开卡片时按需加载，无需等待']),
        el('div', { id: 'qyPoints' }),
        el('div', { class: 'qy-saverow' }, [
          el('input', { id: 'qyPlanName', placeholder: '给这条路线取个名字，如「滇西北环线」', style: 'flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:9px;font-size:12.5px' }),
          el('button', { class: 'qy-savebtn', onclick: savePlan }, ['💾 保存这段路'])
        ]),
        el('div', { id: 'qyPlans' })
      ])
    ]);
    anchor.parentNode.insertBefore(card, anchor.nextSibling);
    // 页面对 details.card 的展开/收起动画（JS 接管 .cbody 的 max-height）在初始解析时注册，
    // 彼时本卡片尚未注入 → 本卡片的 .cbody 永远停留在 CSS 默认 max-height:0，
    // 内容（含地图）被永久裁剪为 0 高。这里按页面同款逻辑自行接管本卡片的动画。
    var cb = card.querySelector('.cbody');
    cb.style.maxHeight = card.open ? cb.scrollHeight + 'px' : '0px';
    card.addEventListener('toggle', function () {
      if (card.open) {
        cb.style.maxHeight = '0px';
        requestAnimationFrame(function () { cb.style.maxHeight = cb.scrollHeight + 'px'; });
        // 过渡结束后放开高度限制：后续加点/保存列表增高时不被 max-height 裁剪
        setTimeout(function () { if (card.open) cb.style.maxHeight = 'none'; }, 420);
        ensureMap(); // 按需建图：首次展开才初始化地图，加快页面加载
      } else {
        var fullH = cb.scrollHeight; // 返回完整内容高度，不受当前 max-height 限制
        cb.style.maxHeight = fullH + 'px';
        requestAnimationFrame(function () { cb.style.maxHeight = '0px'; });
      }
      setTimeout(function () { if (map) map.invalidateSize(); }, 140);
    });
    renderPlans(); // 卡片注入后即渲染已保存旅行记（地图按需加载，不阻塞列表）
    return true;
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('#qyCard .qy-mbtn[data-m]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-m') === m);
    });
    var hint = $('qyHint');
    if (hint) hint.textContent = {
      view: '浏览模式：可自由拖动/缩放地图，点击地图不会添加点位。',
      route: '线路模式：按顺序点击地图添加途经点，自动连线成路线。',
      stay: '住宿模式：点击地图标注当晚住宿位置，可在下方列表改名。',
      scenery: '景观模式：点击地图添加景观点，加入后自动聚焦下方命名框。'
    }[m];
  }

  function clearCanvas() {
    if (!points.length) { toast('画布已是空的'); return; }
    if (confirm('清空当前绘制的 ' + points.length + ' 个点位？')) { points = []; redraw(); toast('已清空画布'); }
  }

  function addPoint(type, ll, name) {
    if (!map) { ensureMap(function () { addPoint(type, ll, name); }); return; } // 地图未就绪：建图后自动补加
    defaultCnt[type]++;
    var p = {
      type: type,
      lat: +(+ll.lat).toFixed(6),
      lng: +(+ll.lng).toFixed(6),
      name: name || (TYPE_STYLE[type].label + defaultCnt[type])
    };
    points.push(p);
    redraw();
    if (type === 'scenery' && !name) { // 景观加入后聚焦命名框
      var inputs = $('qyPoints').querySelectorAll('input');
      var last = inputs[inputs.length - 1];
      if (last) { last.focus(); last.select(); }
    }
  }

  function totalKm() {
    var d = 0;
    for (var i = 1; i < points.length; i++) d += hav(points[i - 1], points[i]);
    return d;
  }

  function redraw() {
    if (!map) return;
    markers.forEach(function (m) { try { map.removeLayer(m); } catch (e) {} });
    markers = [];
    if (line) { try { map.removeLayer(line); } catch (e) {} line = null; }
    var latlngs = [];
    points.forEach(function (p, i) {
      var st = TYPE_STYLE[p.type] || TYPE_STYLE.route;
      var m = window.L.marker([p.lat, p.lng], {
        icon: window.L.divIcon({
          className: '',
          html: '<div style="width:28px;height:28px;border-radius:50%;background:' + st.bg + ';border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-size:13px">' + st.ico + '</div>',
          iconSize: [28, 28], iconAnchor: [14, 14]
        })
      }).addTo(map);
      m.bindPopup('<b>' + esc(p.name) + '</b><br><span style="color:#64748b;font-size:11px">#' + (i + 1) + ' · ' + st.label + ' · ' + p.lat.toFixed(3) + ', ' + p.lng.toFixed(3) + '</span>');
      var isDefault = /^(景观|途经|住宿点)\d+$/.test(p.name); // 未改名不加常驻标签
      if (p.type === 'scenery' && !isDefault) m.bindTooltip(esc(p.name), { permanent: true, direction: 'top', offset: [0, -14] });
      markers.push(m);
      latlngs.push([p.lat, p.lng]);
    });
    if (latlngs.length > 1) {
      line = window.L.polyline(latlngs, { color: '#0ea5e9', weight: 3, opacity: .85, dashArray: '7 7' }).addTo(map);
    }
    renderStats(); renderPoints(); renderPlans(); saveDraft();
  }

  function renderStats() {
    var s = $('qyStats');
    if (!s) return;
    if (!points.length) { s.textContent = '画布空空如也 —— 选一个模式在地图上点下第一个点位吧'; return; }
    s.textContent = '已标 ' + points.length + ' 个点 · 全程约 ' + totalKm().toFixed(1) + ' km（按点位顺序直线连接，仅供参考）';
  }

  function renderPoints() {
    var box = $('qyPoints');
    if (!box) return;
    box.innerHTML = '';
    points.forEach(function (p, i) {
      var st = TYPE_STYLE[p.type] || TYPE_STYLE.route;
      var row = el('div', { class: 'qy-prow' }, [
        el('span', { class: 'qy-pico', style: 'background:' + st.bg }, [st.ico]),
        el('span', { class: 'qy-time', style: 'width:16px;text-align:right' }, [String(i + 1)]),
        el('input', {
          class: 'qy-pname', value: p.name,
          title: st.label + '：点击可重命名',
          onchange: function () {
            var v = this.value.trim();
            points[i].name = v || (st.label + (i + 1));
            redraw();
          }
        }),
        el('span', { class: 'qy-coord' }, [p.lat.toFixed(3) + ', ' + p.lng.toFixed(3)]),
        el('button', { class: 'qy-mini', title: '在地图上定位此点', onclick: function () {
          if (!map) return;
          map.setView([p.lat, p.lng], Math.max(map.getZoom(), 13));
          if (markers[i]) markers[i].openPopup();
        } }, ['⌖']),
        el('button', { class: 'qy-mini danger', title: '删除此点', onclick: function () { points.splice(i, 1); redraw(); } }, ['×'])
      ]);
      box.appendChild(row);
    });
  }

  function saveDraft() { dbSet('draft', { points: points, savedAt: now() }); }

  function savePlan() {
    if (!points.length) { toast('请先在地图上添加点位'); return; }
    var nameI = $('qyPlanName');
    var name = ((nameI && nameI.value) || '').trim();
    if (!name) {
      var d = new Date();
      name = '旅行记 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    var arr = load('plans');
    arr.unshift({
      id: 'P' + now(), name: name, t: now(),
      dist: +totalKm().toFixed(1),
      points: JSON.parse(JSON.stringify(points))
    });
    if (arr.length > 50) arr.length = 50;
    save('plans', arr);
    if (nameI) nameI.value = '';
    renderPlans();
    toast('已保存旅行记「' + name + '」（' + points.length + ' 点 · 约' + totalKm().toFixed(1) + ' km），可在「我的 → 旅行记录」查看');
  }

  function renderPlans() {
    var box = $('qyPlans');
    if (!box) return;
    box.innerHTML = '';
    var plans = load('plans');
    if (!plans.length) return;
    box.appendChild(el('div', { class: 'qy-sec' }, ['🗂 已保存的旅行记（' + plans.length + '）']));
    plans.forEach(function (p) {
      box.appendChild(el('div', { class: 'qy-prow', style: 'background:#fff' }, [
        el('span', { style: 'font-size:14px' }, ['📄']),
        el('span', { class: 'qy-txt' }, [p.name]),
        el('span', { class: 'qy-coord' }, [p.points.length + '点 · ' + (p.dist || 0) + 'km · ' + tf(p.t)]),
        el('button', { class: 'qy-mini', onclick: function () { loadPlan(p.id); } }, ['📖']),
        el('button', { class: 'qy-mini danger', onclick: function () { deletePlan(p.id); } }, ['×'])
      ]));
    });
  }

  function loadPlan(id) {
    var p = null;
    load('plans').forEach(function (x) { if (x.id === id) p = x; });
    if (!p) return;
    if (!map) { ensureMap(function () { loadPlan(id); }); return; } // 地图未就绪：建图后自动载入
    points = JSON.parse(JSON.stringify(p.points));
    setMode('view');
    redraw();
    var card = $('qyCard');
    if (card) {
      card.open = true;
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(function () {
        if (!map) return;
        map.invalidateSize();
        try {
          var b = window.L.latLngBounds(points.map(function (q) { return [q.lat, q.lng]; }));
          map.fitBounds(b.pad(0.18));
        } catch (e) {}
      }, 200);
    }
    toast('已载入旅行记「' + p.name + '」');
  }

  function deletePlan(id) {
    var name = '';
    load('plans').forEach(function (x) { if (x.id === id) name = x.name; });
    if (!confirm('删除旅行记「' + name + '」？该操作不可恢复。')) return;
    var arr = load('plans').filter(function (x) { return x.id !== id; });
    save('plans', arr);
    renderPlans();
    toast('已删除旅行记「' + name + '」');
    if ($('qyMyOv')) renderMyTab();
  }

  /* ---------- 地图初始化（按需：首次展开卡片/加入点位时才建图，页面加载更快） ---------- */
  var tries = 0, mapCbs = [];
  function ensureMap(cb) { // 确保 map 就绪；cb 在就绪后回调（可堆叠，去重由调用方保证）
    if (map) { if (cb) cb(); return; }
    if (cb) mapCbs.push(cb);
    if (!ensureMap.started) { ensureMap.started = true; waitL(); }
  }
  function mapReady() { // 建图成功后冲刷排队回调
    var cbs = mapCbs; mapCbs = [];
    cbs.forEach(function (c) { try { c(); } catch (e) {} });
  }
  function waitL() {
    if (window.L) { initMap(); return; }
    if (++tries === 10) { // 约 3s 仍无 Leaflet → 优先复用页面自带多源加载器，缺失时自行兜底
      if (typeof window.ensureLeaflet === 'function') {
        try { window.ensureLeaflet(function () {}, true); } catch (e) { loadLeafletFallback(); }
      } else loadLeafletFallback();
    }
    if (tries > 160) { mapFail(); return; }
    setTimeout(waitL, 300);
  }
  function loadLeafletFallback() {
    if ($('qyLeafCss') || $('leafletJs')) return; // 主页面已在加载 Leaflet，等待其完成即可
    try {
      // 兜底源：bootcdn 优先，失败自动切 unpkg（与主页面 ensureLeaflet 同款多源策略）
      document.head.appendChild(el('link', { id: 'qyLeafCss', rel: 'stylesheet', href: 'https://cdn.bootcdn.net/ajax/libs/leaflet/1.9.4/leaflet.css' }));
      var jsUrls = ['https://cdn.bootcdn.net/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];
      var s = el('script', { id: 'qyLeafJs' });
      var i = 0;
      s.onerror = function () { i++; if (i < jsUrls.length) s.src = jsUrls[i]; };
      s.src = jsUrls[i];
      document.head.appendChild(s);
    } catch (e) {}
  }
  function mapFail() {
    var box = $('qyMap');
    if (box) box.innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#64748b;font-size:12.5px;padding:0 20px;text-align:center">地图组件加载失败，请检查网络后刷新重试（点位与旅行记的保存功能不受影响）</div>';
    var s = $('qyStats'); if (s) s.textContent = '';
  }
  function initMap() {
    var box = $('qyMap');
    if (!box || map || !window.L) return;
    try {
      map = window.L.map(box, { zoomControl: true, attributionControl: true }).setView([34.5, 105], 4);
      window.L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
        subdomains: ['1', '2', '3', '4'], maxZoom: 18, attribution: '© 高德地图',
        keepBuffer: 2, updateWhenZooming: false // 与页面快地图同款：缩放时减少瓦片抖动与重复请求
      }).addTo(map);
      map.on('click', function (e) {
        if (mode === 'view' || !mode) return;
        addPoint(mode, e.latlng);
      });
      setMode('view');
      var d = dbGet('draft'); // 恢复未保存的草稿（按需流程下卡片此刻已展开，无需再强制打开）
      if (d && d.points && d.points.length) {
        points = d.points;
        redraw();
        toast('已恢复上次未保存的 ' + points.length + ' 个点位草稿');
      } else {
        renderStats();
      }
      mapReady(); // 冲刷排队中的加点/载入请求
    } catch (e) { mapFail(); }
  }

  /* ============================================================
   * 追加监听（不修改页面任何既有监听）
   * ============================================================ */
  function hookSearchInput(id, type) {
    var e = $(id);
    if (!e) return;
    e.addEventListener('change', function () {
      var v = (e.value || '').trim();
      if (!v) return;
      var arr = load('searches');
      if (arr.length && arr[0].type === type && arr[0].text === v) arr[0].t = now();
      else arr.unshift({ type: type, text: v, t: now() });
      if (arr.length > 30) arr.length = 30;
      save('searches', arr);
    });
  }
  var tripTm = 0;
  function hookTripInput(id) {
    var e = $(id);
    if (!e) return;
    e.addEventListener('change', function () {
      clearTimeout(tripTm);
      tripTm = setTimeout(function () {
        var a = (($('fromCity') || {}).value || '').trim();
        var b = (($('toCity') || {}).value || '').trim();
        if (!a || !b || a === b) return;
        var people = +((($('people') || {}).value) || 1) || 1;
        var arr = load('trips');
        if (arr.length && arr[0].a === a && arr[0].b === b) { arr[0].t = now(); arr[0].people = people; }
        else arr.unshift({ a: a, b: b, people: people, t: now() });
        if (arr.length > 30) arr.length = 30;
        save('trips', arr);
      }, 700);
    });
  }

  /* ---------- 景点行收藏按钮注入（MutationObserver，防抖批量处理） ---------- */
  function rowInfo(row) {
    var oc = row.getAttribute('onclick') || '';
    var m = oc.match(/focusScenic\((-?[\d.]+),\s*(-?[\d.]+)\)/);
    if (!m) return null;
    var cn = row.children[1];
    var name = cn && cn.children[0] ? cn.children[0].textContent.trim() : '';
    if (!name) return null;
    return { name: name, lat: +m[1], lng: +m[2] };
  }
  function decorateRow(row) {
    if (row.querySelector('.qy-favbtn')) return;
    var inf = rowInfo(row);
    if (!inf) return;
    var btn = document.createElement('button');
    btn.className = 'qy-favbtn';
    btn.title = '收藏景点（在右上角「我的」查看）';
    btn.textContent = isFav(inf.name, inf.lat, inf.lng) ? '♥' : '♡';
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation(); // 不触发行自带的地图定位
      toggleFav(inf.name, inf.lat, inf.lng, btn);
    });
    var photo = row.querySelector('button:not(.qy-favbtn)');
    if (photo && photo.parentNode === row) row.insertBefore(btn, photo);
    else row.appendChild(btn);
  }
  function toggleFav(name, lat, lng, btn) {
    var arr = load('favs');
    var idx = -1;
    arr.forEach(function (f, i) { if (f.name === name && Math.abs(f.lat - lat) < 0.01 && Math.abs(f.lng - lng) < 0.01) idx = i; });
    var added;
    if (idx > -1) { arr.splice(idx, 1); added = false; }
    else { arr.unshift({ name: name, lat: lat, lng: lng, t: now() }); added = true; if (arr.length > 50) arr.length = 50; }
    save('favs', arr);
    if (btn) btn.textContent = added ? '♥' : '♡';
    toast(added ? '已收藏「' + name + '」，右上角「我的」可查看' : '已取消收藏「' + name + '」');
    if ($('qyMyOv')) renderMyTab();
  }
  var rowTm = 0;
  function startRowObserver() {
    var mo = new MutationObserver(function () {
      clearTimeout(rowTm);
      rowTm = setTimeout(decorateRows, 150);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    decorateRows();
  }
  function decorateRows() {
    try {
      document.querySelectorAll('.sp-row').forEach(decorateRow);
    } catch (e) {}
  }

  /* ---------- 样式 ---------- */
  function injectStyle() {
    if ($('qyStyle')) return;
    var css = [
      '.qy-ov{position:fixed;inset:0;background:rgba(15,23,42,.5);display:flex;align-items:flex-start;justify-content:center;padding:7vh 14px;z-index:99990;animation:qyFade .25s ease both}',
      '.qy-modal{background:#fff;border-radius:16px;max-width:580px;width:100%;max-height:82vh;overflow:auto;padding:18px 18px 14px;box-shadow:0 18px 50px rgba(2,6,23,.35);animation:qyUp .28s cubic-bezier(.22,1,.36,1) both}',
      '.qy-head{display:flex;align-items:center;gap:10px;margin-bottom:4px}',
      '.qy-title{font-size:15.5px;font-weight:800;color:#0f172a}',
      '.qy-sub{font-size:11.5px;color:#64748b;margin-top:1px}',
      '.qy-x{margin-left:auto;width:30px;height:30px;border-radius:9px;border:1px solid #e2e8f0;background:#f8fafc;cursor:pointer;font-size:13px;color:#475569}',
      '.qy-x:hover{background:#eef2ff}',
      '.qy-tabs{display:flex;gap:6px;margin:12px 0 10px;flex-wrap:wrap}',
      '.qy-tab{padding:6px 13px;border-radius:999px;border:1px solid #e2e8f0;background:#f8fafc;font-size:12.5px;cursor:pointer;color:#334155;transition:.15s}',
      '.qy-tab.on{background:#0f172a;color:#fff;border-color:#0f172a}',
      '.qy-tip{font-size:11.5px;color:#94a3b8;margin:2px 0 8px;line-height:1.6}',
      '.qy-sec{font-size:12.5px;font-weight:800;color:#0f172a;margin:12px 0 6px}',
      '.qy-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:6px;font-size:12.5px;background:#fff}',
      '.qy-chip{font-size:10.5px;color:#fff;background:#0ea5e9;padding:1px 7px;border-radius:999px;white-space:nowrap;flex:none}',
      '.qy-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:#0f172a}',
      '.qy-time{color:#94a3b8;font-size:10.5px;white-space:nowrap}',
      '.qy-coord{color:#94a3b8;font-size:10.5px;white-space:nowrap;flex:none}',
      '.qy-mini{border:1px solid #e2e8f0;background:#f8fafc;border-radius:7px;padding:3px 8px;font-size:11.5px;cursor:pointer;white-space:nowrap;color:#334155;flex:none;transition:.15s}',
      '.qy-mini:hover{background:#eef2ff}',
      '.qy-mini.danger{color:#b91c1c;border-color:#fecaca;background:#fef2f2}',
      '.qy-empty{color:#94a3b8;font-size:12px;padding:14px 4px;text-align:center}',
      '.qy-tools{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}',
      '.qy-mbtn{padding:6px 13px;border-radius:999px;border:1px solid #e2e8f0;background:#fff;font-size:12.5px;cursor:pointer;color:#334155;transition:.15s}',
      '.qy-mbtn:hover{background:#f1f5f9}',
      '.qy-mbtn.on{background:#0f172a;color:#fff;border-color:#0f172a}',
      '.qy-hint{font-size:11.5px;color:#64748b;margin-bottom:8px;line-height:1.6}',
      '#qyPoints{max-height:250px;overflow:auto;margin-top:8px}',
      '.qy-prow{display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid #e2e8f0;border-radius:9px;margin-bottom:5px;font-size:12px;background:#f8fafc}',
      '.qy-pico{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;flex:none}',
      '.qy-pname{flex:1;min-width:0;padding:4px 8px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;color:#0f172a}',
      '.qy-pname:focus{outline:2px solid #bae6fd;border-color:#0ea5e9}',
      '.qy-saverow{display:flex;gap:6px;margin-top:10px}',
      '.qy-savebtn{padding:8px 16px;border-radius:9px;border:none;background:#0f172a;color:#fff;font-size:12.5px;font-weight:700;cursor:pointer;white-space:nowrap;transition:.15s}',
      '.qy-savebtn:hover{background:#1e293b}',
      '.qy-toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%) translateY(16px);background:#0f172a;color:#fff;padding:9px 16px;border-radius:999px;font-size:12.5px;opacity:0;transition:.25s;z-index:100001;pointer-events:none;max-width:80vw}',
      '.qy-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}',
      '@keyframes qyFade{from{opacity:0}to{opacity:1}}',
      '@keyframes qyUp{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion: reduce){.qy-ov,.qy-modal,.qy-toast,.qy-tab,.qy-mini,.qy-mbtn,.qy-savebtn{animation:none!important;transition:none!important}}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'qyStyle';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- 启动 ---------- */
  function boot() {
    injectStyle();
    if (!injectCard()) { // 主容器尚未就绪时稍后重试
      var n = 0;
      var t = setInterval(function () { if (injectCard() || ++n > 40) clearInterval(t); }, 300);
    }
    hookSearchInput('fromCity', '出发地');
    hookSearchInput('toCity', '目的地');
    hookSearchInput('scenicCity', '景点搜索');
    hookTripInput('fromCity');
    hookTripInput('toCity');
    startRowObserver();
    startMyBtnObserver();
    // 地图不再开机初始化：首次展开「启程」卡片或加入点位时才建图（见 ensureMap）
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
