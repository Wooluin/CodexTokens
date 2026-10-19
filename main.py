# -*- coding: utf-8 -*-
"""Codex 用量面板 v2 —— 本地 Codex 日志 + DeepSeek 余额 API。

v2 升级：
- 按 日/周/月/年 切换查看，支持日期前后翻页和日期选择器跳转
- 柱状图：日视图按小时，周/月视图按天，年视图按月
- 显示缓存命中率（cached_input / input）
- 记住窗口大小，下次启动恢复
"""
import datetime
import glob
import json
import os
import re
import sys
import threading
import time

# 依赖按需导入：网页模式（--web）只需标准库，桌面模式才需要 pywebview
try:
    import webview  # noqa: F401  仅桌面模式使用
except Exception:
    webview = None

# 便携化：不再写死用户名，自动取当前用户的 home 目录，exe 发给别人也能用
_HOME = os.path.expanduser("~")
SESSIONS = os.path.join(_HOME, ".codex", "sessions")
CONFIG = os.path.join(_HOME, ".codex", "config.toml")
LOCAL_TZ = datetime.timezone(datetime.timedelta(hours=8))
EFFECTIVE_PER_MILLION = 0.039  # 按真实账单校准：¥32.86 / 8.38亿 tokens
CACHE_V = 5  # v5：小时桶增加 API 请求数 h[2]，供 API 折线图使用，旧缓存重扫

if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(sys.executable)
    RES_DIR = getattr(sys, "_MEIPASS", APP_DIR)
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))
    RES_DIR = APP_DIR
CACHE_FILE = os.path.join(APP_DIR, "cache.json")
UI_FILE = os.path.join(APP_DIR, "ui_state.json")
MERGE_FILE = os.path.join(APP_DIR, "merges.json")
SETTINGS_FILE = os.path.join(APP_DIR, "settings.json")


def load_merges():
    """子任务 tid -> 父任务 tid 的合并映射。"""
    try:
        return json.load(open(MERGE_FILE, encoding="utf-8"))
    except Exception:
        return {}


def load_settings():
    """面板设置（如亿位高亮开关），重启后保持上次状态。"""
    try:
        return json.load(open(SETTINGS_FILE, encoding="utf-8"))
    except Exception:
        return {}


def save_settings(d):
    try:
        json.dump(d, open(SETTINGS_FILE, "w", encoding="utf-8"))
    except Exception:
        pass


def local_dt(ts):
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(LOCAL_TZ)
    except Exception:
        return None


def load_api_key():
    try:
        txt = open(CONFIG, encoding="utf-8").read()
        m = re.search(r'experimental_bearer_token\s*=\s*"([^"]+)"', txt)
        return m.group(1) if m else None
    except Exception:
        return None


class BalanceFetcher:
    """DeepSeek 余额（网页版在 Mac 上零第三方依赖，用标准库 urllib）。"""
    def __init__(self):
        self.value = None
        self.key = load_api_key()
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        import urllib.request
        while True:
            if self.key:
                try:
                    req = urllib.request.Request(
                        "https://api.deepseek.com/user/balance",
                        headers={"Authorization": "Bearer " + self.key})
                    with urllib.request.urlopen(req, timeout=8) as r:
                        js = json.loads(r.read().decode("utf-8", "ignore"))
                    infos = js.get("balance_infos", [])
                    if infos:
                        self.value = infos[0].get("total_balance")
                except Exception:
                    pass
            time.sleep(60)


