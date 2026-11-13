/*
 * SC7705 (800x1280) offline poster player for the Lakala CS80 display board.
 *
 * Everything panel-specific here was recovered from the original lakala.bin:
 *   - 19-entry SC7705 init table            -> sc7705_init.h
 *   - DSI: 2 lanes, 600 Mbps, LDO ch3 2.5V  -> bus config below
 *   - DPI: 80 MHz, RGB565, video timing     -> dpi config below
 *   - LCD reset GPIO36, backlight GPIO24    -> pins below
 *
 * Posters are JPEG files (exactly 800x1280, baseline) stored in the "storage"
 * SPIFFS partition and played in a loop. The build generates/flashes that
 * partition automatically (see main/CMakeLists.txt).
 *
 * NOTE: not verified on real hardware yet.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <stdbool.h>
#include <dirent.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_vfs_spiffs.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "driver/jpeg_decode.h"
#include "esp_ldo_regulator.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "hal/color_types.h"

#include "sc7705_init.h"

static const char *TAG = "poster";

/* ---------------- panel / board constants (from lakala.bin + netlist) ----- */
#define LCD_H_RES            800
#define LCD_V_RES            1280
#define LCD_FB_BYTES         (LCD_H_RES * LCD_V_RES * 2)

#define LCD_DSI_LANES        2
#define LCD_LANE_MBPS        600      /* "byte clks @75MHz" -> 600 Mbps */
#define LCD_DPI_MHZ          80
#define LCD_DPI_CLK          MIPI_DSI_DPI_CLK_SRC_PLL_F160M

/* video timing recovered from the DPI panel config built at 0x4800bba0 */
#define LCD_HSW              120
#define LCD_HBP              140
#define LCD_HFP              140
#define LCD_VSW              4
#define LCD_VBP              10
#define LCD_VFP              156

#define PIN_LCD_RST          36
#define PIN_LCD_BL           24
#define PIN_LED_R            40
#define PIN_LED_G            39
#define PIN_LED_B            41

/* ---------------- playback settings -------------------------------------- */
#define POSTER_DIR           "/posters"
#define POSTER_MAX           64
#define POSTER_NAME_MAX      32       /* must fit CONFIG_SPIFFS_OBJ_NAME_LEN */
#define JPEG_BUF_BYTES       (2 * 1024 * 1024)
#define SLIDE_MS             8000

/* If red and blue are swapped on screen, change this to
 * JPEG_DEC_RGB_ELEMENT_ORDER_RGB. */
#define JPEG_RGB_ORDER       JPEG_DEC_RGB_ELEMENT_ORDER_BGR

/* ---------------- LEDC --------------------------------------------------- */
#define BL_TIMER             LEDC_TIMER_0
#define BL_CHANNEL           LEDC_CHANNEL_0
#define BL_RES               LEDC_TIMER_10_BIT

#define RGB_TIMER            LEDC_TIMER_1
#define RGB_RES              LEDC_TIMER_8_BIT
#define RGB_CH_R             LEDC_CHANNEL_1
#define RGB_CH_G             LEDC_CHANNEL_2
#define RGB_CH_B             LEDC_CHANNEL_3

static esp_lcd_panel_handle_t    s_panel;
static esp_lcd_panel_io_handle_t s_io;
static jpeg_decoder_handle_t     s_jpeg;
static uint8_t                  *s_jpeg_buf;

static const uint8_t s_led_palette[][3] = {
    { 90,  45,  12 },   /* warm amber */
    { 70,  25,  10 },   /* ember     */
    { 12,  48,  44 },   /* teal      */
    { 55,  45,  10 },   /* olive     */
};

/* ------------------------------------------------------------------------- */
static esp_err_t backlight_init(void)
{
    ledc_timer_config_t timer = {
        .speed_mode      = LEDC_LOW_SPEED_MODE,
        .duty_resolution = BL_RES,
        .timer_num       = BL_TIMER,
        .freq_hz         = 5000,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    esp_err_t err = ledc_timer_config(&timer);
    if (err != ESP_OK) {
        return err;
    }

    ledc_channel_config_t ch = {
        .gpio_num   = PIN_LCD_BL,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel    = BL_CHANNEL,
        .intr_type  = LEDC_INTR_DISABLE,
        .timer_sel  = BL_TIMER,
        .duty       = 0,
        .hpoint     = 0,
    };
    return ledc_channel_config(&ch);
}

static void backlight_set(int percent)
{
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    uint32_t duty = (uint32_t)(1023 * percent / 100);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, BL_CHANNEL, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, BL_CHANNEL);
}

