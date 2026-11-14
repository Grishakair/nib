// Nib bring-up v2: finds which GPIO pair is the I2C bus (touch controller, audio codec, power chip) by trying them all.
// Prints (115200, USB serial): chip, flash, PSRAM, Wi-Fi networks, then "I2C RESULT" with every pair that has real devices.
// The report repeats every 15 s. Skipped pins: 0,3,45,46 (boot straps), 19,20 (USB), 26-37 (flash/PSRAM), 43,44 (UART0).
// A pair counts only if the lines are idle-high and 1..12 addresses answer (a floating bus answers to everything and is ignored).
#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>

static const char* hint(uint8_t a) {
  switch (a) {
    case 0x38: return "FT6336/FT5x06 capacitive touch";
    case 0x5D: case 0x14: return "GT911 capacitive touch";
    case 0x15: return "CST816 capacitive touch";
    case 0x18: case 0x19: return "ES8311 audio codec (speaker/mic)";
    case 0x40: case 0x41: return "ES7210 mic ADC (or INA219)";
    case 0x34: return "AXP2101 power/battery chip";
    case 0x51: return "PCF85063 RTC";
    case 0x6B: case 0x6A: return "QMI8658 IMU";
    case 0x20: case 0x74: case 0x27: return "I/O expander (TCA9554/PCA9554)";
    default: return "unknown";
  }
}
static const int PINS[] = {1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 38, 39, 40, 41, 42, 47, 48};
struct Hit { int sda, scl, n; uint8_t addr[12]; };
static Hit hits[24]; static int nhits = 0; static bool scanned = false;

static void bruteForce() {
  nhits = 0;
  for (int a : PINS) for (int b : PINS) {
    if (a == b || nhits >= 24) continue;
    pinMode(a, INPUT_PULLUP); pinMode(b, INPUT_PULLUP); delayMicroseconds(100);
    if (digitalRead(a) == LOW || digitalRead(b) == LOW) continue;      // a line held low is not a free bus
    Wire.end(); Wire.begin(a, b, 100000); Wire.setTimeOut(10);
    Hit h = {a, b, 0, {0}};
    for (uint8_t ad = 1; ad < 127 && h.n < 13; ad++) { Wire.beginTransmission(ad); if (Wire.endTransmission() == 0 && h.n < 12) h.addr[h.n++] = ad; else if (h.n >= 12) h.n = 13; }
    if (h.n >= 1 && h.n <= 12) hits[nhits++] = h;
  }
  Wire.end(); scanned = true;
}

static void report() {
  Serial.println("\n=== Nib bring-up v2 report ===");
  Serial.printf("Chip: %s rev %d, %d core(s), %d MHz\n", ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores(), ESP.getCpuFreqMHz());
  Serial.printf("Flash: %u MB | PSRAM: %u KB (free %u KB) | free heap: %u KB\n", ESP.getFlashChipSize() / 1048576, ESP.getPsramSize() / 1024, ESP.getFreePsram() / 1024, ESP.getFreeHeap() / 1024);
  Serial.printf("MAC: %s\n", WiFi.macAddress().c_str());
  Serial.println("-- Wi-Fi networks --");
  WiFi.mode(WIFI_STA); int n = WiFi.scanNetworks();
  for (int i = 0; i < n && i < 6; i++) Serial.printf("  %-24s %4d dBm\n", WiFi.SSID(i).c_str(), WiFi.RSSI(i));
  Serial.println("-- I2C RESULT (pairs with real devices) --");
  if (!scanned) Serial.println("  scanning...");
  else if (!nhits) Serial.println("  no pair answered");
  for (int i = 0; i < nhits && scanned; i++) { Serial.printf("  SDA=%d SCL=%d: %d device(s)\n", hits[i].sda, hits[i].scl, hits[i].n); for (int j = 0; j < hits[i].n; j++) Serial.printf("      0x%02X  %s\n", hits[i].addr[j], hint(hits[i].addr[j])); }
  Serial.println("=== end of report ===");
}

void setup() { Serial.begin(115200); delay(2500); Serial.println("scanning all pin pairs, ~30 s..."); bruteForce(); }
void loop() { report(); delay(15000); }