# ---------------- 日志增量解析 ----------------
class LogScanner:
    def __init__(self):
        self.lock = threading.Lock()
        self.states = {}
        if os.path.exists(CACHE_FILE):
            try:
                self.states = json.load(open(CACHE_FILE, encoding="utf-8"))
            except Exception:
                self.states = {}
        if self.states.get("_v") != CACHE_V:  # 旧版缓存没有按天聚合桶，重扫一次
            self.states = {"_v": CACHE_V}

    def _new_state(self):
        return {"offset": 0, "requests": 0, "tasks": [],
                "open_idx": -1, "pending_user": None, "last_total": None,
                "days": {}}

    def _add_usage(self, st, ts, u):
        dt = local_dt(ts)
        if not dt:
            return
        dkey = dt.strftime("%Y-%m-%d")
        d = st["days"].get(dkey)
        if d is None:
            d = st["days"][dkey] = {"i": 0, "c": 0, "w": 0, "o": 0, "r": 0, "h": {}}
        i = u.get("input_tokens", 0)
        d["i"] += i
        d["c"] += u.get("cached_input_tokens", 0)
        d["w"] += u.get("cache_write_input_tokens", 0)
        d["o"] += u.get("output_tokens", 0)
        d["r"] += 1
        hh = dt.strftime("%H")
        h = d["h"].get(hh)
        if h is None:
            h = d["h"][hh] = [0, 0, 0]
        h[0] += i
        h[1] += u.get("output_tokens", 0)
        h[2] += 1

    def _process(self, st, line):
        try:
            if '"token_count"' in line:
                obj = json.loads(line)
                info = obj["payload"]["info"]
                u = info["total_token_usage"]
                st["requests"] += 1
                delta = info.get("last_token_usage")
                if delta is None and st["last_total"] is not None:
                    lt = st["last_total"]
                    delta = {k: max(0, u.get(k, 0) - lt.get(k, 0))
                             for k in ("input_tokens", "cached_input_tokens",
                                       "cache_write_input_tokens", "output_tokens")}
                if delta:
                    self._add_usage(st, obj.get("timestamp", ""), delta)
                if st["open_idx"] >= 0 and st["last_total"] is not None:
                    t = st["tasks"][st["open_idx"]]
                    b = t["base"]
                    if b is not None:
                        t["in"] = u["input_tokens"] - b["input_tokens"]
                        t["cached"] = u["cached_input_tokens"] - b["cached_input_tokens"]
                        t["out"] = u["output_tokens"] - b["output_tokens"]
                st["last_total"] = u
            elif '"task_started"' in line:
                obj = json.loads(line)
                label = st["pending_user"][1] if st["pending_user"] else None
                st["pending_user"] = None
                idx = len(st["tasks"])
                st["tasks"].append({"ts": obj.get("timestamp", ""), "label": label or "(后台任务)",
                                    "in": 0, "cached": 0, "out": 0,
                                    "base": st["last_total"]})
                st["open_idx"] = idx
            elif '"role":"user"' in line and '"input_text"' in line:
                obj = json.loads(line)
                p = obj["payload"]
                if p.get("type") == "message" and p.get("role") == "user":
                    text = " ".join(c.get("text", "") for c in p.get("content", [])
                                    if c.get("type") == "input_text").strip()
                    if text and not text.startswith("<"):
                        if text.startswith("# Files"):
                            blocks = [b for b in text.split("\n\n") if b.strip()]
                            if len(blocks) > 1:
                                text = blocks[-1]
                        text = re.sub(r"^#+\s*My request:\s*", "", text)
                        text = re.sub(r"<image[^>]*>", "", text)
                        text = re.sub(r"\s+", " ", text).strip()[:60]
                        # 从后往前找最近的"（后台任务）"，时间差<60秒则判定为它的真实用户消息
                        hit = -1
                        for i in range(len(st["tasks"]) - 1, -1, -1):
                            if st["tasks"][i]["label"] == "(后台任务)":
                                hit = i
                                break
                        if hit >= 0:
                            msg_dt = local_dt(obj.get("timestamp", ""))
                            t_dt = local_dt(st["tasks"][hit]["ts"])
                            if (msg_dt and t_dt
                                    and 0 <= (msg_dt - t_dt).total_seconds() < 60):
                                st["tasks"][hit]["label"] = text + "（执行）"
                            else:
                                st["pending_user"] = [obj.get("timestamp", ""), text]
                        else:
                            st["pending_user"] = [obj.get("timestamp", ""), text]
        except Exception:
            pass

    def scan_all(self):
        with self.lock:
            files = glob.glob(os.path.join(SESSIONS, "**", "rollout-*.jsonl"), recursive=True)
            for path in files:
                try:
                    size = os.path.getsize(path)
                except OSError:
                    continue
                st = self.states.get(path)
                if not isinstance(st, dict) or "days" not in st:
                    st = self._new_state()
                if size < st["offset"]:
                    st = self._new_state()
                if size == st["offset"]:
                    self.states[path] = st
                    continue
                with open(path, "rb") as f:
                    f.seek(st["offset"])
                    data = f.read().decode("utf-8", errors="ignore")
                for line in data.splitlines():
                    self._process(st, line)
                st["offset"] = size
                self.states[path] = st
            try:
                json.dump(self.states, open(CACHE_FILE, "w", encoding="utf-8"))
            except Exception:
                pass

    # ---------- 聚合 ----------
    def combined_days(self):
        """所有文件的按天桶合并：{date: {i,c,w,o,r,h:{HH:[i,o]}}}"""
        out = {}
        for path, st in self.states.items():
            if path.startswith("_"):
                continue
            for dkey, d in st.get("days", {}).items():
                t = out.get(dkey)
                if t is None:
                    t = out[dkey] = {"i": 0, "c": 0, "w": 0, "o": 0, "r": 0, "h": {}}
                for k in ("i", "c", "w", "o", "r"):
                    t[k] += d[k]
                for hh, v in d["h"].items():
                    hv = t["h"].get(hh)
                    if hv is None:
                        hv = t["h"][hh] = [0, 0, 0]
                    hv[0] += v[0]
                    hv[1] += v[1]
                    hv[2] += v[2]
        return out

    def all_tasks(self):
        tasks = []
        latest_path, latest_mtime = None, 0
        for path, st in self.states.items():
            if path.startswith("_"):
                continue
            try:
                mt = os.path.getmtime(path)
                if mt > latest_mtime:
                    latest_mtime, latest_path = mt, path
            except OSError:
                pass
            for ti, t in enumerate(st["tasks"]):
                dt = local_dt(t["ts"])
                if dt:
                    tasks.append({"dt": dt, "label": t["label"],
                                  "in": t["in"], "cached": t["cached"], "out": t["out"],
                                  "tid": path + "#" + str(ti),
                                  "live_from": path})
        # 应用合并：子任务数值并入父任务，明细挂到 kid_list 供展开查看
        merges = load_merges()
        if merges:
            byid = {t["tid"]: t for t in tasks}
            kids, skip = {}, set()
            for cid, pid in merges.items():
                c, p = byid.get(cid), byid.get(pid)
                if c is None or p is None or cid == pid:
                    continue
                p["in"] += c["in"]
                p["cached"] += c["cached"]
                p["out"] += c["out"]
                kids[pid] = kids.get(pid, 0) + 1
                p.setdefault("kid_list", []).append(c)
                skip.add(cid)
            if skip:
                tasks = [t for t in tasks if t["tid"] not in skip]
                for t in tasks:
                    if t["tid"] in kids:
                        t["kids"] = kids[t["tid"]]
        tasks.sort(key=lambda x: x["dt"], reverse=True)
        for i, t in enumerate(tasks):
            t["live"] = (i == 0 and t["live_from"] == latest_path
                         and time.time() - latest_mtime < 90)
        return tasks


