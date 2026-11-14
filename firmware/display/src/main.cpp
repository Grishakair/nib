// Nib display test: ST77922 QSPI. Pins: CS10 SCK12 D0=11 D1=13 D2=14 D3=9, backlight IO41, reset tied to EN.
#include <Arduino.h>
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_st77922.h"
#include "nib_sprites.h"
#include "st77922_vendor_init.h"

#define W 320
#define H 480
static esp_lcd_panel_handle_t panel;
static uint16_t *fb; static uint16_t *line; static SemaphoreHandle_t done;
static bool IRAM_ATTR onDone(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void*) { BaseType_t w = pdFALSE; xSemaphoreGiveFromISR(done, &w); return w == pdTRUE; }
static void blit(int x0, int y0, int x1, int y1, const void* d) { esp_err_t e = esp_lcd_panel_draw_bitmap(panel, x0, y0, x1, y1, d); if (e) Serial.printf("draw err %d\n", e); xSemaphoreTake(done, pdMS_TO_TICKS(500)); }   // one strip buffer in DMA-capable RAM

static void flush() {                                        // whole frame, 40 rows at a time through a DMA bounce buffer
  for (int y = 0; y < H; y += 8) { const uint16_t *src = fb + (size_t)y * W; for (int i = 0; i < W * 8; i++) line[i] = __builtin_bswap16(src[i]); blit(0, y, W, y + 8, line); }
}
static void fillFb(uint16_t c) { for (size_t i = 0; i < (size_t)W * H; i++) fb[i] = c; }
static void spriteFb(const uint16_t *s, int x, int y, int scale, uint16_t bg) {
  for (int sy = 0; sy < NIB_H; sy++) for (int sx = 0; sx < NIB_W; sx++) {
    uint16_t c = pgm_read_word(&s[sy * NIB_W + sx]); if (c == NIB_KEY) continue;
    for (int j = 0; j < scale; j++) for (int i = 0; i < scale; i++) fb[(size_t)(y + sy * scale + j) * W + x + sx * scale + i] = c;
  }
}

void setup() {
  Serial.begin(115200); delay(1500); Serial.println("\n=== Nib display test ===");
  pinMode(41, OUTPUT); digitalWrite(41, HIGH);
  done = xSemaphoreCreateBinary(); line = (uint16_t*)heap_caps_malloc(W * 40 * 2, MALLOC_CAP_DMA); fb = (uint16_t*)heap_caps_malloc(W * H * 2, MALLOC_CAP_SPIRAM); if (!fb || !line) { Serial.println("alloc FAILED"); while (1) delay(1000); }
  spi_bus_config_t bus = {}; bus.data0_io_num = 11; bus.data1_io_num = 13; bus.sclk_io_num = 12; bus.data2_io_num = 14; bus.data3_io_num = 9; bus.max_transfer_sz = W * 8 * 2;
  ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));
  esp_lcd_panel_io_handle_t io = NULL;
  esp_lcd_panel_io_spi_config_t ioc = ST77922_PANEL_IO_QSPI_CONFIG(10, onDone, NULL); ioc.pclk_hz = 20 * 1000 * 1000;
  ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &ioc, &io));
  const st77922_vendor_config_t vc = { .init_cmds = vendor_init, .init_cmds_size = sizeof(vendor_init) / sizeof(vendor_init[0]), .flags = { .use_qspi_interface = 1 } };
  const esp_lcd_panel_dev_config_t pc = { .reset_gpio_num = -1, .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB, .bits_per_pixel = 16, .vendor_config = (void*)&vc };
  ESP_ERROR_CHECK(esp_lcd_new_panel_st77922(io, &pc, &panel));
  esp_lcd_panel_reset(panel); esp_lcd_panel_init(panel); esp_lcd_panel_disp_on_off(panel, true);
  Serial.println("panel init done");
  { auto cmd=[&](uint8_t c){ esp_err_t e=esp_lcd_panel_io_tx_param(io, (0x02<<24)|(c<<8), NULL, 0); Serial.printf("cmd %02X -> %d\n", c, e); };
    cmd(0x11); delay(150); cmd(0x29); delay(50);
    Serial.println("ALL PIXELS ON (white expected) 5 s"); cmd(0x23); delay(1500); cmd(0x22); cmd(0x13); Serial.println("normal mode"); }
  const uint16_t cols[] = {0xF800, 0x07E0, 0x001F};
  for (int i = 0; i < 3; i++) { fillFb(cols[i]); flush(); delay(1500); }
  Serial.println("drawn");
}
void loop() {
  static uint32_t n = 0, nextBlink = 0; static bool blink = false;
  uint32_t now = millis();
  if (now >= nextBlink) { blink = !blink; nextBlink = now + (blink ? 150 : 1800); }
  fillFb(0x0010);
  spriteFb(blink ? SPR_NIB_BLINK : SPR_NIB_IDLE, (W - NIB_W * 10) / 2, 120, 10, 0x0010);
  flush();
  if (++n % 50 == 0) Serial.printf("frame %u (%u ms)\n", n, millis() - now);
  delay(30);
}
