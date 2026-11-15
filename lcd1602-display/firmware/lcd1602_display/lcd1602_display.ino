/*
 * LCD1602 customer display — ESP32 / ESP8266
 *
 * The ESP is intentionally dumb: it only draws two 16-character lines that a
 * Mac (or any host) sends over serial. All cart logic, paging and currency
 * formatting stay on the host side.
 *
 * Wiring (I2C backpack, PCF8574):
 *   LCD VCC  -> 5V
 *   LCD GND  -> GND
 *   LCD SDA  -> ESP32 GPIO21 / ESP8266 D2 (GPIO4)
 *   LCD SCL  -> ESP32 GPIO22 / ESP8266 D1 (GPIO5)
 *   The backpack pulls SDA/SCL to 5V. Use a level shifter (preferred) or
 *   move the two pull-ups to 3.3V. See README.
 *
 * Serial: 115200 8N1, newline-terminated ASCII commands.
 *   PING              -> PONG
 *   CLR               -> OK            clear both lines
 *   INIT              -> OK            show boot screen
 *   L1:<text>         -> (silent)      line 1, max 16 chars, ASCII
 *   L2:<text>         -> (silent)      line 2, max 16 chars, ASCII
 *   BL:0 / BL:1..100  -> OK            backlight off / on
 *   anything else     -> ERR
 *
 * LCD1602 has no Chinese font: non-ASCII input is replaced with '?'. Keep
 * names in English/pinyin/SKU, or use a 12864 (ST7920) instead.
 */
#include <Arduino.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

#if defined(ESP8266)
#define I2C_SDA 4   // D2
#define I2C_SCL 5   // D1
#else
#define I2C_SDA 21
#define I2C_SCL 22
#endif

#define LCD_COLS 16
#define LCD_ROWS 2

// Two candidates cover almost all PCF8574 backpacks.
LiquidCrystal_I2C lcd27(0x27, LCD_COLS, LCD_ROWS);
LiquidCrystal_I2C lcd3f(0x3F, LCD_COLS, LCD_ROWS);
LiquidCrystal_I2C *lcd = nullptr;

static String rxLine;

static bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

static String toAscii(const String &in) {
  String out;
  for (size_t i = 0; i < in.length(); i++) {
    uint8_t c = (uint8_t)in[i];
    if (c >= 0x20 && c <= 0x7E) {
      out += (char)c;
    } else if (c >= 0xC0) {
      out += '?';  // one '?' per UTF-8 character, skip its continuation bytes
    }
  }
  return out;
}

static void writeLine(uint8_t row, const String &text) {
  if (!lcd) return;
  String t = toAscii(text);
  if (t.length() > LCD_COLS) t = t.substring(0, LCD_COLS);
  while (t.length() < LCD_COLS) t += ' ';
  lcd->setCursor(0, row);
  lcd->print(t);
}

static void showBoot() {
  writeLine(0, "LCD1602 ready");
  writeLine(1, "115200 8N1");
}

static void handle(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd == "PING") {
    Serial.println("PONG");
  } else if (!lcd) {
    Serial.println("ERR");
  } else if (cmd == "CLR") {
    lcd->clear();
    Serial.println("OK");
  } else if (cmd == "INIT") {
    showBoot();
    Serial.println("OK");
  } else if (cmd.startsWith("L1:")) {
    writeLine(0, cmd.substring(3));   // silent on purpose: avoids TX backpressure
  } else if (cmd.startsWith("L2:")) {
    writeLine(1, cmd.substring(3));
  } else if (cmd.startsWith("BL:")) {
    int v = cmd.substring(3).toInt();
    if (v > 0) lcd->backlight(); else lcd->noBacklight();
    Serial.println("OK");
  } else {
    Serial.println("ERR");
  }
}

void setup() {
  Serial.begin(115200);
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);

  if (i2cPresent(0x27)) {
    lcd = &lcd27;
  } else if (i2cPresent(0x3F)) {
    lcd = &lcd3f;
  }

  if (!lcd) {
    Serial.println("ERR no LCD at 0x27/0x3F");
    // Keep running so the host can see the error; nothing to draw.
    return;
  }

  lcd->init();
  lcd->backlight();
  showBoot();
  Serial.println("READY");
}

void loop() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (rxLine.length() > 0) {
        handle(rxLine);
        rxLine = "";
      }
    } else if (rxLine.length() < 80) {
      rxLine += c;
    }
  }
}