CN_WEEK = "一二三四五六日"


def kid_rows(t, time_fmt):
    """合并进该任务的子任务明细（展开用）。"""
    out = []
    for c in t.get("kid_list", []):
        tok = c["in"] + c["out"]
        out.append({"id": c["tid"], "label": c["label"],
                    "time": c["dt"].strftime(time_fmt),
                    "tokens": tok,
                    "cost": round(tok * EFFECTIVE_PER_MILLION / 1e6, 3)})
    return out


def period_range(date, mode):
    if mode == "day":
        return date, date
    if mode == "week":
        s = date - datetime.timedelta(days=date.weekday())
        return s, s + datetime.timedelta(days=6)
    if mode == "month":
        s = date.replace(day=1)
        e = (s + datetime.timedelta(days=32)).replace(day=1) - datetime.timedelta(days=1)
        return s, e
    return date.replace(month=1, day=1), date.replace(month=12, day=31)


class Api:
    def __init__(self, scanner, balance):
        self.scanner = scanner
        self.balance = balance
        threading.Thread(target=self._scan_loop, daemon=True).start()

    def _scan_loop(self):
        while True:
            self.scanner.scan_all()
            time.sleep(5)

    def get_data(self, date_str=None, mode="day"):
        with self.scanner.lock:
            days = self.scanner.combined_days()
            tasks = self.scanner.all_tasks()

        today = datetime.datetime.now(LOCAL_TZ).date()
        try:
            date = datetime.date.fromisoformat(date_str) if date_str else today
        except Exception:
            date = today
        if mode not in ("day", "week", "month", "year"):
            mode = "day"
        s, e = period_range(date, mode)

        # 汇总区间
        pi = pc = po = pr = 0
        d = s
        while d <= e:
            b = days.get(d.strftime("%Y-%m-%d"))
            if b:
                pi += b["i"]; pc += b["c"]; po += b["o"]; pr += b["r"]
            d += datetime.timedelta(days=1)

        # 累计
        ti = sum(b["i"] for b in days.values())
        to = sum(b["o"] for b in days.values())
        tc = sum(b["c"] for b in days.values())

        # API 请求次数：今日 / 累计（d["r"] 为按天聚合的请求数）
        today_api = sum(b["r"] for k, b in days.items() if k == today.isoformat())
        total_api = sum(b["r"] for b in days.values())

        # 区间单次请求平均消耗（tokens/次）；无请求时为 None
        period_avg = (pi + po) / pr if pr else None

        # 本周消费（周一到今天，固定卡片，不随查看区间变化）
        ws = today - datetime.timedelta(days=today.weekday())
        wi = wo = 0
        d = ws
        while d <= today:
            b = days.get(d.strftime("%Y-%m-%d"))
            if b:
                wi += b["i"]; wo += b["o"]
            d += datetime.timedelta(days=1)
        week_tokens = wi + wo

        # 图表与明细
        chart, breakdown, api_chart = [], [], []
        if mode == "day":
            b = days.get(date.strftime("%Y-%m-%d"), {"h": {}})
            for h in range(24):
                v = b["h"].get("%02d" % h)
                tok = (v[0] + v[1]) if v else 0
                api = v[2] if v else 0
                chart.append({"label": "%d时" % h, "tokens": tok,
                              "cost": round(tok * EFFECTIVE_PER_MILLION / 1e6, 4)})
                api_chart.append({"label": "%d时" % h, "api": api})
        elif mode in ("week", "month"):
            d = s
            while d <= e:
                b = days.get(d.strftime("%Y-%m-%d"))
                tok = (b["i"] + b["o"]) if b else 0
                rate = (b["c"] / b["i"]) if b and b["i"] else None
                label = ("%d/%d 周%s" % (d.month, d.day, CN_WEEK[d.weekday()])) if mode == "week" \
                    else ("%d/%d" % (d.month, d.day))
                chart.append({"label": label, "tokens": tok,
                              "cost": round(tok * EFFECTIVE_PER_MILLION / 1e6, 4)})
                api_chart.append({"label": label, "api": b["r"] if b else 0})
                breakdown.append({"label": label, "tokens": tok, "rate": rate,
                                  "cost": round(tok * EFFECTIVE_PER_MILLION / 1e6, 3)})
                d += datetime.timedelta(days=1)
            breakdown.reverse()
        else:  # year
            for m in range(1, 13):
                mi = mc = mo = mr = 0
                for dkey, b in days.items():
                    if dkey.startswith("%04d-%02d-" % (date.year, m)):
                        mi += b["i"]; mc += b["c"]; mo += b["o"]; mr += b["r"]
                tok = mi + mo
                chart.append({"label": "%d月" % m, "tokens": tok,
                              "cost": round(tok * EFFECTIVE_PER_MILLION / 1e6, 4)})
                api_chart.append({"label": "%d月" % m, "api": mr})
                breakdown.append({"label": "%d 月" % m, "tokens": tok,
                                  "rate": (mc / mi) if mi else None,
                                  "cost": round(tok * EFFECTIVE_PER_MILLION / 1e6, 3)})
            breakdown.reverse()

        # 区间文字
        if mode == "day":
            plabel = "%d 年 %d 月 %d 日 周%s" % (date.year, date.month, date.day,
                                                CN_WEEK[date.weekday()])
            if date == today:
                plabel += "（今天）"
        elif mode == "week":
            plabel = "%d/%d – %d/%d 这一周" % (s.month, s.day, e.month, e.day)
        elif mode == "month":
            plabel = "%d 年 %d 月" % (date.year, date.month)
        else:
            plabel = "%d 年" % date.year

        # 卡片短标签：当前区间用 今日/本周/本月/今年，翻到过去则用具体日期/区间，避免与固定卡片重名
        if mode == "day":
            period_short = "今日" if date == today else "%d/%d" % (date.month, date.day)
        elif mode == "week":
            period_short = "本周" if s <= today <= e \
                else "%d/%d–%d/%d" % (s.month, s.day, e.month, e.day)
        elif mode == "month":
            period_short = "本月" if s <= today <= e else "%d月" % date.month
        else:
            period_short = "今年" if s <= today <= e else "%d年" % date.year

        # 按天汇总（周/月/年分组视图的"天=组"表头数据）
        day_sum = {}
        if mode != "day":
            d = s
            while d <= e:
                b = days.get(d.strftime("%Y-%m-%d"))
                if b and (b["i"] + b["o"]) > 0:
                    day_sum[d.strftime("%Y-%m-%d")] = {
                        "label": "%d/%d 周%s" % (d.month, d.day, CN_WEEK[d.weekday()]),
                        "tokens": b["i"] + b["o"],
                        "rate": (b["c"] / b["i"]) if b["i"] else None,
                        "cost": round((b["i"] + b["o"]) * EFFECTIVE_PER_MILLION / 1e6, 3),
                    }
                d += datetime.timedelta(days=1)

        # 任务明细表：日 = 当天，周/月/年 = 区间内全部任务（每行带 date 供前端按天分组）
        task_rows = []
        if mode in ("day", "week", "month", "year"):
            fmt_t = "%H:%M" if mode == "day" else "%m/%d %H:%M"
            for t in tasks:
                if not (s <= t["dt"].date() <= e):
                    continue
                tok = t["in"] + t["out"]
                task_rows.append({
                    "time": t["dt"].strftime(fmt_t),
                    "date": t["dt"].strftime("%Y-%m-%d"),
                    "label": t["label"], "tokens": tok,
                    "cost": round(tok * EFFECTIVE_PER_MILLION / 1e6, 3),
                    "id": t["tid"],
                    "kids": t.get("kids", 0),
                    "children": kid_rows(t, fmt_t),
                    "live": t["live"]})

        return {
            "balance": self.balance.value,
            "updated": datetime.datetime.now(LOCAL_TZ).strftime("%H:%M:%S"),
            "mode": mode, "date": date.isoformat(),
            "period_label": plabel,
            "period_short": period_short,
            "period_tokens": pi + po,
            "period_cost": (pi + po) * EFFECTIVE_PER_MILLION / 1e6,
            "period_requests": pr,
            "cache_rate": (pc / pi) if pi else None,
            "week_tokens": week_tokens,
            "week_cost": week_tokens * EFFECTIVE_PER_MILLION / 1e6,
            "today_api": today_api,
            "total_api": total_api,
            "period_avg": period_avg,
            "total_tokens": ti + to,
            "total_cost": (ti + to) * EFFECTIVE_PER_MILLION / 1e6,
            # 全历史输入/缓存命中/输出结构（官方标价折算用）+ 每亿 Token 均价
            "total_in": ti, "total_cached": tc, "total_out": to,
            "avg_per_yi": EFFECTIVE_PER_MILLION * 100,
            "chart": chart, "api_chart": api_chart, "breakdown": breakdown, "day_sum": day_sum,
            "tasks": task_rows,
            "is_today_period": s <= today <= e,
        }

    def search_tasks(self, keyword):
        """全局搜索任务（跨全部日期），按任务名关键词匹配，返回消耗列表。"""
        kw = (keyword or "").strip().lower()
        if not kw:
            return []
        with self.scanner.lock:
            tasks = self.scanner.all_tasks()
        out = []
        for t in tasks:
            if kw in t["label"].lower():
                tok = t["in"] + t["out"]
                out.append({
                    "time": t["dt"].strftime("%Y-%m-%d %H:%M"),
                    "date": t["dt"].strftime("%Y-%m-%d"),
                    "label": t["label"], "tokens": tok,
                    "cost": round(tok * EFFECTIVE_PER_MILLION / 1e6, 3),
                    "id": t["tid"],
                    "kids": t.get("kids", 0),
                    "children": kid_rows(t, "%Y-%m-%d %H:%M"),
                    "live": t["live"]})
        return out[:300]

    def get_tasks_by_ids(self, tids):
        """按 tid 列表批量取任务（跨全部日期），分组视图用。"""
        ids = set(tids or [])
        if not ids:
            return []
        with self.scanner.lock:
            tasks = self.scanner.all_tasks()
        out = []
        for t in tasks:
            if t["tid"] in ids:
                tok = t["in"] + t["out"]
                out.append({
                    "time": t["dt"].strftime("%Y-%m-%d %H:%M"),
                    "date": t["dt"].strftime("%Y-%m-%d"),
                    "label": t["label"], "tokens": tok,
                    "cost": round(tok * EFFECTIVE_PER_MILLION / 1e6, 3),
                    "id": t["tid"],
                    "kids": t.get("kids", 0),
                    "children": kid_rows(t, "%Y-%m-%d %H:%M"),
                    "live": t["live"]})
        return out[:500]

    def merge_tasks(self, parent_tid, child_tids):
        """把若干子任务并入父任务（拖拽合并），映射存 merges.json。"""
        if not parent_tid or not isinstance(child_tids, list):
            return False
        children = [c for c in child_tids
                    if isinstance(c, str) and c and c != parent_tid]
        if not children:
            return False
        m = load_merges()
        child_set = set(children)
        for cid in child_set:
            m[cid] = parent_tid
        # 扁平化：原来挂在子任务下的孙任务改挂到新父任务
        for k, v in list(m.items()):
            if v in child_set:
                m[k] = parent_tid
        m.pop(parent_tid, None)  # 父任务自己不能是别人的子任务
        try:
            json.dump(m, open(MERGE_FILE, "w", encoding="utf-8"))
            return True
        except Exception:
            return False

    def edit_task(self, tid, new_label):
        """按 tid（文件路径#下标）修改任务名称，写回缓存持久化。"""
        new_label = (new_label or "").strip()
        if not tid or not new_label:
            return False
        path, _, sidx = tid.rpartition("#")
        try:
            idx = int(sidx)
        except ValueError:
            return False
        with self.scanner.lock:
            st = self.scanner.states.get(path)
            if not isinstance(st, dict):
                return False
            tasks = st.get("tasks", [])
            if idx < 0 or idx >= len(tasks):
                return False
            tasks[idx]["label"] = new_label[:60]
            try:
                json.dump(self.scanner.states,
                          open(CACHE_FILE, "w", encoding="utf-8"))
            except Exception:
                pass
        return True

    def get_settings(self):
        """前端启动时读取面板设置（亿位高亮/图表合并/收纳/排序/明细高度），保持上次状态。"""
        return load_settings()

    def set_setting(self, key, value):
        """保存面板设置（白名单），写入 exe 旁的 settings.json，重启后仍生效。"""
        d = load_settings()
        if value is None:
            d.pop(key, None)
        elif key == "hiYi":
            d[key] = bool(value)
        elif key == "chart_mode":
            d[key] = "merge" if value == "merge" else "split"
        elif key == "chart_layout":
            d[key] = "h" if value == "h" else "v"
        elif key == "panel_order":
            if isinstance(value, list):
                d[key] = [str(x) for x in value if isinstance(x, str)][:10]
            else:
                return False
        elif key == "panel_collapsed":
            if isinstance(value, dict):
                d[key] = {str(k): bool(v) for k, v in value.items()}
            else:
                return False
        elif key == "task_h":
            try:
                d[key] = max(120, min(2000, int(value)))
            except Exception:
                return False
        else:
            return False
        save_settings(d)
        return True


