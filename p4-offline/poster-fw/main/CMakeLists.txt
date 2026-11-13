idf_component_register(SRCS "main.c"
                       INCLUDE_DIRS "."
                       REQUIRES esp_lcd
                                esp_driver_jpeg
                                esp_driver_gpio
                                esp_driver_ledc
                                esp_hw_support
                                spiffs)

# Build the SPIFFS image from ../posters and flash it together with the app.
# Requires CONFIG_PARTITION_TABLE_CUSTOM with a partition named "storage".
spiffs_create_partition_image(storage "${CMAKE_CURRENT_LIST_DIR}/../posters" FLASH_IN_PROJECT)
