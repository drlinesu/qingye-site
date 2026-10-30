/* ============================================================
 * 轻野 · 轻旅行智能推荐（Light Trip Rank）
 * 零侵入追加：不改动 轻野.html 的任何既有渲染逻辑，
 * 仅在 renderScenicGuide 之后，把「🤖 智能推荐」插入 #scenicGuide 顶部。
 *
 * 做三件事：
 *   1) 给每个景点推断「热度 / 类型（自然|人文|人工） / 蓝调亲和度」
 *   2) 按条件过滤 + 加权打分 + 多样性重排（MMR），给出 Top N 与推荐理由
 *   3) 支持外部热度数据覆盖：window.QY_SPOT_META（由 轻旅-热度.json 载入）
 *
 * 数据契约（可选）：
 *   window.QY_SPOT_META = {
 *     "怀柔水库（蓝调时刻）": { heat: 18, src: "小红书", plays: 3200, kind: "natural" }
 *   }
 *   heat  0-100，越低越冷门；src 只做来源标注；plays 为原始播放/点赞量（可选）
 * ============================================================ */
(function (global) {
  'use strict';
  if (global.QYTRIP) return;

  var PREFS_KEY = 'qy_trip_prefs';
  var META = global.QY_SPOT_META || null;   // 外部热度表（可为空）

  /* ---------- 小工具 ---------- */
  function txt(s) { return (s && (s.name || '')) + ' ' + (s && (s.desc || '')) + ' ' + (s && (s.emoji || '')); }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  /* ---------- 1. 推断层 ---------- */

  /* 类型：natural 自然 / human 人文（古镇村寺）/ artificial 人工（乐园、馆、商场） */
  function kindOf(s) {
    if (META && META[s.name] && META[s.name].kind) return META[s.name].kind;
    var t = txt(s);
    if (/乐园|水族馆|海洋馆|动物园|博物馆|科技馆|美术馆|展览|商场|购物|步行街|影城|温泉度假|景区大门/.test(t)) return 'artificial';
    if (/古镇|古城|古村|村落|寺庙|古寺|遗址|故居|祠堂|老街/.test(t)) return 'human';
    return 'natural';
  }

  /* 热度（0-100）：有外部数据用外部，没有就按 tier + 文本线索估算（标注为估算） */
  function heatOf(s) {
    if (META && META[s.name] && typeof META[s.name].heat === 'number') {
      return { heat: clamp(META[s.name].heat, 1, 99), est: false, src: META[s.name].src || '' };
    }
    var h = s.tier === 'popular' ? 72 : 28;
    var t = txt(s);
    if (/网红|打卡|必去|爆火|排队|人山人海/.test(t)) h += 12;
    if (/小众|人少|隐秘|秘境|冷门|无人/.test(t)) h -= 12;
    if (typeof s.crowd === 'number') h = Math.round(h * 0.5 + s.crowd * 10);
    return { heat: clamp(h, 1, 99), est: true, src: '' };
  }

  /* 蓝调/黄金时刻亲和度 0-5：水面反射、西向、日出日落线索 */
  function blueAffinity(s) {
    var t = txt(s), n = 0;
    if (/蓝调|日落|黄昏|晚霞|傍晚|夕阳/.test(t)) n += 2;
    if (/日出|清晨|晨雾|朝霞/.test(t)) n += 1;
    if (/海|湖|水库|江|湾|滩|湿地|盐湖/.test(t)) n += 1;
    if (/西向|面西|朝西/.test(t)) n += 2;
    if (s.facing === '西') n += 2;
    return clamp(n, 0, 5);
  }

  /* ---------- 2. 排序层 ---------- */

  /* 打分：蓝调亲和 45% + 冷门度 35% + 自然度 20%（关闭蓝调时改按冷门/自然加权） */
  function scoreSpot(s, p) {
    var heat = heatOf(s).heat;
    var niche = (100 - heat) / 100;
    var blue = blueAffinity(s) / 5;
    var natural = kindOf(s) === 'natural' ? 1 : (kindOf(s) === 'human' ? 0.45 : 0);
    var v = p.blue ? (0.45 * blue + 0.35 * niche + 0.20 * natural)
                   : (0.55 * niche + 0.45 * natural);
    return { v: v, heat: heat, niche: niche, blue: blue, natural: natural };
  }

  /* MMR 多样性重排：避免 Top5 全是湖/全是古镇 */
  function diversify(scored, k, lambda) {
    var picked = [], pool = scored.slice();
    while (picked.length < k && pool.length) {
      var best = 0, bestScore = -1;
      for (var i = 0; i < pool.length; i++) {
        var sim = 0;
        for (var j = 0; j < picked.length; j++) sim = Math.max(sim, similarity(pool[i].spot, picked[j].spot));
        var val = (1 - lambda) * pool[i].score - lambda * sim;
        if (val > bestScore) { bestScore = val; best = i; }
      }
      picked.push(pool.splice(best, 1)[0]);
    }
    return picked;
  }
  function bucketOf(s) {
    var t = txt(s);
    if (/湖|水库/.test(t)) return 'lake';
    if (/海|湾|滩|岛|港/.test(t)) return 'sea';
    if (/山|峰|岭|峡谷|草甸/.test(t)) return 'mountain';
    if (/古镇|古村|村落|老街/.test(t)) return 'town';
    if (/湿地|森林|草原|林场/.test(t)) return 'wetland';
    if (/寺|庙|祠/.test(t)) return 'temple';
    return 'other';
  }
  function similarity(a, b) { return bucketOf(a) === bucketOf(b) ? 1 : 0; }

  /* ---------- 3. 过滤 ---------- */
  function pass(s, p, heat) {
    var k = kindOf(s);
    if (p.natureOnly && k !== 'natural') return false;
    if (p.noArtificial && k === 'artificial') return false;
    if (p.blue && blueAffinity(s) < 2) return false;
    if (p.lowHeat && heat > 40) return false;
    return true;
  }

  /* ---------- 4. 文案 ---------- */
  function reasonOf(s, sc, p) {
    var bits = [];
    var k = kindOf(s);
    bits.push(k === 'natural' ? '自然景观' : (k === 'human' ? '人文古村' : '人工景点'));
    var h = heatOf(s);
    bits.push(h.est ? ('热度估算 ' + h.heat) : ('热度 ' + h.heat + (h.src ? '（' + h.src + '）' : '')));
    var b = blueAffinity(s);
    if (b >= 3) bits.push('蓝调/日落出片佳');
    else if (b >= 2) bits.push('傍晚光线好');
    if (p.lowHeat && h.heat <= 40) bits.push('低流量小众');
    return bits.join(' · ');
  }

  /* ---------- 5. 渲染 ---------- */
  var state = { city: '', data: null };

  function loadPrefs() {
    try { var o = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); return o || {}; } catch (e) { return {}; }
  }
  var prefs = Object.assign({ natureOnly: false, noArtificial: true, blue: false, lowHeat: false }, loadPrefs());
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {} }

  /* 读取景点库：SCENIC_SPOTS 在主页面用 const 声明，不会挂到 window 上，
     但顶层 const 属于全局词法环境，本脚本用裸标识符就能读到；window 属性作为兜底。 */
  function spotsDB() {
    try { if (typeof SCENIC_SPOTS !== 'undefined' && SCENIC_SPOTS) return SCENIC_SPOTS; } catch (e) {}
    return global.SCENIC_SPOTS || null;
  }

  function resolveList(city) {
    if (!city) return null;
    var S = spotsDB();
    if (!S) return null;
    if (S[city]) return S[city];
    var hit = Object.keys(S).find(function (k) { return city.indexOf(k) > -1 || k.indexOf(city) > -1; });
    return hit ? S[hit] : null;
  }

  function chip(key, label, on) {
    return '<button type="button" onclick="QYTRIP.toggle(\'' + key + '\')" style="font-size:11px;padding:3px 9px;border-radius:999px;cursor:pointer;border:1px solid ' +
      (on ? '#0f766e' : '#e2e8f0') + ';background:' + (on ? '#0f766e' : '#fff') + ';color:' + (on ? '#fff' : '#475569') + '">' +
      (on ? '✓ ' : '') + label + '</button>';
  }

  function render() {
    var host = document.getElementById('scenicGuide');
    if (!host || !state.city) return;
    var list = resolveList(state.city);
    if (!list || !list.length) return;

    var scored = [];
    list.forEach(function (s) {
      var h = heatOf(s).heat;
      if (!pass(s, prefs, h)) return;
      var sc = scoreSpot(s, prefs);
      scored.push({ spot: s, score: sc.v, parts: sc });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    var top = diversify(scored, 5, 0.25);

    var box = document.getElementById('qyTripAI');
    if (!box) {
      box = document.createElement('div');
      box.id = 'qyTripAI';
      host.insertBefore(box, host.firstChild);
    }

    var rows = top.map(function (x, i) {
      var s = x.spot;
      return '<div style="display:flex;gap:8px;align-items:flex-start;padding:7px 9px;border:1px solid #d1fae5;background:#f0fdf9;border-radius:8px;margin-bottom:5px;cursor:pointer" onclick="focusScenic(' + s.coords[0] + ',' + s.coords[1] + ')">' +
        '<span style="font-weight:700;color:#0f766e;font-size:12px;min-width:16px">' + (i + 1) + '</span>' +
        '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12.5px;font-weight:600;color:#134e4a">' + s.emoji + ' ' + s.name + '</div>' +
        '<div style="font-size:11px;color:#0f766e;margin-top:1px">' + reasonOf(s, x.parts, prefs) + '</div>' +
        '</div>' +
        '<span style="font-size:10px;color:#94a3b8;white-space:nowrap">匹配 ' + Math.round(x.score * 100) + '</span>' +
        '</div>';
    }).join('');

    var none = '<div style="font-size:11.5px;color:#94a3b8;padding:6px 2px">当前条件下没有合适的自然景点，试试放宽「蓝调」或「低热度」筛选。</div>';

    box.innerHTML =
      '<div style="border:1px solid #99f6e4;background:linear-gradient(180deg,#f0fdfa,#fff);border-radius:10px;padding:9px 10px;margin-bottom:8px">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">' +
      '<b style="font-size:12.5px;color:#0f766e">🤖 智能推荐</b>' +
      '<span style="font-size:10.5px;color:#64748b">按蓝调/冷门/自然度加权 · 结果来自本地景点库</span>' +
      '</div>' +
      '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px">' +
      chip('noArtificial', '排除人工景点', prefs.noArtificial) +
      chip('natureOnly', '只看自然', prefs.natureOnly) +
      chip('blue', '蓝调20分', prefs.blue) +
      chip('lowHeat', '低热度小众', prefs.lowHeat) +
      '</div>' +
      (rows || none) +
      '<div style="font-size:10px;color:#94a3b8;margin-top:2px">热度为估算值；如已导入平台数据将自动采用真实数值。人工景点（乐园/场馆）默认排除。</div>' +
      '</div>';
  }

  /* ---------- 6. 对外 ---------- */
  var api = {
    version: '1.0.0',
    heatOf: heatOf,
    kindOf: kindOf,
    blueAffinity: blueAffinity,
    scoreSpot: scoreSpot,
    diversify: diversify,
    bucketOf: bucketOf,
    prefs: prefs,
    toggle: function (k) {
      if (!(k in prefs)) return;
      prefs[k] = !prefs[k];
      savePrefs();
      render();
    },
    render: render,
    /* 供外部脚本注入平台热度数据 */
    setMeta: function (m) { META = m || null; render(); },
    _resolveList: resolveList
  };
  global.QYTRIP = api;

  /* ---------- 7. 勾住既有渲染 ---------- */
  function hook() {
    if (typeof global.renderScenicGuide !== 'function') { setTimeout(hook, 300); return; }
    if (global.renderScenicGuide.__qyTripHooked) return;
    var orig = global.renderScenicGuide;
    var wrapped = function (name) {
      var r = orig.apply(this, arguments);
      try {
        state.city = typeof name === 'string' ? name : (name && name.name) || '';
        render();
      } catch (e) {}
      return r;
    };
    wrapped.__qyTripHooked = true;
    global.renderScenicGuide = wrapped;
  }
  hook();

  /* 可选：载入同目录的平台热度数据（file:// 下 fetch 会失败，静默跳过） */
  try {
    fetch('轻旅-热度.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && typeof j === 'object') { META = j; if (global.QYTRIP) api.setMeta(j); } })
      .catch(function () {});
  } catch (e) {}
})(window);
