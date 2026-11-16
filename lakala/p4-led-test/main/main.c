/*
 * MFCafe — ESP32-P4 LED bring-up test
 *
 * Purpose: prove two things before we touch the display driver
 *   1. the board can be flashed (UART header H1 / USB)
 *   2. the three RGB channels are wired the way the probe file says
 *
 * Wiring derived from LAKALA_V103 flying-probe netlist:
 *   LED_R -> Q2 base -> IO40
 *   LED_G -> Q3 base -> IO39
 *   LED_B -> Q1 base -> IO41
 *   LED_P (CN2 pin 4) is the common anode (5V), so PWM is active-low.
 *
 * Expected sequence after boot:
 *   red -> green -> blue -> white (0.6 s each), then a breathing rainbow.
 *   If the strip stays dark, nothing else in this project will work, so stop
 *   here and check wiring/power before continuing.
 */

#include <math.h>
#include <stdio.h>

#include "driver/ledc.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846f
#endif

#define PIN_R 40
#define PIN_G 39
#define PIN_B 41

#define COMMON_ANODE 1          // set to 0 for a common-cathode strip
#define LEDC_MODE LEDC_LOW_SPEED_MODE
#define LEDC_TIMER LEDC_TIMER_0
#define LEDC_DUTY_RES LEDC_TIMER_10_BIT
#define LEDC_MAX_DUTY ((1 << 10) - 1)
#define LEDC_FREQ_HZ 5000

static const char *TAG = "led-test";

static const int ch_pins[3] = {PIN_R, PIN_G, PIN_B};
static const ledc_channel_t ch_ids[3] = {LEDC_CHANNEL_0, LEDC_CHANNEL_1, LEDC_CHANNEL_2};

static inline uint32_t duty_for(uint8_t level)
{
    uint32_t v = (uint32_t)level * LEDC_MAX_DUTY / 255;
    return COMMON_ANODE ? (LEDC_MAX_DUTY - v) : v;
}

static void led_write(uint8_t r, uint8_t g, uint8_t b)
{
    const uint8_t rgb[3] = {r, g, b};
    for (int i = 0; i < 3; i++) {
        ledc_set_duty(LEDC_MODE, ch_ids[i], duty_for(rgb[i]));
        ledc_update_duty(LEDC_MODE, ch_ids[i]);
    }
}

static void led_init(void)
{
    ledc_timer_config_t timer = {
        .speed_mode = LEDC_MODE,
        .duty_resolution = LEDC_DUTY_RES,
        .timer_num = LEDC_TIMER,
        .freq_hz = LEDC_FREQ_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer));

    for (int i = 0; i < 3; i++) {
        ledc_channel_config_t ch = {
            .gpio_num = ch_pins[i],
            .speed_mode = LEDC_MODE,
            .channel = ch_ids[i],
            .intr_type = LEDC_INTR_DISABLE,
            .timer_sel = LEDC_TIMER,
            .duty = duty_for(0),
            .hpoint = 0,
        };
        ESP_ERROR_CHECK(ledc_channel_config(&ch));
    }
    led_write(0, 0, 0);
}

/* Simple HSV -> RGB so the rainbow does not need a library. */
static void hsv_to_rgb(float h, float s, float v, uint8_t *r, uint8_t *g, uint8_t *b)
{
    float c = v * s;
    float hp = fmodf(h, 360.0f) / 60.0f;
    float x = c * (1.0f - fabsf(fmodf(hp, 2.0f) - 1.0f));
    float m = v - c;
    float rf = 0, gf = 0, bf = 0;

    if (hp < 1)      { rf = c; gf = x; }
    else if (hp < 2) { rf = x; gf = c; }
    else if (hp < 3) { gf = c; bf = x; }
    else if (hp < 4) { gf = x; bf = c; }
    else if (hp < 5) { rf = x; bf = c; }
    else             { rf = c; bf = x; }

    *r = (uint8_t)((rf + m) * 255.0f);
    *g = (uint8_t)((gf + m) * 255.0f);
    *b = (uint8_t)((bf + m) * 255.0f);
}

void app_main(void)
{
    ESP_LOGI(TAG, "boot ok, chip=%s", CONFIG_IDF_TARGET);
    led_init();

    // Channel self test: if one colour is missing, that GPIO/MOSFET is the fault.
    struct { const char *name; uint8_t r, g, b; } steps[] = {
        {"RED", 255, 0, 0},
        {"GREEN", 0, 255, 0},
        {"BLUE", 0, 0, 255},
        {"WHITE", 255, 255, 255},
        {"OFF", 0, 0, 0},
    };
    for (int i = 0; i < (int)(sizeof(steps) / sizeof(steps[0])); i++) {
        ESP_LOGI(TAG, "self test: %s", steps[i].name);
        led_write(steps[i].r, steps[i].g, steps[i].b);
        vTaskDelay(pdMS_TO_TICKS(600));
    }

    ESP_LOGI(TAG, "entering rainbow mode");

    float hue = 0.0f;
    float phase = 0.0f;
    int log_div = 0;

    while (true) {
        // 0.35..1.0 brightness breathing, 12 s per full rainbow.
        float brightness = 0.675f + 0.325f * sinf(phase);
        uint8_t r, g, b;
        hsv_to_rgb(hue, 1.0f, brightness, &r, &g, &b);
        led_write(r, g, b);

        hue += 0.6f;
        if (hue >= 360.0f) hue -= 360.0f;
        phase += 0.0157f;                 // ~2 s per breath at 20 ms tick
        if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;

        if (++log_div >= 100) {           // one line every ~2 s
            log_div = 0;
            ESP_LOGI(TAG, "rgb=%3u,%3u,%3u", r, g, b);
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
