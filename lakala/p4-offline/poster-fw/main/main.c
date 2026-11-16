/*
 * MFCAFE CS80 poster screen — ESP32-P4 firmware
 *
 * Hardware (reverse-engineered from the CS80 PCB, PCB is NOT modified):
 *   Module      : WT0132P4-A1-N16R32X (ESP32-P4, 16MB flash, 32MB PSRAM)
 *   Panel       : SC7705, 800x1280, MIPI-DSI 2 lanes @ 600 Mbps
 *   DSI reset   : GPIO36
 *   Backlight   : GPIO24 -> MP3202 EN (PWM dimming)
 *   USB         : USB-C D+/D- -> module pins 16/17 (12 Mbps full-speed device,
 *                 external 1.5k pull-up on DP)
 *
 * Data path: Raspberry Pi enumerates the P4 as a USB CDC-ACM serial port,
 * pushes JPEG posters with a tiny framed protocol, the P4 stores them in
 * SPIFFS and loops them on the panel (hardware JPEG decode, no video).
 *
 * !!! NOT YET VALIDATED ON HARDWARE !!!
 * The LCD init table / timings come from the stock firmware image, but the
 * ESP-IDF side has never been compiled or run against the real board.
 */
#include <dirent.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>

#include "esp_check.h"
#include "driver/gpio.h"
#include "driver/jpeg_decode.h"
#include "driver/ledc.h"
#include "driver/usb_serial_jtag.h"
#include "esp_heap_caps.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_log.h"
#include "esp_rom_crc.h"
#include "esp_spiffs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "sc7705_init.h"

#define LCD_H_RES 800
#define LCD_V_RES 1280

#define PIN_LCD_RST 36
#define PIN_BL 24

#define POSTER_MOUNT "/spiffs"
#define CFG_PATH POSTER_MOUNT "/cfg.txt"
#define MAX_POSTERS 64
#define MAX_NAME_LEN 64
#define MAX_JPEG_BYTES (6 * 1024 * 1024)

#define DEFAULT_INTERVAL_MS 8000
#define DEFAULT_BRIGHTNESS 80

#define FRAME_MAX 16384
#define RX_BUF_SIZE (FRAME_MAX * 2)
#define PUT_CHUNK_MAX 4096

static const char *TAG = "poster";

static esp_lcd_dsi_bus_handle_t s_dsi_bus;
static esp_lcd_panel_io_handle_t s_io;
static esp_lcd_panel_handle_t s_panel;
static jpeg_decoder_handle_t s_jpeg;

static uint8_t *s_rgb;   /* 800*1280*2 bytes in PSRAM */
static uint32_t s_rgb_len;

static SemaphoreHandle_t s_lock;
static volatile bool s_reload;
static volatile uint32_t s_interval_ms = DEFAULT_INTERVAL_MS;
static volatile uint8_t s_brightness = DEFAULT_BRIGHTNESS;

typedef struct {
    char name[MAX_NAME_LEN];
    uint32_t size;
} poster_t;

static poster_t s_posters[MAX_POSTERS];
static int s_poster_count;

/* ------------------------------------------------------------------ */
/* Backlight                                                          */
/* ------------------------------------------------------------------ */
static void backlight_init(void)
{
    ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 5000,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer));

    ledc_channel_config_t ch = {
        .gpio_num = PIN_BL,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
        .hpoint = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&ch));
}

