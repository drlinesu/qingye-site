﻿﻿﻿/* ============================================================
 * 轻野 · 云仓 (Light Wild · Cloud Hub)
 * GitHub 配置同步模块 —— 零侵入：不修改 轻野.html 的任何计算与渲染逻辑。
 *   ① 管理端：在 云盾 管理控制台注入「GitHub 配置」卡片
 *             填写 owner/repo/branch/path/token，token 经 AES-256-GCM 加密存本机
 *             改网站开关/关闭提示语/捐赠金额时自动推送 config.json 到 GitHub
 *   ② 用户端：启动时拉取 GitHub config.json 覆盖本机配置，实现全网统一
 *             GitHub 不可达时降级本机 localStorage 缓存
 * 读取：raw.githubusercontent.com（实时） → jsDelivr CDN（降级） → 本机缓存 → 默认值
 * ============================================================ */
(function (global) {
  'use strict';
  if (global.QYHub) return;

  var STORE_PREFIX = 'cs_';
  var SETTINGS_KEY = 'hubSettings';   /* 明文 Store：owner/repo/branch/path（非敏感） */
  var TOKEN_KEY = 'hubToken';          /* Channel 加密：token（敏感） */
  var CACHE_KEY = 'hubCache';          /* 明文 Store：config.json 缓存 */
  var CACHE_TTL = 5 * 60 * 1000;       /* 5 分钟 */

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

  /* UTF-8 安全的 base64 编解码 */
  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToUtf8(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---------- Hub 模块 ---------- */
  var Hub = {
    /* 读取仓库信息（明文，同步） — 用户端构建 raw URL 用 */
    getRepoInfo: function () {
      try {
        var raw = localStorage.getItem(STORAGE_PREFIX + SETTINGS_KEY);
        if (raw) {
          var s = JSON.parse(raw);
          if (s && s.owner && s.repo) return s;
        }
      } catch (e) {}
      return null;
    },

    /* 读取完整设置（含 token，异步解密） — 管理端 push 用 */
    getSettings: function () {
      var self = this;
      var info = self.getRepoInfo() || { owner: '', repo: '', branch: 'main', path: 'config.json' };
      return global.CloudShield.Channel.read(TOKEN_KEY).then(function (token) {
        info.token = token || '';
        return info;
      }).catch(function () {
        info.token = '';
        return info;
      });
    },

    /* 保存设置（仓库信息→明文 Store，token→Channel 加密） */
    saveSettings: function (settings) {
      try {
        localStorage.setItem(STORAGE_PREFIX + SETTINGS_KEY, JSON.stringify({
          owner: settings.owner || '',
          repo: settings.repo || '',
          branch: settings.branch || 'main',
          path: settings.path || 'config.json'
        }));
      } catch (e) {}
      return global.CloudShield.Channel.write(TOKEN_KEY, settings.token || '').then(function () {
        return true;
      });
    },

    /* 构建 URL */
    _rawUrl: function (s) {
      return 'https://raw.githubusercontent.com/' + s.owner + '/' + s.repo + '/' + s.branch + '/' + s.path;
    },
    _jsdelivrUrl: function (s) {
      return 'https://cdn.jsdelivr.net/gh/' + s.owner + '/' + s.repo + '@' + s.branch + '/' + s.path;
    },
    _apiUrl: function (s) {
      return 'https://api.github.com/repos/' + s.owner + '/' + s.repo + '/contents/' + s.path + '?ref=' + s.branch;
    },

    /* 读取 GitHub 配置（用户端，无 token） */
    getConfig: function () {
      var self = this;
      var info = self.getRepoInfo();
      if (!info) return Promise.resolve(null);

      var cached = self._readCache();

      /* 尝试 raw.githubusercontent.com（实时） */
      return fetch(self._rawUrl(info), { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('raw ' + r.status);
          return r.text();
        })
        .then(function (text) {
          var obj = JSON.parse(text);
          self._writeCache(obj);
          return obj;
        })
        .catch(function () {
          /* 降级 jsDelivr CDN */
          return fetch(self._jsdelivrUrl(info))
            .then(function (r) {
              if (!r.ok) throw new Error('jsDelivr ' + r.status);
              return r.text();
            })
            .then(function (text) {
              var obj = JSON.parse(text);
              self._writeCache(obj);
              return obj;
            });
        })
        .catch(function () {
          /* 降级本机缓存 */
          if (cached) return cached;
          return null;
        });
    },

    /* 推送配置到 GitHub（管理端，需 token） */
    pushConfig: function (partial) {
      var self = this;
      var mergedConfig = null;

      return self.getSettings().then(function (s) {
        if (!s.owner || !s.repo || !s.token) {
          return { ok: false, msg: '未配置 GitHub（需 owner/repo/token）' };
        }

        var headers = {
          'Accept': 'application/vnd.github+json',
          'Authorization': 'Bearer ' + s.token,
          'Content-Type': 'application/json'
        };

        /* 先 GET 获取 sha + 当前内容 */
        return fetch(self._apiUrl(s), { headers: headers })
          .then(function (r) {
            if (r.status === 404) return null;
            if (!r.ok) throw new Error('GET ' + r.status);
            return r.json();
          })
          .then(function (info) {
            /* 合并配置 */
            var current = {};
            if (info && info.content) {
              try { current = JSON.parse(b64ToUtf8(info.content.replace(/\n/g, ''))); } catch (e) {}
            }
            mergedConfig = {};
            var k;
            for (k in current) mergedConfig[k] = current[k];
            for (k in partial) mergedConfig[k] = partial[k];

            var body = {
              message: 'chore: sync config via 轻野·云仓',
              content: utf8ToB64(JSON.stringify(mergedConfig, null, 2)),
              branch: s.branch
            };
            if (info && info.sha) body.sha = info.sha;

            /* PUT 更新 */
            return fetch(self._apiUrl(s), {
              method: 'PUT',
              headers: headers,
              body: JSON.stringify(body)
            });
          })
          .then(function (r) {
            if (!r.ok) {
              return r.text().then(function (t) {
                var msg = 'PUT ' + r.status;
                try { var e = JSON.parse(t); if (e.message) msg = e.message; } catch (err) {}
                throw new Error(msg);
              });
            }
            return r.json();
          })
          .then(function () {
            self._writeCache(mergedConfig);
            return { ok: true, msg: '已同步到 GitHub' };
          });
      })
      .catch(function (e) {
        return { ok: false, msg: e.message || '推送失败' };
      });
    },

    /* 测试连接 */
    testConnection: function (settings) {
      var self = this;
      var s = settings;
      if (!s.owner || !s.repo) return Promise.resolve({ ok: false, msg: '请填写用户名和仓库名' });

      return fetch(self._rawUrl(s), { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('读取失败 ' + r.status);
          return r.text();
        })
        .then(function () {
          if (!s.token) return { ok: true, msg: '读取正常（未填 token，仅可读取）' };
          return fetch(self._apiUrl(s), {
            headers: {
              'Accept': 'application/vnd.github+json',
              'Authorization': 'Bearer ' + s.token
            }
          }).then(function (r) {
            if (r.status === 404) return { ok: true, msg: '读取正常，config.json 尚未创建（首次推送时自动创建）' };
            if (!r.ok) throw new Error('写入验证失败 ' + r.status);
            return { ok: true, msg: '连接正常，读写均可用' };
          });
        })
        .catch(function (e) {
          return { ok: false, msg: e.message || '连接失败' };
        });
    },

    /* 本机缓存读写 */
    _readCache: function () {
      try {
        var raw = localStorage.getItem(STORAGE_PREFIX + CACHE_KEY);
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

    /* 拉取 GitHub 配置覆盖本机（用户端启动时调用） */
    syncToLocal: function () {
      var self = this;
      return self.getConfig().then(function (cfg) {
        if (!cfg) return false;
        if (cfg.siteStatus) {
          global.CloudShield.Store.json('siteStatus', cfg.siteStatus);
        }
        if (cfg.announcement) {
          global.CloudShield.Store.json('announcement', cfg.announcement);
        }
        if (Array.isArray(cfg.donationAmounts)) {
          global.CloudShield.Channel.write('donationAmounts', cfg.donationAmounts).catch(function () {});
        }
        return true;
      }).catch(function () { return false; });
    },

    /* 管理端配置卡 */
    renderAdminCard: function (container) {
      var self = this;
      container.innerHTML = '';
      container.appendChild(el('h3', {}, ['☁️ GitHub 配置同步']));
      container.appendChild(el('p', { class: 'cs-meta' }, ['配置 GitHub 仓库实现全网统一配置。token 经 AES-256-GCM 加密存本机，不进源码。']));

      var ownerInput = el('input', { type: 'text', placeholder: 'GitHub 用户名', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:4px 0;box-sizing:border-box' });
      var repoInput = el('input', { type: 'text', placeholder: '仓库名（如 qingye-config）', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:4px 0;box-sizing:border-box' });
      var branchInput = el('input', { type: 'text', placeholder: '分支（默认 main）', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:4px 0;box-sizing:border-box' });
      var pathInput = el('input', { type: 'text', placeholder: '文件路径（默认 config.json）', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:4px 0;box-sizing:border-box' });
      var tokenInput = el('input', { type: 'password', placeholder: 'Personal Access Token（fine-grained, contents:write）', style: 'width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:4px 0;box-sizing:border-box' });

      var status = el('p', { class: 'cs-meta', style: 'color:#64748b' });
      var testBtn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', style: 'margin-right:8px' }, ['测试连接']);
      var saveBtn = el('button', { class: 'cs-btn cs-btn-primary cs-btn-sm' }, ['保存配置']);
      var syncBtn = el('button', { class: 'cs-btn cs-btn-outline cs-btn-sm', style: 'margin-left:8px' }, ['立即同步']);

      function loadSettings() {
        self.getSettings().then(function (s) {
          ownerInput.value = s.owner || '';
          repoInput.value = s.repo || '';
          branchInput.value = s.branch || 'main';
          pathInput.value = s.path || 'config.json';
          tokenInput.value = s.token || '';
          if (s.owner && s.repo) {
            status.style.color = '#16a34a';
            status.textContent = '已配置：' + s.owner + '/' + s.repo + ' @ ' + (s.branch || 'main');
          } else {
            status.style.color = '#64748b';
            status.textContent = '未配置 GitHub 仓库';
          }
        });
      }
      loadSettings();

      testBtn.addEventListener('click', function () {
        var st = {
          owner: ownerInput.value.trim(),
          repo: repoInput.value.trim(),
          branch: branchInput.value.trim() || 'main',
          path: pathInput.value.trim() || 'config.json',
          token: tokenInput.value.trim()
        };
        if (!st.owner || !st.repo) { status.style.color = '#dc2626'; status.textContent = '请填写用户名和仓库名'; return; }
        status.style.color = '#64748b';
        status.textContent = '测试中…';
        self.testConnection(st).then(function (r) {
          status.style.color = r.ok ? '#16a34a' : '#dc2626';
          status.textContent = (r.ok ? '✅ ' : '❌ ') + r.msg;
        });
      });

      saveBtn.addEventListener('click', function () {
        var st = {
          owner: ownerInput.value.trim(),
          repo: repoInput.value.trim(),
          branch: branchInput.value.trim() || 'main',
          path: pathInput.value.trim() || 'config.json',
          token: tokenInput.value.trim()
        };
        if (!st.owner || !st.repo) { status.style.color = '#dc2626'; status.textContent = '请填写用户名和仓库名'; return; }
        self.saveSettings(st).then(function () {
          status.style.color = '#16a34a';
          status.textContent = '✅ 配置已保存（token 已加密存储）';
          loadSettings();
        });
      });

      syncBtn.addEventListener('click', function () {
        status.style.color = '#64748b';
        status.textContent = '同步中…';
        var siteStatus = global.CloudShield.Store.json('siteStatus') || { open: true, message: '' };
        global.CloudShield.Channel.read('donationAmounts').then(function (arr) {
          var partial = {
            siteStatus: siteStatus,
            donationAmounts: Array.isArray(arr) ? arr : [5, 10, 20, 50]
          };
          return self.pushConfig(partial);
        }).then(function (r) {
          status.style.color = r.ok ? '#16a34a' : '#dc2626';
          status.textContent = (r.ok ? '✅ ' : '❌ ') + r.msg;
        });
      });

      container.appendChild(status);
      container.appendChild(el('div', { class: 'cs-row' }, [ownerInput]));
      container.appendChild(el('div', { class: 'cs-row' }, [repoInput]));
      container.appendChild(el('div', { class: 'cs-row' }, [branchInput]));
      container.appendChild(el('div', { class: 'cs-row' }, [pathInput]));
      container.appendChild(el('div', { class: 'cs-row' }, [tokenInput]));
      container.appendChild(el('div', { class: 'cs-row' }, [testBtn, saveBtn, syncBtn]));
      container.appendChild(el('p', { class: 'cs-meta', style: 'margin-top:8px' }, ['使用前需在 GitHub 新建 public 空仓库，并生成 fine-grained PAT（仅授予该仓库 contents:write）。']));
    }
  };

  global.QYHub = Hub;

  /* 后端访问最小化：用户端启动不再自动拉取 GitHub 配置，
     仅在捐赠场景由 QYDonation 按需读取；管理端不受影响。 */
})(window);
