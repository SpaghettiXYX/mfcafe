#!/usr/bin/env python3
"""
MFCAFE poster screen — Raspberry Pi sync daemon.

Polls the Apps Script admin backend, downloads the active poster set whenever
its version changes, and pushes it to the ESP32-P4 over USB CDC-ACM.

The P4 enumerates as a plain serial port (VID:PID 303a:1001). No driver or
network setup is needed on the Pi beyond pyserial.

Usage:
    python3 poster_sync.py --api https://script.google.com/.../exec
    python3 poster_sync.py --api ... --once           # sync once, then exit
    python3 poster_sync.py --port /dev/ttyACM0 --verbose
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import struct
import sys
import time
import zlib
from dataclasses import dataclass
from typing import List, Optional

import urllib.request

try:
    import serial  # pyserial
except ImportError:  # pragma: no cover
    sys.stderr.write("pyserial is required: sudo apt install python3-serial\n")
    raise

# --------------------------------------------------------------------------
# Wire protocol shared with main.c
# --------------------------------------------------------------------------
MAGIC = b"PS"
F_PUT_BEGIN = 1
F_PUT_DATA = 2
F_PUT_END = 3
F_CLEAR = 4
F_CONFIG = 5
F_RELOAD = 6
F_STATUS = 7
F_PING = 8

CHUNK = 4096


def _frame(ftype: int, payload: bytes = b"") -> bytes:
    return MAGIC + bytes([ftype]) + struct.pack("<I", len(payload)) + payload


class PosterLink:
    """Thin blocking client for the P4 USB protocol."""

    def __init__(self, port: str, timeout: float = 5.0, verbose: bool = False):
        self.port = port
        self.verbose = verbose
        self.ser = serial.Serial(port, 115200, timeout=timeout, write_timeout=timeout)
        time.sleep(0.2)
        self.ser.reset_input_buffer()

    def close(self) -> None:
        try:
            self.ser.close()
        except Exception:
            pass

    def _send(self, ftype: int, payload: bytes = b"") -> None:
        self.ser.write(_frame(ftype, payload))
        self.ser.flush()

    def _line(self) -> str:
        raw = self.ser.readline()
        if not raw:
            raise TimeoutError("no reply from P4")
        line = raw.decode("utf-8", "replace").strip()
        if self.verbose:
            print("  <-", line)
        return line

    def cmd(self, ftype: int, payload: bytes = b"", expect: str = "OK") -> str:
        self._send(ftype, payload)
        line = self._line()
        if not line.startswith(expect):
            raise RuntimeError(f"device replied: {line}")
        return line

    def ping(self) -> bool:
        try:
            self._send(F_PING)
            return self._line().startswith("OK")
        except Exception:
            return False

    def clear(self) -> None:
        self.cmd(F_CLEAR, b"", "OK cleared")

    def put(self, name: str, data: bytes) -> None:
        raw = name.encode("ascii")
        if len(raw) >= 64:
            raise ValueError("name too long")
        begin = bytes([len(raw)]) + raw + struct.pack("<II", len(data), zlib.crc32(data) & 0xFFFFFFFF)
        self.cmd(F_PUT_BEGIN, begin, "OK begin")
        for off in range(0, len(data), CHUNK):
            self._send(F_PUT_DATA, data[off:off + CHUNK])
        result = self.cmd(F_PUT_END, b"", "OK put")
        if self.verbose:
            print("  ", result)

    def config(self, interval_ms: int, brightness: int) -> None:
        self.cmd(F_CONFIG, struct.pack("<IB", interval_ms, brightness), "OK cfg")

    def reload(self) -> None:
        self.cmd(F_RELOAD, b"", "OK reload")

    def status(self) -> str:
        return self.cmd(F_STATUS, b"", "STATUS")


# --------------------------------------------------------------------------
# Backend
# --------------------------------------------------------------------------
@dataclass
class Poster:
    name: str
    url: str


@dataclass
class PosterSet:
    version: str
    interval_ms: int
    brightness: int
    posters: List[Poster]


def fetch_set(api: str, timeout: float = 30.0) -> PosterSet:
    sep = "&" if "?" in api else "?"
    url = f"{api}{sep}action=posters&t={int(time.time() * 1000)}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (mfc-poster-pi)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    data = json.loads(body)
    if not data.get("success", True):
        raise RuntimeError(data.get("error") or "backend error")
    return PosterSet(
        version=str(data.get("version", "0")),
        interval_ms=int(data.get("interval_ms", 8000)),
        brightness=int(data.get("brightness", 80)),
        posters=[Poster(p["name"], p["url"]) for p in data.get("posters", [])],
    )


def download(url: str, timeout: float = 60.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (mfc-poster-pi)"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def is_jpeg(data: bytes) -> bool:
    return len(data) > 4 and data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9"


def safe_name(name: str) -> str:
    base = os.path.splitext(os.path.basename(name))[0]
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("_") or "poster"
    return base[:48]


# --------------------------------------------------------------------------
# Serial discovery
# --------------------------------------------------------------------------
def discover_port() -> Optional[str]:
    preferred = sorted(glob.glob("/dev/serial/by-id/*Espressif*"))
    if preferred:
        return preferred[0]
    candidates = sorted(glob.glob("/dev/ttyACM*"))
    return candidates[0] if candidates else None


def wait_for_link(port: Optional[str], verbose: bool) -> PosterLink:
    while True:
        p = port or discover_port()
        if p:
            try:
                link = PosterLink(p, verbose=verbose)
                if link.ping():
                    print(f"[sync] connected to {p}")
                    return link
                link.close()
            except Exception as exc:
                if verbose:
                    print(f"[sync] {p}: {exc}")
        print("[sync] waiting for P4 USB device…")
        time.sleep(3)


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------
class State:
    def __init__(self, path: str):
        self.path = path
        self.version = ""
        self.load()

    def load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                self.version = json.load(fh).get("version", "")
        except Exception:
            pass

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"version": self.version}, fh)
        os.replace(tmp, self.path)


def sync_once(api: str, port: Optional[str], state: State, force: bool, verbose: bool) -> bool:
    pset = fetch_set(api)
    print(f"[sync] backend version={pset.version} posters={len(pset.posters)} "
          f"interval={pset.interval_ms}ms bright={pset.brightness}%")

    if pset.version == state.version and not force:
        # The Pi's state file survives a firmware reflash, but SPIFFS does not.
        # If the screen says it has nothing, push the set again.
        probe = port or discover_port()
        if probe:
            try:
                link = PosterLink(probe, verbose=verbose)
                try:
                    status = link.status()
                finally:
                    link.close()
                if "posters=0" in status:
                    print("[sync] screen is empty (reflashed?) — re-pushing")
                    force = True
            except Exception:
                pass
        if not force:
            if verbose:
                print("[sync] up to date")
            return False

    if not pset.posters:
        link = wait_for_link(port, verbose)
        try:
            link.clear()
            link.reload()
            print("[sync] no active posters — screen shows the waiting image")
        finally:
            link.close()
        state.version = pset.version
        state.save()
        return True

    # Download first: never wipe the screen for a half-finished transfer.
    blobs = []
    for i, p in enumerate(pset.posters):
        data = download(p.url)
        if not is_jpeg(data):
            raise RuntimeError(f"{p.name}: not a JPEG")
        if len(data) > 6 * 1024 * 1024:
            raise RuntimeError(f"{p.name}: larger than 6 MB")
        blobs.append((f"{i:04d}_{safe_name(p.name)}.jpg", data))
        print(f"[sync] downloaded {p.name} ({len(data) / 1024:.0f} KB)")

    link = wait_for_link(port, verbose)
    try:
        link.clear()
        for name, data in blobs:
            link.put(name, data)
            print(f"[sync] pushed {name}")
        link.config(pset.interval_ms, pset.brightness)
        link.reload()
        print("[sync] done: " + link.status())
    finally:
        link.close()

    state.version = pset.version
    state.save()
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Push admin-panel posters to the CS80 screen")
    ap.add_argument("--api", required=True, help="Apps Script /exec URL")
    ap.add_argument("--port", default=None, help="/dev/ttyACM0 (auto-detected by default)")
    ap.add_argument("--interval", type=int, default=15, help="poll period in seconds")
    ap.add_argument("--state", default="/var/lib/mfc-poster/state.json")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--force", action="store_true", help="re-push even if version matches")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    state = State(args.state)
    while True:
        try:
            sync_once(args.api, args.port, state, args.force, args.verbose)
            args.force = False
        except Exception as exc:
            print(f"[sync] error: {exc}", file=sys.stderr)
        if args.once:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
