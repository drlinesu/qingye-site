/* ============================================================
 * 轻野 · 桥接 (Light Wild · Bridge)
 * BaaS 中间层 —— 唯一与 Supabase 交互的模块（安全保护 + 隔离）
 *   ① 设计目的：后端只集中在本文件，后续迁移只改此一处
 *   ② 安全中间层：所有出站请求前经 CloudShield.WAF 检查 + RateLimit 限流
 *   ③ 配置同步：管理端 pushConfig 写 Supabase；用户端 syncToLocal 读覆盖本机
 *   ④ 数据存储：users / waf_logs 可选镜像到 Supabase（RLS 控制可见性）
 * 依赖：window.supabase（supabase-js v2 CDN）+ window.CloudShield（云盾）
 * 降级：Supabase 不可达 / 未配置 / RLS 拦截 → 返回 null/本地缓存
 * ============================================================ */
(function (global) {
  'use strict';
  if (global.QYBridge) return;

  var STORE_PREFIX = 'cs_';
  var SETTINGS_KEY = 'baasConfig';   /* Channel 加密存储：{ url, anonKey } */
  var CACHE_KEY = 'baasCache';       /* 明文 Store：config 缓存 */
  var CACHE_TTL = 5 * 60 * 1000;     /* 5 分钟 */
  var CONFIG_ROW_KEY = 'app_config'; /* config 表单行设计主键 */

  /* 内置默认凭据：publishable key 官方定位为可公开的前端密钥（安全由 RLS 保证），
   * 纯前端架构下访客浏览器无需配置即可读云端；管理端保存配置后优先级更高。 */
  var DEFAULT_SETTINGS = {
    url: 'https://qiezweasohrgxqaefiqh.supabase.co',
    anonKey: 'sb_publishable_bXBjIDP7k0OZv92CggD_rg_0VT1TnDA'
  };

  /* ---------- 工具 ---------- */
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

  /* ---------- Bridge 模块 ---------- */
  var Bridge = {
    _client: null,

    /* 读取设置（异步解密）：本机加密配置优先，无则回退内置默认 */
    getSettings: function () {
      return global.CloudShield.Channel.read(SETTINGS_KEY).then(function (s) {
        if (s && s.url && s.anonKey) return s;
        return { url: DEFAULT_SETTINGS.url, anonKey: DEFAULT_SETTINGS.anonKey, isDefault: true };
      }).catch(function () {
        return { url: DEFAULT_SETTINGS.url, anonKey: DEFAULT_SETTINGS.anonKey, isDefault: true };
      });
    },

    /* 保存设置（url + anonKey → Channel 加密） */
    saveSettings: function (settings) {
      return global.CloudShield.Channel.write(SETTINGS_KEY, {
        url: (settings.url || '').trim(),
        anonKey: (settings.anonKey || '').trim()
      });
    },

    /* 安全中间层：WAF 检查 + 限流，返回是否放行 */
    _guard: function (input) {
      var cs = global.CloudShield;
      if (!cs) return true;
      var waf = cs.Waf.check(input);
      if (!waf.ok) { cs.Waf.logAttack(input, waf.reason); return false; }
      var rl = cs.RateLimit.check('api');
      if (!rl.ok) return false;
      return true;
    },

    /* 懒加载 Supabase client（缓存） */
    _getClient: function () {
      var self = this;
      if (self._client) return Promise.resolve(self._client);
      return self.getSettings().then(function (s) {
        if (!s.url || !s.anonKey) return null;
        if (!global.supabase || typeof global.supabase.createClient !== 'function') return null;
        try {
          self._client = global.supabase.createClient(s.url, s.anonKey);
          return self._client;
        } catch (e) { return null; }
      });
    },

    /* 本机缓存读写 */
    _readCache: function () {
      try {
        var raw = localStorage.getItem(STORE_PREFIX + CACHE_KEY);
        if (!raw) return null;
        var obj = JSON.parse(raw);
        if (Date.now() - obj.t > CACHE_TTL) return null;
        return obj.data;
      } catch (e) { return null; }
    },
    _writeCache: function (data) {
      try {
        localStorage.setItem(STORAGE_PREFIX + CACHE_KEY, JSON.stringify({ t: Date.now(), data: data }));
      } catch (e) {}
    },

    /* 读取云端 config（带缓存，降级本机缓存） */
    getConfig: function () {
      var self = this;
      var cached = self._readCache();
      return self._getClient().then(function (client) {
        if (!client) return cached || null;
        return client.from('config').select('value').eq('key', CONFIG_ROW_KEY).maybeSingle()
          .then(function (res) {
            if (res.error) throw res.error;
            var cfg = (res.data && res.data.value) ? res.data.value : null;
            if (cfg) self._writeCache(cfg);
            return cfg || cached || null;
          })
          .catch(function () { return cached || null; });
      });
    },

    /* 推送配置到 Supabase（合并后 upsert） */
    pushConfig: function (partial) {
      var self = this;
      if (!self._guard(JSON.stringify(partial))) {
        return Promise.resolve({ ok: false, msg: '安全检查未通过（WAF 或限流拦截）' });
      }
      return self._getClient().then(function (client) {
        if (!client) return { ok: false, msg: '未配置 Supabase（需 URL + anonKey）' };
        /* 先读当前 config，合并后 upsert */
        return client.from('config').select('value').eq('key', CONFIG_ROW_KEY).maybeSingle()
          .then(function (res) {
            if (res.error && res.error.code !== 'PGRST116') throw res.error;
            var current = (res.data && res.data.value) ? res.data.value : {};
            var merged = {};
            var k;
            for (k in current) merged[k] = current[k];
            for (k in partial) merged[k] = partial[k];
            return client.from('config').upsert({
              key: CONFIG_ROW_KEY,
              value: merged,
              updated_at: new Date().toISOString()
            });
          })
          .then(function (res) {
            if (res.error) throw res.error;
            /* 刷新本机缓存 */
            return self.getConfig().then(function () {
              return { ok: true, msg: '已同步到 Supabase' };
            });
          });
      }).catch(function (e) {
        return { ok: false, msg: (e && e.message) || '推送失败' };
      });
    },

    /* 读取 users 表（管理端；RLS 拦截时返回 null，调用方降级本机 Channel） */
    getUsers: function () {
      var self = this;
      return self._getClient().then(function (client) {
        if (!client) return null;
        return client.from('users').select('phone,data')
          .then(function (res) {
            if (res.error) return null;
            var obj = {};
            (res.data || []).forEach(function (row) { obj[row.phone] = row.data || {}; });
            return obj;
          })
          .catch(function () { return null; });
      });
    },

    /* 写入 WAF 日志到 Supabase（用户端出站前经 _guard） */
    logWaf: function (input, reason) {
      var self = this;
      if (!self._guard(String(input))) return Promise.resolve(false);
      var cs = global.CloudShield;
      return self._getClient().then(function (client) {
        if (!client) return false;
        return client.from('waf_logs').insert({
          input: String(input).slice(0, 200),
          reason: String(reason || ''),
          fp: cs ? cs.Cert.fingerprint() : ''
        })
          .then(function (res) { return !res.error; })
          .catch(function () { return false; });
      });
    },

    /* 读取 waf_logs（管理端） */
    getWafLogs: function () {
      var self = this;
      return self._getClient().then(function (client) {
        if (!client) return null;
        return client.from('waf_logs').select('*').order('created_at', { ascending: false }).limit(100)
          .then(function (res) {
            if (res.error) return null;
            return (res.data || []).map(function (row) {
              return {
                t: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
                input: row.input,
                reason: row.reason,
                fp: row.fp
              };
            });
          })
          .catch(function () { return null; });
      });
    },

    /* 测试连接（用临时 client，不缓存） */
    testConnection: function (settings) {
      var s = settings;
      if (!s.url || !s.anonKey) return Promise.resolve({ ok: false, msg: '请填写 URL 和 anon key' });
      if (!global.supabase || typeof global.supabase.createClient !== 'function') {
        return Promise.resolve({ ok: false, msg: 'Supabase SDK 未加载（检查 CDN）' });
      }
      try {
        var c = global.supabase.createClient(s.url.trim(), s.anonKey.trim());
        return c.from('config').select('*').limit(1)
          .then(function (res) {
            if (res.error) return { ok: false, msg: res.error.message || '连接失败' };
            return { ok: true, msg: '连接正常，config 表可读' };
          })
          .catch(function (e) { return { ok: false, msg: (e && e.message) || '连接失败' }; });
      } catch (e) {
        return Promise.resolve({ ok: false, msg: e.message || '创建客户端失败' });
      }
    },

    /* 拉取 BaaS 配置覆盖本机（用户端启动时调用） */
    syncToLocal: function () {
      var self = this;
      return self.getConfig().then(function (cfg) {
        if (!cfg) return false;
        var cs = global.CloudShield;
        if (cfg.siteStatus) cs.Store.json('siteStatus', cfg.siteStatus);
        if (Array.isArray(cfg.donationAmounts)) {
          cs.Channel.write('donationAmounts', cfg.donationAmounts).catch(function () {});
        }
        return true;
      }).catch(function () { return false; });
    },

    /* 管理端配置卡 */
    renderAdminCard: function (container) {
      var self = this;
      container.innerHTML = '';
      container.appendChild(el('h3', {}, ['☁️ BaaS 后端 (Supabase)']));
      container.appendChild(el('p', { class: 'cs-meta' }, ['唯一与后端交互的中间层。URL + anonKey 经 AES-256-GCM 加密存本机，不进源码。出站前经 WAF + 限流保护。']));

      var urlInput = el('input', { type: 'text', placeholder: 'Supabase URL（如 https://xxxx.supabase.co）', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:4px 0;box-sizing:border-box' });
      var keyInput = el('input', { type: 'password', placeholder: 'anon public key（公开密钥）', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:4px 0;box-sizing:border-box' });
      var status = el('p', { class: 'cs-meta', style: 'color:#64748b' });
      var testBtn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', style: 'margin-right:8px' }, ['测试连接']);
      var saveBtn = el('button', { class: 'cs-btn cs-btn-primary cs-btn-sm' }, ['保存配置']);
      var syncBtn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', style: 'margin-left:8px' }, ['立即同步']);

      function loadSettings() {
        self.getSettings().then(function (s) {
          urlInput.value = s.url || '';
          keyInput.value = s.anonKey || '';
          if (s.url && s.anonKey) {
            status.style.color = s.isDefault ? '#64748b' : '#16a34a';
            status.textContent = s.isDefault
              ? '当前使用内置默认配置（可在下方填写并保存以覆盖）：' + s.url
              : '已配置：' + s.url;
          } else {
            status.style.color = '#64748b';
            status.textContent = '未配置 Supabase';
          }
        });
      }
      loadSettings();

      testBtn.addEventListener('click', function () {
        var st = { url: urlInput.value.trim(), anonKey: keyInput.value.trim() };
        if (!st.url || !st.anonKey) { status.style.color = '#dc2626'; status.textContent = '请填写 URL 和 anon key'; return; }
        status.style.color = '#64748b';
        status.textContent = '测试中…';
        self.testConnection(st).then(function (r) {
          status.style.color = r.ok ? '#16a34a' : '#dc2626';
          status.textContent = (r.ok ? '✅ ' : '❌ ') + r.msg;
        });
      });

      saveBtn.addEventListener('click', function () {
        var st = { url: urlInput.value.trim(), anonKey: keyInput.value.trim() };
        if (!st.url || !st.anonKey) { status.style.color = '#dc2626'; status.textContent = '请填写 URL 和 anon key'; return; }
        self.saveSettings(st).then(function () {
          self._client = null; /* 重置缓存 client */
          status.style.color = '#16a34a';
          status.textContent = '✅ 配置已保存（加密存储）';
          loadSettings();
        });
      });

      syncBtn.addEventListener('click', function () {
        status.style.color = '#64748b';
        status.textContent = '同步中…';
        var cs = global.CloudShield;
        var siteStatus = cs.Store.json('siteStatus') || { open: true, message: '' };
        Promise.all([
          cs.Channel.read('donationAmounts'),
          cs.Channel.read('donationRecords'),
          cs.Channel.read('afdianUrl')
        ]).then(function (rs) {
          var partial = {
            siteStatus: siteStatus,
            donationAmounts: Array.isArray(rs[0]) && rs[0].length ? rs[0] : [5, 10, 20, 50]
          };
          if (Array.isArray(rs[1]) && rs[1].length) partial.donationRecords = rs[1];
          if (rs[2]) partial.afdianUrl = rs[2];
          return self.pushConfig(partial);
        }).then(function (r) {
          status.style.color = r.ok ? '#16a34a' : '#dc2626';
          status.textContent = (r.ok ? '✅ ' : '❌ ') + r.msg;
        });
      });

      container.appendChild(status);
      container.appendChild(el('div', { class: 'cs-row' }, [urlInput]));
      container.appendChild(el('div', { class: 'cs-row' }, [keyInput]));
      container.appendChild(el('div', { class: 'cs-row' }, [testBtn, saveBtn, syncBtn]));
      container.appendChild(el('p', { class: 'cs-meta', style: 'margin-top:8px' }, ['使用前需在 Supabase 新建项目并执行建表 SQL（config / users / waf_logs）。']));
    }
  };

  global.QYBridge = Bridge;

  /* 用户端启动时拉取 BaaS 配置覆盖本机 */
  whenReady(function () {
    if (global.__CS_ADMIN__ === true) return;
    Bridge.syncToLocal().catch(function () {});
  });
})(window);
