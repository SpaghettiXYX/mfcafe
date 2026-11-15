#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
吧台状态显示屏 — 驱动 Divoom Times Gate 某一块屏。

状态由 JSON 文件驱动（默认 ./bar_state.json）：
  {
    "open": true,           // 是否营业
    "current_order": "A023",// 制作中订单号，null 表示空闲
    "cups_today": 42,       // 今日杯数
    "message": null         // 自定义底部消息（覆盖 cups_today）
  }

命令行：
  python3 bar_status.py run
  python3 bar_status.py set --open true --current A023 --cups 42
  python3 bar_status.py close
"""

from __future__ import annotations

import argparse
import json
import os
import time

from divoom_display import DivoomTimesGate
from render_dashboard import render_bar_status

DEFAULT_STATE = {
    "open": True,
    "current_order": None,
    "cups_today": 0,
    "message": None,
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
    img = render_bar_status(
        open=state["open"],
        current_order=state.get("current_order"),
        cups_today=state.get("cups_today"),
        message=state.get("message"),
    )
    dev.push_to_screen(screen, img)


def main() -> None:
    ap = argparse.ArgumentParser(description="Divoom 吧台状态屏")
    ap.add_argument("--host", default=os.environ.get("DIVOOM_HOST", "192.168.1.50"))
    ap.add_argument("--screen", type=int, default=1)
    ap.add_argument("--state", default="./bar_state.json")
    ap.add_argument("--interval", type=float, default=2.0)
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("run")
    p_set = sub.add_parser("set")
    p_set.add_argument("--open", choices=["true", "false"])
    p_set.add_argument("--current", dest="current_order")
    p_set.add_argument("--cups", type=int, dest="cups_today")
    p_set.add_argument("--message")
    sub.add_parser("close")
    sub.add_parser("open")

    args = ap.parse_args()
    dev = DivoomTimesGate(args.host)

    if args.cmd == "set":
        state = load_state(args.state)
        if args.open is not None:
            state["open"] = args.open == "true"
        if args.current_order is not None:
            state["current_order"] = args.current_order or None
        if args.cups_today is not None:
            state["cups_today"] = args.cups_today
        if args.message is not None:
            state["message"] = args.message or None
        save_state(args.state, state)
        push(dev, args.screen, state)
        print("已更新:", state)
        return

    if args.cmd == "close":
        state = load_state(args.state)
        state["open"] = False
        state["current_order"] = None
        save_state(args.state, state)
        push(dev, args.screen, state)
        print("已打烊")
        return

    if args.cmd == "open":
        state = load_state(args.state)
        state["open"] = True
        save_state(args.state, state)
        push(dev, args.screen, state)
        print("已营业")
        return

    print(f"吧台状态屏运行中: host={args.host} screen={args.screen}")
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
