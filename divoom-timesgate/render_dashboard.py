#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把"排队号 / 吧台状态"等信息渲染成 128x128 的 PIL 图像，
供 DivoomTimesGate.push_image() 推送到屏幕。

设计取向：128x128 像素小屏，文字要粗、对比度高、信息密度低。
支持中文（默认 Noto Sans CJK SC）。
"""

from __future__ import annotations

import os
from typing import Optional, Tuple

from PIL import Image, ImageDraw, ImageFont

SCREEN = 128

# 配色（适合深色背景的小屏，醒目）
BG_DARK = (18, 18, 24)
BG_OK = (16, 60, 36)        # 营业中 - 深绿
BG_BUSY = (70, 44, 8)      # 忙碌 - 深橙
BG_CLOSED = (58, 16, 16)   # 打烊 - 深红
FG_WHITE = (240, 240, 245)
FG_ACCENT = (120, 220, 255)
FG_GOLD = (255, 200, 60)
FG_DIM = (150, 150, 165)

# 默认中文字体（系统安装了 Noto Sans CJK SC 时可用）
_FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto-cjk-otf/NotoSansCJKsc-Bold.otf",
    "/usr/share/fonts/opentype/noto-cjk-otf/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
]


def _load_font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    paths = []
    env_font = os.environ.get("DIVOOM_FONT")
    if env_font and os.path.exists(env_font):
        paths.append(env_font)
    # 让 fontconfig 帮忙找
    try:
        import subprocess

        style = "Bold" if bold else "Regular"
        r = subprocess.run(
            ["fc-match", f"Noto Sans CJK SC:style={style}", "-f", "%{file}"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if r.returncode == 0 and r.stdout.strip():
            paths.append(r.stdout.strip())
    except Exception:
        pass
    paths.extend(_FONT_CANDIDATES)
    for p in paths:
        if p and os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    # 兜底：位图默认字体（不支持中文）
    return ImageFont.load_default()


def _text_size(draw: ImageDraw.ImageDraw, text: str, font) -> Tuple[int, int]:
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def _center_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    y: int,
    font,
    fill=FG_WHITE,
) -> None:
    w, h = _text_size(draw, text, font)
    x = (SCREEN - w) // 2
    draw.text((x, y), text, font=font, fill=fill)


# ============ 排队叫号屏 ============

def render_queue_number(
    number: int,
    prefix: str = "A",
    wait_count: Optional[int] = None,
    status: str = "请取餐",
) -> Image.Image:
    """
    排队叫号主画面。
    - 上方小字：状态（如 "请取餐" / "制作中"）
    - 中间超大号：prefix + number（如 A023）
    - 下方：等待人数（可选）
    """
    img = Image.new("RGB", (SCREEN, SCREEN), BG_DARK)
    draw = ImageDraw.Draw(img)

    # 顶部状态条
    status_font = _load_font(16)
    _center_text(draw, status, 6, status_font, fill=FG_ACCENT)

    # 中间大号号码
    label = f"{prefix}{number:03d}"
    # 根据位数选字号
    if len(label) <= 4:
        num_font = _load_font(64)
    else:
        num_font = _load_font(52)
    nw, nh = _text_size(draw, label, num_font)
    nx = (SCREEN - nw) // 2
    ny = (SCREEN - nh) // 2 - 4
    draw.text((nx, ny), label, font=num_font, fill=FG_GOLD)

    # 底部等待人数
    if wait_count is not None:
        wait_font = _load_font(15)
        wait_text = f"等待 {wait_count} 位"
        _center_text(draw, wait_text, SCREEN - 22, wait_font, fill=FG_DIM)

    return img


# ============ 吧台状态屏 ============

def render_bar_status(
    open: bool = True,
    current_order: Optional[str] = None,
    cups_today: Optional[int] = None,
    message: Optional[str] = None,
) -> Image.Image:
    """
    吧台状态画面。
    - 顶部：OPEN / CLOSED / BUSY
    - 中部：当前制作中订单号（可选）
    - 底部：今日杯数 或 自定义消息
    """
    if not open:
        bg = BG_CLOSED
        tag = "CLOSED"
        tag_color = (255, 120, 120)
    elif current_order:
        bg = BG_BUSY
        tag = "BUSY"
        tag_color = FG_GOLD
    else:
        bg = BG_OK
        tag = "OPEN"
        tag_color = (120, 255, 170)

    img = Image.new("RGB", (SCREEN, SCREEN), bg)
    draw = ImageDraw.Draw(img)

    # 顶部状态标签
    tag_font = _load_font(22)
    _center_text(draw, tag, 8, tag_font, fill=tag_color)

    # 分隔线
    draw.line([(16, 38), (SCREEN - 16, 38)], fill=tag_color, width=2)

    # 中部当前订单
    if current_order:
        co_font = _load_font(18)
        _center_text(draw, "制作中", 46, co_font, fill=FG_DIM)
        order_font = _load_font(34)
        _center_text(draw, current_order, 68, order_font, fill=FG_WHITE)
    else:
        idle_font = _load_font(20)
        _center_text(draw, "空闲中", 70, idle_font, fill=FG_WHITE)

    # 底部
    if message is not None:
        bottom_font = _load_font(15)
        _center_text(draw, message, SCREEN - 22, bottom_font, fill=FG_DIM)
    elif cups_today is not None:
        bottom_font = _load_font(15)
        _center_text(
            draw, f"今日 {cups_today} 杯", SCREEN - 22, bottom_font, fill=FG_DIM
        )

    return img


# ============ 文本/时钟小工具 ============

def render_text_lines(
    lines: list[str],
    bg=BG_DARK,
    align: str = "center",
) -> Image.Image:
    """通用：最多 4 行文字居中显示。"""
    img = Image.new("RGB", (SCREEN, SCREEN), bg)
    draw = ImageDraw.Draw(img)
    n = len(lines)
    if n == 0:
        return img
    font_size = 26 if n == 1 else 20 if n == 2 else 16 if n == 3 else 13
    font = _load_font(font_size)
    total_h = n * (font_size + 4)
    y = (SCREEN - total_h) // 2
    for line in lines:
        if align == "center":
            w, h = _text_size(draw, line, font)
            x = (SCREEN - w) // 2
        else:
            x = 8
        draw.text((x, y), line, font=font, fill=FG_WHITE)
        y += font_size + 4
    return img


def render_clock(now) -> Image.Image:
    """简单时钟画面（HH:MM）。"""
    img = Image.new("RGB", (SCREEN, SCREEN), BG_DARK)
    draw = ImageDraw.Draw(img)
    time_str = now.strftime("%H:%M")
    date_str = now.strftime("%m-%d %a")
    time_font = _load_font(52)
    date_font = _load_font(16)
    _center_text(draw, time_str, 30, time_font, fill=FG_WHITE)
    _center_text(draw, date_str, 92, date_font, fill=FG_DIM)
    return img


if __name__ == "__main__":
    # 生成示例图到 /tmp 方便肉眼检查
    render_queue_number(23, prefix="A", wait_count=5).save("/tmp/qn.png")
    render_bar_status(open=True, current_order="A023", cups_today=42).save("/tmp/bar.png")
    render_text_lines(["欢迎光临", "MF CAFE"]).save("/tmp/welcome.png")
    print("已生成 /tmp/qn.png /tmp/bar.png /tmp/welcome.png")
