# LCD1602 客显（Mac → USB 串口 → ESP32/ESP8266）

给顾客确认购买项目用的 16×2 字符客显。Mac 负责算出要显示什么，ESP 只负责把
两行 16 字符画到屏上——没有业务逻辑，掉线也不会影响收银。

> **先看清楚限制**：LCD1602 只有 32 个字符，标准字库**不带中文**。
> 商品名只能用英文/拼音/SKU；中文会被替换成 `?`。
> 如果要显示中文商品名，建议换 12864（ST7920，自带 GB2312）或小 TFT。

## 1. 需要买什么

| 物料 | 说明 |
|---|---|
| LCD1602 模块 | **一定要买带 I2C 背板（PCF8574）的版本**，只需 4 根线 |
| ESP32 或 ESP8266 | NodeMCU / Wemos D1 mini 都行，带 USB 方便插 Mac |
| 杜邦线 | 4 根母对母 |
| 电平转换模块（建议） | TXS0108E 或 BSS138 双向转换，见第 3 节 |
| 5V 电源 | USB 口即可，整机不到 100mA |

## 2. 接线

| LCD1602（I2C 背板） | ESP32 | ESP8266（D1 mini） |
|---|---|---|
| VCC | 5V / VIN | 5V |
| GND | GND | GND |
| SDA | GPIO21 | D2（GPIO4） |
| SCL | GPIO22 | D1（GPIO5） |

背板上还有一个小电位器，用来调对比度；上电后如果只有背光没有字，先拧它。

## 3. 5V 电平问题（重要）

LCD1602 和 I2C 背板是 5V 供电，背板上的 SDA/SCL 上拉电阻通常接到 5V，而
ESP32/ESP8266 的 IO 是 3.3V。两种处理方式：

1. **推荐**：加一个 TXS0108E/BSS138 双向电平转换，低压侧 3.3V、高压侧 5V；
2. 或者把背板上 SDA/SCL 的两个上拉电阻改接到 3.3V（需要动烙铁）。

直接把 5V 上拉接到 ESP 的 IO，很多情况下“能用”，但长期属于超规格，不建议
24 小时开着。

## 4. 烧录固件

1. Arduino IDE → 开发板管理器安装：
   - ESP32：`esp32 by Espressif Systems`
   - ESP8266：`esp8266 by ESP8266 Community`
2. 库管理器安装：`LiquidCrystal I2C`（作者 Frank de Brabander）
3. 打开 `firmware/lcd1602_display/lcd1602_display.ino`
4. 选对应开发板（ESP32 Dev Module / LOLIN(WEMOS) D1 mini），上传。
5. 打开串口监视器 115200，正常会看到：

   ```
   READY
   ```

   如果显示 `ERR no LCD at 0x27/0x3F`，检查接线；固件会自动探测 `0x27` 和
   `0x3F` 两个常见地址。

## 5. Mac 端使用

```bash
python3 -m pip install pyserial

cd mac
python3 send_display.py --demo                        # 演示购物车，自动翻页
python3 send_display.py --cart example_cart.json --loop
python3 send_display.py --line1 "Coffee x2" --line2 "TOTAL 12.00"
python3 send_display.py --interactive                 # 手动敲命令调试
python3 send_display.py --off                         # 关背光
```

串口默认自动扫描 `/dev/cu.usbserial*`、`/dev/cu.wchusbserial*`、
`/dev/cu.SLAB_USBtoUART*`、`/dev/cu.usbmodem*`。如果认错了，用
`--port /dev/cu.usbserial-1130` 指定。

购物车 JSON 格式：

```json
{
  "items": [
    {"name": "Americano", "qty": 2, "price": 12.00},
    {"name": "Cheesecake", "qty": 1, "price": 18.00}
  ],
  "total": 42.00
}
```

翻页顺序：`YOUR ORDER / 3 items` → 每条商品 `名称 / x数量 小计` → `TOTAL / 总价`，
每页默认 2.5 秒，`--dwell` 可改。

> **macOS 驱动**：CP2102 一般免驱；CH340 克隆板可能需要装 WCH 驱动。
> 插上后 `ls /dev/cu.*` 能看到设备即可。

## 6. 串口协议（115200 8N1，`\n` 结尾）

| 指令 | 回复 | 说明 |
|---|---|---|
| `PING` | `PONG` | 连通性检查 |
| `CLR` | `OK` | 清屏 |
| `INIT` | `OK` | 显示开机画面 |
| `L1:<text>` | 无 | 第一行，最多 16 个 ASCII 字符，自动补空格 |
| `L2:<text>` | 无 | 第二行 |
| `BL:0` | `OK` | 关背光 |
| `BL:1..100` | `OK` | 开背光 |

`L1/L2` 故意不回复，避免主机不读串口时把 ESP 的发送缓冲堵死；需要探活就发
`PING`。

## 7. 接到现有订单系统

现在 `send_display.py` 支持命令行、JSON 文件和交互模式。要接你的订单后台，
在 Mac 上做一个小轮询即可：

1. 从现有 Apps Script 拉当前订单（或本地收银程序的下单事件）；
2. 组装成上面的 JSON；
3. 调 `show_cart()` 或直接发 `L1/L2`。

如果后面要显示中文，建议把屏换成 12864（ST7920），固件只需换显示库，
串口协议可以保持不变。

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| 只有背光没有字 | 拧背板上的对比度电位器 |
| 屏幕全黑 | 检查 5V、GND；背光跳线/`BL` 指令 |
| `ERR no LCD at 0x27/0x3F` | 接线反了/没供电；用 I2C 扫描确认地址 |
| Mac 提示找不到串口 | 换数据线；装 CH340 驱动；`ls /dev/cu.*` |
| 乱码 | 波特率不是 115200，或买了非标准字库的屏 |
| 中文变成 `?` | 正常，1602 没有中文字库 |
| 背光不受控 | 个别背板的背光不在 P3，需要改库里的引脚定义 |
