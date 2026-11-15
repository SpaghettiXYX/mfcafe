#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
排队叫号显示屏 — 驱动 Divoom Times Gate 某一块屏。

状态由一个 JSON 文件驱动（默认 ./queue_state.json），外部点单系统
只需改写这个文件，本脚本每 N 秒读取并刷新屏幕。

queue_state.json 格式：
  {
    "number": 23,        // 当前叫号
    "prefix": "A",       // 号段前缀
    "wait_count": 5,     // 等待人数
    "status": "请取餐"   // 顶部状态文字
  }

也支持命令行直接设置（写入同一个 JSON）：
  python3 queue_display.py set --number 24 --wait 4
  python3 queue_display.py next        # number +1
  python3 queue_display.py run         # 常驻刷新
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from divoom_display import DivoomTimesGate
from render_dashboard import render_queue_number

DEFAULT_STATE = {
    "number": 1,
    "prefix": "A",
    "wait_count": 0,
    "status": "请取餐",
}


def load_state(path: str) -> dict:
    if not os.path.exists(path):
        return dict(DEFAULT_STATE)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        merged = dict(DEFAULT_STATE)
        merged.update(data)
        return merged
    except Exception:
        return dict(DEFAULT_STATE)


def save_state(path: str, state: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def push(dev: DivoomTimesGate, screen: int, state: dict) -> None:
    img = render_queue_number(
        number=state["number"],
        prefix=state["prefix"],
        wait_count=state.get("wait_count"),
        status=state.get("status", "请取餐"),
    )
    dev.push_to_screen(screen, img)


def main() -> None:
    ap = argparse.ArgumentParser(description="Divoom 排队叫号屏")
    ap.add_argument("--host", default=os.environ.get("DIVOOM_HOST", "192.168.1.50"))
    ap.add_argument("--screen", type=int, default=0, help="使用第几块屏 (0-4)")
    ap.add_argument("--state", default="./queue_state.json")
    ap.add_argument("--interval", type=float, default=2.0, help="刷新间隔秒")
    sub = ap.add_subparsers(dest="cmd")

    p_run = sub.add_parser("run", help="常驻刷新")
    p_set = sub.add_parser("set", help="设置状态")
    p_set.add_argument("--number", type=int)
    p_set.add_argument("--prefix")
    p_set.add_argument("--wait", type=int, dest="wait_count")
    p_set.add_argument("--status")
    p_next = sub.add_parser("next", help="号码 +1")

    args = ap.parse_args()
    dev = DivoomTimesGate(args.host)

    if args.cmd == "set":
        state = load_state(args.state)
        for k in ("number", "prefix", "wait_count", "status"):
            v = getattr(args, k, None)
            if v is not None:
                state[k] = v
        save_state(args.state, state)
        push(dev, args.screen, state)
        print("已更新:", state)
        return

    if args.cmd == "next":
        state = load_state(args.state)
        state["number"] = int(state["number"]) + 1
        save_state(args.state, state)
        push(dev, args.screen, state)
        print("下一号:", state["number"])
        return

    # 默认 run
    print(f"排队叫号屏运行中: host={args.host} screen={args.screen}")
    print(f"状态文件: {args.state}  (Ctrl-C 退出)")
    last = None
    try:
        while True:
            state = load_state(args.state)
            if state != last:
                push(dev, args.screen, state)
                last = state
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n已退出")


if __name__ == "__main__":
    main()
