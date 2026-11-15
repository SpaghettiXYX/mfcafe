#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Divoom Times Gate 本地 LAN API 封装。

协议要点（基于 Divoom Pixoo 系列逆向协议，Times Gate 同源）：
  - 设备上电后必须先完成与 Divoom 云端的 MQTT+HTTPS 握手，
    之后本机局域网才会开放 HTTP API（http://{host}/post）。
  - 所有命令都是 POST JSON 到 /post，无鉴权。
  - 推图：Command=Draw/SendHttpGif，PicData 为 base64 编码的 RGB888 原始字节。
  - Times Gate 有 5 块 128x128 屏，分屏寻址参数名在公开资料中未完全确定，
    本模块支持两种模式并提供探测脚本 discover.py。

依赖：requests, Pillow
"""

from __future__ import annotations

import base64
import itertools
import time
from typing import Optional

import requests
from PIL import Image


DEFAULT_SCREEN_SIZE = 128
DEFAULT_TIMEOUT = 9  # 与社区库一致，9 秒超时
DEFAULT_BRIGHTNESS = 60


class DivoomError(Exception):
    """Divoom 设备返回的错误。"""

    def __init__(self, message: str, error_code: Optional[int] = None):
        super().__init__(message)
        self.error_code = error_code


class DivoomTimesGate:
    """控制一台 Divoom Times Gate。"""

    def __init__(
        self,
        host: str,
        screen_size: int = DEFAULT_SCREEN_SIZE,
        timeout: int = DEFAULT_TIMEOUT,
        screen_index_param: str = "ScreenIndex",
        sub_index_command: str = "Channel/SetSubIndex",
        sub_index_param: str = "SelectSubIndex",
    ):
        """
        host: 设备局域网 IP（如 192.168.1.50）。
        screen_size: 单屏像素边长，Times Gate 为 128。
        timeout: HTTP 超时秒数。
        screen_index_param: 推图命令里携带屏索引的字段名（默认猜测 "ScreenIndex"）。
                            若你的固件不识别，可用 discover.py 探测或直接改这里。
        sub_index_command / sub_index_param:
            "select" 分屏模式下，先发送此命令选中某块子屏再推图。
            默认猜测 Channel/SetSubIndex + SelectSubIndex。
        """
        self.host = host.rstrip("/")
        if not self.host.startswith("http"):
            self.host = f"http://{self.host}"
        self.url = f"{self.host}/post"
        self.screen_size = screen_size
        self.timeout = timeout
        self.screen_index_param = screen_index_param
        self.sub_index_command = sub_index_command
        self.sub_index_param = sub_index_param
        # PicID 自动递增，避免动画 ID 冲突
        self._pic_id_iter = itertools.count(1)

    # ---------- 底层通信 ----------

    def send_command(self, payload: dict) -> dict:
        """发送一条命令，返回设备 JSON 响应。"""
        try:
            resp = requests.post(self.url, json=payload, timeout=self.timeout)
        except requests.RequestException as e:
            raise DivoomError(f"请求设备失败: {e}") from e
        if resp.status_code != 200:
            raise DivoomError(
                f"设备返回 HTTP {resp.status_code}: {resp.text[:200]}"
            )
        try:
            data = resp.json()
        except ValueError as e:
            raise DivoomError(f"设备返回非 JSON: {resp.text[:200]}") from e
        err = data.get("error_code")
        if err not in (0, None):
            raise DivoomError(
                f"设备返回 error_code={err}: {data}", error_code=err
            )
        return data

    def raw_command(self, **kwargs) -> dict:
        """透传任意 JSON 命令，用于探测 / 实验。"""
        return self.send_command(kwargs)

    # ---------- 系统 / 设置 ----------

    def get_settings(self) -> dict:
        """获取设备全部设置。"""
        return self.send_command({"Command": "Channel/GetAllSettings"})

    def get_device_time(self) -> dict:
        return self.send_command({"Command": "Device/GetDeviceTime"})

    def set_brightness(self, brightness: int) -> dict:
        """0-100。"""
        brightness = max(0, min(100, int(brightness)))
        return self.send_command(
            {"Command": "Channel/SetBrightness", "Brightness": brightness}
        )

    def set_screen_power(self, on: bool) -> dict:
        """开关屏幕背光。"""
        return self.send_command(
            {"Command": "System/SetScreenPowerState", "State": 1 if on else 0}
        )

    def reboot(self) -> dict:
        return self.send_command({"Command": "System/Reset"})

    # ---------- 频道 ----------

    def set_channel(self, index: int) -> dict:
        """切换整体频道（0=Clock, 1=Cloud, 2=Visualizer, 3=CustomPage 等，视固件而定）。"""
        return self.send_command(
            {"Command": "Channel/SetIndex", "SelectIndex": int(index)}
        )

    def select_sub_screen(self, sub_index: int) -> dict:
        """
        选中某一块子屏（Times Gate 的 5 块屏之一，0-4）。
        之后推图会落在该屏上。参数名可在构造时调整。
        """
        return self.send_command(
            {
                "Command": self.sub_index_command,
                self.sub_index_param: int(sub_index),
            }
        )

    # ---------- 推图 ----------

    def reset_gif_id(self) -> dict:
        """重置动画 PicID 计数。推图前调用一次更稳妥。"""
        return self.send_command({"Command": "Draw/ResetHttpGifId"})

    def push_image(
        self,
        image: Image.Image,
        screen_index: Optional[int] = None,
        pic_id: Optional[int] = None,
        speed_ms: int = 100,
    ) -> dict:
        """
        把一张 PIL 图像推到设备。
        - 自动缩放到 screen_size x screen_size，转 RGB888，base64 编码。
        - screen_index:
            None -> 推到当前选中的子屏（配合 select_sub_screen 使用）
            0-4  -> 在推图命令里附带屏索引字段（inline 模式）
        """
        if image.size != (self.screen_size, self.screen_size):
            image = image.resize(
                (self.screen_size, self.screen_size), Image.LANCZOS
            )
        rgb = image.convert("RGB")
        raw = rgb.tobytes()  # RGB888, 3 bytes/pixel
        pic_data = base64.b64encode(raw).decode("ascii")

        if pic_id is None:
            pic_id = next(self._pic_id_iter)

        payload = {
            "Command": "Draw/SendHttpGif",
            "PicNum": 1,
            "PicWidth": self.screen_size,
            "PicOffset": 0,
            "PicID": pic_id,
            "PicSpeed": speed_ms,
            "PicData": pic_data,
        }
        if screen_index is not None:
            payload[self.screen_index_param] = int(screen_index)
        return self.send_command(payload)

    def push_to_screen(
        self,
        screen_index: int,
        image: Image.Image,
        mode: str = "auto",
    ) -> dict:
        """
        推图到指定子屏（0-4）。
        mode:
          "auto"   -> 先试 inline 字段；若失败回退到 select 模式。
          "inline" -> 直接在 Draw/SendHttpGif 里带屏索引字段。
          "select" -> 先 select_sub_screen 再推图。
        """
        if mode == "inline":
            return self.push_image(image, screen_index=screen_index)
        if mode == "select":
            self.select_sub_screen(screen_index)
            time.sleep(0.05)
            return self.push_image(image)
        # auto
        try:
            return self.push_image(image, screen_index=screen_index)
        except DivoomError:
            self.select_sub_screen(screen_index)
            time.sleep(0.05)
            return self.push_image(image)


# ---------- 设备发现 ----------

def discover_devices(timeout: float = 2.0) -> list[dict]:
    """
    通过 Divoom 云端服务发现同局域网内的设备。
    返回 [{device_name, device_id, device_private_ip}, ...]。
    注意：需要能访问 app.divoom-gz.com。
    """
    url = "https://app.divoom-gz.com/Device/GetSameLANDevice"
    try:
        resp = requests.post(url, json={}, timeout=timeout)
        data = resp.json()
    except Exception as e:
        raise DivoomError(f"发现设备失败（需联网访问 Divoom 云端）: {e}") from e
    return data.get("DeviceList", []) or []


if __name__ == "__main__":
    # 快速自检：python3 divoom_display.py 192.168.1.50
    import sys

    if len(sys.argv) < 2:
        print("用法: python3 divoom_display.py <设备IP>")
        sys.exit(1)
    dev = DivoomTimesGate(sys.argv[1])
    print("获取设置...")
    try:
        s = dev.get_settings()
        print("OK:", s)
    except DivoomError as e:
        print("失败:", e)
        print("提示：确认设备已连网并完成云端握手（屏上显示正常内容）。")
