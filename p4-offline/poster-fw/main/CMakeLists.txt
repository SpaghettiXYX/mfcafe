idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES
        esp_lcd
        esp_driver_gpio
        esp_driver_ledc
        esp_driver_usb_serial_jtag
        esp_driver_jpeg
        spiffs
        nvs_flash
        esp_psram
)

# Bundle ./posters/*.jpg into the SPIFFS "storage" partition at build time.
spiffs_create_partition_image(storage ../posters FLASH_IN_PROJECT)
