/*
 * MFCafe poster LED bridge
 * ------------------------
 * Receives one colour per poster slide from poster.html over USB serial and
 * fades a 3-channel RGB strip to match it.
 *
 * Protocol (115200 8N1, one command per line):
 *   RGB <r> <g> <b>   r/g/b are 0-255
 *   OFF               all channels off
 *   PING              replies "OK"
 *
 * Wiring: common-anode strip -> 3x N-MOSFET (AO3400 / IRLZ44N) low side.
 * The board's own CN2 RGB header can be used if you feed it from this
 * controller instead of the terminal's GPIOs.
 *
 * Open poster.html and click the "LED" chip (Chrome/Edge only).
 */

#include <Arduino.h>

const int PIN_R = 25;
const int PIN_G = 26;
const int PIN_B = 27;

const int FREQ = 5000;      // 5 kHz, above audible
const int RES  = 8;         // 8-bit per channel
const bool COMMON_ANODE = true;

int target[3] = {0, 0, 0};
int current[3] = {0, 0, 0};

void applyChannel(int ch, int value) {
  int duty = COMMON_ANODE ? (255 - value) : value;
  ledcWrite(ch, duty);
}

void setup() {
  Serial.begin(115200);
  ledcSetup(0, FREQ, RES);
  ledcSetup(1, FREQ, RES);
  ledcSetup(2, FREQ, RES);
  ledcAttachPin(PIN_R, 0);
  ledcAttachPin(PIN_G, 1);
  ledcAttachPin(PIN_B, 2);
  for (int i = 0; i < 3; i++) applyChannel(i, 0);
  Serial.println("READY");
}

void loop() {
  // Fade toward the last colour we were told to show.
  for (int i = 0; i < 3; i++) {
    if (current[i] != target[i]) {
      current[i] += (target[i] > current[i]) ? 1 : -1;
      applyChannel(i, current[i]);
    }
  }

  while (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.startsWith("RGB")) {
      int sp1 = line.indexOf(' ', 4);
      int sp2 = (sp1 > 0) ? line.indexOf(' ', sp1 + 1) : -1;
      if (sp1 > 0 && sp2 > 0) {
        target[0] = constrain(line.substring(4, sp1).toInt(), 0, 255);
        target[1] = constrain(line.substring(sp1 + 1, sp2).toInt(), 0, 255);
        target[2] = constrain(line.substring(sp2 + 1).toInt(), 0, 255);
      }
    } else if (line == "OFF") {
      target[0] = target[1] = target[2] = 0;
    } else if (line == "PING") {
      Serial.println("OK");
    }
  }

  delay(8);
}
