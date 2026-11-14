// Touch discovery. SDA 38, SCL 39, INT 47, RST 48. Prints which I2C addresses answer after a reset, then dumps raw bytes while you touch.
#include <Arduino.h>
#include <Wire.h>
#define SDA 38
#define SCL 39
#define TINT 47
#define TRST 48
static uint8_t found[16]; static int nf = 0;
static void scan() { nf = 0; for (uint8_t a = 1; a < 127; a++) { Wire.beginTransmission(a); if (Wire.endTransmission() == 0 && nf < 16) found[nf++] = a; } }
static void dump(uint8_t a, uint8_t reg, int n) { Wire.beginTransmission(a); Wire.write(reg); Wire.endTransmission(false); int got = Wire.requestFrom((int)a, n); Serial.printf("  0x%02X reg 0x%02X:", a, reg); while (got-- > 0 && Wire.available()) Serial.printf(" %02X", Wire.read()); Serial.println(); }
void setup() {
  Serial.begin(115200); delay(2000); Serial.println("\n=== touch discovery ===");
  pinMode(TINT, INPUT_PULLUP); pinMode(TRST, OUTPUT);
  Wire.begin(SDA, SCL, 100000);
  scan(); Serial.print("before reset:"); for (int i = 0; i < nf; i++) Serial.printf(" 0x%02X", found[i]); Serial.println();
  digitalWrite(TRST, LOW); delay(20); digitalWrite(TRST, HIGH); delay(200);
  scan(); Serial.print("after reset: "); for (int i = 0; i < nf; i++) Serial.printf(" 0x%02X", found[i]); Serial.println();
  for (int i = 0; i < nf; i++) { uint8_t a = found[i]; if (a == 0x18) continue; Serial.printf("device 0x%02X:\n", a); dump(a, 0x00, 8); dump(a, 0xA7, 4); dump(a, 0x80, 4); dump(a, 0xA3, 4); }
  Serial.println("Now touch the screen (INT 47 and registers are printed)...");
}
static void poll(uint8_t a, bool useReg, uint8_t reg, const char* tag) {
  static uint8_t prev[4][24]; static bool first[4] = {1,1,1,1}; int k = (a == 0x28 ? 0 : 2) + (useReg ? 1 : 0); uint8_t cur[24];
  if (useReg) { Wire.beginTransmission(a); Wire.write(reg); Wire.endTransmission(false); }
  int got = Wire.requestFrom((int)a, 24); for (int i = 0; i < 24; i++) cur[i] = (i < got && Wire.available()) ? Wire.read() : 0xEE;
  if (first[k] || memcmp(cur, prev[k], 24)) { first[k] = false; memcpy(prev[k], cur, 24); Serial.printf("%s:", tag); for (int i = 0; i < 24; i++) Serial.printf(" %02X", cur[i]); Serial.printf("  INT=%d\n", digitalRead(TINT)); }
}
void loop() { poll(0x28, false, 0, "28 raw"); poll(0x28, true, 0x00, "28 r00"); poll(0x55, false, 0, "55 raw"); poll(0x55, true, 0x10, "55 r10"); delay(30); }
