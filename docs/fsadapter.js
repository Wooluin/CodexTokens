/* Codex 用量面板 · 公开网页版
   原理：访客通过文件选择器授权本机 ~/.codex/sessions 目录，
   浏览器在本地解析 rollout-*.jsonl 日志（与桌面版 main.py 同一套逻辑），
   数据全程不离开访客电脑，无任何后端。
   需要 Chrome / Edge 桌面版（File System Access API）。 */
(function () {
  "use strict";

  var RATE = (function () {
    try { var v = parseFloat(localStorage.getItem("ct_rate")); if (v > 0) return v; } catch (e) {}
    return 0.039; // 与桌面版一致：按真实账单校准的 元/百万 Token
  })();
  var CN_WEEK = "一二三四五六日"; // 周一=0，与桌面版一致
  var WEEK_CN = "日一二三四五六";

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function parseYmd(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) { var d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
  function hhmmss(d) { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()); }
  function fmtHM(d) { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function fmtMDHM(d) { return pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()) + " " + fmtHM(d); }
  function fmtFull(d) { return ymd(d) + " " + fmtHM(d); }
  function round3(x) { return Math.round(x * 1000) / 1000; }
  function round4(x) { return Math.round(x * 10000) / 10000; }
  function taskCost(tok) { return round3(tok * RATE / 1e6); }
  function cnWeek(d) { return CN_WEEK[(d.getDay() + 6) % 7]; }

  /* ---------------- 解析引擎（复刻 main.py LogScanner） ---------------- */
  function newState() {
    return { requests: 0, tasks: [], openIdx: -1, pendingUser: null,
             lastTotal: null, days: {} };
  }

  function addUsage(st, ts, u) {
    var dt = new Date(ts);
    if (isNaN(dt)) return;
    var dkey = ymd(dt);
    var d = st.days[dkey];
    if (!d) d = st.days[dkey] = { i: 0, c: 0, w: 0, o: 0, r: 0, h: {} };
    var i = u.input_tokens || 0;
    d.i += i;
    d.c += u.cached_input_tokens || 0;
    d.w += u.cache_write_input_tokens || 0;
    d.o += u.output_tokens || 0;
    d.r += 1;
    var hh = pad2(dt.getHours());
    var h = d.h[hh];
    if (!h) h = d.h[hh] = [0, 0, 0];
    h[0] += i;
    h[1] += u.output_tokens || 0;
    h[2] += 1;
  }

  function processLine(st, line) {
    try {
      if (line.indexOf('"token_count"') >= 0) {
        var obj = JSON.parse(line);
        var info = obj.payload.info;
        var u = info.total_token_usage;
        st.requests += 1;
        var delta = info.last_token_usage;
        if (delta == null && st.lastTotal != null) {
          var lt = st.lastTotal;
          delta = {};
          var keys = ["input_tokens", "cached_input_tokens",
                      "cache_write_input_tokens", "output_tokens"];
          for (var ki = 0; ki < keys.length; ki++) {
            var k = keys[ki];
            delta[k] = Math.max(0, (u[k] || 0) - (lt[k] || 0));
          }
        }
        if (delta) addUsage(st, obj.timestamp || "", delta);
        if (st.openIdx >= 0 && st.lastTotal != null) {
          var t = st.tasks[st.openIdx], b = t.base;
          if (b != null) {
            t.in = u.input_tokens - b.input_tokens;
            t.cached = u.cached_input_tokens - b.cached_input_tokens;
            t.out = u.output_tokens - b.output_tokens;
          }
        }
        st.lastTotal = u;
      } else if (line.indexOf('"task_started"') >= 0) {
        var o2 = JSON.parse(line);
        var label = st.pendingUser ? st.pendingUser[1] : null;
        st.pendingUser = null;
        st.tasks.push({ ts: o2.timestamp || "", label: label || "(后台任务)",
                        in: 0, cached: 0, out: 0, base: st.lastTotal });
        st.openIdx = st.tasks.length - 1;
      } else if (line.indexOf('"role":"user"') >= 0 && line.indexOf('"input_text"') >= 0) {
        var o3 = JSON.parse(line);
        var p = o3.payload;
        if (p && p.type === "message" && p.role === "user") {
          var text = (p.content || []).filter(function (c) { return c && c.type === "input_text"; })
            .map(function (c) { return c.text || ""; }).join(" ").trim();
          if (text && text.charAt(0) !== "<") {
            if (text.indexOf("# Files") === 0) {
              var blocks = text.split("\n\n").filter(function (b) { return b.trim(); });
              if (blocks.length > 1) text = blocks[blocks.length - 1];
            }
            text = text.replace(/^#+\s*My request:\s*/, "")
                       .replace(/<image[^>]*>/g, "")
                       .replace(/\s+/g, " ").trim().slice(0, 60);
            var hit = -1, i2;
            for (i2 = st.tasks.length - 1; i2 >= 0; i2--) {
              if (st.tasks[i2].label === "(后台任务)") { hit = i2; break; }
            }
            if (hit >= 0) {
              var msgDt = new Date(o3.timestamp || ""), tDt = new Date(st.tasks[hit].ts);
              var diff = (msgDt - tDt) / 1000;
              if (!isNaN(msgDt) && !isNaN(tDt) && diff >= 0 && diff < 60) {
                st.tasks[hit].label = text + "（执行）";
              } else {
                st.pendingUser = [o3.timestamp || "", text];
              }
            } else {
              st.pendingUser = [o3.timestamp || "", text];
            }
          }
        }
      }
    } catch (e) { /* 单行解析失败不影响整体，与桌面版一致 */ }
  }

  function parseText(text) {
    var st = newState();
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) processLine(st, lines[i]);
    return st;
  }

  /* ---------------- 状态与扫描 ---------------- */
  var rootHandle = null;        // 已授权的 sessions 目录句柄
  var states = {};              // path -> { mtime, size, st }
  var latestPath = null, latestMtime = 0;
  var fileCount = 0, scanning = false, lastScanAt = 0;

  function loadJson(key, def) {
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return (v && typeof v === "object") ? v : def;
    } catch (e) { return def; }
  }
  function saveJson(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {}
  }

  function walk(dir, prefix, out, depth) {
    if (depth > 8 || !dir.values) return Promise.resolve();
    var it = dir.values();  // FileSystemDirectoryHandle 的异步迭代器
    function step() {
      return it.next().then(function (r) {
        if (r.done) return;
        var ent = r.value, next = Promise.resolve();
        if (ent.name.charAt(0) !== ".") {
          if (ent.kind === "file" && /^rollout-.*\.jsonl$/.test(ent.name)) {
            out.push({ handle: ent, path: prefix + ent.name });
          } else if (ent.kind === "directory") {
            next = walk(ent, prefix + ent.name + "/", out, depth + 1);
          }
        }
        return next.then(step);
      });
    }
    return step();
  }

  function scanAll() {
    if (!rootHandle || scanning) return Promise.resolve();
    scanning = true;
    return Promise.resolve().then(function () {
      return walk(rootHandle, "", [], 0);
    }).then(function (files) {
      fileCount = files.length;
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          return f.handle.getFile().then(function (file) {
            var c = states[f.path];
            if (c && c.mtime === file.lastModified && c.size === file.size) return;
            return file.text().then(function (text) {
              states[f.path] = { mtime: file.lastModified, size: file.size, st: parseText(text) };
            });
          });
        }).catch(function () {});
      });
      return chain;
    }).then(function () {
      for (var p in states) {
        if (states[p].mtime > latestMtime) { latestMtime = states[p].mtime; latestPath = p; }
      }
      lastScanAt = Date.now();
      scanning = false;
    }).catch(function () { scanning = false; });
  }

  function ensureFresh() {
    if (rootHandle && Date.now() - lastScanAt > 4000 && !scanning) scanAll();
  }

  /* ---------------- 聚合（复刻 main.py get_data） ---------------- */
  function combinedDays() {
    var out = {};
    for (var path in states) {
      var days = states[path].st.days;
      for (var dkey in days) {
        var d = days[dkey], t = out[dkey];
        if (!t) t = out[dkey] = { i: 0, c: 0, w: 0, o: 0, r: 0, h: {} };
        t.i += d.i; t.c += d.c; t.w += d.w; t.o += d.o; t.r += d.r;
        for (var hh in d.h) {
          var v = d.h[hh], hv = t.h[hh];
          if (!hv) hv = t.h[hh] = [0, 0, 0];
          hv[0] += v[0]; hv[1] += v[1]; hv[2] += v[2];
        }
      }
    }
    return out;
  }

  function kidRows(t, fmt) {
    var out = [];
    (t.kidList || []).forEach(function (c) {
      var tok = c.in + c.out;
      out.push({ id: c.tid, label: c.label, time: fmt(c.dt),
                 tokens: tok, cost: taskCost(tok) });
    });
    return out;
  }

  function allTasks() {
    var out = [];
    for (var path in states) {
      states[path].st.tasks.forEach(function (t, ti) {
        var dt = new Date(t.ts);
        if (isNaN(dt)) return;
        var tid = path + "#" + ti;
        out.push({ dt: dt, label: (loadJson("ct_labels", {})[tid]) || t.label,
                   in: t.in, cached: t.cached, out: t.out, tid: tid, liveFrom: path });
      });
    }
    var merges = loadJson("ct_merges", {});
    if (Object.keys(merges).length) {
      var byid = {};
      out.forEach(function (t) { byid[t.tid] = t; });
      var kids = {}, skip = {};
      for (var cid in merges) {
        var c = byid[cid], pp = byid[merges[cid]];
        if (!c || !pp || cid === merges[cid]) continue;
        pp.in += c.in; pp.cached += c.cached; pp.out += c.out;
        kids[pp.tid] = (kids[pp.tid] || 0) + 1;
        (pp.kidList = pp.kidList || []).push(c);
        skip[cid] = 1;
      }
      if (Object.keys(skip).length) {
        out = out.filter(function (t) { return !skip[t.tid]; });
        out.forEach(function (t) { if (kids[t.tid]) t.kids = kids[t.tid]; });
      }
    }
    out.sort(function (a, b) { return b.dt - a.dt; });
    out.forEach(function (t, i) {
      t.live = i === 0 && t.liveFrom === latestPath && Date.now() - latestMtime < 90000;
    });
    return out;
  }

  function taskRow(t, mode, kidFmt) {
    var tok = t.in + t.out;
    return {
      time: mode === "day" ? fmtHM(t.dt) : (mode === "full" ? fmtFull(t.dt) : fmtMDHM(t.dt)),
      date: ymd(t.dt),
      label: t.label, tokens: tok, cost: taskCost(tok),
      id: t.tid, kids: t.kids || 0,
      children: kidRows(t, kidFmt || (mode === "day" ? fmtHM : mode === "full" ? fmtFull : fmtMDHM)),
      live: t.live
    };
  }

  function periodRange(dstr, mode) {
    if (mode === "day") return [dstr, dstr];
    var d = parseYmd(dstr);
    if (mode === "week") {
      var s = new Date(d); s.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      var e = new Date(s); e.setDate(s.getDate() + 6);
      return [ymd(s), ymd(e)];
    }
    if (mode === "month") {
      return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)),
              ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
    }
    return [d.getFullYear() + "-01-01", d.getFullYear() + "-12-31"];
  }

  function buildPayload(dateStr, mode) {
    ensureFresh();
    var days = combinedDays();
    var tasks = allTasks();
    var now = new Date();
    var today = ymd(now);
    var date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") ? dateStr : today;
    if (["day", "week", "month", "year"].indexOf(mode) < 0) mode = "day";
    var s = periodRange(date, mode)[0], e = periodRange(date, mode)[1];

    var pi = 0, pc = 0, po = 0, pr = 0, d;
    for (d = s; d <= e; d = addDays(d, 1)) {
      var b = days[d];
      if (b) { pi += b.i; pc += b.c; po += b.o; pr += b.r; }
    }
    var ti = 0, to = 0, tc = 0, totalApi = 0, k;
    for (k in days) { ti += days[k].i; to += days[k].o; tc += days[k].c; totalApi += days[k].r; }
    var todayApi = days[today] ? days[today].r : 0;
    var periodAvg = pr ? (pi + po) / pr : null;

    var wi = 0, wo = 0, wd = addDays(today, -((now.getDay() + 6) % 7));
    for (d = wd; d <= today; d = addDays(d, 1)) {
      var wb = days[d];
      if (wb) { wi += wb.i; wo += wb.o; }
    }
    var weekTokens = wi + wo;

    var chart = [], apiChart = [], breakdown = [];
    if (mode === "day") {
      var db = days[date] || { h: {} };
      for (var h = 0; h < 24; h++) {
        var v = db.h[pad2(h)];
        var tok = v ? v[0] + v[1] : 0;
        chart.push({ label: h + "时", tokens: tok, cost: round4(tok * RATE / 1e6) });
        apiChart.push({ label: h + "时", api: v ? v[2] : 0 });
      }
    } else if (mode === "week" || mode === "month") {
      var arr = [];
      for (d = s; d <= e; d = addDays(d, 1)) {
        var bb = days[d];
        var tok2 = bb ? bb.i + bb.o : 0;
        var dd = parseYmd(d);
        var label = mode === "week"
          ? (dd.getMonth() + 1) + "/" + dd.getDate() + " 周" + cnWeek(dd)
          : (dd.getMonth() + 1) + "/" + dd.getDate();
        arr.push({ label: label, tokens: tok2, api: bb ? bb.r : 0,
                   rate: (bb && bb.i) ? bb.c / bb.i : null,
                   cost4: round4(tok2 * RATE / 1e6), cost3: round3(tok2 * RATE / 1e6) });
      }
      arr.forEach(function (x) {
        chart.push({ label: x.label, tokens: x.tokens, cost: x.cost4 });
        apiChart.push({ label: x.label, api: x.api });
        breakdown.push({ label: x.label, tokens: x.tokens, rate: x.rate, cost: x.cost3 });
      });
      breakdown.reverse();
    } else {
      var arr2 = [];
      for (var m = 1; m <= 12; m++) {
        var mi = 0, mc = 0, mo = 0, mr = 0, prefix = date.slice(0, 4) + "-" + pad2(m) + "-";
        for (k in days) {
          if (k.indexOf(prefix) === 0) { mi += days[k].i; mc += days[k].c; mo += days[k].o; mr += days[k].r; }
        }
        var tok3 = mi + mo;
        arr2.push({ tokens: tok3, api: mr, rate: mi ? mc / mi : null,
                    cost4: round4(tok3 * RATE / 1e6), cost3: round3(tok3 * RATE / 1e6) });
      }
      arr2.forEach(function (x, i3) {
        chart.push({ label: (i3 + 1) + "月", tokens: x.tokens, cost: x.cost4 });
        apiChart.push({ label: (i3 + 1) + "月", api: x.api });
        breakdown.push({ label: (i3 + 1) + " 月", tokens: x.tokens, rate: x.rate, cost: x.cost3 });
      });
      breakdown.reverse();
    }

    var d2 = parseYmd(date);
    var plabel, pshort;
    if (mode === "day") {
      plabel = d2.getFullYear() + " 年 " + (d2.getMonth() + 1) + " 月 " + d2.getDate() +
               " 日 周" + cnWeek(d2) + (date === today ? "（今天）" : "");
      pshort = date === today ? "今日" : (d2.getMonth() + 1) + "/" + d2.getDate();
    } else if (mode === "week") {
      var ws = parseYmd(s), we = parseYmd(e);
      plabel = (ws.getMonth() + 1) + "/" + ws.getDate() + " – " +
               (we.getMonth() + 1) + "/" + we.getDate() + " 这一周";
      pshort = (s <= today && today <= e) ? "本周" : s.slice(5).replace("-", "/") + "–" + e.slice(5).replace("-", "/");
    } else if (mode === "month") {
      plabel = d2.getFullYear() + " 年 " + (d2.getMonth() + 1) + " 月";
      pshort = (s <= today && today <= e) ? "本月" : (d2.getMonth() + 1) + "月";
    } else {
      plabel = d2.getFullYear() + " 年";
      pshort = (s <= today && today <= e) ? "今年" : d2.getFullYear() + "年";
    }

    var daySum = {};
    if (mode !== "day") {
      for (d = s; d <= e; d = addDays(d, 1)) {
        var sb = days[d];
        if (sb && sb.i + sb.o > 0) {
          var sd = parseYmd(d);
          daySum[d] = {
            label: (sd.getMonth() + 1) + "/" + sd.getDate() + " 周" + cnWeek(sd),
            tokens: sb.i + sb.o,
            rate: sb.i ? sb.c / sb.i : null,
            cost: round3((sb.i + sb.o) * RATE / 1e6)
          };
        }
      }
    }

    var taskRows = [];
    var kidF = mode === "day" ? fmtHM : fmtMDHM;
    tasks.forEach(function (t) {
      var ds = ymd(t.dt);
      if (ds >= s && ds <= e) taskRows.push(taskRow(t, mode, kidF));
    });

    return {
      balance: null,
      updated: hhmmss(now),
      mode: mode, date: date,
      period_label: plabel, period_short: pshort,
      period_tokens: pi + po,
      period_cost: (pi + po) * RATE / 1e6,
      period_requests: pr,
      cache_rate: pi ? pc / pi : null,
      week_tokens: weekTokens,
      week_cost: weekTokens * RATE / 1e6,
      today_api: todayApi,
      total_api: totalApi,
      period_avg: periodAvg,
      total_tokens: ti + to,
      total_cost: (ti + to) * RATE / 1e6,
      total_in: ti, total_cached: tc, total_out: to,
      avg_per_yi: RATE * 100,
      chart: chart, api_chart: apiChart, breakdown: breakdown, day_sum: daySum,
      tasks: taskRows,
      is_today_period: s <= today && today <= e
    };
  }

  /* ---------------- 目录选择与授权 ---------------- */
  function idbOpen() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open("codexTokensWeb", 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore("handles"); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  function idbSet(v) {
    return idbOpen().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction("handles", "readwrite");
        tx.objectStore("handles").put(v, "sessionsDir");
        tx.oncomplete = res; tx.onerror = res;
      });
    });
  }
  function idbGet() {
    return idbOpen().then(function (db) {
      return new Promise(function (res) {
        var rq = db.transaction("handles").objectStore("handles").get("sessionsDir");
        rq.onsuccess = function () { res(rq.result || null); };
        rq.onerror = function () { res(null); };
      });
    });
  }

  var overlay, ovStatus, pendingHandle = null;

  function ovMsg(mode) {
    var supported = !!window.showDirectoryPicker;
    var steps = supported
      ? '<ol style="text-align:left;line-height:2;margin:14px auto;max-width:520px;font-size:14px;color:#555;">' +
        '<li>打开文件管理器，进入你的 Codex 日志目录：<br>' +
        '<code style="background:#f4f5f7;padding:2px 8px;border-radius:6px;">C:\\Users\\你的用户名\\.codex\\sessions</code>（Windows）<br>' +
        '<code style="background:#f4f5f7;padding:2px 8px;border-radius:6px;">~/.codex/sessions</code>（macOS / Linux）</li>' +
        '<li>点击下方按钮，选中该文件夹并允许访问</li></ol>'
      : "";
    var btn = supported
      ? '<button id="ctPick" style="background:#1677ff;color:#fff;border:0;border-radius:10px;padding:12px 34px;font-size:15px;cursor:pointer;">选择 sessions 文件夹</button>'
      : '<div style="color:#d4380d;font-size:14px;">当前浏览器不支持本地目录读取。<br>请使用 <b>Chrome 或 Edge 桌面版</b> 打开本页面。</div>';
    var extra = mode === "reauth"
      ? '<div style="margin-top:10px;color:#888;font-size:13px;">检测到上次选择的目录，请重新点击按钮授权访问</div>'
      : "";
    overlay.innerHTML =
      '<div style="background:#fff;border-radius:16px;padding:30px 36px;max-width:640px;box-shadow:0 8px 40px rgba(0,0,0,.25);text-align:center;">' +
      '<div style="font-size:19px;font-weight:700;margin-bottom:6px;">选择你的 Codex 日志目录</div>' +
      '<div style="color:#888;font-size:13px;line-height:1.8;">网页版直接在浏览器里解析本机 Codex 日志并统计消耗。<br>' +
      '<b style="color:#2e7d32;">数据全程只在你的电脑上处理，不会上传到任何服务器。</b></div>' +
      steps + btn + extra +
      '<div id="ctOvStatus" style="margin-top:14px;color:#1677ff;font-size:13px;min-height:18px;"></div>' +
      '<div style="margin-top:8px;color:#bbb;font-size:12px;">需要 Chrome / Edge 桌面版 · 刷新或关闭后下次仍需授权（浏览器会记住目录）</div>' +
      '</div>';
    var pick = document.getElementById("ctPick");
    if (pick) pick.onclick = function () { pickDirectory(); };
  }

  function showOverlay(mode) {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "ctOverlay";
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(245,246,248,.97);z-index:2000;" +
                              "display:flex;align-items:center;justify-content:center;padding:20px;";
      document.body.appendChild(overlay);
    }
    overlay.style.display = "flex";
    ovStatus = null;
    ovMsg(mode);
  }
  function hideOverlay() { if (overlay) overlay.style.display = "none"; }

  function ovText(msg) {
    var el = document.getElementById("ctOvStatus");
    if (el) el.textContent = msg;
  }

  function pickDirectory() {
    if (!window.showDirectoryPicker) return;
    window.showDirectoryPicker({ id: "codex-sessions", mode: "read" })
      .then(function (h) {
        pendingHandle = null;
        return h.requestPermission({ mode: "read" }).then(function (perm) {
          if (perm !== "granted") { ovText("未获得目录读取权限，请重试"); return; }
          rootHandle = h;
          states = {};
          return idbSet(h).then(function () {
            ovText("正在扫描日志…");
            return scanAll().then(function () {
              hideOverlay();
            });
          });
        });
      })
      .catch(function () { /* 用户取消选择 */ });
  }

  /* ---------------- 对外 API（与桌面版 pywebview 桥同构） ---------------- */
  function rowFor(t) {
    return taskRow(t, "full", fmtFull);
  }

  window.pywebview = {
    api: {
      get_data: function (date, mode) {
        return Promise.resolve(buildPayload(date, mode));
      },
      search_tasks: function (kw) {
        kw = (kw || "").trim().toLowerCase();
        if (!kw) return Promise.resolve([]);
        return Promise.resolve(allTasks().filter(function (t) {
          return t.label.toLowerCase().indexOf(kw) >= 0;
        }).slice(0, 300).map(function (t) {
          var r = rowFor(t); return r;
        }));
      },
      get_tasks_by_ids: function (ids) {
        var set = {};
        (ids || []).forEach(function (x) { set[x] = 1; });
        if (!Object.keys(set).length) return Promise.resolve([]);
        return Promise.resolve(allTasks().filter(function (t) {
          return set[t.tid];
        }).slice(0, 500).map(function (t) {
          var r = rowFor(t); return r;
        }));
      },
      get_settings: function () {
        return Promise.resolve(loadJson("ct_settings", {}));
      },
      set_setting: function (key, value) {
        var d = loadJson("ct_settings", {});
        if (value === null || value === undefined) { delete d[key]; }
        else if (key === "hiYi") { d[key] = !!value; }
        else if (key === "chart_mode") { d[key] = value === "merge" ? "merge" : "split"; }
        else if (key === "chart_layout") { d[key] = value === "h" ? "h" : "v"; }
        else if (key === "panel_order") {
          if (!Array.isArray(value)) return Promise.resolve(false);
          d[key] = value.filter(function (x) { return typeof x === "string"; }).slice(0, 10);
        } else if (key === "panel_collapsed") {
          if (typeof value !== "object" || Array.isArray(value)) return Promise.resolve(false);
          var o = {};
          for (var kk in value) o[kk] = !!value[kk];
          d[key] = o;
        } else if (key === "task_h") {
          var n = parseInt(value, 10);
          if (isNaN(n)) return Promise.resolve(false);
          d[key] = Math.max(120, Math.min(2000, n));
        } else { return Promise.resolve(false); }
        saveJson("ct_settings", d);
        return Promise.resolve(true);
      },
      edit_task: function (tid, label) {
        label = (label || "").trim();
        if (!tid || !label) return Promise.resolve(false);
        var labels = loadJson("ct_labels", {});
        labels[tid] = label.slice(0, 60);
        saveJson("ct_labels", labels);
        return Promise.resolve(true);
      },
      merge_tasks: function (parent, children) {
        if (!parent || !Array.isArray(children)) return Promise.resolve(false);
        var kids = children.filter(function (c) {
          return typeof c === "string" && c && c !== parent;
        });
        if (!kids.length) return Promise.resolve(false);
        var m = loadJson("ct_merges", {});
        kids.forEach(function (c) { m[c] = parent; });
        for (var kk in m) if (kids.indexOf(m[kk]) >= 0) m[kk] = parent;
        delete m[parent];
        saveJson("ct_merges", m);
        return Promise.resolve(true);
      }
    }
  };

  /* 测试钩子：浏览器里注入模拟扫描结果验证聚合（不影响正常使用） */
  window.__ct = {
    setFake: function (fake) {
      states = fake.states || {};
      latestPath = fake.latestPath || null;
      latestMtime = fake.latestMtime || 0;
      fileCount = Object.keys(states).length;
      lastScanAt = Date.now();
    },
    parseText: parseText,
    payload: buildPayload
  };

  /* ---------------- 启动 ---------------- */
  document.addEventListener("DOMContentLoaded", function () {
    if (!window.showDirectoryPicker) { showOverlay("unsupported"); return; }
    idbGet().then(function (h) {
      if (!h) { showOverlay("pick"); return; }
      h.queryPermission({ mode: "read" }).then(function (perm) {
        if (perm === "granted") {
          rootHandle = h;
          hideOverlay();
          scanAll();
        } else {
          pendingHandle = h;
          showOverlay("reauth");
        }
      }).catch(function () { showOverlay("pick"); });
    });
  });
})();
