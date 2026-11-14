// Nib mic + AI test (no screen needed). Board: 3.5" ESP32-S3 display, ES3C35P / Elecrow N16R8.
// Hold the BOOT button (IO0), speak, release: the recording goes to the Nib server (/voice), and the transcript and the answer are printed on the serial monitor.
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <ESP_I2S.h>
#include <ArduinoJson.h>
#include "AudioBoard.h"
#include "secrets.h"

#define PIN_SDA 38
#define PIN_SCL 39
#define PIN_MCLK 17
#define PIN_BCLK 18
#define PIN_WS 21
#define PIN_DOUT 15
#define PIN_DIN 16
#define PIN_PA 1
#define BTN 0
#define RATE 16000
#define MAX_SEC 6
#define MIC_GAIN_REG16 6        // found by the gain sweep: speech ~1300 rms vs ~10 in silence

DriverDeviceInfo pins; AudioBoard board(AudioDriverES8311, pins); I2SClass i2s;
static void wr(uint8_t reg, uint8_t val) { Wire.beginTransmission(0x18); Wire.write(reg); Wire.write(val); Wire.endTransmission(); }

static void wifiUp() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Wi-Fi: joining %s ...\n", WIFI_SSID); WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t = millis(); while (WiFi.status() != WL_CONNECTED && millis() - t < 20000) { delay(300); Serial.print("."); }
  if (WiFi.status() == WL_CONNECTED) Serial.printf("\nWi-Fi OK, my IP %s, server %s\n", WiFi.localIP().toString().c_str(), SERVER_URL); else Serial.println("\nWi-Fi FAILED (check name/password, must be a 2.4 GHz network)");
}

void setup() {
  Serial.begin(115200); delay(2500); Serial.println("\n=== Nib mic + AI ===");
  pinMode(BTN, INPUT_PULLUP); pinMode(PIN_PA, OUTPUT); digitalWrite(PIN_PA, HIGH);   // speaker amp off
  pins.addI2C(PinFunction::CODEC, PIN_SCL, PIN_SDA, 0x18);
  i2s.setPins(PIN_BCLK, PIN_WS, PIN_DOUT, PIN_DIN, PIN_MCLK);
  if (!i2s.begin(I2S_MODE_STD, RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) { Serial.println("I2S FAILED"); return; }
  CodecConfig cfg; cfg.input_device = ADC_INPUT_LINE1; cfg.output_device = DAC_OUTPUT_ALL; cfg.i2s.bits = BIT_LENGTH_16BITS; cfg.i2s.rate = RATE_16K; cfg.i2s.fmt = I2S_NORMAL; cfg.i2s.mode = MODE_SLAVE;
  Serial.println(board.begin(cfg) ? "codec OK" : "codec FAILED"); wr(0x16, MIC_GAIN_REG16);
  wifiUp(); Serial.println("Ready: HOLD the BOOT button, speak, release.");
}

void loop() {
  if (digitalRead(BTN) == HIGH) { delay(20); return; }
  wifiUp();
  const size_t maxFrames = (size_t)RATE * MAX_SEC;                         // stereo frames
  int16_t* st = (int16_t*)ps_malloc(maxFrames * 4); int16_t* mono = (int16_t*)ps_malloc(maxFrames * 2);
  if (!st || !mono) { Serial.println("out of memory"); delay(1000); return; }
  Serial.println("recording... (release to send)"); size_t frames = 0; double eL = 0, eR = 0; static int16_t tmp[512];
  while (digitalRead(BTN) == LOW && frames < maxFrames) { size_t got = i2s.readBytes((char*)tmp, sizeof(tmp)) / 4; for (size_t i = 0; i < got && frames < maxFrames; i++, frames++) { st[frames * 2] = tmp[i * 2]; st[frames * 2 + 1] = tmp[i * 2 + 1]; eL += (double)tmp[i * 2] * tmp[i * 2]; eR += (double)tmp[i * 2 + 1] * tmp[i * 2 + 1]; } }
  int ch = eL >= eR ? 0 : 1; for (size_t i = 0; i < frames; i++) mono[i] = st[i * 2 + ch];                 // use whichever channel carries the microphone
  double rms = frames ? sqrt((ch ? eR : eL) / frames) : 0; Serial.printf("recorded %.1f s, channel %s, level rms %.0f\n", frames / (float)RATE, ch ? "R" : "L", rms);
  if (frames < RATE * 0.4) { Serial.println("too short, ignored"); }
  else {
    HTTPClient http; http.setTimeout(40000); http.begin(String(SERVER_URL) + "/voice"); http.addHeader("Content-Type", "application/octet-stream");
    Serial.println("thinking..."); uint32_t t0 = millis(); int code = http.POST((uint8_t*)mono, frames * 2); String body = http.getString(); http.end();
    if (code != 200) Serial.printf("server answered HTTP %d (is the Nib server running on %s ? same Wi-Fi?)\n", code, SERVER_URL);
    else { JsonDocument d; deserializeJson(d, body); Serial.printf("YOU SAID : %s\nNIB SAYS : %s   [%s]   (%.1f s)\n", d["heard"] | "(nothing)", d["say"] | "(no answer)", d["state"] | "?", (millis() - t0) / 1000.0f); }
  }
  free(st); free(mono); while (digitalRead(BTN) == LOW) delay(20); Serial.println("Ready: hold BOOT, speak, release.");
}
