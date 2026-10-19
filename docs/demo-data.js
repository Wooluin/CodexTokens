/* Codex 用量面板 · 在线演示数据
   仅用于 GitHub Pages 静态演示：在真实 index.html 之前注入模拟的 pywebview 桥，
   页面无需任何后端即可浏览。所有数据均为示例数据，不代表任何真实用户。 */
(function () {
  var RATE = 0.039;             // 元 / 百万 token（与真实版本一致的成本单价）
  var DAY = 86400000;

  function iso(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
           "-" + String(d.getDate()).padStart(2, "0");
  }
  function nowStr() {
    var d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" +
           String(d.getMinutes()).padStart(2, "0") + ":" +
           String(d.getSeconds()).padStart(2, "0");
  }
  function today() { return iso(new Date()); }
  function cnWeek(d) { return "日一二三四五六"[d.getDay()]; }
  function parseDate(s) { return new Date(s + "T00:00:00"); }

  /* ---------- 固定随机（同一天的数据稳定，不随刷新乱跳） ---------- */
  function seedRand(seed) {
    var s = 0;
    for (var i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* ---------- 示例任务 ---------- */
  var TASK_LABELS = [
    "修复图表布局在窄窗口下的错位问题（执行）",
    "（后台任务）",
    "为统计卡片增加问号说明弹窗（执行）",
    "排查 API 折线图偶发断点的原因（执行）",
    "重构日志解析模块，提升增量扫描速度（执行）",
    "新增每亿 Token 均价统计卡片（执行）",
    "整理任务分组视图的交互细节（执行）",
    "（后台任务）",
    "优化明细表格排序与列宽记忆（执行）",
    "编写 README 与在线演示页（执行）"
  ];
  var TASK_TOK = [54267433, 4404860, 6231977, 9748107, 21036091, 29099071,
                  34622098, 50754942, 51860368, 10870428];

  function buildTasks(dateStr) {
    var rows = [], base = parseDate(dateStr);
    for (var i = 0; i < TASK_LABELS.length; i++) {
      var d = new Date(base.getTime() + (22 - i * 2) * 3600000);
      var tok = TASK_TOK[i];
      rows.push({
        time: (dateStr === today() ? "" : dateStr.slice(5).replace("-", "/") + " ") +
              String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"),
        date: dateStr,
        label: TASK_LABELS[i],
        tokens: tok,
        cost: +(tok * RATE / 1e6).toFixed(3),
        id: "demo#" + i,
        kids: 0,
        children: [],
        live: dateStr === today() && i === 0
      });
    }
    return rows;
  }

  /* ---------- 按天/模式生成汇总 ---------- */
  function dayBucket(dateStr) {
    var rnd = seedRand(dateStr);
    var hours = [], tokens = 0, api = 0, cached = 0;
    for (var h = 0; h < 24; h++) {
      var peak = (h >= 9 && h <= 23) ? Math.sin((h - 9) / 14 * Math.PI) : 0;
      var v = Math.floor(peak * peak * (4e7 + rnd() * 1.6e8));
      var a = v ? Math.max(1, Math.floor(v / 4.5e5 + rnd() * 30)) : 0;
      var c = Math.floor(v * (0.985 + rnd() * 0.012));
      hours.push({ i: v, o: Math.floor(v * 0.004), c: c, r: a });
      tokens += v + Math.floor(v * 0.004);
      cached += c;
      api += a;
    }
    return { hours: hours, tokens: tokens, api: api, cached: cached,
             i: hours.reduce(function (s, x) { return s + x.i; }, 0),
             o: hours.reduce(function (s, x) { return s + x.o; }, 0) };
  }

  function get_data(dateStr, mode) {
    dateStr = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || "") ? dateStr : today();
    mode = ["day", "week", "month", "year"].indexOf(mode) >= 0 ? mode : "day";
    var date = parseDate(dateStr), isToday = dateStr === today();

    var chart = [], api_chart = [], breakdown = [], day_sum = {};
    var pi = 0, po = 0, pc = 0, pr = 0;

    function push(label, tok, rate, api, key) {
      chart.push({ label: label, tokens: tok, cost: +(tok * RATE / 1e6).toFixed(4) });
      api_chart.push({ label: label, api: api });
      breakdown.push({ label: label, tokens: tok, rate: rate, cost: +(tok * RATE / 1e6).toFixed(3) });
      if (key) day_sum[key] = { label: label, tokens: tok, rate: rate, cost: +(tok * RATE / 1e6).toFixed(3) };
    }

    var totalTokens = 2356893025, totalIn = 2353205455, totalCached = 2340827520, totalOut = 3687570;

    if (mode === "day") {
      var b = dayBucket(dateStr);
      for (var h = 0; h < 24; h++) {
        var tok = b.hours[h].i + b.hours[h].o;
        push(h + "时", tok, null, b.hours[h].r);
      }
      pi = b.i; po = b.o; pc = b.cached; pr = b.api;
    } else if (mode === "week" || mode === "month") {
      var s = new Date(date);
      if (mode === "week") s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
      else s.setDate(1);
      var e = new Date(s);
      if (mode === "week") e.setDate(s.getDate() + 6);
      else e.setMonth(s.getMonth() + 1), e.setDate(0);
      var cur = new Date(s), idx = 0;
      while (cur <= e) {
        var ds = iso(cur), db = dayBucket(ds);
        var wk = "周" + cnWeek(cur);
        var label = (cur.getMonth() + 1) + "/" + cur.getDate() +
                    (mode === "week" ? " " + wk : "");
        var show = idx % (mode === "month" ? 5 : 1) === 0;
        push(label, db.tokens,
             db.i ? +(db.cached / db.i).toFixed(4) : null, db.api, ds);
        pi += db.i; po += db.o; pc += db.cached; pr += db.api;
        cur.setDate(cur.getDate() + 1); idx++;
      }
      breakdown.reverse();
    } else {
      for (var m = 1; m <= 12; m++) {
        var rnd = seedRand(dateStr + "-" + m);
        var mt = Math.floor((2e8 + rnd() * 5e8) * (m <= new Date().getMonth() + 1 ? 1 : 0.15));
        var ma = Math.floor(mt / 4.6e5);
        push(m + "月", mt, 0.991 + rnd() * 0.006, ma);
        pi += mt * 0.98; po += mt * 0.02; pr += ma;
      }
      breakdown.reverse();
    }

    var periodTokens = pi + po;
    var weekT = 632222346;
    return {
      balance: "14.44",
      updated: nowStr(),
      mode: mode, date: dateStr,
      period_label: mode === "day"
        ? date.getFullYear() + " 年 " + (date.getMonth() + 1) + " 月 " + date.getDate() +
          " 日 周" + cnWeek(date) + (isToday ? "（今天）" : "")
        : mode === "week" ? "本周（演示数据）"
        : mode === "month" ? date.getFullYear() + " 年 " + (date.getMonth() + 1) + " 月"
        : date.getFullYear() + " 年",
      period_short: mode === "day" ? (isToday ? "今日" : (date.getMonth() + 1) + "/" + date.getDate())
        : mode === "week" ? "本周" : mode === "month" ? "本月" : "今年",
      period_tokens: periodTokens,
      period_cost: +(periodTokens * RATE / 1e6).toFixed(4),
      period_requests: pr,
      cache_rate: pi ? +(pc / pi).toFixed(6) : null,
      week_tokens: weekT,
      week_cost: +(weekT * RATE / 1e6).toFixed(4),
      today_api: 1153,
      total_api: 4930,
      period_avg: pr ? Math.floor(periodTokens / pr) : null,
      total_tokens: totalTokens,
      total_cost: +(totalTokens * RATE / 1e6).toFixed(4),
      total_in: totalIn, total_cached: totalCached, total_out: totalOut,
      avg_per_yi: RATE * 100,
      chart: chart, api_chart: api_chart, breakdown: breakdown, day_sum: day_sum,
      tasks: mode === "day" ? buildTasks(dateStr) : [],
      is_today_period: true
    };
  }

  var ALL_TASKS = buildTasks(today()).map(function (t, i) {
    var d = new Date(); d.setDate(d.getDate() - i);
    var c = Object.assign({}, t, { date: iso(d), live: false, id: "demo#" + i,
      time: iso(d).slice(5).replace("-", "/") + " " + t.time.trim() });
    return c;
  });

  window.pywebview = {
    api: {
      get_data: function (date, mode) { return Promise.resolve(get_data(date, mode)); },
      search_tasks: function (kw) {
        kw = (kw || "").toLowerCase();
        return Promise.resolve(ALL_TASKS.filter(function (t) {
          return kw && t.label.toLowerCase().indexOf(kw) >= 0;
        }));
      },
      get_tasks_by_ids: function (ids) {
        var set = ids || [];
        return Promise.resolve(ALL_TASKS.filter(function (t) { return set.indexOf(t.id) >= 0; }));
      },
      get_settings: function () { return Promise.resolve({ chart_layout: "h" }); },
      edit_task: function () { return Promise.resolve(true); },
      merge_tasks: function () { return Promise.resolve(true); },
      set_setting: function () { return Promise.resolve(true); }
    }
  };

  /* 页面加载后标注演示模式 */
  document.addEventListener("DOMContentLoaded", function () {
    try {
      document.title = "Codex 用量面板（在线演示）";
      var sub = document.querySelector(".sub");
      if (sub) sub.innerHTML += " · <b>在线演示模式 —— 以下全部为示例数据</b>";
    } catch (e) {}
  });
})();
