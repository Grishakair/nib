// Nib mic test: wakes the ES8311 audio codec and shows a live level meter of the on-board microphone (serial, 115200).
// Board: 3.5" ESP32-S3 display (ES3C35P / Elecrow N16R8). Pins from the vendor page:
//   codec I2C: SDA 38, SCL 39 (address 0x18)   I2S: MCLK 17, BCLK 18, WS 21, to-codec DOUT 15, from-codec DIN 16   speaker amp enable: IO1 (active low)
// Speak or clap near the board: the bar must move. Prints "MIC OK" once it has heard something clearly above the silence level.
#include <Arduino.h>
#include <ESP_I2S.h>
#include <Wire.h>
#include "AudioBoard.h"

#define PIN_SDA 38
#define PIN_SCL 39
#define PIN_MCLK 17
#define PIN_BCLK 18
#define PIN_WS 21
#define PIN_DOUT 15
#define PIN_DIN 16
#define PIN_PA 1

DriverDeviceInfo pins;
AudioBoard board(AudioDriverES8311, pins);
I2SClass i2s;

void setup() {
  Serial.begin(115200); delay(2500);
  Serial.println("\n=== Nib mic test ===");
  pinMode(PIN_PA, OUTPUT); digitalWrite(PIN_PA, HIGH);                 // speaker amplifier OFF (active low): we only listen
  pins.addI2C(PinFunction::CODEC, PIN_SCL, PIN_SDA, 0x18);
  i2s.setPins(PIN_BCLK, PIN_WS, PIN_DOUT, PIN_DIN, PIN_MCLK);           // order: bclk, ws, dout, din, mclk
  if (!i2s.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) { Serial.println("I2S start FAILED"); return; }   // MCLK must run before the codec is configured
  CodecConfig cfg; cfg.input_device = ADC_INPUT_LINE1; cfg.output_device = DAC_OUTPUT_ALL;
  cfg.i2s.bits = BIT_LENGTH_16BITS; cfg.i2s.rate = RATE_16K; cfg.i2s.fmt = I2S_NORMAL; cfg.i2s.mode = MODE_SLAVE;
  Serial.println(board.begin(cfg) ? "codec configured" : "codec begin FAILED");
  Serial.println("Make some noise near the board (clap, speak)...");
}

static void wr(uint8_t reg, uint8_t val) { Wire.beginTransmission(0x18); Wire.write(reg); Wire.write(val); Wire.endTransmission(); }
static uint8_t rd(uint8_t reg) { Wire.beginTransmission(0x18); Wire.write(reg); Wire.endTransmission(false); Wire.requestFrom((uint8_t)0x18, (uint8_t)1); return Wire.available() ? Wire.read() : 0xFF; }
// gain sweep: every 4 s a new value of ADC digital gain (REG16 bits 2..0, 0..7 = 0..42 dB); prints quiet level vs speech level per step
void loop() {
  static int gain = -1; static uint32_t gStart = 0; static float gMin = 1e9, gMax = 0; static float best = 0; static int bestGain = 0;
  if (gain < 0 && millis() > 4000) { Serial.printf("regs: 0x14=%02X 0x16=%02X 0x17=%02X\n", rd(0x14), rd(0x16), rd(0x17)); gain = 0; gStart = millis(); wr(0x16, 0x00); Serial.println("SWEEP start: say things / play speech near the board"); }
  static int16_t buf[1024]; static uint32_t t0 = millis(); static float floorRms = -1; static bool ok = false;
  size_t n = i2s.readBytes((char*)buf, sizeof(buf)) / 2; if (!n) { Serial.println("no I2S data"); delay(500); return; }
  double s = 0; int peak = 0; for (size_t i = 0; i < n; i++) { int v = abs(buf[i]); s += (double)buf[i] * buf[i]; if (v > peak) peak = v; }
  float rms = sqrt(s / n); if (floorRms < 0) floorRms = rms;
  if (millis() - t0 < 3000) floorRms = min(floorRms, rms);              // first 3 s = silence level
  if (gain >= 0 && gain < 8) { gMin = min(gMin, rms); gMax = max(gMax, rms);
    if (millis() - gStart > 4000) { float snr = gMax / max(gMin, 1.0f); Serial.printf("GAIN %d: quiet %5.0f speech %6.0f ratio %5.1f\n", gain, gMin, gMax, snr); if (gMax < 20000 && snr * (gMax > 300 ? 1.0f : 0.3f) > best) { best = snr * (gMax > 300 ? 1.0f : 0.3f); bestGain = gain; }
      gain++; gMin = 1e9; gMax = 0; gStart = millis(); if (gain < 8) wr(0x16, gain); else { wr(0x16, bestGain); Serial.printf("BEST GAIN = %d (set; meter continues)\n", bestGain); } } }
  static uint32_t last = 0; if (millis() - last > 250) { last = millis(); int bars = min(40, (int)(rms / 60.0)); char line[64]; for (int i = 0; i < 40; i++) line[i] = i < bars ? '#' : '.'; line[40] = 0; Serial.printf("rms %6.0f peak %5d  %s\n", rms, peak, line); }
  if (!ok && millis() - t0 > 3500 && rms > floorRms * 4 + 300) { ok = true; Serial.println(">>> MIC OK: heard sound clearly above the silence level <<<"); }
}
