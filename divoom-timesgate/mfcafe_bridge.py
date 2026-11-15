#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MFCAFE 后台 -> Divoom 屏幕 桥接。

轮询 Apps Script 的 getOrderHistory 接口，把订单状态翻译成：
  - queue_state.json  （排队叫号屏）
      number  = 最新 READY 订单的号段数字
      prefix  = 号段字母
      wait_count = PENDING + ASSIGNED 的数量
      status  = "请取餐"
  - bar_state.json    （吧台状态屏）
      open = 是否营业（默认 true）
      current_order = 最新 ASSIGNED 订单号（制作中），没有则 null
      cups_today = 今日 CLEARED 数量

用法：
  export MFCAFE_URL="https://script.google.com/macros/s/XXXX/exec"
  python3 mfcafe_bridge.py --host 192.168.1.50 --queue-screen 0 --bar-screen 1
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from datetime import datetime, timezone

import requests

import queue_display
import bar_status

DEFAULT_INTERVAL = 5.0


def fetch_orders(script_url: str, limit: int = 80) -> list[dict]:
    url = f"{script_url}?action=getOrderHistory&limit={limit}"
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    data = r.json()
    return data.get("orders", []) or []


def parse_order_num(order_num: str) -> tuple[str, int]:
    """把 'A023' 拆成 ('A', 23)。拆不出返回 ('', 0)。"""
    m = re.match(r"^([A-Za-z]+)?0*(\d+)$", str(order_num).strip())
    if not m:
        return ("", 0)
    prefix = (m.group(1) or "").upper()
    num = int(m.group(2))
    return (prefix, num)


def is_today(order_time: str) -> bool:
    if not order_time:
        return True
    try:
        # 格式 yyyy-MM-dd'T'HH:mm:ss'Z'
        dt = datetime.strptime(order_time[:19], "%Y-%m-%dT%H:%M:%S")
        return dt.date() == datetime.now().date()
    except Exception:
        return True


def compute_states(orders: list[dict]) -> tuple[dict, dict]:
    pending = [o for o in orders if o["status"] in ("PENDING", "ASSIGNED")]
    ready = [o for o in orders if o["status"] == "READY"]
    cleared_today = [
        o for o in orders if o["status"] == "CLEARED" and is_today(o.get("orderTime", ""))
    ]

    # 排队屏：取最新 READY 订单作为当前叫号
    q_state = dict(queue_display.DEFAULT_STATE)
    if ready:
        prefix, num = parse_order_num(ready[0]["orderNum"])
        q_state["prefix"] = prefix or "A"
        q_state["number"] = num
    q_state["wait_count"] = len(pending)
    q_state["status"] = "请取餐"

    # 吧台屏：最新 ASSIGNED 为制作中
    b_state = dict(bar_status.DEFAULT_STATE)
    assigned = [o for o in orders if o["status"] == "ASSIGNED"]
    b_state["current_order"] = assigned[0]["orderNum"] if assigned else None
    b_state["cups_today"] = len(cleared_today)

    return q_state, b_state


def main() -> None:
    ap = argparse.ArgumentParser(description="MFCAFE -> Divoom 桥接")
    ap.add_argument("--url", default=os.environ.get("MFCAFE_URL", ""),
                    help="Apps Script Web App URL")
    ap.add_argument("--host", default=os.environ.get("DIVOOM_HOST", "192.168.1.50"))
    ap.add_argument("--queue-screen", type=int, default=0)
    ap.add_argument("--bar-screen", type=int, default=1)
    ap.add_argument("--interval", type=float, default=DEFAULT_INTERVAL)
    ap.add_argument("--once", action="store_true", help="只跑一次")
    args = ap.parse_args()

    if not args.url:
        print("请设置 MFCAFE_URL 环境变量或 --url 参数")
        return

    from divoom_display import DivoomTimesGate
    from render_dashboard import render_queue_number, render_bar_status

    dev = DivoomTimesGate(args.host)
    print(f"桥接运行中: {args.url}")
    print(f"  排队屏 -> screen {args.queue_screen}")
    print(f"  吧台屏 -> screen {args.bar_screen}")
    print(f"  轮询间隔 {args.interval}s  (Ctrl-C 退出)")

    last_q = None
    last_b = None
    while True:
        try:
            orders = fetch_orders(args.url)
            q_state, b_state = compute_states(orders)

            if q_state != last_q:
                queue_display.save_state("./queue_state.json", q_state)
                dev.push_to_screen(
                    args.queue_screen,
                    render_queue_number(
                        q_state["number"], q_state["prefix"],
                        q_state["wait_count"], q_state["status"],
                    ),
                )
                last_q = q_state
                print(f"  [排队] {q_state['prefix']}{q_state['number']:03d}  等待{q_state['wait_count']}")

            if b_state != last_b:
                bar_status.save_state("./bar_state.json", b_state)
                dev.push_to_screen(
                    args.bar_screen,
                    render_bar_status(
                        open=b_state["open"],
                        current_order=b_state["current_order"],
                        cups_today=b_state["cups_today"],
                    ),
                )
                last_b = b_state
                cur = b_state["current_order"] or "空闲"
                print(f"  [吧台] {cur}  今日{b_state['cups_today']}杯")

        except Exception as e:
            print(f"  错误: {e}")

        if args.once:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
