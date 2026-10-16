/* ============================================================
 * 轻野 · 云盾 (Light Wild · Cloud Shield)
 * 客户端安全网关 —— 纯浏览器原生 API 实现（零后端、零依赖、免费）
 * 功能：邮箱验证登入 / 接口防刷 / WAF / 证书认证 / 管理端MFA / 数据加密 / 云端储存 / 独立管理端
 * 架构：用户端（轻野.html）与管理端（轻野-管理端.html）为两个独立网页；
 *       两端之间的数据传送（用户记录 / WAF 日志）统一经 AES-256-GCM 加密通道
 * 约束：不修改原轻野.html 的任何计算与渲染逻辑
 * ============================================================ */
(function (global) {
  'use strict';

  var STORAGE_PREFIX = 'cs_';
  var CS_VERSION = '1.2.0';
  // 独立管理端网页（与用户端分离）
  var ADMIN_PAGE = '轻野-管理端.html';
  // 页面模式：管理端页面在加载云盾前设置 window.__CS_ADMIN__ = true
  var PAGE_MODE = global.__CS_ADMIN__ === true ? 'admin' : 'user';

  /* ---------- 工具函数 ---------- */
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
  function randHex(n) {
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function b64enc(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64dec(s) {
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  function buf2hex(buf) {
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function hex2buf(h) {
    var bytes = new Uint8Array(h.length / 2);
    for (var i = 0; i < h.length; i += 2) bytes[i / 2] = parseInt(h.substr(i, 2), 16);
    return bytes.buffer;
  }

  /* ---------- 存储封装（带前缀） ---------- */
  var Store = {
    get: function (k) { try { return localStorage.getItem(STORAGE_PREFIX + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(STORAGE_PREFIX + k, v); return true; } catch (e) { return false; } },
    del: function (k) { try { localStorage.removeItem(STORAGE_PREFIX + k); } catch (e) {} },
    json: function (k, v) {
      if (v === undefined) { var s = this.get(k); return s ? JSON.parse(s) : null; }
      return this.set(k, JSON.stringify(v));
    }
  };

  /* ---------- AES-GCM 加密模块 ---------- */
  var Crypto = {
    // 从口令派生密钥（PBKDF2）
    deriveKey: function (password, salt) {
      var enc = new TextEncoder();
      return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
        .then(function (baseKey) {
          return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
          );
        });
    },
    // 加密字符串 → 返回 {ct, iv, salt} 的 base64 JSON
    encrypt: function (plaintext, password) {
      var self = this;
      var salt = crypto.getRandomValues(new Uint8Array(16));
      var iv = crypto.getRandomValues(new Uint8Array(12));
      return self.deriveKey(password, salt).then(function (key) {
        return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(plaintext));
      }).then(function (ct) {
        return JSON.stringify({
          v: 1,
          salt: b64enc(salt),
          iv: b64enc(iv),
          ct: b64enc(ct)
        });
      });
    },
    // 解密
    decrypt: function (cipherJson, password) {
      var self = this;
      var obj;
      try { obj = JSON.parse(cipherJson); } catch (e) { return Promise.reject(new Error('密文格式错误')); }
      var salt = b64dec(obj.salt);
      var iv = b64dec(obj.iv);
      var ct = b64dec(obj.ct);
      return self.deriveKey(password, salt).then(function (key) {
        return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
      }).then(function (pt) {
        return new TextDecoder().decode(pt);
      });
    },
    // 哈希（SHA-256）
    hash: function (text) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(buf2hex);
    }
  };

  /* ---------- 加密数据通道（两端数据传送统一加密） ----------
   * 用户端写入 / 管理端读取的共享数据（用户记录、WAF 日志）在存储通道内
   * 全程 AES-256-GCM 密文；通道密钥由本机随机密钥派生（PBKDF2 10 万轮），
   * 旧版明文数据自动兼容读取并迁移为密文。 */
  var Channel = {
    SECRET_KEY: 'channelKey',
    _keyPromise: null,
    _secret: function () {
      var s = Store.get(this.SECRET_KEY);
      if (!s || s.length < 64) { s = randHex(32); Store.set(this.SECRET_KEY, s); }
      return s;
    },
    // 判定是否为本方案的密文格式
    _isCipher: function (raw) {
      var t = String(raw).trim();
      return t.charAt(0) === '{' && t.indexOf('"v":1') > -1 && t.indexOf('"ct":') > -1;
    },
    // 读取：自动解密；旧版明文 JSON 兼容返回，并静默迁移为密文
    _migrating: {},
    read: function (key) {
      var self = this;
      var raw = Store.get(key);
      if (!raw) return Promise.resolve(null);
      if (this._isCipher(raw)) {
        return Crypto.decrypt(raw, this._secret()).then(function (pt) {
          try { return JSON.parse(pt); } catch (e) { return null; }
        }).catch(function () { return null; });
      }
      try {
        var obj = JSON.parse(raw);
        // 旧明文数据：先原样返回保证读取可用，随后后台改写为密文
        if (obj && typeof obj === 'object' && !self._migrating[key]) {
          self._migrating[key] = true;
          self.write(key, obj).catch(function () {}).then(function () { delete self._migrating[key]; });
        }
        return Promise.resolve(obj);
      } catch (e) { return Promise.resolve(null); }
    },
    // 写入：序列化后加密存储
    write: function (key, obj) {
      var secret = this._secret();
      return Crypto.encrypt(JSON.stringify(obj), secret).then(function (s) {
        Store.set(key, s);
        return true;
      });
    }
  };

  /* ---------- 设备证书（模拟客户端证书认证） ---------- */
  var Cert = {
    getOrCreate: function () {
      var cert = Store.json('deviceCert');
      if (cert && cert.id && cert.pub) return cert;
      cert = {
        id: 'CS-' + randHex(8).toUpperCase(),
        pub: randHex(32),
        createdAt: now(),
        ua: navigator.userAgent.slice(0, 120)
      };
      Store.json('deviceCert', cert);
      return cert;
    },
    fingerprint: function () {
      var c = this.getOrCreate();
      return c.id + ':' + c.pub.slice(0, 16);
    }
  };

  /* ---------- WAF（Web 应用防火墙） ---------- */
  var Waf = {
    // SQL 注入特征
    sqlPatterns: [
      /(\b(union|select|insert|update|delete|drop|alter|create|exec|execute)\b.*\b(from|into|table|database)\b)/i,
      /(--|#|\/\*|\*\/)/,
      /('\s*or\s*'\d+'\s*=\s*'\d+)/i,
      /;\s*drop\s+table/i,
      /xp_cmdshell/i
    ],
    // XSS 特征
    xssPatterns: [
      /<script[\s>]/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /<iframe/i,
      /<img[^>]+onerror/i
    ],
    sanitize: function (input) {
      if (input == null) return '';
      var s = String(input);
      // 转义 HTML
      s = s.replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
      return s;
    },
    check: function (input) {
      if (input == null) return { ok: true };
      var s = String(input);
      for (var i = 0; i < this.sqlPatterns.length; i++) {
        if (this.sqlPatterns[i].test(s)) return { ok: false, reason: '检测到 SQL 注入特征' };
      }
      for (var j = 0; j < this.xssPatterns.length; j++) {
        if (this.xssPatterns[j].test(s)) return { ok: false, reason: '检测到 XSS 攻击特征' };
      }
      return { ok: true };
    },
    // 审计日志（经加密数据通道存储）
    logAttack: function (input, reason) {
      Channel.read('wafLogs').then(function (logs) {
        logs = logs || [];
        logs.unshift({ t: now(), input: String(input).slice(0, 200), reason: reason, fp: Cert.fingerprint() });
        if (logs.length > 100) logs = logs.slice(0, 100);
        return Channel.write('wafLogs', logs);
      }).catch(function () {});
    }
  };

  /* ---------- 接口防刷（限流） ---------- */
  var RateLimit = {
    buckets: {
      sms: { max: 5, windowMs: 60 * 1000, lockMs: 15 * 60 * 1000 },
      login: { max: 5, windowMs: 60 * 1000, lockMs: 15 * 60 * 1000 },
      mfa: { max: 3, windowMs: 60 * 1000, lockMs: 30 * 60 * 1000 },
      api: { max: 60, windowMs: 60 * 1000, lockMs: 5 * 60 * 1000 }
    },
    check: function (bucket) {
      var b = this.buckets[bucket];
      if (!b) return { ok: true };
      var state = Store.json('rl_' + bucket) || { count: 0, windowStart: now(), lockedUntil: 0 };
      if (state.lockedUntil > now()) {
        return { ok: false, locked: true, remain: Math.ceil((state.lockedUntil - now()) / 1000) };
      }
      if (now() - state.windowStart > b.windowMs) {
        state = { count: 0, windowStart: now(), lockedUntil: 0 };
      }
      state.count++;
      if (state.count > b.max) {
        state.lockedUntil = now() + b.lockMs;
        Store.json('rl_' + bucket, state);
        return { ok: false, locked: true, remain: Math.ceil(b.lockMs / 1000) };
      }
      Store.json('rl_' + bucket, state);
      return { ok: true, remain: b.max - state.count };
    },
    reset: function (bucket) { Store.del('rl_' + bucket); }
  };

  /* ---------- MFA（TOTP 基于时间的一次性密码） ---------- */
  var Mfa = {
    // Base32 编码
    base32Encode: function (bytes) {
      var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      var bits = '';
      for (var i = 0; i < bytes.length; i++) bits += bytes[i].toString(2).padStart(8, '0');
      while (bits.length % 5) bits += '0';
      var out = '';
      for (var j = 0; j < bits.length; j += 5) out += chars[parseInt(bits.substr(j, 5), 2)];
      while (out.length % 8) out += '=';
      return out;
    },
    generateSecret: function () {
      var bytes = crypto.getRandomValues(new Uint8Array(20));
      return this.base32Encode(bytes).replace(/=+$/, '');
    },
    // HMAC-SHA1
    hmacSha1: function (key, data) {
      return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
        .then(function (k) { return crypto.subtle.sign('HMAC', k, data); });
    },
    // Base32 解码
    base32Decode: function (secret) {
      var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      var s = secret.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
      var bits = '';
      for (var i = 0; i < s.length; i++) {
        var idx = chars.indexOf(s[i]);
        if (idx < 0) continue;
        bits += idx.toString(2).padStart(5, '0');
      }
      var bytes = new Uint8Array(Math.floor(bits.length / 8));
      for (var j = 0; j < bytes.length; j++) bytes[j] = parseInt(bits.substr(j * 8, 8), 2);
      return bytes;
    },
    // 生成 TOTP 码
    totp: function (secret, timeStep) {
      var self = this;
      timeStep = timeStep || 30;
      var counter = Math.floor(now() / 1000 / timeStep);
      var counterBytes = new Uint8Array(8);
      for (var i = 7; i >= 0; i--) { counterBytes[i] = counter & 0xff; counter = Math.floor(counter / 256); }
      var key = self.base32Decode(secret);
      return self.hmacSha1(key, counterBytes).then(function (sig) {
        var sigBytes = new Uint8Array(sig);
        var offset = sigBytes[19] & 0x0f;
        var code = ((sigBytes[offset] & 0x7f) << 24) |
          ((sigBytes[offset + 1] & 0xff) << 16) |
          ((sigBytes[offset + 2] & 0xff) << 8) |
          (sigBytes[offset + 3] & 0xff);
        code = code % 1000000;
        return code.toString().padStart(6, '0');
      });
    },
    // 验证 TOTP 码（允许 ±1 步长）
    verify: function (secret, code) {
      var self = this;
      return self.totp(secret, 30).then(function (c1) {
        return self.totp(secret, 30).then(function () {
          // 检查当前及前后窗口
          var promises = [];
          var steps = [0, -1, 1];
          steps.forEach(function (step) {
            var counter = Math.floor(now() / 1000 / 30) + step;
            var counterBytes = new Uint8Array(8);
            var c = counter;
            for (var i = 7; i >= 0; i--) { counterBytes[i] = c & 0xff; c = Math.floor(c / 256); }
            var key = self.base32Decode(secret);
            promises.push(self.hmacSha1(key, counterBytes).then(function (sig) {
              var sb = new Uint8Array(sig);
              var off = sb[19] & 0x0f;
              var cd = ((sb[off] & 0x7f) << 24) | ((sb[off + 1] & 0xff) << 16) | ((sb[off + 2] & 0xff) << 8) | (sb[off + 3] & 0xff);
              return (cd % 1000000).toString().padStart(6, '0');
            }));
          });
          return Promise.all(promises).then(function (codes) {
            return codes.indexOf(code) >= 0;
          });
        });
      });
    },
    // 生成 otpauth:// URI 供扫码
    otpauthUri: function (secret, account, issuer) {
      return 'otpauth://totp/' + encodeURIComponent(issuer || '轻野云盾') + ':' + encodeURIComponent(account || 'user') +
        '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer || '轻野云盾') + '&algorithm=SHA1&digits=6&period=30';
    }
  };

  /* ---------- 云端储存（加密本地 + 导出导入） ---------- */
  var Cloud = {
    // 保存用户数据到加密云存储
    save: function (phone, data, masterKey) {
      var self = this;
      return Crypto.encrypt(JSON.stringify(data), masterKey).then(function (ct) {
        var users = Store.json('cloudUsers') || {};
        users[phone] = { data: ct, updatedAt: now() };
        Store.json('cloudUsers', users);
        return true;
      });
    },
    // 读取
    load: function (phone, masterKey) {
      var users = Store.json('cloudUsers') || {};
      if (!users[phone]) return Promise.resolve(null);
      return Crypto.decrypt(users[phone].data, masterKey).then(function (pt) {
        return JSON.parse(pt);
      });
    },
    // 导出加密备份（跨设备同步）
    exportBackup: function () {
      var users = Store.json('cloudUsers') || {};
      return JSON.stringify({ _type: 'csBackup', v: CS_VERSION, users: users, exportedAt: now() });
    },
    // 导入备份
    importBackup: function (json) {
      var obj = JSON.parse(json);
      if (obj._type !== 'csBackup') throw new Error('备份文件格式无效');
      var existing = Store.json('cloudUsers') || {};
      Object.keys(obj.users || {}).forEach(function (p) { existing[p] = obj.users[p]; });
      Store.json('cloudUsers', existing);
      return Object.keys(obj.users || {}).length;
    }
  };

  /* ---------- 认证模块 ---------- */
  var Auth = {
    // 当前会话
    session: null,
    // 发送验证码：优先走 Supabase 真实邮件 OTP；后端不可用时降级本地演示码
    // 云端模式 resolve {cloud:true}（无明文码）；演示模式 resolve {cloud:false, code:'123456'}
    sendCode: function (email) {
      var rl = RateLimit.check('sms');
      if (!rl.ok) return Promise.reject(new Error('请求过于频繁，请 ' + rl.remain + ' 秒后重试'));
      if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) return Promise.reject(new Error('邮箱格式不正确'));
      var waf = Waf.check(email);
      if (!waf.ok) { Waf.logAttack(email, waf.reason); return Promise.reject(new Error(waf.reason)); }

      var codes = Store.json('smsCodes') || {};
      /* 本地演示码逻辑（Supabase 缺失/离线时降级使用） */
      function demoCode() {
        var code = String(Math.floor(100000 + Math.random() * 900000));
        codes[email] = { code: code, expiresAt: now() + 5 * 60 * 1000, attempts: 0 };
        Store.json('smsCodes', codes);
        return { cloud: false, code: code };
      }

      if (global.QYBridge && typeof global.QYBridge.sendEmailOtp === 'function') {
        return global.QYBridge.sendEmailOtp(email).then(function (r) {
          if (r && r.ok) {
            codes[email] = { cloud: true, expiresAt: now() + 24 * 60 * 60 * 1000, attempts: 0 };
            Store.json('smsCodes', codes);
            return { cloud: true };
          }
          if (r && r.code === 'unavailable') return demoCode();
          throw new Error((r && r.msg) || '验证码发送失败');
        });
      }
      return Promise.resolve(demoCode());
    },
    // 登录/注册（云端 OTP 或本地演示码；用户端不启用 MFA）
    login: function (email, code) {
      var self = this;
      var rl = RateLimit.check('login');
      if (!rl.ok) return Promise.reject(new Error('登录尝试过于频繁，请 ' + rl.remain + ' 秒后重试'));
      var waf = Waf.check(email);
      if (!waf.ok) { Waf.logAttack(email, waf.reason); return Promise.reject(new Error(waf.reason)); }
      var codes = Store.json('smsCodes') || {};
      var rec = codes[email];
      if (!rec || rec.expiresAt < now()) {
        return Promise.reject(new Error('请先获取验证码'));
      }

      /* 云端模式：交 Supabase Auth 校验 */
      if (rec.cloud === true) {
        if (!global.QYBridge || typeof global.QYBridge.verifyEmailOtp !== 'function') {
          return Promise.reject(new Error('认证服务暂不可用，请重新获取验证码'));
        }
        return global.QYBridge.verifyEmailOtp(email, code).then(function (r) {
          if (!r || !r.ok) {
            rec.attempts = (rec.attempts || 0) + 1;
            codes[email] = rec;
            Store.json('smsCodes', codes);
            throw new Error((r && r.msg) || '验证码错误或已过期');
          }
          /* 校验通过后清除 */
          delete codes[email];
          Store.json('smsCodes', codes);
          return self._afterVerified(email);
        });
      }

      /* 本地演示码模式 */
      if (rec.code !== code) {
        return Promise.reject(new Error('验证码错误或已过期'));
      }
      // 验证码正确后清除
      delete codes[email];
      Store.json('smsCodes', codes);
      return self._afterVerified(email);
    },
    /* 验证码通过后的统一入口：写 users 记录并建立本地会话（云端/演示共用） */
    _afterVerified: function (email) {
      var self = this;
      return Channel.read('users').then(function (users) {
        users = users || {};
        var isNew = !users[email];
        if (isNew) {
          users[email] = { phone: email, createdAt: now(), mfaSecret: null, mfaEnabled: false, logins: [] };
        }
        users[email].lastLoginAt = now();
        users[email].lastFp = Cert.fingerprint();
        // 用户端不启用 MFA：验证码通过后直接建立会话
        return Channel.write('users', users).then(function () {
          return self._establishSession(email, isNew);
        });
      });
    },
    _establishSession: function (email, isNew) {
      // 记录登入位置（免费 IP 地理定位），登入记录走加密数据通道
      var self = this;
      return self._fetchLocation().then(function (loc) {
        return Channel.read('users').then(function (users) {
          users = users || {};
          if (!users[email]) users[email] = { phone: email, createdAt: now(), mfaSecret: null, mfaEnabled: false, logins: [] };
          if (!users[email].logins) users[email].logins = [];
          users[email].logins.unshift({ t: now(), loc: loc, fp: Cert.fingerprint() });
          if (users[email].logins.length > 50) users[email].logins = users[email].logins.slice(0, 50);
          return Channel.write('users', users).then(function () {
            var token = randHex(32);
            self.session = { email: email, phone: email, token: token, loginAt: now(), isNew: isNew, loc: loc };
            Store.json('session', self.session);
            return self.session;
          });
        });
      }).catch(function () {
        // 定位或通道异常也允许登录（优雅降级）
        self.session = { email: email, phone: email, token: randHex(32), loginAt: now(), isNew: isNew, loc: null };
        Store.json('session', self.session);
        return self.session;
      });
    },
    _fetchLocation: function () {
      return fetch('https://ipapi.co/json/').then(function (r) { return r.json(); }).then(function (d) {
        return { ip: d.ip, city: d.city, region: d.region, country: d.country_name };
      });
    },
    logout: function () {
      this.session = null;
      Store.del('session');
    },
    current: function () {
      if (this.session) return this.session;
      var s = Store.json('session');
      if (s) { this.session = s; return s; }
      return null;
    }
  };

  /* ---------- 管理端 ---------- */
  var Admin = {
    // 管理员凭证（免费方案：本地凭证，生产应使用安全后端）
    // 默认账号 admin / 密码 cs@2024 / 密钥 cs-key-2024（首次登录后可改）
    DEFAULT_USER: 'admin',
    DEFAULT_PASS: 'cs@2024',
    DEFAULT_KEY: 'cs-key-2024',
    creds: function () {
      return Store.json('adminCred') || { user: 'admin', passHash: null, accessKeyHash: null, mfaSecret: null, mfaEnabled: false };
    },
    setPassword: function (pass) {
      return Crypto.hash(pass).then(function (h) {
        var c = Admin.creds();
        c.passHash = h;
        Store.json('adminCred', c);
        return true;
      });
    },
    setAccessKey: function (key) {
      return Crypto.hash(key).then(function (h) {
        var c = Admin.creds();
        c.accessKeyHash = h;
        Store.json('adminCred', c);
        return true;
      });
    },
    login: function (user, pass, accessKey, mfaCode) {
      var rl = RateLimit.check('login');
      if (!rl.ok) return Promise.reject(new Error('登录尝试过于频繁，请 ' + rl.remain + ' 秒后重试'));
      var waf = Waf.check(accessKey);
      if (!waf.ok) { Waf.logAttack(accessKey, waf.reason); return Promise.reject(new Error(waf.reason)); }
      var c = Admin.creds();
      if (user !== c.user) return Promise.reject(new Error('管理员账号错误'));
      // 首次登录无密码哈希，设置默认
      if (!c.passHash || !c.accessKeyHash) {
        return Promise.all([Crypto.hash(Admin.DEFAULT_PASS), Crypto.hash(Admin.DEFAULT_KEY)]).then(function (hs) {
          c.passHash = hs[0];
          c.accessKeyHash = hs[1];
          Store.json('adminCred', c);
          return Admin._verify(pass, accessKey, c, mfaCode);
        });
      }
      return Admin._verify(pass, accessKey, c, mfaCode);
    },
    _verify: function (pass, accessKey, c, mfaCode) {
      return Promise.all([Crypto.hash(pass), Crypto.hash(accessKey)]).then(function (hs) {
        if (hs[0] !== c.passHash) return Promise.reject(new Error('密码错误'));
        if (hs[1] !== c.accessKeyHash) return Promise.reject(new Error('访问密钥错误'));
        if (c.mfaEnabled && c.mfaSecret) {
          if (!mfaCode) return Promise.reject(new Error('MFA_REQUIRED'));
          return Mfa.verify(c.mfaSecret, mfaCode).then(function (ok) {
            if (!ok) return Promise.reject(new Error('MFA 验证码错误'));
            Store.json('adminSession', { user: c.user, loginAt: now(), lastAt: now() });
            return true;
          });
        }
        Store.json('adminSession', { user: c.user, loginAt: now(), lastAt: now() });
        return true;
      });
    },
    logout: function () { Store.del('adminSession'); },
    // 管理端会话空闲超时（网页保护：无操作 30 分钟自动登出）
    SESSION_TTL: 30 * 60 * 1000,
    sessionState: function () {
      var s = Store.json('adminSession');
      if (!s) return 'none';
      var last = s.lastAt || s.loginAt || 0;
      if (now() - last > Admin.SESSION_TTL) { Store.del('adminSession'); return 'expired'; }
      return 'active';
    },
    touchSession: function () {
      var s = Store.json('adminSession');
      if (s) { s.lastAt = now(); Store.json('adminSession', s); }
    },
    isLoggedIn: function () { return Admin.sessionState() === 'active'; },
    // 网站开关
    isSiteOpen: function () {
      var s = Store.json('siteStatus');
      return s ? s.open !== false : true; // 默认开启
    },
    setSiteOpen: function (open) {
      var msg = open ? '' : (Store.json('siteStatus') || {}).message || '网站正在维护升级中，暂不可用。';
      var st = { open: open, updatedAt: now(), message: msg };
      Store.json('siteStatus', st);
      /* BaaS 桥接优先推送，降级 GitHub 云仓 */
      if (global.QYBridge) global.QYBridge.pushConfig({ siteStatus: st }).then(function (r) {
        if (!r.ok && global.QYHub) global.QYHub.pushConfig({ siteStatus: st }).catch(function () {});
      });
      else if (global.QYHub) global.QYHub.pushConfig({ siteStatus: st }).catch(function () {});
    },
    setCloseMessage: function (msg) {
      var s = Store.json('siteStatus') || { open: true };
      s.message = msg;
      Store.json('siteStatus', s);
      if (global.QYBridge) global.QYBridge.pushConfig({ siteStatus: s }).then(function (r) {
        if (!r.ok && global.QYHub) global.QYHub.pushConfig({ siteStatus: s }).catch(function () {});
      });
      else if (global.QYHub) global.QYHub.pushConfig({ siteStatus: s }).catch(function () {});
    },
    getCloseMessage: function () {
      var s = Store.json('siteStatus');
      return s && s.message ? s.message : '网站正在维护升级中，暂不可用，请稍后再试。';
    },
    // 获取所有用户（经加密数据通道解密读取）
    getUsers: function () {
      return Channel.read('users').then(function (u) { return u || {}; });
    },
    // 获取活动日志（经加密数据通道解密读取）
    getWafLogs: function () { return Channel.read('wafLogs').then(function (l) { return l || []; }); }
  };

  /* ---------- UI 渲染 ---------- */
  var UI = {
    gateEl: null,
    _idleArmed: false,
    init: function () {
      var self = this;
      // 独立管理端网页模式（轻野-管理端.html）
      if (PAGE_MODE === 'admin') {
        self.initAdminPage();
        return;
      }
      // 用户端网页：不再提供任何管理端入口（管理端仅靠独立网址进入）
      // 检查网站状态
      if (!Admin.isSiteOpen()) {
        self.renderClosed();
        return;
      }
      // 检查已有会话
      if (Auth.current()) {
        self.unlock();
        return;
      }
      self.renderLogin();
    },
    // 独立管理端页面初始化：四因子验证 + 会话空闲自动锁定
    initAdminPage: function () {
      var self = this;
      var state = Admin.sessionState();
      if (state === 'active') {
        self.renderAdminPanel();
        self._armIdleGuard();
      } else {
        self.renderAdminLogin(state === 'expired' ? '会话已超时，为保护数据已自动登出，请重新验证' : '');
      }
    },
    // 管理端会话空闲保护：活动节流续期 + 定期检查自动登出
    _armIdleGuard: function () {
      var self = this;
      if (self._idleArmed) return;
      self._idleArmed = true;
      var lastTouch = 0;
      var touch = function () {
        if (Date.now() - lastTouch < 30000) return;
        lastTouch = Date.now();
        Admin.touchSession();
      };
      document.addEventListener('click', touch);
      document.addEventListener('keydown', touch);
      setInterval(function () {
        if (Admin.sessionState() === 'expired') {
          self._idleArmed = false;
          self.renderAdminLogin('会话已超时，为保护数据已自动登出，请重新验证');
        }
      }, 15000);
    },
    renderLogin: function () {
      var self = this;
      // 管理端页面的「返回登入」走管理端专属登入页
      if (PAGE_MODE === 'admin') { self.renderAdminLogin(); return; }
      self._ensureGate();
      self.gateEl.innerHTML = '';
      self._lockBody(true);

      var form = el('div', { id: 'csForm' });
      var box = el('div', { class: 'cs-box' }, [
        el('div', { class: 'cs-logo' }, ['🧭']),
        el('h1', { class: 'cs-title' }, ['轻野 · 云盾']),
        el('p', { class: 'cs-sub' }, ['轻装出发，慢看山河 · 加密守护每一段旅程']),
        form,
        el('div', { class: 'cs-footer' }, ['云盾 v' + CS_VERSION + ' · 设备证书 ' + Cert.fingerprint()])
      ]);
      self.gateEl.appendChild(box);
      self.renderUserForm(form);
    },
    // 独立管理端登入页（账号+密码+访问密钥+MFA 四因子）
    renderAdminLogin: function (notice) {
      var self = this;
      self._ensureGate();
      self.gateEl.innerHTML = '';
      self._lockBody(true);
      var form = el('div', { id: 'csForm' });
      var box = el('div', { class: 'cs-box' }, [
        el('div', { class: 'cs-logo' }, ['🧭']),
        el('h1', { class: 'cs-title' }, ['轻野 · 云盾 管理端']),
        el('p', { class: 'cs-sub' }, ['独立加密页面 · 四因子守护每一段旅程']),
        notice ? el('p', { class: 'cs-msg cs-msg-error', style: 'margin-bottom:8px' }, [notice]) : null,
        form,
        el('div', { class: 'cs-footer' }, ['云盾 v' + CS_VERSION + ' · 设备证书 ' + Cert.fingerprint()])
      ]);
      self.gateEl.appendChild(box);
      self.renderAdminForm(form);
    },
    renderUserForm: function (form) {
      var self = this;
      var emailInput = el('input', { type: 'email', placeholder: '请输入邮箱', id: 'csEmail' });
      var codeInput = el('input', { type: 'text', placeholder: '6 位验证码', maxlength: '6', id: 'csCode' });
      var sendBtn = el('button', { class: 'cs-btn cs-btn-outline', id: 'csSend' }, ['获取验证码']);
      var loginBtn = el('button', { class: 'cs-btn cs-btn-primary', id: 'csUserLoginBtn' }, ['登入 / 注册']);
      var msg = el('div', { class: 'cs-msg', id: 'csMsg' });

      sendBtn.onclick = function () {
        if (sendBtn.disabled) return;
        var email = emailInput.value.trim();
        sendBtn.disabled = true;
        sendBtn.textContent = '发送中…';
        msg.className = 'cs-msg';
        msg.textContent = '';
        Auth.sendCode(email).then(function (res) {
          if (res && res.cloud) {
            msg.textContent = '📧 验证码已发送至邮箱，请查收（含垃圾邮件），24 小时内有效。请勿点击邮件内链接，否则验证码会失效。';
          } else {
            msg.textContent = '验证码已发送：' + (res && res.code) + '（演示模式：认证服务不可达，验证码直接展示）';
          }
          msg.className = 'cs-msg cs-msg-info';
          var sec = 60;
          sendBtn.textContent = sec + 's 后重发';
          var t = setInterval(function () {
            sendBtn.textContent = sec + 's 后重发';
            if (--sec < 0) { clearInterval(t); sendBtn.disabled = false; sendBtn.textContent = '获取验证码'; }
          }, 1000);
        }).catch(function (e) {
          sendBtn.disabled = false;
          sendBtn.textContent = '获取验证码';
          msg.textContent = e.message;
          msg.className = 'cs-msg cs-msg-error';
        });
      };

      var submit = function () {
        if (loginBtn.disabled) return;
        loginBtn.disabled = true;
        loginBtn.classList.add('cs-btn-loading');
        msg.className = 'cs-msg';
        msg.textContent = '';
        var email = emailInput.value.trim();
        var code = codeInput.value.trim();
        Auth.login(email, code).then(function () {
          self.unlock();
        }).catch(function (e) {
          loginBtn.disabled = false;
          loginBtn.classList.remove('cs-btn-loading');
          msg.textContent = e.message;
          msg.className = 'cs-msg cs-msg-error';
        });
      };
      loginBtn.onclick = submit;
      [emailInput, codeInput].forEach(function (inp) {
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      });

      form.appendChild(el('div', { class: 'cs-row' }, [emailInput]));
      form.appendChild(el('div', { class: 'cs-row cs-row-2' }, [codeInput, sendBtn]));
      form.appendChild(el('div', { class: 'cs-row' }, [loginBtn]));
      form.appendChild(msg);
    },
    renderAdminForm: function (form) {
      var self = this;
      var userInput = el('input', { type: 'text', placeholder: '管理员账号', id: 'csAdmUser', value: 'admin' });
      var passInput = el('input', { type: 'password', placeholder: '管理员密码', id: 'csAdmPass' });
      var keyInput = el('input', { type: 'password', placeholder: '访问密钥', id: 'csAdmKey' });
      var mfaInput = el('input', { type: 'text', placeholder: 'MFA 动态码（如已绑定）', maxlength: '6', id: 'csAdmMfa' });
      var loginBtn = el('button', { class: 'cs-btn cs-btn-primary', id: 'csAdmLoginBtn' }, ['进入管理端']);
      var msg = el('div', { class: 'cs-msg', id: 'csMsg' });
      var vpnNote = el('div', { class: 'cs-vpn-note' }, ['⚠️ 管理端建议通过 VPN 访问，并启用 MFA 二次验证；访问密钥默认 cs-key-2024']);

      var submit = function () {
        if (loginBtn.disabled) return;
        loginBtn.disabled = true;
        loginBtn.classList.add('cs-btn-loading');
        msg.className = 'cs-msg';
        msg.textContent = '';
        Admin.login(userInput.value.trim(), passInput.value, keyInput.value, mfaInput.value.trim() || undefined).then(function () {
          self.renderAdminPanel();
          self._armIdleGuard();
        }).catch(function (e) {
          loginBtn.disabled = false;
          loginBtn.classList.remove('cs-btn-loading');
          if (e.message === 'MFA_REQUIRED') { msg.textContent = '请输入 MFA 动态码'; mfaInput.focus(); }
          else msg.textContent = e.message;
          msg.className = 'cs-msg cs-msg-error';
        });
      };
      loginBtn.onclick = submit;
      [userInput, passInput, keyInput, mfaInput].forEach(function (inp) {
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      });

      form.appendChild(vpnNote);
      form.appendChild(el('div', { class: 'cs-row' }, [userInput]));
      form.appendChild(el('div', { class: 'cs-row' }, [passInput]));
      form.appendChild(el('div', { class: 'cs-row' }, [keyInput]));
      form.appendChild(el('div', { class: 'cs-row' }, [mfaInput]));
      form.appendChild(el('div', { class: 'cs-row' }, [loginBtn]));
      form.appendChild(msg);
    },
    renderAdminPanel: function () {
      var self = this;
      self._ensureGate();
      self.gateEl.innerHTML = '';
      self._lockBody(true);
      // 数据通道为密文：先解密再在内存中渲染面板
      self.gateEl.appendChild(el('div', { class: 'cs-box' }, [
        el('div', { class: 'cs-logo' }, ['🔐']),
        el('p', { class: 'cs-sub' }, ['正在解密加密数据通道…'])
      ]));
      Promise.all([Admin.getUsers(), Admin.getWafLogs()]).then(function (res) {
        if (!self.gateEl) return;
        var users = res[0] || {};
        var wafLogs = res[1] || [];
        var userList = Object.keys(users);
        var siteOpen = Admin.isSiteOpen();

        var header = el('div', { class: 'cs-admin-head' }, [
          el('div', { class: 'cs-admin-title' }, ['🛡️ 管理控制台']),
          el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', onclick: function () { Admin.logout(); self.renderLogin(); } }, ['退出'])
        ]);

      // 网站开关
      var toggleBtn = el('button', {
        class: 'cs-btn ' + (siteOpen ? 'cs-btn-danger' : 'cs-btn-primary'),
        onclick: function () {
          Admin.setSiteOpen(!Admin.isSiteOpen());
          self.renderAdminPanel();
        }
      }, [siteOpen ? '🔴 关闭网站' : '🟢 开启网站']);

      var msgInput = el('input', { type: 'text', placeholder: '关闭时的提示语', value: Admin.getCloseMessage(), id: 'csCloseMsg' });
      var saveMsgBtn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', onclick: function () { Admin.setCloseMessage(msgInput.value); alert('提示语已保存'); } }, ['保存提示语']);

      var siteCard = el('div', { class: 'cs-card' }, [
        el('h3', {}, ['网站状态']),
        el('p', { class: 'cs-meta' }, ['当前状态：' + (siteOpen ? '🟢 正常开放' : '🔴 已关闭')]),
        el('div', { class: 'cs-row cs-row-2' }, [toggleBtn, el('span', {})]),
        el('div', { class: 'cs-row cs-row-2' }, [msgInput, saveMsgBtn])
      ]);

      // 用户列表
      var userRows = userList.map(function (p) {
        var u = users[p];
        var lastLogin = u.logins && u.logins[0] ? u.logins[0] : null;
        var locStr = lastLogin && lastLogin.loc ? (lastLogin.loc.city || lastLogin.loc.region || lastLogin.loc.country || '未知') : '未知';
        var ipStr = lastLogin && lastLogin.loc ? lastLogin.loc.ip : '-';
        return el('tr', {}, [
          el('td', {}, [u.phone]),
          el('td', {}, [u.mfaEnabled ? '✅' : '—']),
          el('td', {}, [locStr]),
          el('td', {}, [ipStr]),
          el('td', {}, [lastLogin ? new Date(lastLogin.t).toLocaleString() : '—']),
          el('td', {}, [String(u.logins ? u.logins.length : 0)])
        ]);
      });

      var userCard = el('div', { class: 'cs-card' }, [
        el('h3', {}, ['用户列表 (' + userList.length + ')']),
        el('table', { class: 'cs-table' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', {}, ['账号（邮箱）']), el('th', {}, ['MFA']), el('th', {}, ['最近登入位置']),
            el('th', {}, ['IP']), el('th', {}, ['最近登入时间']), el('th', {}, ['登入次数'])
          ])]),
          el('tbody', {}, userRows.length ? userRows : [el('tr', {}, [el('td', { colspan: '6', style: 'text-align:center;padding:20px;color:#94a3b8' }, ['暂无用户'])])])
        ])
      ]);

      // WAF 攻击日志
      var wafRows = wafLogs.slice(0, 20).map(function (l) {
        return el('tr', {}, [
          el('td', {}, [new Date(l.t).toLocaleString()]),
          el('td', {}, [l.reason]),
          el('td', {}, [l.input]),
          el('td', {}, [l.fp])
        ]);
      });

      var wafCard = el('div', { class: 'cs-card' }, [
        el('h3', {}, ['WAF 拦截日志 (' + wafLogs.length + ')']),
        el('table', { class: 'cs-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', {}, ['时间']), el('th', {}, ['原因']), el('th', {}, ['内容']), el('th', {}, ['设备指纹'])])]),
          el('tbody', {}, wafRows.length ? wafRows : [el('tr', {}, [el('td', { colspan: '4', style: 'text-align:center;padding:20px;color:#94a3b8' }, ['暂无拦截记录'])])])
        ])
      ]);

      // 管理员安全设置
      var c = Admin.creds();
      var mfaCard = el('div', { class: 'cs-card' }, [
        el('h3', {}, ['管理员安全']),
        el('p', { class: 'cs-meta' }, ['MFA 状态：' + (c.mfaEnabled ? '✅ 已启用' : '❌ 未启用') + '　|　访问密钥：' + (c.accessKeyHash ? '✅ 已设置' : '⚠️ 使用默认密钥')]),
        el('div', { class: 'cs-row cs-row-2' }, [
          el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', onclick: function () { self.renderAdminMfaSetup(); } }, [c.mfaEnabled ? '重新绑定 MFA' : '绑定 MFA']),
          el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', onclick: function () { self.renderAdminPassSetup(); } }, ['修改密码']),
          el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', onclick: function () { self.renderAdminKeySetup(); } }, ['修改访问密钥'])
        ])
      ]);

      var backBtn = el('button', { class: 'cs-btn cs-btn-primary', onclick: function () { self.renderLogin(); } }, ['返回登入']);

        self.gateEl.innerHTML = '';
        var dnCards = [header, siteCard, userCard, wafCard, mfaCard];
        /* BaaS 桥接配置卡（mfaCard 后） */
        if (window.QYBridge && typeof window.QYBridge.renderAdminCard === 'function') {
          var bridgeCard = el('div', { class: 'cs-card' });
          dnCards.push(bridgeCard);
          window.QYBridge.renderAdminCard(bridgeCard);
        }
        /* GitHub 云仓配置卡（降级备选） */
        if (window.QYHub && typeof window.QYHub.renderAdminCard === 'function') {
          var hubCard = el('div', { class: 'cs-card' });
          dnCards.push(hubCard);
          window.QYHub.renderAdminCard(hubCard);
        }
        if (window.QYDonation && typeof window.QYDonation.renderAdminCard === 'function') {
          var donationCard = el('div', { class: 'cs-card' });
          dnCards.push(donationCard);
          window.QYDonation.renderAdminCard(donationCard);
        }
        dnCards.push(backBtn);
        self.gateEl.appendChild(el('div', { class: 'cs-box cs-box-wide' }, dnCards));
      }).catch(function () {
        // 通道解密异常：安全起见登出并回到验证页
        Admin.logout();
        self.renderAdminLogin('加密数据通道解密失败，请重新验证');
      });
    },
    renderAdminKeySetup: function () {
      var self = this;
      var oldInput = el('input', { type: 'password', placeholder: '原访问密钥', id: 'csOldKey' });
      var newInput = el('input', { type: 'password', placeholder: '新访问密钥（至少6位）', id: 'csNewKey' });
      var confirmInput = el('input', { type: 'password', placeholder: '确认新密钥', id: 'csNewKey2' });
      var msg = el('div', { class: 'cs-msg' });

      var box = el('div', { class: 'cs-box' }, [
        el('h2', { class: 'cs-title' }, ['修改访问密钥']),
        el('p', { class: 'cs-sub' }, ['密钥用于管理端登入验证，修改后下次登入生效']),
        el('div', { class: 'cs-row' }, [oldInput]),
        el('div', { class: 'cs-row' }, [newInput]),
        el('div', { class: 'cs-row' }, [confirmInput]),
        msg,
        el('div', { class: 'cs-row cs-row-2' }, [
          el('button', { class: 'cs-btn cs-btn-primary', onclick: function () {
            var oldK = oldInput.value, newK = newInput.value, newK2 = confirmInput.value;
            if (!oldK || !newK || !newK2) { msg.textContent = '请填写所有字段'; msg.className = 'cs-msg cs-msg-error'; return; }
            if (newK.length < 6) { msg.textContent = '新密钥至少 6 位'; msg.className = 'cs-msg cs-msg-error'; return; }
            if (newK !== newK2) { msg.textContent = '两次输入的新密钥不一致'; msg.className = 'cs-msg cs-msg-error'; return; }
            // 验证旧密钥
            var c = Admin.creds();
            Crypto.hash(oldK).then(function (h) {
              if (h !== c.accessKeyHash) { msg.textContent = '原密钥错误'; msg.className = 'cs-msg cs-msg-error'; return; }
              // 二次确认弹窗
              var panel = el('div', { class: 'cs-overlay', onclick: function (e) { if (e.target === panel) panel.remove(); } }, [
                el('div', { class: 'cs-modal' }, [
                  el('h3', {}, ['⚠️ 二次确认']),
                  el('p', { class: 'cs-meta' }, ['即将修改管理端访问密钥。修改后原密钥立即失效，下次登入需使用新密钥，请牢记新密钥。']),
                  el('p', { class: 'cs-meta' }, ['新密钥：' + newK]),
                  el('div', { class: 'cs-row cs-row-2', style: 'margin-top:16px' }, [
                    el('button', { class: 'cs-btn cs-btn-danger', onclick: function () {
                      panel.remove();
                      Admin.setAccessKey(newK).then(function (ok) {
                        if (ok) { alert('访问密钥修改成功'); self.renderAdminPanel(); }
                      });
                    } }, ['确认修改']),
                    el('button', { class: 'cs-btn cs-btn-outline', onclick: function () { panel.remove(); } }, ['再想想'])
                  ])
                ])
              ]);
              document.body.appendChild(panel);
            });
          } }, ['确认修改']),
          el('button', { class: 'cs-btn cs-btn-outline', onclick: function () { self.renderAdminPanel(); } }, ['取消'])
        ])
      ]);
      self._ensureGate();
      self.gateEl.innerHTML = '';
      self.gateEl.appendChild(box);
    },
    renderAdminPassSetup: function () {
      var self = this;
      var oldInput = el('input', { type: 'password', placeholder: '原密码', id: 'csOldPass' });
      var newInput = el('input', { type: 'password', placeholder: '新密码（至少6位）', id: 'csNewPass' });
      var confirmInput = el('input', { type: 'password', placeholder: '确认新密码', id: 'csNewPass2' });
      var msg = el('div', { class: 'cs-msg' });

      var box = el('div', { class: 'cs-box' }, [
        el('h2', { class: 'cs-title' }, ['修改密码']),
        el('p', { class: 'cs-sub' }, ['密码用于管理端登入验证，修改后下次登入生效']),
        el('div', { class: 'cs-row' }, [oldInput]),
        el('div', { class: 'cs-row' }, [newInput]),
        el('div', { class: 'cs-row' }, [confirmInput]),
        msg,
        el('div', { class: 'cs-row cs-row-2' }, [
          el('button', { class: 'cs-btn cs-btn-primary', onclick: function () {
            var oldP = oldInput.value, newP = newInput.value, newP2 = confirmInput.value;
            if (!oldP || !newP || !newP2) { msg.textContent = '请填写所有字段'; msg.className = 'cs-msg cs-msg-error'; return; }
            if (newP.length < 6) { msg.textContent = '新密码至少 6 位'; msg.className = 'cs-msg cs-msg-error'; return; }
            if (newP !== newP2) { msg.textContent = '两次输入的新密码不一致'; msg.className = 'cs-msg cs-msg-error'; return; }
            var c = Admin.creds();
            Crypto.hash(oldP).then(function (h) {
              if (h !== c.passHash) { msg.textContent = '原密码错误'; msg.className = 'cs-msg cs-msg-error'; return; }
              var panel = el('div', { class: 'cs-overlay', onclick: function (e) { if (e.target === panel) panel.remove(); } }, [
                el('div', { class: 'cs-modal' }, [
                  el('h3', {}, ['⚠️ 二次确认']),
                  el('p', { class: 'cs-meta' }, ['即将修改管理端密码。修改后原密码立即失效，下次登入需使用新密码，请牢记新密码。']),
                  el('p', { class: 'cs-meta' }, ['新密码：' + newP]),
                  el('div', { class: 'cs-row cs-row-2', style: 'margin-top:16px' }, [
                    el('button', { class: 'cs-btn cs-btn-danger', onclick: function () {
                      panel.remove();
                      Admin.setPassword(newP).then(function (ok) {
                        if (ok) { alert('密码修改成功'); self.renderAdminPanel(); }
                      });
                    } }, ['确认修改']),
                    el('button', { class: 'cs-btn cs-btn-outline', onclick: function () { panel.remove(); } }, ['再想想'])
                  ])
                ])
              ]);
              document.body.appendChild(panel);
            });
          } }, ['确认修改']),
          el('button', { class: 'cs-btn cs-btn-outline', onclick: function () { self.renderAdminPanel(); } }, ['取消'])
        ])
      ]);
      self._ensureGate();
      self.gateEl.innerHTML = '';
      self.gateEl.appendChild(box);
    },
    renderAdminMfaSetup: function () {
      var self = this;
      var secret = Mfa.generateSecret();
      var uri = Mfa.otpauthUri(secret, 'admin', '轻野云盾');
      var qr = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(uri);

      var box = el('div', { class: 'cs-box' }, [
        el('h2', { class: 'cs-title' }, ['绑定 MFA']),
        el('p', { class: 'cs-sub' }, ['使用 Google Authenticator / 微软身份验证器 扫描二维码']),
        el('img', { src: qr, style: 'display:block;margin:12px auto;border:1px solid #e2e8f0;border-radius:12px' }),
        el('p', { class: 'cs-meta' }, ['密钥：' + secret]),
        el('input', { type: 'text', placeholder: '输入 6 位动态码验证', id: 'csAdmMfaBind', maxlength: '6', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:12px 0' }),
        el('button', { class: 'cs-btn cs-btn-primary', onclick: function () {
          var code = $('csAdmMfaBind').value.trim();
          Mfa.verify(secret, code).then(function (ok) {
            if (!ok) { alert('动态码错误'); return; }
            var c = Admin.creds();
            c.mfaSecret = secret; c.mfaEnabled = true;
            Store.json('adminCred', c);
            alert('MFA 绑定成功');
            self.renderAdminPanel();
          });
        } }, ['确认绑定']),
        el('button', { class: 'cs-btn cs-btn-outline', onclick: function () { self.renderAdminPanel(); } }, ['取消'])
      ]);
      self._ensureGate();
      self.gateEl.innerHTML = '';
      self.gateEl.appendChild(box);
    },
    renderClosed: function () {
      var self = this;
      self._ensureGate();
      self.gateEl.innerHTML = '';
      self._lockBody(true);
      var msg = Admin.getCloseMessage();
      self.gateEl.appendChild(el('div', { class: 'cs-box cs-closed' }, [
        el('div', { class: 'cs-logo' }, ['🚧']),
        el('h1', { class: 'cs-title' }, ['网站维护中']),
        el('p', { class: 'cs-sub' }, [msg]),
        el('p', { class: 'cs-meta' }, ['请稍后再试，或联系管理员'])
      ]));
    },
    unlock: function () {
      var self = this;
      // 先解锁 body（触发 gate 淡出动画），动画结束后清空 gate
      self._lockBody(false);
      self.injectUserBar();
      if (self.gateEl) {
        setTimeout(function () {
          if (self.gateEl) self.gateEl.innerHTML = '';
        }, 320);
      }
    },
    injectUserBar: function () {
      var s = Auth.current();
      if (!s) return;
      // 移除已有
      var old = $('csUserBar');
      if (old) old.remove();
      var bar = el('div', { id: 'csUserBar', class: 'cs-userbar' }, [
        el('span', {}, ['🛡️ 云盾已加密 · ' + (String(s.phone).indexOf('@') > -1 ? String(s.phone).replace(/(^.).*(@.*)$/, '$1***$2') : String(s.phone).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'))]),
        el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', onclick: function () { UI.renderCloudPanel(); } }, ['☁️ 云端']),
        el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', onclick: function () {
          if (confirm('确定退出登入？')) { Auth.logout(); var b = $('csUserBar'); if (b) b.remove(); UI.renderLogin(); }
        } }, ['退出'])
      ]);
      document.body.insertBefore(bar, document.body.firstChild);
    },
    renderCloudPanel: function () {
      var s = Auth.current();
      if (!s) return;
      var mk = prompt('请输入云存储主密钥（用于加密您的数据）：\n（如遗忘将无法恢复数据）');
      if (!mk) return;
      var panel = el('div', { class: 'cs-overlay', onclick: function (e) { if (e.target === panel) panel.remove(); } }, [
        el('div', { class: 'cs-modal' }, [
          el('h3', {}, ['☁️ 云端储存']),
          el('p', { class: 'cs-meta' }, ['数据使用 AES-256-GCM 加密，密钥由您的主密钥派生']),
          el('button', { class: 'cs-btn cs-btn-primary', onclick: function () {
            // 保存当前表单数据
            var form = {};
            document.querySelectorAll('input, select').forEach(function (el) {
              if (el.id) form[el.id] = el.type === 'checkbox' ? el.checked : el.value;
            });
            Cloud.save(s.phone, { form: form, savedAt: now() }, mk).then(function () {
              alert('已保存到加密云端');
              panel.remove();
            }).catch(function (e) { alert('保存失败：' + e.message); });
          } }, ['保存当前数据到云端']),
          el('button', { class: 'cs-btn cs-btn-outline', onclick: function () {
            Cloud.load(s.phone, mk).then(function (data) {
              if (!data) { alert('云端无数据'); return; }
              if (data.form) {
                Object.keys(data.form).forEach(function (id) {
                  var el2 = document.getElementById(id);
                  if (el2) {
                    if (el2.type === 'checkbox') el2.checked = data.form[id];
                    else el2.value = data.form[id];
                    el2.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                });
              }
              alert('云端数据已恢复');
              panel.remove();
            }).catch(function (e) { alert('恢复失败（密钥错误或数据损坏）：' + e.message); });
          } }, ['从云端恢复数据']),
          el('button', { class: 'cs-btn cs-btn-outline', onclick: function () {
            var blob = new Blob([Cloud.exportBackup()], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = '轻野云盾备份_' + new Date().toISOString().slice(0, 10) + '.json';
            a.click(); URL.revokeObjectURL(url);
          } }, ['导出加密备份']),
          el('button', { class: 'cs-btn cs-btn-outline', onclick: function () {
            var inp = document.createElement('input');
            inp.type = 'file'; inp.accept = '.json';
            inp.onchange = function (e) {
              var f = e.target.files[0];
              var r = new FileReader();
              r.onload = function () {
                try {
                  var n = Cloud.importBackup(r.result);
                  alert('已导入 ' + n + ' 个用户的备份');
                  panel.remove();
                } catch (err) { alert('导入失败：' + err.message); }
              };
              r.readAsText(f);
            };
            inp.click();
          } }, ['导入加密备份']),
          el('button', { class: 'cs-btn cs-btn-outline', onclick: function () { panel.remove(); } }, ['关闭'])
        ])
      ]);
      document.body.appendChild(panel);
    },
    _ensureGate: function () {
      if (!this.gateEl) {
        this.gateEl = $('csGate');
        if (!this.gateEl) {
          this.gateEl = el('div', { id: 'csGate', class: 'cs-gate' });
          document.body.insertBefore(this.gateEl, document.body.firstChild);
        } else if ((' ' + this.gateEl.className + ' ').indexOf(' cs-gate ') < 0) {
          // 复用页面静态 #csGate 时补回 class，使 .cs-gate 定位/居中/背景样式生效
          this.gateEl.className = (this.gateEl.className + ' cs-gate').trim();
        }
      }
    },
    _lockBody: function (lock) {
      // 隐藏非 gate 的内容
      document.body.classList.toggle('cs-locked', lock);
    }
  };

  /* ---------- 样式注入 ---------- */
  function injectStyles() {
    var css = [
      '.cs-gate{position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#c9d6c9 0%,#e6dcc8 45%,#d4b896 100%);font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;opacity:0;animation:csGateIn .55s cubic-bezier(.22,1,.36,1) forwards;overflow:hidden}',
      '.cs-gate::before{content:"";position:absolute;inset:-10%;background:radial-gradient(circle at 30% 20%,rgba(255,255,255,.28),transparent 55%),radial-gradient(circle at 75% 80%,rgba(212,184,150,.2),transparent 55%);animation:csBreathe 14s ease-in-out infinite alternate;pointer-events:none}',
      '@keyframes csBreathe{from{transform:translate(-1.5%,0) scale(1)}to{transform:translate(1.5%,0) scale(1.04)}}',
      '@keyframes csGateIn{from{opacity:0}to{opacity:1}}',
      '@keyframes csBoxIn{from{opacity:0;transform:translateY(20px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '@keyframes csFadeIn{from{opacity:0}to{opacity:1}}',
      '@keyframes csModalIn{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}',
      'body.cs-locked>*:not(#csGate):not(#csUserBar){display:none!important}',
      'body:not(.cs-locked) #csGate{animation:csGateOut .35s cubic-bezier(.4,0,.2,1) forwards}',
      '@keyframes csGateOut{from{opacity:1}to{opacity:0;visibility:hidden}}',
      '.cs-box{background:rgba(255,255,255,0.82);backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2);border:1px solid rgba(255,255,255,0.6);border-radius:22px;padding:38px 32px;max-width:420px;width:90%;box-shadow:0 20px 50px rgba(61,79,61,.18),0 4px 12px rgba(61,79,61,.08);text-align:center;animation:csBoxIn .55s cubic-bezier(.22,1,.36,1) both}',
      '.cs-box-wide{max-width:820px;text-align:left;max-height:90vh;overflow-y:auto}',
      '.cs-logo{font-size:48px;margin-bottom:8px;filter:drop-shadow(0 2px 4px rgba(61,79,61,.15))}',
      '.cs-title{font-size:24px;font-weight:800;color:#3d4f3d;margin-bottom:4px}',
      '.cs-sub{font-size:13px;color:#6b7a6b;margin-bottom:24px;letter-spacing:.02em}',
      '.cs-tabs{display:flex;background:rgba(255,255,255,0.45);border-radius:12px;padding:4px;margin-bottom:20px;gap:4px}',
      '.cs-tab{flex:1;border:0;background:transparent;padding:10px;border-radius:9px;font-size:13px;font-weight:600;color:#6b7a6b;cursor:pointer;transition:all .2s ease}',
      '.cs-tab.on{background:#fff;color:#5b8c7a;box-shadow:0 1px 3px rgba(91,140,122,.15)}',
      '#csForm{animation:csFadeIn .3s ease both}',
      '.cs-row{margin-bottom:12px;display:flex;gap:8px}',
      '.cs-row-2>*{flex:1}',
      '.cs-row input{flex:1;padding:12px 14px;border:1px solid #d4cdb8;border-radius:10px;font-size:14px;background:rgba(255,255,255,0.55);outline:none;transition:border-color .2s,background .2s,box-shadow .2s}',
      '.cs-row input:focus{border-color:#5b8c7a;background:rgba(255,255,255,0.85);box-shadow:0 0 0 3px rgba(91,140,122,.18)}',
      '.cs-btn{border:0;border-radius:10px;padding:11px 18px;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s ease;width:100%}',
      '.cs-btn:active{transform:scale(.97)}',
      '.cs-btn:disabled{opacity:.6;cursor:not-allowed;transform:none}',
      '.cs-btn-sm{padding:7px 12px;font-size:12px;width:auto}',
      '.cs-btn-primary{background:#5b8c7a;color:#fff}',
      '.cs-btn-primary:hover:not(:disabled){background:#4a7a68}',
      '.cs-btn-outline{background:rgba(255,255,255,0.5);color:#6b7a6b;border:1px solid #d4cdb8}',
      '.cs-btn-outline:hover:not(:disabled){background:rgba(255,255,255,0.75)}',
      '.cs-btn-danger{background:#c0656f;color:#fff}',
      '.cs-btn-danger:hover:not(:disabled){background:#a8525c}',
      '.cs-btn-loading{position:relative;color:transparent!important}',
      '.cs-btn-loading::after{content:"";position:absolute;left:50%;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:csSpin .6s linear infinite}',
      '@keyframes csSpin{to{transform:rotate(360deg)}}',
      '.cs-msg{font-size:12px;margin-top:8px;min-height:18px;text-align:left;transition:color .2s}',
      '.cs-msg-info{color:#5b8794}',
      '.cs-msg-error{color:#c0656f;animation:csShake .3s ease}',
      '@keyframes csShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}',
      '.cs-footer{margin-top:20px;font-size:11px;color:#9a8f7a}',
      '.cs-vpn-note{background:#fdf3dc;border:1px solid #ecd9a8;color:#8a6d3b;padding:10px 12px;border-radius:10px;font-size:12px;margin-bottom:16px;text-align:left}',
      '.cs-admin-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}',
      '.cs-admin-title{font-size:20px;font-weight:800}',
      '.cs-card{background:rgba(255,255,255,0.6);border:1px solid #d4cdb8;border-radius:14px;padding:18px;margin-bottom:16px;animation:csFadeIn .3s ease both}',
      '.cs-card h3{font-size:14px;font-weight:700;margin-bottom:12px}',
      '.cs-meta{font-size:12px;color:#6b7a6b;margin-bottom:10px}',
      '.cs-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.cs-table th,.cs-table td{padding:8px 10px;text-align:left;border-bottom:1px solid #e0d8c4}',
      '.cs-table th{background:rgba(255,255,255,0.5);font-weight:600;color:#6b7a6b}',
      '.cs-closed{text-align:center}',
      '.cs-userbar{position:sticky;top:0;z-index:10000;background:#2d3f2d;color:#fff;padding:8px 16px;display:flex;align-items:center;gap:10px;font-size:12px;flex-wrap:wrap;animation:csFadeIn .3s ease both}',
      '.cs-userbar .cs-btn{background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.22)}',
      '.cs-userbar .cs-btn:hover:not(:disabled){background:rgba(255,255,255,.24)}',
      '.cs-overlay{position:fixed;inset:0;z-index:999998;background:rgba(61,79,61,.5);display:flex;align-items:center;justify-content:center;padding:20px;animation:csFadeIn .2s ease both}',
      '.cs-modal{background:rgba(255,255,255,0.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.6);border-radius:18px;padding:28px;max-width:460px;width:100%;box-shadow:0 20px 50px rgba(61,79,61,.2);animation:csModalIn .3s cubic-bezier(.22,1,.36,1) both}',
      '.cs-modal h3{font-size:18px;font-weight:800;margin-bottom:12px}',
      '.cs-modal .cs-btn{margin-bottom:10px}',
      '@media(max-width:480px){.cs-box{padding:24px 18px}.cs-title{font-size:20px}}',
      '@media (prefers-reduced-motion: reduce){.cs-gate,.cs-gate::before,.cs-box,.cs-card,.cs-userbar,.cs-overlay,.cs-modal,#csForm,.cs-msg-error{animation:none!important}*,.cs-btn{transition:none!important}}'
    ].join('');
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ---------- 启动 ---------- */
  function boot() {
    injectStyles();
    // 检查 crypto 支持
    if (!global.crypto || !crypto.subtle) {
      alert('当前浏览器不支持 Web Crypto API，云盾安全模块无法运行。\n请使用现代浏览器（Chrome/Edge/Firefox 最新版）。');
      return;
    }
    UI.init();
  }

  // 暴露 API
  global.CloudShield = {
    Auth: Auth, Admin: Admin, Crypto: Crypto, Mfa: Mfa, Cloud: Cloud, Waf: Waf, RateLimit: RateLimit, Cert: Cert, Channel: Channel, UI: UI, Store: Store,
    version: CS_VERSION, pageMode: PAGE_MODE
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window);