def load_ui_state():
    try:
        d = json.load(open(UI_FILE, encoding="utf-8"))
        w, h = int(d.get("w", 0)), int(d.get("h", 0))
        mx = bool(d.get("max"))
        if w < 700:
            w = 1060
        if h < 500:
            h = 860
        return w, h, mx
    except Exception:
        return 1060, 860, False


def watch_size():
    """每 2 秒用 Win32 读窗口真实尺寸/最大化状态，变了就记下来，下次启动恢复。"""
    import ctypes
    import ctypes.wintypes
    u = ctypes.windll.user32
    EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    last = None
    seen = False
    while True:
        time.sleep(2)
        try:
            found = []

            def cb(hwnd, lp):
                if u.IsWindowVisible(hwnd):
                    n = u.GetWindowTextLengthW(hwnd)
                    buf = ctypes.create_unicode_buffer(n + 1)
                    u.GetWindowTextW(hwnd, buf, n + 1)
                    if buf.value == "Codex 用量面板":
                        found.append(hwnd)
                return True

            u.EnumWindows(EnumProc(cb), 0)
            if not found:
                if seen:
                    return  # 窗口已关闭，线程结束
                continue  # 窗口还没出来，继续等
            hwnd = found[0]
            seen = True
            if u.IsZoomed(hwnd):
                cur = {"max": True}
            else:
                rc = ctypes.wintypes.RECT()
                u.GetWindowRect(hwnd, ctypes.byref(rc))
                cur = {"w": rc.right - rc.left, "h": rc.bottom - rc.top, "max": False}
            if cur != last and (cur.get("max") or (cur["w"] >= 700 and cur["h"] >= 500)):
                last = cur
                json.dump(cur, open(UI_FILE, "w", encoding="utf-8"))
        except Exception:
            return