static esp_err_t rgb_led_init(void)
{
    ledc_timer_config_t timer = {
        .speed_mode      = LEDC_LOW_SPEED_MODE,
        .duty_resolution = RGB_RES,
        .timer_num       = RGB_TIMER,
        .freq_hz         = 4000,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    esp_err_t err = ledc_timer_config(&timer);
    if (err != ESP_OK) {
        return err;
    }

    const int gpios[3] = { PIN_LED_R, PIN_LED_G, PIN_LED_B };
    const ledc_channel_t chans[3] = { RGB_CH_R, RGB_CH_G, RGB_CH_B };
    for (int i = 0; i < 3; i++) {
        ledc_channel_config_t ch = {
            .gpio_num   = gpios[i],
            .speed_mode = LEDC_LOW_SPEED_MODE,
            .channel    = chans[i],
            .intr_type  = LEDC_INTR_DISABLE,
            .timer_sel  = RGB_TIMER,
            .duty       = 0,
            .hpoint     = 0,
        };
        err = ledc_channel_config(&ch);
        if (err != ESP_OK) {
            return err;
        }
    }
    return ESP_OK;
}

static void rgb_led_set(uint8_t r, uint8_t g, uint8_t b)
{
    ledc_set_duty(LEDC_LOW_SPEED_MODE, RGB_CH_R, r);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, RGB_CH_G, g);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, RGB_CH_B, b);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, RGB_CH_R);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, RGB_CH_G);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, RGB_CH_B);
}

/* ------------------------------------------------------------------------- */
static esp_err_t lcd_init(void)
{
    esp_err_t err;

    /* MIPI DSI PHY is powered by LDO channel 3 @ 2.5 V (same as original FW) */
    esp_ldo_channel_handle_t ldo = NULL;
    esp_ldo_channel_config_t ldo_cfg = {
        .chan_id    = 3,
        .voltage_mv = 2500,
    };
    err = esp_ldo_acquire_channel(&ldo_cfg, &ldo);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "LDO acquire failed: %s", esp_err_to_name(err));
        return err;
    }

    /* backlight off while the panel is not initialised */
    err = backlight_init();
    if (err != ESP_OK) {
        return err;
    }
    backlight_set(0);

    /* hold the panel in reset */
    gpio_config_t rst_cfg = {
        .pin_bit_mask = 1ULL << PIN_LCD_RST,
        .mode         = GPIO_MODE_OUTPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    err = gpio_config(&rst_cfg);
    if (err != ESP_OK) {
        return err;
    }
    gpio_set_level(PIN_LCD_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(20));

    /* DSI bus: 2 data lanes, 600 Mbps per lane */
    esp_lcd_dsi_bus_config_t bus_cfg = {
        .bus_id             = 0,
        .num_data_lanes     = LCD_DSI_LANES,
        .phy_clk_src        = MIPI_DSI_PHY_CLK_SRC_DEFAULT,
        .lane_bit_rate_mbps = LCD_LANE_MBPS,
    };
    esp_lcd_dsi_bus_handle_t dsi_bus = NULL;
    err = esp_lcd_new_dsi_bus(&bus_cfg, &dsi_bus);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "new_dsi_bus failed: %s", esp_err_to_name(err));
        return err;
    }

    /* DBI command channel (8-bit cmd / 8-bit param) */
    esp_lcd_dbi_io_config_t dbi_cfg = {
        .virtual_channel = 0,
        .lcd_cmd_bits    = 8,
        .lcd_param_bits  = 8,
    };
    err = esp_lcd_new_panel_io_dbi(dsi_bus, &dbi_cfg, &s_io);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "new_panel_io_dbi failed: %s", esp_err_to_name(err));
        return err;
    }

    /* DPI video panel: 800x1280 RGB565 + recovered timing */
    esp_lcd_dpi_panel_config_t dpi_cfg = {
        .virtual_channel    = 0,
        .dpi_clk_src        = LCD_DPI_CLK,
        .dpi_clock_freq_mhz = LCD_DPI_MHZ,
        .pixel_format       = LCD_COLOR_PIXEL_FORMAT_RGB565,
        .in_color_format    = COLOR_TYPE_ID(COLOR_SPACE_RGB, COLOR_PIXEL_RGB565),
        .out_color_format   = COLOR_TYPE_ID(COLOR_SPACE_RGB, COLOR_PIXEL_RGB565),
        .num_fbs            = 2,
        .video_timing = {
            .h_size            = LCD_H_RES,
            .v_size            = LCD_V_RES,
            .hsync_pulse_width = LCD_HSW,
            .hsync_back_porch  = LCD_HBP,
            .hsync_front_porch = LCD_HFP,
            .vsync_pulse_width = LCD_VSW,
            .vsync_back_porch  = LCD_VBP,
            .vsync_front_porch = LCD_VFP,
        },
        .flags.use_dma2d = 0,
    };
    err = esp_lcd_new_panel_dpi(dsi_bus, &dpi_cfg, &s_panel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "new_panel_dpi failed: %s", esp_err_to_name(err));
        return err;
    }

    /* release reset, wait for the panel to power up */
    gpio_set_level(PIN_LCD_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(120));

    /* send the 19-command SC7705 init sequence recovered from lakala.bin */
    for (size_t i = 0; i < sizeof(sc7705_init_cmds) / sizeof(sc7705_init_cmds[0]); i++) {
        const sc7705_init_cmd_t *c = &sc7705_init_cmds[i];
        err = esp_lcd_panel_io_tx_cmd(s_io, c->cmd, c->data, c->data_bytes);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "init cmd 0x%02X failed: %s", c->cmd, esp_err_to_name(err));
            return err;
        }
        if (c->delay_ms) {
            vTaskDelay(pdMS_TO_TICKS(c->delay_ms));
        }
    }

    /* start the DPI video stream only after the panel has been configured */
    err = esp_lcd_panel_init(s_panel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "panel init failed: %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG, "SC7705 up: %dx%d RGB565, %d lanes @ %d Mbps, DPI %d MHz",
             LCD_H_RES, LCD_V_RES, LCD_DSI_LANES, LCD_LANE_MBPS, LCD_DPI_MHZ);
    return ESP_OK;
}

