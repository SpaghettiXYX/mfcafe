#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Divoom Times Gate 设备发现 + 分屏参数探测工具。

用法：
  1) 自动发现局域网设备（需能访问 Divoom 云端）：
       python3 discover.py
  2) 指定 IP 探测分屏寻址方式：
       python3 discover.py 192.168.1.50

探测逻辑：依次尝试几种常见的"选中子屏"命令和"推图带屏索引"字段，
把每种尝试的设备响应打印出来，由你判断哪种生效。
"""

from __future__ import annotations

import sys
import time

from PIL import Image

from divoom_display import DivoomTimesGate, DivoomError, discover_devices


# 候选的分屏命令（select 模式）
SUB_INDEX_CANDIDATES = [
    ("Channel/SetSubIndex", "SelectSubIndex"),
    ("Channel/SetSubScreenIndex", "SubScreenIndex"),
    ("Channel/SelectSubIndex", "SelectSubIndex"),
    ("Channel/SetIndex", "SelectSubIndex"),
]

# 候选的推图内嵌屏索引字段名（inline 模式）
INLINE_PARAM_CANDIDATES = [
    "ScreenIndex",
    "SubIndex",
    "SubScreenIndex",
    "SelectIndex",
]


def make_test_image(label: str) -> Image.Image:
    from render_dashboard import render_text_lines
    return render_text_lines(["TEST", label])


def probe(host: str) -> None:
    dev = DivoomTimesGate(host)
    print(f"== 设备 {host} ==")

    # 1) 基础连通性
    print("\n[1] 基础连通 / 设置查询")
    try:
        s = dev.get_settings()
        print("  OK ->", s)
    except DivoomError as e:
        print(f"  失败: {e}")
        print("  提示：设备需完成云端握手后本地 API 才开放。")
        return

    # 2) 探测 select 模式：发送各候选"选中子屏"命令
    print("\n[2] 探测 select-sub-screen 命令（看哪条不报错）")
    for cmd, param in SUB_INDEX_CANDIDATES:
        try:
            r = dev.send_command({"Command": cmd, param: 0})
            print(f"  {cmd} / {param} -> OK: {r}")
        except DivoomError as e:
            print(f"  {cmd} / {param} -> 不支持 ({e.error_code})")

    # 3) 探测 inline 模式：推一张带屏索引字段的图
    print("\n[3] 探测 inline 屏索引字段（推图到 screen 0）")
    test_img = make_test_image("S0")
    for param in INLINE_PARAM_CANDIDATES:
        try:
            dev2 = DivoomTimesGate(host, screen_index_param=param)
            r = dev2.push_image(test_img, screen_index=0)
            print(f"  field={param} -> OK: {r}")
        except DivoomError as e:
            print(f"  field={param} -> 不支持 ({e.error_code})")
        time.sleep(0.3)

    # 4) 不带动屏索引直接推图（默认落到当前屏）
    print("\n[4] 无屏索引直接推图（应落在当前选中屏）")
    try:
        r = dev.push_image(make_test_image("NOW"))
        print(f"  OK: {r}")
    except DivoomError as e:
        print(f"  失败: {e}")

    print("\n== 探测完成。根据上面 OK 的项，")
    print("   在 DivoomTimesGate(...) 构造参数里填对应的 screen_index_param / sub_index_command / sub_index_param。")


def main() -> None:
    if len(sys.argv) >= 2:
        host = sys.argv[1]
        probe(host)
        return

    print("尝试通过 Divoom 云端发现局域网设备...")
    try:
        devices = discover_devices()
    except DivoomError as e:
        print(f"发现失败: {e}")
        print("请手动指定设备 IP: python3 discover.py <IP>")
        return
    if not devices:
        print("未发现设备。请确认手机 App 已把设备添加到同一账号，")
        print("并手动指定 IP: python3 discover.py <IP>")
        return
    print(f"发现 {len(devices)} 台设备：")
    for d in devices:
        print(f"  - {d.get('device_name')} @ {d.get('device_private_ip')} (id={d.get('device_id')})")
    ip = devices[0].get("device_private_ip")
    if ip:
        print(f"\n对第一台 {ip} 进行探测...")
        probe(ip)


if __name__ == "__main__":
    main()