static void set_brightness(uint8_t percent)
{
    if (percent > 100) percent = 100;
    s_brightness = percent;
    uint32_t duty = (uint32_t)percent * 1023 / 100;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

/* ------------------------------------------------------------------ */
/* Panel                                                              */
/* ------------------------------------------------------------------ */
static void panel_reset(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << PIN_LCD_RST,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io);
    gpio_set_level(PIN_LCD_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(PIN_LCD_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(120));
}

static esp_err_t panel_init(void)
{
    panel_reset();

    esp_lcd_dsi_bus_config_t bus_cfg = {
        .bus_id = 0,
        .num_data_lanes = 2,
        .phy_clk_src = MIPI_DSI_PHY_CLK_SRC_DEFAULT,
        .lane_bit_rate_mbps = 600,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_dsi_bus(&bus_cfg, &s_dsi_bus), TAG, "dsi bus");

    esp_lcd_dbi_io_config_t dbi_cfg = {
        .virtual_channel = 0,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_dbi(s_dsi_bus, &dbi_cfg, &s_io), TAG, "dbi io");

    /* Vendor table must be sent while the panel is still out of the DPI
     * stream: sleep-out (0x11) and display-on (0x29) are the last entries. */
    for (size_t i = 0; i < SC7705_INIT_TABLE_LEN; i++) {
        const sc7705_cmd_t *c = &sc7705_init_table[i];
        ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(s_io, c->cmd, c->data, c->len),
                            TAG, "cmd 0x%02x", c->cmd);
        if (c->delay_ms) {
            vTaskDelay(pdMS_TO_TICKS(c->delay_ms));
        }
    }
    ESP_LOGI(TAG, "sc7705 init table sent (%d cmds)", (int)SC7705_INIT_TABLE_LEN);

    esp_lcd_dpi_panel_config_t dpi_cfg = {
        .virtual_channel = 0,
        .dpi_clk_src = MIPI_DSI_DPI_CLK_SRC_DEFAULT,
        .dpi_clock_freq_mhz = 80,
        .pixel_format = LCD_COLOR_PIXEL_FORMAT_RGB565,
        .in_color_format = LCD_COLOR_FMT_RGB565,
        .out_color_format = LCD_COLOR_FMT_RGB565,
        .num_fbs = 2,
        .video_timing = {
            .h_size = LCD_H_RES,
            .v_size = LCD_V_RES,
            .hsync_pulse_width = 120,
            .hsync_back_porch = 140,
            .hsync_front_porch = 140,
            .vsync_pulse_width = 4,
            .vsync_back_porch = 10,
            .vsync_front_porch = 156,
        },
        .flags = {
            .use_dma2d = true,
        },
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_dpi(s_dsi_bus, &dpi_cfg, &s_panel), TAG, "dpi panel");
    /* The DPI panel has no disp_on_off op: init() starts the video stream. */
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s_panel), TAG, "panel init");
    return ESP_OK;
}

/* ------------------------------------------------------------------ */
/* Storage                                                            */
/* ------------------------------------------------------------------ */
static esp_err_t storage_init(void)
{
    esp_vfs_spiffs_conf_t conf = {
        .base_path = POSTER_MOUNT,
        .partition_label = "storage",
        .max_files = 8,
        .format_if_mount_failed = true,
    };
    esp_err_t err = esp_vfs_spiffs_register(&conf);
    if (err != ESP_OK) return err;

    size_t total = 0, used = 0;
    esp_spiffs_info("storage", &total, &used);
    ESP_LOGI(TAG, "spiffs: %u/%u bytes used", (unsigned)used, (unsigned)total);
    return ESP_OK;
}

static int cmp_poster(const void *a, const void *b)
{
    return strcmp(((const poster_t *)a)->name, ((const poster_t *)b)->name);
}

static bool poster_name_ok(const char *name)
{
    size_t n = strlen(name);
    if (n < 5 || n >= MAX_NAME_LEN) return false;
    if (strchr(name, '/') || strchr(name, '\\')) return false;
    if (strstr(name, "..")) return false;
    const char *dot = strrchr(name, '.');
    if (!dot) return false;
    return !strcasecmp(dot, ".jpg") || !strcasecmp(dot, ".jpeg");
}

/* Caller must hold s_lock. */
static void scan_posters(void)
{
    DIR *dir = opendir(POSTER_MOUNT);
    if (!dir) {
        s_poster_count = 0;
        return;
    }

    s_poster_count = 0;
    struct dirent *de;
    while ((de = readdir(dir)) != NULL && s_poster_count < MAX_POSTERS) {
        if (!poster_name_ok(de->d_name)) continue;
        char path[320];
        snprintf(path, sizeof(path), "%s/%s", POSTER_MOUNT, de->d_name);
        struct stat st;
        if (stat(path, &st) != 0 || st.st_size <= 0) continue;
        strlcpy(s_posters[s_poster_count].name, de->d_name, MAX_NAME_LEN);
        s_posters[s_poster_count].size = (uint32_t)st.st_size;
        s_poster_count++;
    }
    closedir(dir);
    qsort(s_posters, s_poster_count, sizeof(poster_t), cmp_poster);
    ESP_LOGI(TAG, "found %d poster(s)", s_poster_count);
}

