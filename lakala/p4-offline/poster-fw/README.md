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

## 2. 烧录教程

### 2.1 准备环境

需要 ESP-IDF **v5.4**（`esp_lcd` 的 DSI/DPI API 与 `esp_driver_jpeg` 都按 5.4 编写，
5.2 及更早版本没有 `esp_lcd_new_panel_dpi`）。

Linux / macOS 安装：

```bash
mkdir -p ~/esp && cd ~/esp
git clone -b v5.4 --recursive https://github.com/espressif/esp-idf.git
cd esp-idf
./install.sh esp32p4
. ./export.sh          # 每开一个新终端都要 source 一次
```

Windows 用官方 ESP-IDF v5.4 安装器，勾选 esp32p4 目标即可，后续命令在
“ESP-IDF 5.4 PowerShell”里执行。

Linux 下还要给当前用户串口权限（只需一次，之后重新登录）：

```bash
sudo usermod -aG dialout $USER
```

另外准备一根**能传数据的 USB-C 线**（很多线只能充电），以及一个 3.3V 电平的
USB-TTL 模块（CH340/CP2102/FT232 都行，仅供第 2.4 节的备用方案使用）。

### 2.2 编译

```bash
cd p4-offline/poster-fw
idf.py set-target esp32p4
idf.py build
```

产物在 `build/`：`poster-fw.bin`（应用）、`bootloader/bootloader.bin`、
`partition_table/partition-table.bin`、`storage.bin`（SPIFFS 海报分区）。

`posters/` 目录下的 JPEG 会在编译时整包打进 `storage` 分区（约 12 MB），
`0000_waiting.jpg` 是没收到海报时的等待画面。想换开机默认画面，替换这个文件后
重新 `idf.py build` 即可。

如果 `sdkconfig.defaults` 里有选项被 IDF 小版本拒绝（主要是 PSRAM 的
`CONFIG_SPIRAM_MODE_HEX` / `CONFIG_SPIRAM_SPEED_200M`），执行一次
`idf.py menuconfig`，在 `Component config → ESP PSRAM` 里按模组实际情况修正。

### 2.3 方式 A：USB-C 直接烧（推荐）

板上的 USB-C 直连 P4 的 USB Serial/JTAG，不需要任何 USB-TTL。**先把接树莓派的
线拔掉**，USB-C 接到电脑。

1. 确认枚举（Linux）：

   ```bash
   lsusb | grep 303a          # 应显示 303a:1001 Espressif USB JTAG/serial
   ls /dev/ttyACM*            # 一般是 /dev/ttyACM0
   ```

   Windows 在设备管理器里会多出 `USB 串行设备 (COMx)`；macOS 是
   `/dev/cu.usbmodem*`。

2. 烧录并看日志：

   ```bash
   idf.py -p /dev/ttyACM0 -b 460800 flash monitor
   ```

   Windows 把 `-p` 换成 `-p COM5`（以设备管理器为准）。退出 monitor 是 `Ctrl+]`。

3. **连不上时手动进下载模式**（最常见的一步）：

   - 用镊子/杜邦线把 H1 的 **IO35 短接到 GND** 并保持；
   - 把 **EN 碰一下 GND 再松开**（相当于按复位）；
   - 松开 IO35；
   - 再执行 `idf.py -p /dev/ttyACM0 flash monitor`。

   烧录成功后正常上电即可，不需要再短接。

4. 第一次烧建议先整片擦除（清掉原厂残留和旧 SPIFFS）：

   ```bash
   idf.py -p /dev/ttyACM0 erase-flash
   idf.py -p /dev/ttyACM0 -b 460800 flash monitor
   ```

   注意 `erase-flash` 不会自动重写海报分区，所以擦完必须再执行一次 `flash`。

### 2.4 方式 B：H1 调试口 UART 烧录（备用）

USB-C 枚举不出来、或板子没焊 USB 座时用这个。H1 是 6 pin，丝印顺序：

