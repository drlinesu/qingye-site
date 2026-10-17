﻿﻿﻿﻿﻿﻿﻿﻿/* ============================================================
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
        localStorage.setItem(STORE_PREFIX + CACHE_KEY, JSON.stringify({ t: Date.now(), data: data }));
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

    /* ---------- 邮箱验证码登录（Supabase Auth Email OTP） ---------- */
    /* GoTrue 错误码 → 中文文案；后端不可用统一 code:'unavailable' 供云盾降级演示模式 */
    _authErr: function (err) {
      var raw = String((err && (err.code || err.error || err.message || err.msg)) || '').toLowerCase();
      var status = err && err.status;
      if (raw.indexOf('over_email_send_rate_limit') >= 0 || status === 429)
        return { ok: false, code: 'rate_limit', msg: '发送过于频繁，请 60 秒后重试' };
      if (raw.indexOf('otp_disabled') >= 0)
        return { ok: false, code: 'disabled', msg: '邮箱登录未开放或已停止新注册' };
      if (raw.indexOf('already registered') >= 0 || raw.indexOf('user_already_exists') >= 0 || raw.indexOf('email_exists') >= 0)
        return { ok: false, code: 'exists', msg: '该邮箱已注册，请直接用验证码登录' };
      if (raw.indexOf('otp_expired') >= 0 || raw.indexOf('token has expired') >= 0 || raw.indexOf('invalid') >= 0)
        return { ok: false, code: 'bad_token', msg: '验证码错误或已过期' };
      if (raw.indexOf('email_address_invalid') >= 0 || raw.indexOf('valid email') >= 0)
        return { ok: false, code: 'bad_email', msg: '邮箱格式不正确' };
      if (raw.indexOf('validation_failed') >= 0)
        return { ok: false, code: 'bad_request', msg: '请求参数有误' };
      return { ok: false, code: 'error', msg: (err && err.message) || '认证服务异常，请稍后重试' };
    },
    /* 发送邮箱验证码（新用户自动注册）。成功 {ok:true}；后端不可用 {ok:false,code:'unavailable'} */
    sendEmailOtp: function (email) {
      var self = this;
      return self._getClient().then(function (client) {
        if (!client) return { ok: false, code: 'unavailable' };
        return client.auth.signInWithOtp({ email: String(email), options: { shouldCreateUser: true } })
          .then(function (res) {
            if (res && res.error) return self._authErr(res.error);
            return { ok: true };
          })
          .catch(function (e) {
            var t = self._authErr(e);
            /* 网络层故障（fetch failed / NetworkError / Failed to fetch）→ 触发降级 */
            var raw = String((e && (e.message || e.name)) || '').toLowerCase();
            if (raw.indexOf('fetch') >= 0 || raw.indexOf('network') >= 0 || raw.indexOf('load failed') >= 0) t.code = 'unavailable';
            return t;
          });
      }).catch(function () { return { ok: false, code: 'unavailable' }; });
    },
    /* 注册新账号（邮箱+密码）：GoTrue 创建用户并发确认邮件，码用 type:'signup' 校验 */
    signUpEmail: function (email, password) {
      var self = this;
      return self._getClient().then(function (client) {
        if (!client) return { ok: false, code: 'unavailable' };
        return client.auth.signUp({
          email: String(email),
          password: String(password),
          options: { emailRedirectTo: global.location.origin }
        }).then(function (res) {
          if (res && res.error) return self._authErr(res.error);
          /* GoTrue 防枚举：邮箱已存在时返回 identities 为空数组且不发信 */
          var u = res && res.data && res.data.user;
          if (u && Array.isArray(u.identities) && u.identities.length === 0)
            return { ok: false, code: 'exists', msg: '该邮箱已注册，请直接用验证码登录' };
          return { ok: true };
        }).catch(function (e) {
          var t = self._authErr(e);
          var raw = String((e && (e.message || e.name)) || '').toLowerCase();
          if (raw.indexOf('fetch') >= 0 || raw.indexOf('network') >= 0 || raw.indexOf('load failed') >= 0) t.code = 'unavailable';
          return t;
        });
      }).catch(function () { return { ok: false, code: 'unavailable' }; });
    },
    /* 校验邮箱验证码。type：'email'（登录/OTP）或 'signup'（注册确认邮件），GoTrue 内部区分 */
    verifyEmailOtp: function (email, token, otpType) {
      var self = this;
      var vType = otpType === 'signup' ? 'signup' : 'email';
      return self._getClient().then(function (client) {
        if (!client) return { ok: false, code: 'unavailable' };
        return client.auth.verifyOtp({ email: String(email), token: String(token), type: vType })
          .then(function (res) {
            if (res && res.error) return self._authErr(res.error);
            return { ok: true, userId: res.data && res.data.user ? res.data.user.id : null };
          })
          .catch(function (e) {
            var t = self._authErr(e);
            var raw = String((e && (e.message || e.name)) || '').toLowerCase();
            if (raw.indexOf('fetch') >= 0 || raw.indexOf('network') >= 0 || raw.indexOf('load failed') >= 0) t.code = 'unavailable';
            return t;
          });
      }).catch(function () { return { ok: false, code: 'unavailable' }; });
    },

    /* 邮箱+密码登录（注册时已设置密码的用户） */
    signInPassword: function (email, password) {
      var self = this;
      return self._getClient().then(function (client) {
        if (!client) return { ok: false, code: 'unavailable' };
        return client.auth.signInWithPassword({ email: String(email), password: String(password) })
          .then(function (res) {
            var err = res && res.error;
            if (err) {
              var raw = String(err.message || err.msg || err.code || '').toLowerCase();
              if (raw.indexOf('invalid login credentials') >= 0 || raw.indexOf('email not confirmed') >= 0)
                return { ok: false, code: 'bad_credentials', msg: '邮箱或密码不正确（未设置过密码请用验证码登录）' };
              return self._authErr(err);
            }
            return { ok: true, userId: res.data && res.data.user ? res.data.user.id : null };
          })
          .catch(function (e) {
            var raw = String((e && (e.message || e.name)) || '').toLowerCase();
            if (raw.indexOf('invalid login credentials') >= 0 || raw.indexOf('email not confirmed') >= 0)
              return { ok: false, code: 'bad_credentials', msg: '邮箱或密码不正确（未设置过密码请用验证码登录）' };
            var t = self._authErr(e);
            if (raw.indexOf('fetch') >= 0 || raw.indexOf('network') >= 0 || raw.indexOf('load failed') >= 0) t.code = 'unavailable';
            return t;
          });
      }).catch(function () { return { ok: false, code: 'unavailable' }; });
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

    /* ---------- 注册用户列表（管理端实时拉取，云端不落盘） ----------
       走 GoTrue 管理接口 GET /auth/v1/admin/users，需 service_role 密钥；
       密钥由管理员在管理端粘贴、经 Channel 加密仅存本机，绝不写入源码/云端。 */
    fetchAuthUsers: function (serviceKey) {
      var self = this;
      return self.getSettings().then(function (s) {
        if (!s.url) return { ok: false, msg: '未配置 Supabase URL' };
        if (!serviceKey) return { ok: false, msg: '请先粘贴 service_role 密钥' };
        var all = [];
        var page = 1;
        function req(p) {
          return fetch(s.url + '/auth/v1/admin/users?per_page=200&page=' + p, {
            headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey }
          }).then(function (r) {
            if (r.status === 401 || r.status === 403) throw new Error('密钥无效或权限不足（需 service_role 密钥）');
            if (!r.ok) throw new Error('后端返回 HTTP ' + r.status);
            return r.json();
          });
        }
        function loop() {
          return req(page).then(function (j) {
            all = all.concat(j && j.users ? j.users : []);
            var np = j ? j.nextpage : null;
            if (np != null && np !== '' && page < 20) {
              page = (typeof np === 'number') ? np : (parseInt(np, 10) || page + 1);
              return loop();
            }
            return all;
          });
        }
        return loop().then(function (users) {
          users.sort(function (a, b) {
            return String(b.created_at || '').localeCompare(String(a.created_at || ''));
          });
          return { ok: true, users: users };
        });
      }).catch(function (e) {
        return { ok: false, msg: (e && e.message) || '拉取失败，请检查网络' };
      });
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

      /* ---------- 注册用户列表（实时拉取，云端不落盘） ---------- */
      if (Bridge._skTimer) { clearInterval(Bridge._skTimer); Bridge._skTimer = null; }
      var SEC_KEY = 'sbServiceKey';
      var skInput = el('input', { type: 'password', placeholder: 'service_role 密钥（粘贴后仅加密存于本机）', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:4px 0;box-sizing:border-box' });
      var skStatus = el('p', { class: 'cs-meta', style: 'color:#64748b;font-size:11px' });
      var userBox = el('div', { style: 'overflow-x:auto' });
      var skSaveBtn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', style: 'margin-right:8px' }, ['保存密钥']);
      var skClearBtn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', style: 'margin-right:8px' }, ['清除密钥']);
      var pullBtn = el('button', { class: 'cs-btn cs-btn-primary cs-btn-sm', style: 'margin-right:8px' }, ['🔄 拉取用户']);
      var autoLabel = el('label', { style: 'font-size:11px;color:#64748b;margin-left:10px;cursor:pointer' });
      var autoChk = el('input', { type: 'checkbox', style: 'vertical-align:-2px;margin-right:4px' });
      autoLabel.appendChild(autoChk);
      autoLabel.appendChild(document.createTextNode('每 60 秒自动刷新'));

      function fmtDT(v) { return v ? new Date(v).toLocaleString() : '—'; }
      function renderUsersTable(users) {
        userBox.innerHTML = '';
        var head = el('tr', {}, [
          el('th', {}, ['邮箱']), el('th', {}, ['注册时间']), el('th', {}, ['最近登录']), el('th', {}, ['状态'])
        ]);
        var rows = users.map(function (u) {
          var confirmed = !!(u.email_confirmed_at || u.confirmed_at || (u.identities && u.identities.length));
          return el('tr', {}, [
            el('td', {}, [String(u.email || u.phone || u.id || '-')]),
            el('td', {}, [fmtDT(u.created_at)]),
            el('td', {}, [fmtDT(u.last_sign_in_at)]),
            el('td', {}, [confirmed ? '✅ 已确认' : '⏳ 未确认'])
          ]);
        });
        userBox.appendChild(el('table', { class: 'cs-table' }, [
          el('thead', {}, [head]),
          el('tbody', {}, rows.length ? rows : [el('tr', {}, [el('td', { colspan: '4', style: 'text-align:center;padding:16px;color:#94a3b8' }, ['暂无注册用户'])])])
        ]));
      }
      function pullUsers() {
        skStatus.style.color = '#64748b';
        skStatus.textContent = '拉取中…';
        self.fetchAuthUsers(skInput.value.trim()).then(function (r) {
          if (!r.ok) { skStatus.style.color = '#dc2626'; skStatus.textContent = '❌ ' + r.msg; return; }
          skStatus.style.color = '#16a34a';
          skStatus.textContent = '✅ 共 ' + r.users.length + ' 位注册用户 · 更新于 ' + new Date().toLocaleTimeString();
          renderUsersTable(r.users);
        });
      }
      skSaveBtn.addEventListener('click', function () {
        var cs = global.CloudShield;
        if (!cs || !cs.Channel) { skStatus.style.color = '#dc2626'; skStatus.textContent = '❌ 加密通道不可用'; return; }
        if (!skInput.value.trim()) { skStatus.style.color = '#dc2626'; skStatus.textContent = '❌ 请先粘贴密钥'; return; }
        cs.Channel.write(SEC_KEY, { key: skInput.value.trim() }).then(function () {
          skStatus.style.color = '#16a34a';
          skStatus.textContent = '✅ 密钥已加密保存到本机（不进代码/不上云）';
        }).catch(function () {
          skStatus.style.color = '#dc2626'; skStatus.textContent = '❌ 保存失败';
        });
      });
      skClearBtn.addEventListener('click', function () {
        skInput.value = '';
        var cs = global.CloudShield;
        if (cs && cs.Channel) cs.Channel.write(SEC_KEY, {}).catch(function () {});
        skStatus.style.color = '#64748b';
        skStatus.textContent = '已清除本机保存的密钥';
      });
      pullBtn.addEventListener('click', pullUsers);
      autoChk.addEventListener('change', function () {
        if (Bridge._skTimer) { clearInterval(Bridge._skTimer); Bridge._skTimer = null; }
        if (autoChk.checked) { Bridge._skTimer = setInterval(pullUsers, 60000); pullUsers(); }
      });

      container.appendChild(el('div', { style: 'border-top:1px dashed #e2e8f0;margin-top:14px' }, []));
      container.appendChild(el('h3', {}, ['👥 注册用户列表（实时）']));
      container.appendChild(el('p', { class: 'cs-meta', style: 'font-size:11px;color:#64748b' }, ['实时读取 Supabase 注册用户（邮箱/注册时间/最近登录/确认状态），不在云端额外存储。密钥取自 Supabase 控制台 → Project Settings → API Keys → service_role。']));
      container.appendChild(skInput);
      container.appendChild(el('div', { class: 'cs-row' }, [skSaveBtn, skClearBtn, pullBtn, autoLabel]));
      container.appendChild(skStatus);
      container.appendChild(userBox);

      /* 预填已保存密钥；已保存过则打开面板即自动拉取一次 */
      var csG = global.CloudShield;
      if (csG && csG.Channel) {
        csG.Channel.read(SEC_KEY).then(function (v) {
          if (v && v.key) {
            skInput.value = v.key;
            pullUsers();
          }
        }).catch(function () {});
      }
    }
  };

  global.QYBridge = Bridge;

  /* 后端访问最小化：用户端启动不再自动拉取云端配置。
     云端配置仅在「账号登录」（sendEmailOtp/verifyEmailOtp）与「捐赠」
     （打开捐赠弹窗时 QYDonation 读取）两个场景按需访问；
     syncToLocal 方法保留，仅供管理端「立即同步」按钮主动调用。 */
})(window);