/* Caller must hold s_lock. */
static void delete_all_posters(void)
{
    DIR *dir = opendir(POSTER_MOUNT);
    if (!dir) return;
    struct dirent *de;
    while ((de = readdir(dir)) != NULL) {
        if (!poster_name_ok(de->d_name)) continue;
        char path[320];
        snprintf(path, sizeof(path), "%s/%s", POSTER_MOUNT, de->d_name);
        unlink(path);
    }
    closedir(dir);
    s_poster_count = 0;
}

static void load_cfg(void)
{
    FILE *f = fopen(CFG_PATH, "r");
    if (!f) return;
    char line[64];
    while (fgets(line, sizeof(line), f)) {
        unsigned v;
        if (sscanf(line, "interval=%u", &v) == 1) {
            if (v >= 1000 && v <= 600000) s_interval_ms = v;
        } else if (sscanf(line, "bright=%u", &v) == 1) {
            if (v <= 100) s_brightness = (uint8_t)v;
        }
    }
    fclose(f);
}

static void save_cfg(void)
{
    FILE *f = fopen(CFG_PATH, "w");
    if (!f) return;
    fprintf(f, "interval=%u\nbright=%u\n", (unsigned)s_interval_ms, (unsigned)s_brightness);
    fclose(f);
}

/* ------------------------------------------------------------------ */
/* Playback                                                           */
/* ------------------------------------------------------------------ */
static void fill_screen(uint16_t color)
{
    uint16_t *p = (uint16_t *)s_rgb;
    for (uint32_t i = 0; i < (uint32_t)LCD_H_RES * LCD_V_RES; i++) p[i] = color;
    esp_lcd_panel_draw_bitmap(s_panel, 0, 0, LCD_H_RES, LCD_V_RES, s_rgb);
}

