# Divoom Times Gate 改造：吧台状态 / 排队叫号显示器

用 Divoom Times Gate 的**本地局域网 HTTP API**（不拆刷机）把它变成
咖啡馆的信息面板：5 块 128×128 屏分别显示排队号、吧台状态、时钟等。

## 前置条件

1. Times Gate 已用手机 App 配网，能正常连 Wi-Fi。
2. 设备**必须完成与 Divoom 云端的握手**（屏上显示正常内容后），
   本地 `http://{IP}/post` 才会响应。重启后需要重新握手。
3. 运行本脚本的机器（树莓派/Mac/PC）与设备在同一局域网。

## 安装

```bash
cd divoom-timesgate
pip install -r requirements.txt
```

中文字体：脚本自动用 `fc-match` 找 Noto Sans CJK SC。若系统没有，
设置环境变量 `DIVOOM_FONT=/path/to/your/cjk.ttf`。

## 第一步：找到设备 + 确认分屏寻址方式

```bash
# 自动发现（需联网访问 Divoom 云端）
python3 discover.py

# 或直接指定 IP
python3 discover.py 192.168.1.50
```

`discover.py` 会打印：
- 设备设置查询结果（验证 API 通）
- 几种"选中子屏"命令哪个不报错
- 几种推图内嵌屏索引字段哪个生效

**根据输出**，在 `DivoomTimesGate(...)` 里填上对应的参数：

```python
from divoom_display import DivoomTimesGate

dev = DivoomTimesGate(
    "192.168.1.50",
    screen_index_param="ScreenIndex",     # 按探测结果改
    sub_index_command="Channel/SetSubIndex",
    sub_index_param="SelectSubIndex",
)
```

> ⚠️ Times Gate 分屏参数名公开资料未完全确定，`discover.py` 就是帮你
> 在真机上测出正确值。如果两种模式都不 OK，用 `dev.raw_command(...)`
> 手动试，或在设备上用 App 切换屏幕后抓包确认。

## 第二步：快速验证推图

```python
from divoom_display import DivoomTimesGate
from render_dashboard import render_queue_number

dev = DivoomTimesGate("192.168.1.50")
img = render_queue_number(23, prefix="A", wait_count=5)
dev.push_to_screen(0, img)   # 推到第 0 块屏
```

## 场景一：排队叫号屏

状态由 `queue_state.json` 驱动，外部系统改这个文件即可：

```json
{ "number": 23, "prefix": "A", "wait_count": 5, "status": "请取餐" }
```

运行：

```bash
# 常驻刷新（默认屏 0）
python3 queue_display.py --host 192.168.1.50 --screen 0 run

# 命令行改状态
python3 queue_display.py set --number 24 --wait 4
python3 queue_display.py next     # 号码 +1
```

## 场景二：吧台状态屏

`bar_state.json`：

```json
{ "open": true, "current_order": "A023", "cups_today": 42, "message": null }
```

```bash
python3 bar_status.py --host 192.168.1.50 --screen 1 run
python3 bar_status.py set --current A024 --cups 43
python3 bar_status.py close
```

## 5 块屏分配建议

| 屏 | 内容 | 脚本 |
|---|---|---|
| 0 | 当前叫号（大号） | queue_display.py |
| 1 | 吧台 OPEN/BUSY | bar_status.py |
| 2 | 等待人数 / 下一位 | queue_display.py（另起一个 screen） |
| 3 | 时钟 | 自己写循环调 render_clock |
| 4 | 欢迎语 / 公告 | render_text_lines |

## 对接 MFCAFE 点单后台

`Code.gs` 里已有 `emitPickupNotify(order)` / `emitPrintEvent` 的预留钩子。
两种对接方式：

**方式 A（推荐，最轻）**：点单后台通过 HTTP 调用树莓派上的 webhook，
树莓派改写 `queue_state.json` / `bar_state.json`，显示脚本自动刷新。

**方式 B**：显示脚本直接轮询 Apps Script 的 `?action=orders` 接口，
把最新订单状态渲染上屏。

需要时可提供 `mfcafe_bridge.py` 把 Apps Script 订单状态同步到状态文件。

## systemd 常驻（树莓派）

```ini
# /etc/systemd/system/divoom-queue.service
[Unit]
Description=Divoom Queue Display
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 /home/pi/divoom-timesgate/queue_display.py --host 192.168.1.50 --screen 0 run
WorkingDirectory=/home/pi/divoom-timesgate
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now divoom-queue
```

## 注意事项

- **云端依赖**：设备重启后必须重新连上 Divoom 云端，本地 API 才恢复。
  咖啡馆网络要稳；若需完全离线，只能走刷固件路线（另议）。
- **固件升级风险**：Divoom 升级固件可能改 API，稳定后建议在 App 里关闭自动升级。
- **无鉴权**：局域网内任何人都能控制设备，不要把设备放到不可信网络。
- **PicID**：`push_image` 内部自动递增 PicID，长时运行无需手动 reset。