| H1 引脚 | 信号 | 接到 USB-TTL |
|---|---|---|
| 1 | 5V | 不接（屏幕独立供电时） |
| 2 | IO38 | TTL 的 **TX**（P4 的 UART0 RX） |
| 3 | IO37 | TTL 的 **RX**（P4 的 UART0 TX） |
| 4 | GND | GND |
| 5 | EN | TTL 的 RTS（可选，自动复位） |
| 6 | IO35 | TTL 的 DTR（可选，自动进下载） |

- **电平必须是 3.3V**，5V 电平的 TTL 可能打坏 IO。
- 不接线时手动进下载：IO35 → GND 并保持，EN 碰 GND 后松开，再松开 IO35。
- 烧录命令同上，端口换成 `/dev/ttyUSB0`。
- 这个口同时是运行日志口（115200），`monitor` 看到的就是它。

### 2.5 只更新固件（保留海报）

后台或协议改动后只重烧应用，不动 12 MB 的海报分区，速度快很多：

```bash
idf.py -p /dev/ttyACM0 app-flash monitor
```

### 2.6 量产：合并成一个 bin

```bash
idf.py merge-bin -o poster-fw-full.bin
```

生成 `poster-fw-full.bin`（含 bootloader + 分区表 + 应用 + 海报），之后任意机器上：

```bash
esptool.py --chip esp32p4 -p /dev/ttyACM0 -b 460800 \
  write_flash 0x0 poster-fw-full.bin
```

### 2.7 常见问题

| 现象 | 处理 |
|---|---|
| `Failed to connect ... No serial data received` | 按 2.3 第 3 步手动进下载模式；确认 IO35 真的拉低；换一根数据线 |
| Linux `Permission denied: '/dev/ttyACM0'` | `sudo usermod -aG dialout $USER` 后重新登录 |
| 烧到一半掉线 / 反复重连 | 供电不足，屏和板子改用独立 5V，或换带供电的 HUB |
| 烧录成功但串口没日志 | 确认接的是 IO37/IO38、波特率 115200；烧完重新上电退出下载模式 |
| 有日志但屏幕全黑 | 背光/DSI 问题，按第 5 节检查 GPIO24、DSI 时序 |
| 屏幕花屏、偏移、红蓝反 | 第 5 节第 4 条，调 `dpi_clock_freq_mhz`、porch、RGB 顺序 |
| `Wrong boot mode detected` | IO35 还短接着 GND，松开后复位 |

烧录成功的标志：115200 日志依次出现
`sc7705 init table sent (19 cmds)` → `spiffs: ... bytes used` →
`found N poster(s)` → `usb serial/jtag ready` → `ready`，同时屏幕点亮并显示等待海报。

## 3. 树莓派端

先确认 P4 已经能正常枚举（`ls /dev/ttyACM*` 有设备），再装守护服务：

```bash
sudo apt install python3-serial
sudo mkdir -p /opt/mfc-poster /var/lib/mfc-poster
sudo cp pi/poster_sync.py /opt/mfc-poster/
sudo cp pi/poster-sync.service /etc/systemd/system/

# 把 service 里的 API 地址换成你的 Apps Script /exec 地址，
# 并把 User=pi 改成实际登录用户（Bookworm 默认用户可能不是 pi）
sudo nano /etc/systemd/system/poster-sync.service

sudo chown -R pi:pi /var/lib/mfc-poster
sudo systemctl daemon-reload
sudo systemctl enable --now poster-sync
journalctl -u poster-sync -f          # 看同步日志
```

脚本每 15 秒请求 `?action=posters`，版本号变化时下载全部启用中的海报，
校验 JPEG 后按 `0000_xxx.jpg`、`0001_xxx.jpg` 的顺序推给 P4，再下发轮播间隔和亮度。
改了 `Code.gs` 之后记得在 Apps Script 里**重新部署**（管理部署 → 编辑 → 新版本），
否则 Pi 仍会拿到旧接口。

手动调试（不装服务也能跑）：

```bash
python3 pi/poster_sync.py --api 'https://script.google.com/.../exec' --once --verbose --force
```

`--port` 可以强制指定串口，例如 `--port /dev/ttyACM0`；不指定时脚本会自动扫描
`/dev/ttyACM*` 和 `/dev/ttyUSB*`。

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