static void playback_task(void *arg)
{
    uint8_t *jpeg_buf = NULL;
    uint32_t jpeg_cap = 0;
    int index = 0;

    fill_screen(0x0841); /* dark navy while empty */

    for (;;) {
        if (s_reload) {
            s_reload = false;
            xSemaphoreTake(s_lock, portMAX_DELAY);
            scan_posters();
            xSemaphoreGive(s_lock);
            index = 0;
        }

        poster_t item;
        bool ok = false;

        /* The file list can be wiped at any moment by CLEAR, so take the lock
         * before touching the count or the names. */
        xSemaphoreTake(s_lock, portMAX_DELAY);
        if (s_poster_count == 0) {
            xSemaphoreGive(s_lock);
            fill_screen(0x0841);
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        item = s_posters[index % s_poster_count];
        if (item.size <= MAX_JPEG_BYTES) {
            if (jpeg_cap < item.size) {
                free(jpeg_buf);
                jpeg_buf = heap_caps_malloc(item.size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
                jpeg_cap = jpeg_buf ? item.size : 0;
            }
            if (jpeg_buf) {
                char path[320];
                snprintf(path, sizeof(path), "%s/%s", POSTER_MOUNT, item.name);
                FILE *f = fopen(path, "rb");
                if (f) {
                    ok = fread(jpeg_buf, 1, item.size, f) == item.size;
                    fclose(f);
                }
            }
        }
        xSemaphoreGive(s_lock);

        if (ok) {
            uint32_t out_len = 0;
            jpeg_decode_cfg_t dec_cfg = {
                .output_format = JPEG_DECODE_OUT_FORMAT_RGB565,
                /* If red/blue are swapped on the real panel, switch to
                 * JPEG_DEC_RGB_ELEMENT_ORDER_RGB. */
                .rgb_order = JPEG_DEC_RGB_ELEMENT_ORDER_BGR,
                .conv_std = JPEG_YUV_RGB_CONV_STD_BT601,
            };
            esp_err_t err = jpeg_decoder_process(s_jpeg, &dec_cfg, jpeg_buf, item.size,
                                                 s_rgb, s_rgb_len, &out_len);
            if (err == ESP_OK && out_len >= s_rgb_len) {
                esp_lcd_panel_draw_bitmap(s_panel, 0, 0, LCD_H_RES, LCD_V_RES, s_rgb);
            } else {
                ESP_LOGW(TAG, "decode %s failed: %s (%u)", item.name, esp_err_to_name(err),
                         (unsigned)out_len);
            }
        }

        index = (index + 1) & 0x7FFFFFFF;
        vTaskDelay(pdMS_TO_TICKS(s_interval_ms));
    }
}

/* ------------------------------------------------------------------ */
/* USB CDC protocol                                                   */
/*                                                                    */
/* Frame: 'P' 'S' | type(1) | len(4, little endian) | payload         */
/*   1 PUT_BEGIN : u8 name_len | name | u32 size | u32 crc32          */
/*   2 PUT_DATA  : raw bytes                                          */
/*   3 PUT_END   : -                                                  */
/*   4 CLEAR     : -                                                  */
/*   5 CONFIG    : u32 interval_ms | u8 brightness                    */
/*   6 RELOAD    : -                                                  */
/*   7 STATUS    : -                                                  */
/*   8 PING      : -                                                  */
/* Responses are plain ASCII lines terminated by '\n'.                */
/* ------------------------------------------------------------------ */
enum {
    FRAME_PUT_BEGIN = 1,
    FRAME_PUT_DATA = 2,
    FRAME_PUT_END = 3,
    FRAME_CLEAR = 4,
    FRAME_CONFIG = 5,
    FRAME_RELOAD = 6,
    FRAME_STATUS = 7,
    FRAME_PING = 8,
};

static FILE *s_upload;
static char s_upload_name[MAX_NAME_LEN];
static uint32_t s_upload_size;
static uint32_t s_upload_crc;
static uint32_t s_upload_got;

static void usb_reply(const char *fmt, ...)
{
    char buf[160];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf) - 2, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if (n > (int)sizeof(buf) - 2) n = sizeof(buf) - 2;
    buf[n] = '\n';
    usb_serial_jtag_write_bytes(buf, n + 1, pdMS_TO_TICKS(1000));
}

static void upload_abort(void)
{
    if (s_upload) {
        fclose(s_upload);
        s_upload = NULL;
        char path[320];
        snprintf(path, sizeof(path), "%s/%s", POSTER_MOUNT, s_upload_name);
        unlink(path);
    }
}

static void handle_frame(uint8_t type, const uint8_t *p, uint32_t len)
{
    switch (type) {
    case FRAME_PUT_BEGIN: {
        upload_abort();
        if (len < 1) { usb_reply("ERR begin"); return; }
        uint8_t nlen = p[0];
        if (len < 1u + nlen + 8u || nlen == 0 || nlen >= MAX_NAME_LEN) {
            usb_reply("ERR name");
            return;
        }
        char name[MAX_NAME_LEN];
        memcpy(name, p + 1, nlen);
        name[nlen] = 0;
        if (!poster_name_ok(name)) { usb_reply("ERR name"); return; }

        uint32_t size, crc;
        memcpy(&size, p + 1 + nlen, 4);
        memcpy(&crc, p + 5 + nlen, 4);
        if (size == 0 || size > MAX_JPEG_BYTES) { usb_reply("ERR size"); return; }

        char path[320];
        snprintf(path, sizeof(path), "%s/%s", POSTER_MOUNT, name);
        xSemaphoreTake(s_lock, portMAX_DELAY);
        s_upload = fopen(path, "wb");
        xSemaphoreGive(s_lock);
        if (!s_upload) { usb_reply("ERR open"); return; }
        strlcpy(s_upload_name, name, MAX_NAME_LEN);
        s_upload_size = size;
        s_upload_crc = crc;
        s_upload_got = 0;
        usb_reply("OK begin %s %u", name, (unsigned)size);
        break;
    }
    case FRAME_PUT_DATA:
        if (!s_upload) { usb_reply("ERR nodata"); return; }
        if (s_upload_got + len > s_upload_size) {
            upload_abort();
            usb_reply("ERR overflow");
            return;
        }
        if (fwrite(p, 1, len, s_upload) != len) {
            upload_abort();
            usb_reply("ERR write");
            return;
        }
        s_upload_got += len;
        break;
    case FRAME_PUT_END: {
        if (!s_upload) { usb_reply("ERR noput"); return; }
        fclose(s_upload);
        s_upload = NULL;
        char path[320];
        snprintf(path, sizeof(path), "%s/%s", POSTER_MOUNT, s_upload_name);
        uint32_t crc = 0;
        FILE *f = fopen(path, "rb");
        if (f) {
            uint8_t tmp[1024];
            size_t n;
            while ((n = fread(tmp, 1, sizeof(tmp), f)) > 0) {
                crc = esp_rom_crc32_le(crc, tmp, n);
            }
            fclose(f);
        }
        if (s_upload_got != s_upload_size || crc != s_upload_crc) {
            unlink(path);
            usb_reply("ERR crc");
            return;
        }
        usb_reply("OK put %s %u", s_upload_name, (unsigned)s_upload_size);
        break;
    }
    case FRAME_CLEAR:
        if (s_upload) upload_abort();
        xSemaphoreTake(s_lock, portMAX_DELAY);
        delete_all_posters();
        xSemaphoreGive(s_lock);
        usb_reply("OK cleared");
        break;
    case FRAME_CONFIG: {
        if (len < 5) { usb_reply("ERR config"); return; }
        uint32_t interval;
        uint8_t bright;
        memcpy(&interval, p, 4);
        bright = p[4];
        if (interval >= 1000 && interval <= 600000) s_interval_ms = interval;
        set_brightness(bright);
        save_cfg();
        usb_reply("OK cfg %u %u", (unsigned)s_interval_ms, (unsigned)s_brightness);
        break;
    }
    case FRAME_RELOAD:
        s_reload = true;
        usb_reply("OK reload");
        break;
    case FRAME_STATUS:
        usb_reply("STATUS posters=%d interval=%u bright=%u",
                  s_poster_count, (unsigned)s_interval_ms, (unsigned)s_brightness);
        break;
    case FRAME_PING:
        usb_reply("OK pong");
        break;
    default:
        usb_reply("ERR proto");
        break;
    }
}

static void usb_task(void *arg)
{
    usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    cfg.rx_buffer_size = 8192;
    cfg.tx_buffer_size = 4096;
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&cfg));
    ESP_LOGI(TAG, "usb serial/jtag ready");

    uint8_t *rx = heap_caps_malloc(RX_BUF_SIZE, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!rx) {
        ESP_LOGE(TAG, "no rx buffer");
        vTaskDelete(NULL);
        return;
    }
    size_t pos = 0;

    for (;;) {
        int n = usb_serial_jtag_read_bytes(rx + pos, RX_BUF_SIZE - pos, pdMS_TO_TICKS(100));
        if (n > 0) pos += n;

        for (;;) {
            /* Resync on the 2-byte magic. */
            size_t i = 0;
            while (i + 1 < pos && !(rx[i] == 'P' && rx[i + 1] == 'S')) i++;
            if (i > 0) {
                memmove(rx, rx + i, pos - i);
                pos -= i;
            }
            if (pos < 7) break;

            uint32_t len;
            memcpy(&len, rx + 3, 4);
            if (len > FRAME_MAX) {
                memmove(rx, rx + 2, pos - 2); /* drop magic, resync again */
                pos -= 2;
                continue;
            }
            if (pos < 7 + len) break;

            uint8_t type = rx[2];
            handle_frame(type, rx + 7, len);
            memmove(rx, rx + 7 + len, pos - 7 - len);
            pos -= 7 + len;
        }

        if (pos == RX_BUF_SIZE) {
            pos = 0; /* should never happen: frames are smaller */
        }
    }
}

