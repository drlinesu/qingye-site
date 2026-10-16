/* ============================================================
 * 轻野 · 捐赠 (Light Wild · Donation)
 * 独立功能脚本 —— 零侵入：不修改 轻野.html 的任何计算与渲染逻辑。
 *   ① 用户端：右下角小小的「❤ 支持一下」入口 → 弹窗显示金额选项
 *   ② 管理端：在 云盾 管理控制台注入「捐赠金额配置」卡片
 * 金额选项由管理端配置，经 CloudShield.Channel（AES-256-GCM）加密存储，
 * 用户端读取同一通道；单机/局域网方案下配置随本机 localStorage 同步。
 * ============================================================ */
(function (global) {
  'use strict';
  if (global.QYDonation) return;
  var IS_ADMIN = global.__CS_ADMIN__ === true;

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
  var _toastTm = 0;
  function toast(msg) {
    try { if (typeof window.toast === 'function') { window.toast(msg); return; } } catch (e) {}
    var t = $('qyDnToast');
    if (!t) {
      t = el('div', { id: 'qyDnToast', style: 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:rgba(15,23,42,.92);color:#fff;padding:10px 18px;border-radius:999px;font-size:13px;z-index:99999;opacity:0;transition:opacity .25s;pointer-events:none' });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(_toastTm);
    _toastTm = setTimeout(function () { t.style.opacity = '0'; }, 2200);
  }

  /* 等待 CloudShield.Channel 就绪 */
  function whenReady(cb) {
    if (global.CloudShield && global.CloudShield.Channel) { cb(); return; }
    var n = 0;
    var t = setInterval(function () {
      if ((global.CloudShield && global.CloudShield.Channel) || ++n > 100) {
        clearInterval(t);
        if (global.CloudShield && global.CloudShield.Channel) cb();
      }
    }, 100);
  }

  /* ---------- 捐赠模块 ---------- */
  var Donation = {
    KEY: 'donationAmounts',
    DEFAULT_AMOUNTS: [5, 10, 20, 50],
    RECORDS_KEY: 'donationRecords',
    AFD_KEY: 'afdianUrl',
    DEFAULT_AFD_URL: 'https://afdian.com/a/yichangqingye',
    getAmounts: function () {
      var self = this;
      /* 优先 BaaS 桥接，降级 GitHub 云仓，再降级本机 Channel，最后默认值 */
      function readLocal() {
        return global.CloudShield.Channel.read(self.KEY).then(function (a) {
          return (Array.isArray(a) && a.length) ? a.slice() : self.DEFAULT_AMOUNTS.slice();
        }).catch(function () { return self.DEFAULT_AMOUNTS.slice(); });
      }
      function tryQYHub() {
        if (!global.QYHub) return readLocal();
        return global.QYHub.getConfig().then(function (cfg) {
          if (cfg && Array.isArray(cfg.donationAmounts) && cfg.donationAmounts.length) return cfg.donationAmounts.slice();
          return readLocal();
        }).catch(function () { return readLocal(); });
      }
      if (global.QYBridge) {
        return global.QYBridge.getConfig().then(function (cfg) {
          if (cfg && Array.isArray(cfg.donationAmounts) && cfg.donationAmounts.length) return cfg.donationAmounts.slice();
          return tryQYHub();
        }).catch(function () { return tryQYHub(); });
      }
      return tryQYHub();
    },
    setAmounts: function (arr) {
      var self = this;
      return global.CloudShield.Channel.write(self.KEY, arr).then(function () {
        /* 写本机后，优先推 BaaS 桥接，降级 GitHub 云仓 */
        if (global.QYBridge) global.QYBridge.pushConfig({ donationAmounts: arr }).then(function (r) {
          if (!r.ok && global.QYHub) global.QYHub.pushConfig({ donationAmounts: arr }).catch(function () {});
        });
        else if (global.QYHub) global.QYHub.pushConfig({ donationAmounts: arr }).catch(function () {});
        return true;
      });
    },
    /* ---------- 捐款记录 ---------- */
    getRecords: function () {
      var self = this;
      function readLocal() {
        return global.CloudShield.Channel.read(self.RECORDS_KEY).then(function (r) {
          return Array.isArray(r) ? r : [];
        }).catch(function () { return []; });
      }
      function fromCfg(cfg) {
        if (cfg && Array.isArray(cfg.donationRecords)) return cfg.donationRecords.slice();
        return readLocal();
      }
      if (global.QYBridge) {
        return global.QYBridge.getConfig().then(function (cfg) {
          if (cfg && Array.isArray(cfg.donationRecords) && cfg.donationRecords.length) return cfg.donationRecords.slice();
          return fromCfg(cfg);
        }).catch(function () { return readLocal(); });
      }
      if (global.QYHub) {
        return global.QYHub.getConfig().then(function (cfg) { return fromCfg(cfg); }).catch(function () { return readLocal(); });
      }
      return readLocal();
    },
    addRecord: function (name, amount) {
      var self = this;
      var record = { name: name || '匿名轻野人', amount: amount, t: Date.now() };
      return self.getRecords().then(function (records) {
        records.push(record);
        if (records.length > 500) records = records.slice(-500);
        return global.CloudShield.Channel.write(self.RECORDS_KEY, records).then(function () {
          /* BaaS 优先，GitHub 降级 */
          if (global.QYBridge) global.QYBridge.pushConfig({ donationRecords: records }).then(function (r) {
            if (!r.ok && global.QYHub) global.QYHub.pushConfig({ donationRecords: records }).catch(function () {});
          });
          else if (global.QYHub) global.QYHub.pushConfig({ donationRecords: records }).catch(function () {});
          return record;
        });
      });
    },
    /* 感谢名单排序：>100 优先，金额由高到低 */
    sortLeaderboard: function (records) {
      var high = [], normal = [], i;
      for (i = 0; i < records.length; i++) {
        if (records[i].amount >= 100) high.push(records[i]);
        else normal.push(records[i]);
      }
      high.sort(function (a, b) { return b.amount - a.amount; });
      normal.sort(function (a, b) { return b.amount - a.amount; });
      return high.concat(normal);
    },
    /* ---------- 爱发电收款入口 ---------- */
    getAfdianUrl: function () {
      var self = this;
      function readLocal() {
        return global.CloudShield.Channel.read(self.AFD_KEY).then(function (u) {
          return u || self.DEFAULT_AFD_URL;
        }).catch(function () { return self.DEFAULT_AFD_URL; });
      }
      if (global.QYBridge) {
        return global.QYBridge.getConfig().then(function (cfg) {
          if (cfg && cfg.afdianUrl) return String(cfg.afdianUrl);
          return readLocal();
        }).catch(function () { return readLocal(); });
      }
      if (global.QYHub) {
        return global.QYHub.getConfig().then(function (cfg) {
          if (cfg && cfg.afdianUrl) return String(cfg.afdianUrl);
          return readLocal();
        }).catch(function () { return readLocal(); });
      }
      return readLocal();
    },
    setAfdianUrl: function (url) {
      var self = this;
      return global.CloudShield.Channel.write(self.AFD_KEY, url).then(function () {
        /* BaaS 优先，GitHub 降级 */
        if (global.QYBridge) global.QYBridge.pushConfig({ afdianUrl: url }).then(function (r) {
          if (!r.ok && global.QYHub) global.QYHub.pushConfig({ afdianUrl: url }).catch(function () {});
        });
        else if (global.QYHub) global.QYHub.pushConfig({ afdianUrl: url }).catch(function () {});
        return true;
      });
    },
    /* 校验爱发电链接：仅允许官方域名，防跳转恶意站点 */
    checkAfdianUrl: function (url) {
      var s = String(url || '').trim();
      if (!s) return '';
      if (!/^https:\/\/(afdian\.com|afdian\.net)(\/|$)/.test(s)) return '';
      return s;
    },
    renderAdminCard: function (container) {
      var self = this;
      container.innerHTML = '';
      container.appendChild(el('h3', {}, ['❤️ 捐赠金额配置']));
      container.appendChild(el('p', { class: 'cs-meta' }, ['配置用户端捐赠弹窗显示的金额选项（单位：元），用逗号分隔，1-12 个正数。']));
      var status = el('p', { class: 'cs-meta', style: 'color:#64748b' });
      var input = el('input', { type: 'text', placeholder: '5, 10, 20, 50', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:8px 0;box-sizing:border-box' });
      var saveBtn = el('button', { class: 'cs-btn cs-btn-primary cs-btn-sm' }, ['保存金额']);
      var resetBtn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', style: 'margin-left:8px' }, ['恢复默认']);

      function refresh() {
        self.getAmounts().then(function (arr) {
          input.value = arr.join(', ');
          status.style.color = '#64748b';
          status.textContent = '当前金额选项：' + arr.map(function (n) { return '¥' + n; }).join(' / ');
        });
      }
      refresh();

      saveBtn.addEventListener('click', function () {
        var parts = input.value.split(/[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
        var nums = [];
        for (var i = 0; i < parts.length; i++) {
          var n = parseFloat(parts[i]);
          if (isNaN(n) || n <= 0) { status.style.color = '#dc2626'; status.textContent = '存在无效数值：' + parts[i] + '（需为正数）'; return; }
          nums.push(Math.round(n * 100) / 100);
        }
        if (!nums.length) { status.style.color = '#dc2626'; status.textContent = '请输入至少一个金额'; return; }
        if (nums.length > 12) { status.style.color = '#dc2626'; status.textContent = '最多 12 个选项，当前 ' + nums.length + ' 个'; return; }
        self.setAmounts(nums).then(function () {
          status.style.color = '#16a34a';
          status.textContent = '✅ 已保存：' + nums.map(function (n) { return '¥' + n; }).join(' / ');
          refresh();
        });
      });
      resetBtn.addEventListener('click', function () {
        if (!confirm('恢复为默认金额选项？')) return;
        self.setAmounts(self.DEFAULT_AMOUNTS.slice()).then(function () { refresh(); });
      });

      container.appendChild(status);
      container.appendChild(el('div', { class: 'cs-row' }, [input]));
      container.appendChild(el('div', { class: 'cs-row' }, [saveBtn, resetBtn]));
      container.appendChild(el('p', { class: 'cs-meta', style: 'margin-top:8px' }, ['用户端弹窗文案：「如果你认为使用情况不错，可以给网页一点小小的捐赠」']));

      /* ---- 爱发电收款入口 ---- */
      container.appendChild(el('div', { style: 'border-top:1px solid #e2e8f0;margin:16px 0 8px' }));
      container.appendChild(el('h3', {}, ['⚡ 爱发电收款入口']));
      container.appendChild(el('p', { class: 'cs-meta' }, ['填写你的爱发电主页链接，用户端捐赠弹窗将显示「前往爱发电支持」按钮跳转到收款页。仅允许 afdian.com / afdian.net 域名。']));
      var afdInput = el('input', { type: 'text', placeholder: 'https://afdian.com/a/你的ID', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:8px 0;box-sizing:border-box' });
      var afdStatus = el('p', { class: 'cs-meta', style: 'color:#64748b' });
      var afdSaveBtn = el('button', { class: 'cs-btn cs-btn-primary cs-btn-sm' }, ['保存链接']);
      var afdClearBtn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', style: 'margin-left:8px' }, ['清除']);
      var afdOpenBtn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', style: 'margin-left:8px' }, ['打开测试']);

      self.getAfdianUrl().then(function (u) {
        afdInput.value = u || '';
        if (u) { afdStatus.style.color = '#16a34a'; afdStatus.textContent = '✅ 已配置：' + u; }
        else { afdStatus.textContent = '未配置（用户端不显示跳转按钮）'; }
      });

      afdSaveBtn.addEventListener('click', function () {
        var raw = afdInput.value.trim();
        var u = self.checkAfdianUrl(raw);
        if (raw && !u) { afdStatus.style.color = '#dc2626'; afdStatus.textContent = '❌ 链接无效：必须为 https://afdian.com/… 或 https://afdian.net/…'; return; }
        self.setAfdianUrl(u).then(function () {
          afdStatus.style.color = u ? '#16a34a' : '#64748b';
          afdStatus.textContent = u ? '✅ 已保存：' + u : '✅ 已清除';
        });
      });
      afdClearBtn.addEventListener('click', function () {
        afdInput.value = '';
        self.setAfdianUrl('').then(function () {
          afdStatus.style.color = '#64748b';
          afdStatus.textContent = '已清除（用户端不显示跳转按钮）';
        });
      });
      afdOpenBtn.addEventListener('click', function () {
        var u = self.checkAfdianUrl(afdInput.value);
        if (u) window.open(u, '_blank');
        else { afdStatus.style.color = '#dc2626'; afdStatus.textContent = '请先填写有效的爱发电链接'; }
      });

      container.appendChild(afdStatus);
      container.appendChild(el('div', { class: 'cs-row' }, [afdInput]));
      container.appendChild(el('div', { class: 'cs-row' }, [afdSaveBtn, afdClearBtn, afdOpenBtn]));

      /* ---- 捐款记录 ---- */
      container.appendChild(el('div', { style: 'border-top:1px solid #e2e8f0;margin:16px 0 8px' }));
      container.appendChild(el('h3', {}, ['📊 捐款记录']));
      var recStatus = el('p', { class: 'cs-meta', style: 'color:#64748b' });
      var refreshBtn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', style: 'margin-bottom:8px' }, ['刷新记录']);
      var recTableWrap = el('div', {});
      container.appendChild(recStatus);
      container.appendChild(refreshBtn);
      container.appendChild(recTableWrap);

      function loadRecords() {
        recStatus.style.color = '#64748b';
        recStatus.textContent = '加载中…';
        self.getRecords().then(function (records) {
          records.sort(function (a, b) { return b.t - a.t; });
          var total = 0, i;
          for (i = 0; i < records.length; i++) total += (records[i].amount || 0);
          recStatus.style.color = '#16a34a';
          recStatus.textContent = '共 ' + records.length + ' 笔，合计 ¥' + (Math.round(total * 100) / 100);
          recTableWrap.innerHTML = '';
          if (!records.length) {
            recTableWrap.appendChild(el('p', { class: 'cs-meta', style: 'text-align:center;padding:16px;color:#94a3b8' }, ['暂无捐款记录']));
            return;
          }
          var rows = records.slice(0, 100).map(function (r) {
            return el('tr', {}, [
              el('td', {}, [r.name || '匿名']),
              el('td', {}, ['¥' + (Math.round(r.amount * 100) / 100)]),
              el('td', {}, [new Date(r.t).toLocaleString()])
            ]);
          });
          recTableWrap.appendChild(el('table', { class: 'cs-table' }, [
            el('thead', {}, [el('tr', {}, [el('th', {}, ['名字']), el('th', {}, ['金额']), el('th', {}, ['时间'])])]),
            el('tbody', {}, rows)
          ]));
        });
      }
      refreshBtn.addEventListener('click', loadRecords);
      loadRecords();
    }
  };

  global.QYDonation = Donation;

  // 注入弹窗动画样式（一次）
  if (!document.getElementById('qyDnStyle')) {
    var st = document.createElement('style');
    st.id = 'qyDnStyle';
    st.textContent = '@keyframes qyDnIn{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}';
    document.head.appendChild(st);
  }

  /* ============================================================
   * 用户端浮动入口（仅用户端页面，管理端页面跳过）
   * ============================================================ */
  if (IS_ADMIN) return;

  var floatBtn = null;
  function ensureFloat() {
    var hasBar = !!$('csUserBar');
    if (floatBtn && document.body.contains(floatBtn)) {
      if (!hasBar) { floatBtn.remove(); floatBtn = null; }
      return true;
    }
    if (!hasBar) return false;
    floatBtn = el('button', {
      id: 'qyDnFloat',
      style: 'position:fixed;right:14px;bottom:14px;z-index:99989;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:none;border-radius:999px;background:linear-gradient(135deg,#fb7185,#e11d48);color:#fff;font-size:13px;box-shadow:0 6px 18px rgba(225,29,72,.35);cursor:pointer;transition:transform .2s,box-shadow .2s',
      onmouseover: function () { floatBtn.style.transform = 'translateY(-2px)'; },
      onmouseout: function () { floatBtn.style.transform = ''; },
      onclick: openDonation
    }, ['❤ 支持一下']);
    document.body.appendChild(floatBtn);
    return true;
  }
  function startFloatObserver() {
    ensureFloat();
    var mo = new MutationObserver(function () { try { ensureFloat(); } catch (e) {} });
    mo.observe(document.body, { childList: true, subtree: false });
    var n = 0;
    var t = setInterval(function () { if (ensureFloat() || ++n > 120) clearInterval(t); }, 1000);
  }

  function openDonation() {
    if ($('qyDnOv')) return;
    var ov = el('div', {
      id: 'qyDnOv',
      style: 'position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(4px);z-index:99990;display:flex;align-items:center;justify-content:center;padding:20px',
      onclick: function (e) { if (e.target === ov) closeDonation(); }
    }, []);
    var modal = el('div', {
      style: 'background:#fff;border-radius:18px;padding:26px 24px;max-width:380px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 24px 60px rgba(0,0,0,.25);animation:qyDnIn .35s cubic-bezier(.22,1,.36,1) both'
    });
    var nameInput = el('input', { type: 'text', placeholder: '留下你的名字（选填，默认匿名轻野人）', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:8px 0;box-sizing:border-box;font-size:14px' });
    var amountBox = el('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:10px;margin:10px 0' });
    var leaderBox = el('div', { style: 'margin-top:14px' });
    var thanksBox = el('div', { style: 'display:none;text-align:center;padding:20px 0' });
    modal.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px' }, [
      el('div', { style: 'font-size:18px;font-weight:600;color:#0f172a' }, ['❤ 支持轻野']),
      el('button', { style: 'border:none;background:transparent;font-size:20px;color:#94a3b8;cursor:pointer', onclick: closeDonation }, ['✕'])
    ]));
    modal.appendChild(el('p', { style: 'color:#475569;font-size:13px;line-height:1.6;margin:0 0 4px' }, ['如果你认为使用情况不错，可以给网页一点小小的捐赠。']));
    var afdBtnWrap = el('div', { style: 'display:none;margin:10px 0 2px' });
    modal.appendChild(afdBtnWrap);
    modal.appendChild(nameInput);
    modal.appendChild(amountBox);
    modal.appendChild(leaderBox);
    modal.appendChild(thanksBox);
    ov.appendChild(modal);
    document.body.appendChild(ov);

    /* 渲染感谢名单（名字 only，>100 优先，金额由高到低，不显示金额） */
    function renderLeaderboard(container, highlightName) {
      container.innerHTML = '';
      container.appendChild(el('div', { style: 'font-size:13px;font-weight:600;color:#0f172a;margin-bottom:6px' }, ['🌟 感谢名单']));
      Donation.getRecords().then(function (records) {
        if (!records.length) {
          container.appendChild(el('p', { style: 'color:#94a3b8;font-size:12px;text-align:center;padding:8px 0' }, ['成为第一个支持轻野的人吧']));
          return;
        }
        var sorted = Donation.sortLeaderboard(records);
        var list = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' });
        sorted.slice(0, 30).forEach(function (r) {
          var isHigh = r.amount >= 100;
          var isMe = highlightName && r.name === highlightName;
          var chipStyle = 'display:inline-flex;align-items:center;gap:3px;padding:4px 10px;border-radius:999px;font-size:12px;';
          if (isHigh) chipStyle += 'background:linear-gradient(135deg,#fef3c7,#fde68a);color:#92400e;border:1px solid #fbbf24;';
          else chipStyle += 'background:#f1f5f9;color:#475569;';
          if (isMe) chipStyle += 'border:2px solid #e11d48;font-weight:600;';
          list.appendChild(el('span', { style: chipStyle }, [(isHigh ? '🌟 ' : '') + (r.name || '匿名') + (isMe ? ' (你)' : '')]));
        });
        container.appendChild(list);
      });
    }
    renderLeaderboard(leaderBox);

    /* 爱发电真实收款入口（管理员配置后才显示） */
    Donation.getAfdianUrl().then(function (u) {
      if (!u) return;
      afdBtnWrap.style.display = 'block';
      afdBtnWrap.appendChild(el('a', {
        href: u,
        target: '_blank',
        rel: 'noopener noreferrer',
        style: 'display:block;text-align:center;background:linear-gradient(135deg,#f59e0b,#f97316);color:#fff;border-radius:12px;padding:12px 0;font-size:14px;font-weight:600;text-decoration:none;box-shadow:0 4px 12px rgba(249,115,22,.3)',
        onmouseover: function (e) { e.currentTarget.style.transform = 'translateY(-1px)'; },
        onmouseout: function (e) { e.currentTarget.style.transform = ''; }
      }, ['⚡ 前往爱发电支持']));
    }).catch(function () {});

    Donation.getAmounts().then(function (arr) {
      amountBox.innerHTML = '';
      arr.forEach(function (amt) {
        amountBox.appendChild(el('button', {
          style: 'border:1px solid #e2e8f0;background:#fff;border-radius:12px;padding:14px 0;font-size:16px;font-weight:600;color:#e11d48;cursor:pointer;transition:all .15s',
          onmouseover: function (e) { e.currentTarget.style.background = '#fff1f2'; e.currentTarget.style.borderColor = '#fb7185'; },
          onmouseout: function (e) { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = '#e2e8f0'; },
          onclick: function () { showThanks(amt); }
        }, ['¥' + amt]));
      });
      amountBox.appendChild(el('button', {
        style: 'border:1px dashed #cbd5e1;background:#f8fafc;border-radius:12px;padding:14px 0;font-size:14px;color:#64748b;cursor:pointer;transition:all .15s',
        onmouseover: function (e) { e.currentTarget.style.background = '#f1f5f9'; },
        onmouseout: function (e) { e.currentTarget.style.background = '#f8fafc'; },
        onclick: function () {
          var v = prompt('输入自定义金额（元）');
          if (v == null) return;
          var n = parseFloat(v);
          if (isNaN(n) || n <= 0) { toast('金额无效'); return; }
          showThanks(Math.round(n * 100) / 100);
        }
      }, ['✎ 自定义']));
    });

    function showThanks(amt) {
      var donorName = nameInput.value.trim() || '匿名轻野人';
      /* 记录捐款 */
      Donation.addRecord(donorName, amt).then(function () {
        amountBox.style.display = 'none';
        nameInput.style.display = 'none';
        leaderBox.style.display = 'none';
        thanksBox.style.display = 'block';
        thanksBox.innerHTML = '';
        thanksBox.appendChild(el('div', { style: 'font-size:40px' }, ['💐']));
        thanksBox.appendChild(el('div', { style: 'font-size:20px;font-weight:600;color:#0f172a;margin:8px 0' }, ['感谢 ' + donorName + ' 的支持！']));
        /* 更新感谢名单（含本次捐款者高亮） */
        renderLeaderboard(thanksBox, donorName);
        /* 爱发电真实收款入口：已配置则显示跳转按钮，未配置保留演示文案 */
        Donation.getAfdianUrl().then(function (u) {
          if (u) {
            thanksBox.appendChild(el('a', {
              href: u,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: 'display:block;text-align:center;background:linear-gradient(135deg,#f59e0b,#f97316);color:#fff;border-radius:999px;padding:11px 0;font-size:14px;font-weight:600;text-decoration:none;margin:0 0 10px',
              onclick: function () { try { toast('感谢你的真实支持！'); } catch (e) {} }
            }, ['⚡ 前往爱发电完成真实支持 →']));
            thanksBox.appendChild(el('p', { style: 'color:#94a3b8;font-size:12px;line-height:1.6;margin:0 0 12px' }, ['演示记录已保存至感谢名单，真实捐赠请前往爱发电完成。']));
          } else {
            thanksBox.appendChild(el('p', { style: 'color:#475569;font-size:13px;line-height:1.6;margin:0 0 16px' }, ['你的鼓励是轻野继续前行的动力。当前为演示入口，暂未接入实际支付；如需真实捐赠，请联系站点管理员获取收款方式。']));
          }
        }).catch(function () {});
        thanksBox.appendChild(el('button', {
          style: 'border:none;background:#e11d48;color:#fff;border-radius:999px;padding:10px 22px;font-size:14px;cursor:pointer;margin-top:12px',
          onclick: closeDonation
        }, ['好的']));
      }).catch(function () {
        toast('记录保存失败，但感谢你的心意！');
        closeDonation();
      });
    }
  }
  function closeDonation() { var o = $('qyDnOv'); if (o) o.remove(); }

  whenReady(startFloatObserver);

})(window);
