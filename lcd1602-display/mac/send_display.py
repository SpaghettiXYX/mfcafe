#!/usr/bin/env python3
"""
Send cart contents to the LCD1602 customer display (ESP32/ESP8266 over USB serial).

Examples:
    python3 send_display.py --demo
    python3 send_display.py --cart example_cart.json --loop
    python3 send_display.py --line1 "Coffee x2" --line2 "TOTAL 12.00"
    python3 send_display.py --interactive
    python3 send_display.py --port /dev/cu.usbserial-1130 --off

Requires: python3 -m pip install pyserial
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
import time
from typing import List, Tuple

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.stderr.write("pyserial is required:  python3 -m pip install pyserial\n")
    raise

COLS = 16


def find_port() -> str | None:
    # Prefer a real USB-UART bridge over the Mac's built-in Bluetooth ports.
    for p in list_ports.comports():
        desc = (p.description or "") + " " + (p.manufacturer or "")
        if any(k in desc for k in ("USB", "UART", "CH340", "CH34", "CP210", "FT232", "Espressif")):
            return p.device
    for pattern in (
        "/dev/cu.usbserial*",
        "/dev/cu.wchusbserial*",
        "/dev/cu.SLAB_USBtoUART*",
        "/dev/cu.usbmodem*",
        "/dev/ttyUSB*",
        "/dev/ttyACM*",
    ):
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[0]
    return None


def ascii_line(text: str, width: int = COLS) -> str:
    out = []
    for ch in str(text):
        out.append(ch if 0x20 <= ord(ch) <= 0x7E else "?")
    return "".join(out)[:width]


class Display:
    def __init__(self, port: str | None, verbose: bool = False):
        self.port = port or find_port()
        if not self.port:
            raise SystemExit("No USB serial port found. Plug the ESP in, or pass --port.")
        self.verbose = verbose
        self.ser = serial.Serial(self.port, 115200, timeout=1, write_timeout=2)
        self.ser.dtr = False   # do not hold the ESP in reset
        self.ser.rts = False
        time.sleep(2.0)        # boards reboot when the port opens
        self.ser.reset_input_buffer()
        if verbose:
            print(f"port {self.port}")
        self.ping()

    def close(self) -> None:
        try:
            self.ser.close()
        except Exception:
            pass

    def _readline(self) -> str:
        return self.ser.readline().decode("utf-8", "replace").strip()

    def ping(self) -> bool:
        for _ in range(3):
            self.ser.write(b"PING\n")
            self.ser.flush()
            reply = self._readline()
            if reply == "PONG":
                return True
            time.sleep(0.5)
        print("warning: no PONG from display (check port / baud / wiring)")
        return False

    def send(self, cmd: str) -> None:
        if self.verbose:
            print("->", cmd)
        self.ser.write((cmd + "\n").encode("ascii", "replace"))
        self.ser.flush()

    def line(self, row: int, text: str) -> None:
        self.send(f"L{row}:{ascii_line(text)}")

    def clear(self) -> None:
        self.send("CLR")

    def backlight(self, on: bool) -> None:
        self.send("BL:100" if on else "BL:0")
        self._readline()


def fmt_money(value) -> str:
    try:
        return f"{float(value):.2f}"
    except (TypeError, ValueError):
        return str(value)


def cart_pages(cart: dict) -> List[Tuple[str, str]]:
    items = cart.get("items") or []
    pages: List[Tuple[str, str]] = []
    if items:
        pages.append(("YOUR ORDER", f"{len(items)} item" + ("s" if len(items) != 1 else "")))
        for it in items:
            name = it.get("name", "ITEM")
            qty = it.get("qty", 1)
            try:
                subtotal = float(it.get("price", 0)) * float(qty)
            except (TypeError, ValueError):
                subtotal = it.get("price", 0)
            # qty + line subtotal is what the customer actually needs to confirm
            pages.append((name, f"x{qty} {fmt_money(subtotal)}"))
    total = fmt_money(cart.get("total", 0))
    pages.append(("TOTAL", total))
    return pages


def show_cart(link: Display, cart: dict, dwell: float, loop: bool) -> None:
    pages = cart_pages(cart)
    while True:
        for l1, l2 in pages:
            link.line(1, l1)
            link.line(2, l2)
            time.sleep(dwell)
        if not loop:
            return


def demo_cart() -> dict:
    return {
        "items": [
            {"name": "Americano", "qty": 2, "price": 12.00},
            {"name": "Cheesecake", "qty": 1, "price": 18.00},
            {"name": "Orange juice", "qty": 1, "price": 8.00},
        ],
        "total": 50.00,
    }


def interactive(link: Display) -> None:
    print("Type a command (PING, CLR, L1:text, L2:text, BL:0/100). Empty line = quit.")
    for raw in sys.stdin:
        cmd = raw.strip()
        if not cmd:
            return
        link.send(cmd)
        if cmd.upper().startswith(("PING", "CLR", "BL")):
            print(link._readline())


def main() -> int:
    ap = argparse.ArgumentParser(description="LCD1602 customer display sender")
    ap.add_argument("--port", help="e.g. /dev/cu.usbserial-1130 (auto-detected by default)")
    ap.add_argument("--line1")
    ap.add_argument("--line2")
    ap.add_argument("--cart", help="JSON file: {items:[{name,qty,price}], total}")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--dwell", type=float, default=2.5, help="seconds per page")
    ap.add_argument("--loop", action="store_true", help="keep rotating")
    ap.add_argument("--interactive", action="store_true")
    ap.add_argument("--off", action="store_true", help="turn backlight off")
    ap.add_argument("--on", action="store_true", help="turn backlight on")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    link = Display(args.port, args.verbose)
    try:
        if args.off:
            link.backlight(False)
            print("backlight off")
        elif args.on:
            link.backlight(True)
            print("backlight on")
        elif args.interactive:
            interactive(link)
        elif args.cart:
            with open(args.cart, "r", encoding="utf-8") as fh:
                cart = json.load(fh)
            show_cart(link, cart, args.dwell, args.loop)
        elif args.line1 is not None or args.line2 is not None:
            if args.line1 is not None:
                link.line(1, args.line1)
            if args.line2 is not None:
                link.line(2, args.line2)
            print("sent")
        else:
            show_cart(link, demo_cart(), args.dwell, args.loop)
    except KeyboardInterrupt:
        pass
    finally:
        link.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
