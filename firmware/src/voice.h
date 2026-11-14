// Push-to-talk: hold BOOT (GPIO0) to record, release to send. Fill I2S pins from your board's schematic.
#pragma once
#include <ESP_I2S.h>   // arduino-esp32 >= 3.0
#define MIC_BCLK 41
#define MIC_WS   42
#define MIC_DIN  2
#define PTT_PIN  0
#define MAX_SEC  6
static I2SClass micI2S;
inline void micBegin(){ micI2S.setPins(MIC_BCLK, MIC_WS, -1, MIC_DIN); micI2S.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO, I2S_STD_SLOT_LEFT); pinMode(PTT_PIN, INPUT_PULLUP); }
// Records into PSRAM while button held. Returns bytes (caller frees *out).
inline size_t micRecord(uint8_t** out){
  size_t cap = 16000*2*MAX_SEC, n = 0; *out = (uint8_t*)ps_malloc(cap);
  while(digitalRead(PTT_PIN)==LOW && n+512<=cap){ n += micI2S.readBytes((char*)(*out)+n, 512); }
  return n;
}