/* ------------------------------------------------------------------------- */
static size_t read_file(const char *path, uint8_t *buf, size_t cap)
{
    FILE *f = fopen(path, "rb");
    if (!f) {
        ESP_LOGW(TAG, "open %s failed", path);
        return 0;
    }
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return 0;
    }
    long size = ftell(f);
    if (size <= 0 || (size_t)size > cap) {
        ESP_LOGW(TAG, "%s: bad size %ld", path, size);
        fclose(f);
        return 0;
    }
    rewind(f);
    size_t rd = fread(buf, 1, (size_t)size, f);
    fclose(f);
    return rd == (size_t)size ? rd : 0;
}

static bool draw_jpeg(const char *name, uint8_t *fb)
{
    char path[64];
    snprintf(path, sizeof(path), "%s/%s", POSTER_DIR, name);

    size_t size = read_file(path, s_jpeg_buf, JPEG_BUF_BYTES);
    if (size == 0) {
        return false;
    }

    jpeg_decode_picture_info_t info;
    if (jpeg_decoder_get_info(s_jpeg_buf, size, &info) != ESP_OK) {
        ESP_LOGW(TAG, "%s: not a valid JPEG", name);
        return false;
    }
    if (info.width != LCD_H_RES || info.height != LCD_V_RES) {
        ESP_LOGW(TAG, "%s: %ux%u, need %dx%d", name,
                 (unsigned)info.width, (unsigned)info.height, LCD_H_RES, LCD_V_RES);
        return false;
    }

    jpeg_decode_cfg_t cfg = {
        .output_format = JPEG_DECODE_OUT_FORMAT_RGB565,
        .rgb_order     = JPEG_RGB_ORDER,
    };
    uint32_t out_size = 0;
    esp_err_t err = jpeg_decoder_process(s_jpeg, &cfg, s_jpeg_buf, size,
                                         fb, LCD_FB_BYTES, &out_size);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s: decode failed (%s)", name, esp_err_to_name(err));
        return false;
    }

    err = esp_lcd_panel_draw_bitmap(s_panel, 0, 0, LCD_H_RES, LCD_V_RES, fb);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s: draw failed (%s)", name, esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "showing %s", name);
    return true;
}

static void fill_screen(uint8_t *fb, uint16_t color)
{
    uint16_t *p = (uint16_t *)fb;
    for (size_t i = 0; i < (size_t)LCD_H_RES * LCD_V_RES; i++) {
        p[i] = color;
    }
    esp_lcd_panel_draw_bitmap(s_panel, 0, 0, LCD_H_RES, LCD_V_RES, fb);
}

static int poster_cmp(const void *a, const void *b)
{
    return strcmp((const char *)a, (const char *)b);
}

