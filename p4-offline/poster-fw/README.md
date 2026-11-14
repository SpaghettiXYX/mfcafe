# CS80 海报轮播屏固件（ESP32-P4）

把拉卡拉 CS80 客显改成 **脱机静态海报轮播屏**：树莓派通过 USB 把 JPEG 推给板上的
ESP32-P4，P4 用硬件 JPEG 解码 + MIPI-DSI 直接循环显示。**不改动已投板的 PCB。**

> **状态：待上板验证。** 面板初始化表、时序、DSI 参数都是从原厂 `lakala.bin`
> 反推的（见 `main/sc7705_init.h` 的注释），但这份 ESP-IDF 工程还没有在真板上
> 编译、烧录、点亮过。第一次上板请按文末“上板检查顺序”逐项确认。

## 1. 硬件连接

| 功能 | 引脚 | 说明 |
|---|---|---|
| DSI 复位 | GPIO36 | 低 20ms → 高 120ms |
| 背光 | GPIO24 | MP3202 EN，5 kHz PWM 调光 |
| USB | 模组 16/17 脚（DN/DP） | 设备口，12 Mbps 全速；板上 R8 1.5k 上拉 |
| 调试串口 | H1: IO37/IO38 | UART0，115200，日志只从这里出 |

树莓派 3 作为 USB host。**注意供电**：5V 从 USB 直接进模组，5 寸屏背光电流不小，
建议屏幕由独立 5V 电源供电、只把 D-/D+ 和 GND 接到 Pi（或使用带外部供电的 HUB），
避免 Pi 的 USB 口限流导致重启。

## 2. 编译

需要 ESP-IDF **v5.4**（`esp_lcd` 的 DSI/DPI API 与 `esp_driver_jpeg` 均按 5.4 编写）。

```bash
. $IDF_PATH/export.sh
cd p4-offline/poster-fw
idf.py set-target esp32p4
idf.py build
idf.py -p /dev/ttyUSB0 flash
```

`posters/` 目录下的 JPEG 会在编译时打包进 `storage` 分区（SPIFFS，约 12 MB），
`0000_waiting.jpg` 是没收到海报时的等待画面。

若 `sdkconfig.defaults` 里有选项因 IDF 小版本不同被拒绝（主要是 PSRAM 的
`CONFIG_SPIRAM_MODE_HEX` / `CONFIG_SPIRAM_SPEED_200M`），执行一次
`idf.py menuconfig` 按模组实际 PSRAM 配置修正即可。

## 3. 树莓派端

```bash
sudo apt install python3-serial
sudo mkdir -p /opt/mfc-poster /var/lib/mfc-poster
sudo cp pi/poster_sync.py /opt/mfc-poster/
sudo cp pi/poster-sync.service /etc/systemd/system/
# 把 service 里的 API 地址换成你的 Apps Script /exec 地址
sudo systemctl enable --now poster-sync
```

脚本每 15 秒请求 `?action=posters`，版本号变化时下载全部启用中的海报，
校验 JPEG 后按 `0000_xxx.jpg`、`0001_xxx.jpg` 的顺序推给 P4，再下发轮播间隔和亮度。

手动调试：

```bash
python3 pi/poster_sync.py --api 'https://script.google.com/.../exec' --once --verbose --force
```

## 4. USB 协议（P4 ← Pi）

帧格式：`'P' 'S' | type(1) | len(4, LE) | payload`

| type | 含义 | payload |
|---|---|---|
| 1 | PUT_BEGIN | u8 名字长度 + 名字 + u32 大小 + u32 CRC32 |
| 2 | PUT_DATA | 原始字节（建议每帧 4 KB） |
| 3 | PUT_END | 空，设备校验大小/CRC 后落盘 |
| 4 | CLEAR | 删除全部海报 |
| 5 | CONFIG | u32 间隔毫秒 + u8 亮度(0–100) |
| 6 | RELOAD | 重新扫描目录 |
| 7 | STATUS | 查询海报数/间隔/亮度 |
| 8 | PING | 连通性测试 |

设备用 ASCII 行回复，例如 `OK put 0000_a.jpg 33102` / `ERR crc`。
设备端实现见 `main/main.c` 的 `handle_frame()`，Pi 端实现见 `pi/poster_sync.py`
的 `PosterLink`。

## 5. 上板检查顺序

1. **USB 枚举**：插上 Pi，`lsusb` 应出现 `303a:1001`（USB-Serial-JTAG）。
   如果出现的是 `303a:4002` 或没有任何设备，说明该板的 USB 走的是 OTG PHY
   而不是 Serial-JTAG，需要改用 TinyUSB CDC（`esp_tinyusb`），协议层不用改。
2. **串口日志**：H1 的 IO37/IO38 接 3.3V USB-TTL，115200 应能看到
   `sc7705 init table sent (19 cmds)` 和 `ready`。
3. **背光**：初始化后亮度应到 80%；若全黑先确认 GPIO24 电平和 MP3202 的 EN。
4. **画面**：能显示 `posters/0000_waiting.jpg` 即 DSI/时序正确。
   - 花屏/偏移：调 `dpi_clock_freq_mhz`（80）和 `video_timing` 的 porch。
   - 红蓝反：把 `JPEG_DEC_RGB_ELEMENT_ORDER_BGR` 改成 `..._RGB`。
   - 颜色发暗/发紫：确认 DSI 2 lane、600 Mbps 与面板一致。
5. **推图**：Pi 上 `--once --force`，设备回 `OK put ...` 后应自动切到新海报。

## 6. 已知限制

- 只支持 800×1280 的 **baseline JPEG**（硬件解码器限制），管理后台上传时会
  自动裁剪并重编码，正常不会踩到。
- 轮播是整屏切换，双 framebuffer 已有，但极短时间内可能有轻微撕裂，静态海报无感。
- 没有音频（ES8311/NS4150B 未使用）。
- 固件不联网、不带 SD 卡；内容完全靠 Pi 通过 USB 推送。