def ensure_single_instance():
    """单实例互斥：已有面板在运行则激活它并返回 False；否则持有互斥量继续启动。"""
    import ctypes
    ERROR_ALREADY_EXISTS = 183
    k = ctypes.windll.kernel32
    mutex = k.CreateMutexW(None, False, "Local\\CodexTokens_SingleInstance")
    if k.GetLastError() == ERROR_ALREADY_EXISTS:
        u = ctypes.windll.user32
        EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        found = []

        def cb(hwnd, lp):
            if u.IsWindowVisible(hwnd):
                n = u.GetWindowTextLengthW(hwnd)
                buf = ctypes.create_unicode_buffer(n + 1)
                u.GetWindowTextW(hwnd, buf, n + 1)
                if buf.value == "Codex 用量面板":
                    found.append(hwnd)
            return True

        u.EnumWindows(EnumProc(cb), 0)
        for hwnd in found:
            if u.IsIconic(hwnd):
                u.ShowWindow(hwnd, 9)  # SW_RESTORE
            u.SetForegroundWindow(hwnd)
        return False
    globals()["_SINGLE_MUTEX"] = mutex  # 持有句柄直到进程退出
    return True


def run_web(api, port):
    """网页版：本地 HTTP 服务，浏览器打开即用（Mac/Windows 通用，无需 pywebview）。"""
    import urllib.parse
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, ctype, data):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _json(self, obj, code=200):
            data = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
            self._send(code, "application/json; charset=utf-8", data)

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path in ("/", "/index.html"):
                try:
                    data = open(os.path.join(RES_DIR, "index.html"),
                                encoding="utf-8").read().encode("utf-8")
                except OSError:
                    self._send(500, "text/plain; charset=utf-8", b"index.html not found")
                    return
                self._send(200, "text/html; charset=utf-8", data)
            elif u.path == "/api/data":
                self._json(api.get_data(q.get("date", [None])[0],
                                        q.get("mode", ["day"])[0]))
            elif u.path == "/api/search":
                self._json(api.search_tasks(q.get("kw", [""])[0]))
            elif u.path == "/api/tasks":
                ids = [x for x in (q.get("ids", [""])[0] or "").split(",") if x]
                self._json(api.get_tasks_by_ids(ids))
            elif u.path == "/api/settings":
                self._json(api.get_settings())
            else:
                self._json({"error": "not found"}, 404)

        def do_POST(self):
            u = urllib.parse.urlparse(self.path)
            try:
                n = int(self.headers.get("Content-Length", 0) or 0)
                body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
            except Exception:
                body = {}
            if u.path == "/api/edit_task":
                self._json({"ok": api.edit_task(body.get("tid"),
                                                body.get("label"))})
            elif u.path == "/api/merge":
                self._json({"ok": api.merge_tasks(body.get("parent"),
                                                  body.get("children"))})
            elif u.path == "/api/setting":
                self._json({"ok": api.set_setting(body.get("key"),
                                                  body.get("value"))})
            else:
                self._json({"error": "not found"}, 404)

    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("Codex 用量面板（网页版）已启动： http://127.0.0.1:%d/" % port)
    print("按 Ctrl+C 停止。")
    try:
        import webbrowser
        webbrowser.open("http://127.0.0.1:%d/" % port)
    except Exception:
        pass
    srv.serve_forever()