static int list_posters(char names[][POSTER_NAME_MAX], int max)
{
    DIR *dir = opendir(POSTER_DIR);
    if (!dir) {
        return 0;
    }

    int n = 0;
    struct dirent *ent;
    while ((ent = readdir(dir)) != NULL && n < max) {
        const char *dot = strrchr(ent->d_name, '.');
        if (!dot) {
            continue;
        }
        if (strcasecmp(dot, ".jpg") != 0 && strcasecmp(dot, ".jpeg") != 0) {
            continue;
        }
        if (ent->d_name[0] == '.') {
            continue;
        }
        snprintf(names[n], POSTER_NAME_MAX, "%s", ent->d_name);
        n++;
    }
    closedir(dir);

    qsort(names, n, POSTER_NAME_MAX, poster_cmp);
    return n;
}

/* ------------------------------------------------------------------------- */
void app_main(void)
{
    ESP_LOGI(TAG, "SC7705 offline poster player");

    /* 2 MB staging buffer for the JPEG bitstream (PSRAM) */
    s_jpeg_buf = heap_caps_aligned_alloc(64, JPEG_BUF_BYTES,
                                         MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_jpeg_buf) {
        ESP_LOGE(TAG, "no PSRAM for JPEG buffer (check CONFIG_SPIRAM)");
        return;
    }

    if (lcd_init() != ESP_OK) {
        ESP_LOGE(TAG, "LCD init failed");
        return;
    }

    esp_err_t err = rgb_led_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "RGB LED init failed: %s", esp_err_to_name(err));
    }
    rgb_led_set(0, 0, 0);

    /* hardware JPEG decoder */
    jpeg_decode_engine_cfg_t eng_cfg = {
        .intr_priority = 0,
        .timeout_ms    = 2000,
    };
    err = jpeg_new_decoder_engine(&eng_cfg, &s_jpeg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "JPEG engine init failed: %s", esp_err_to_name(err));
        return;
    }

    /* SPIFFS with the posters */
    esp_vfs_spiffs_conf_t spiffs = {
        .base_path              = POSTER_DIR,
        .partition_label        = "storage",
        .max_files              = 4,
        .format_if_mount_failed = true,
    };
    bool have_fs = (esp_vfs_spiffs_register(&spiffs) == ESP_OK);
    if (!have_fs) {
        ESP_LOGE(TAG, "SPIFFS mount failed, showing solid colour");
    }

    /* frame buffers */
    void *fb[2] = { NULL, NULL };
    err = esp_lcd_dpi_panel_get_frame_buffer(s_panel, 2, &fb[0], &fb[1]);
    if (err != ESP_OK || !fb[0] || !fb[1]) {
        ESP_LOGE(TAG, "get frame buffer failed: %s", esp_err_to_name(err));
        return;
    }

    char names[POSTER_MAX][POSTER_NAME_MAX];
    int count = have_fs ? list_posters(names, POSTER_MAX) : 0;
    ESP_LOGI(TAG, "%d poster(s) found", count);

    /* The driver scans out fb[0] first. Decode the first poster into fb[1] so
     * the image is never written into the buffer that is being displayed. */
    int cur = 1;
    if (count == 0) {
        /* nothing to show: paint the panel so the backlight has a clean image */
        fill_screen((uint8_t *)fb[0], 0x0000);
        backlight_set(80);
        while (true) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    /* first frame before the backlight comes on */
    int first = -1;
    for (int i = 0; i < count; i++) {
        if (draw_jpeg(names[i], (uint8_t *)fb[cur])) {
            first = i;
            break;
        }
    }
    if (first < 0) {
        fill_screen((uint8_t *)fb[0], 0x0000);
        backlight_set(80);
        while (true) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    rgb_led_set(s_led_palette[0][0], s_led_palette[0][1], s_led_palette[0][2]);
    backlight_set(80);

    int slide = 0;
    int shown_idx = first;
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(SLIDE_MS));

        cur ^= 1;
        bool shown = false;
        for (int tries = 1; tries <= count; tries++) {
            int idx = (shown_idx + tries) % count;
            if (draw_jpeg(names[idx], (uint8_t *)fb[cur])) {
                shown_idx = idx;
                shown = true;
                break;
            }
        }
        if (shown) {
            slide++;
            const uint8_t *c = s_led_palette[slide % (sizeof(s_led_palette) / 3)];
            rgb_led_set(c[0], c[1], c[2]);
        }
    }
}