/* ------------------------------------------------------------------ */
void app_main(void)
{
    ESP_LOGI(TAG, "MFCAFE poster screen starting");

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    s_lock = xSemaphoreCreateMutex();
    configASSERT(s_lock);

    backlight_init();
    set_brightness(0);

    ESP_ERROR_CHECK(storage_init());
    load_cfg();

    s_rgb_len = (uint32_t)LCD_H_RES * LCD_V_RES * 2;
    s_rgb = heap_caps_aligned_alloc(64, s_rgb_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_rgb) {
        ESP_LOGE(TAG, "cannot allocate %u bytes for RGB565 frame", (unsigned)s_rgb_len);
        return;
    }

    jpeg_decode_engine_cfg_t eng_cfg = {
        .intr_priority = 0,
        .timeout_ms = 200,
    };
    ESP_ERROR_CHECK(jpeg_new_decoder_engine(&eng_cfg, &s_jpeg));

    ESP_ERROR_CHECK(panel_init());

    xSemaphoreTake(s_lock, portMAX_DELAY);
    scan_posters();
    xSemaphoreGive(s_lock);

    set_brightness(s_brightness);

    xTaskCreatePinnedToCore(playback_task, "playback", 8192, NULL, 4, NULL, 0);
    xTaskCreatePinnedToCore(usb_task, "usb", 8192, NULL, 5, NULL, 0);

    ESP_LOGI(TAG, "ready");
}