def main():
    if "--web" in sys.argv:
        port = 8765
        for a in sys.argv:
            if a.startswith("--port="):
                try:
                    port = int(a.split("=", 1)[1])
                except Exception:
                    pass
        scanner = LogScanner()
        scanner.scan_all()
        api = Api(scanner, BalanceFetcher())
        run_web(api, port)
        return
    if sys.platform == "win32":
        if not ensure_single_instance():
            return  # 已有面板在运行，本实例退出
    scanner = LogScanner()
    balance = BalanceFetcher()
    api = Api(scanner, balance)
    html = open(os.path.join(RES_DIR, "index.html"), encoding="utf-8").read()
    w, h, mx = load_ui_state()
    win = webview.create_window("Codex 用量面板", html=html, js_api=api,
                                width=w, height=h, min_size=(900, 600))
    if mx:
        win.events.shown += lambda: win.maximize()
    if sys.platform == "win32":
        threading.Thread(target=watch_size, daemon=True).start()
    webview.start()


if __name__ == "__main__":
    if "--dump" in sys.argv:
        s = LogScanner()
        s.scan_all()
        api = Api.__new__(Api)
        api.scanner, api.balance = s, type("B", (), {"value": None})()
        ds = next((a for a in sys.argv if re.match(r"\d{4}-\d{2}-\d{2}", a)), None)
        md = next((a for a in sys.argv if a in ("day", "week", "month", "year")), "day")
        d = api.get_data(ds, md)
        print(json.dumps({k: v for k, v in d.items() if k != "tasks"},
                         ensure_ascii=False, default=str)[:1500])
        print("tasks:", len(d["tasks"]))
    else:
        main()
