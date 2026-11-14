// Nib: pocket AI buddy. ES3C35P board (ESP32-S3, ST77922 320x480 QSPI screen, ES8311 codec + mic).
//  - BOOT button: short press = next character, HOLD = talk (release to send) -> server /voice -> answer (state + text on serial)
//  - First start (no Wi-Fi saved): Wi-Fi "Nib-Setup" opens, join it on your phone and enter your Wi-Fi in the page that appears.
//    Hold BOOT for 8 s at power-up to forget the saved Wi-Fi.
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ESPmDNS.h>
#include <Wire.h>
#include <ESP_I2S.h>
#include <ArduinoJson.h>
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_st77922.h"
#include "AudioBoard.h"
#include "nib_sprites.h"
#include "st77922_vendor_init.h"
#include "secrets.h"

#define W 320
#define H 480
#define BG 0x0010
#define PIN_BL 41
#define BTN 0
#define PIN_SDA 38
#define PIN_SCL 39
#define PIN_MCLK 17
#define PIN_BCLK 18
#define PIN_WS 21
#define PIN_DOUT 15
#define PIN_DIN 16
#define PIN_PA 1
#define RATE 16000
#define MAX_SEC 6
#define MIC_GAIN_REG16 6

// ---------- screen ----------
static esp_lcd_panel_handle_t panel; static uint16_t *fb, *line; static SemaphoreHandle_t done;
static bool IRAM_ATTR onDone(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void*) { BaseType_t w = pdFALSE; xSemaphoreGiveFromISR(done, &w); return w == pdTRUE; }
static uint32_t blitTO = 0;
static void blit(int y0, int y1) { esp_lcd_panel_draw_bitmap(panel, 0, y0, W, y1, line); if (xSemaphoreTake(done, pdMS_TO_TICKS(500)) != pdTRUE) blitTO++; }
static void flush() { for (int y = 0; y < H; y += 8) { const uint16_t* s = fb + (size_t)y * W; for (int i = 0; i < W * 8; i++) line[i] = __builtin_bswap16(s[i]); blit(y, y + 8); } }
static void flushRows(int y0, int y1) { for (int y = y0 & ~7; y < y1; y += 8) { const uint16_t* s = fb + (size_t)y * W; for (int i = 0; i < W * 8; i++) line[i] = __builtin_bswap16(s[i]); blit(y, y + 8); } }
static volatile float micLevel = 0, micThr = 220; static volatile bool micHot = false;
static void fillFb(uint16_t c) { for (size_t i = 0; i < (size_t)W * H; i++) fb[i] = c; }
static void spriteFb(const uint16_t* s, int x, int y, int scale) {
  for (int sy = 0; sy < NIB_H; sy++) for (int sx = 0; sx < NIB_W; sx++) { uint16_t c = pgm_read_word(&s[sy * NIB_W + sx]); if (c == NIB_KEY) continue; for (int j = 0; j < scale; j++) for (int i = 0; i < scale; i++) fb[(size_t)(y + sy * scale + j) * W + x + sx * scale + i] = c; }
}
static void screenInit() {
  pinMode(PIN_BL, OUTPUT); digitalWrite(PIN_BL, HIGH);
  done = xSemaphoreCreateBinary(); line = (uint16_t*)heap_caps_malloc(W * 8 * 2, MALLOC_CAP_DMA); fb = (uint16_t*)heap_caps_malloc((size_t)W * H * 2, MALLOC_CAP_SPIRAM);
  spi_bus_config_t bus = {}; bus.data0_io_num = 11; bus.data1_io_num = 13; bus.sclk_io_num = 12; bus.data2_io_num = 14; bus.data3_io_num = 9; bus.max_transfer_sz = W * 8 * 2;
  ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));
  esp_lcd_panel_io_handle_t io = NULL; esp_lcd_panel_io_spi_config_t ioc = ST77922_PANEL_IO_QSPI_CONFIG(10, onDone, NULL); ioc.pclk_hz = 20 * 1000 * 1000;
  ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &ioc, &io));
  const st77922_vendor_config_t vc = { .init_cmds = vendor_init, .init_cmds_size = sizeof(vendor_init) / sizeof(vendor_init[0]), .flags = { .use_qspi_interface = 1 } };
  const esp_lcd_panel_dev_config_t pc = { .reset_gpio_num = -1, .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB, .bits_per_pixel = 16, .vendor_config = (void*)&vc };
  ESP_ERROR_CHECK(esp_lcd_new_panel_st77922(io, &pc, &panel));
  esp_lcd_panel_reset(panel); esp_lcd_panel_init(panel); esp_lcd_panel_disp_on_off(panel, true);
}

// ---------- character / state ----------
static const char* STATE_NAMES[NIB_STATES] = {"idle", "blink", "listening", "thinking", "happy", "ask", "sad", "sleepy", "surprised", "love", "wink", "laugh", "confused", "lookl", "lookr", "yawn"};
static int ch = 0;                                         // current character
static int stateOf(const char* n) { for (int i = 0; i < NIB_STATES; i++) if (!strcmp(n, STATE_NAMES[i])) return i; return ST_IDLE; }
// ---------- text (5x7 font, upper case only) ----------
static const uint8_t FONT[][5] = {   // ASCII 32..90
{0,0,0,0,0},{0,0,0x5F,0,0},{0,7,0,7,0},{0x14,0x7F,0x14,0x7F,0x14},{0x24,0x2A,0x7F,0x2A,0x12},{0x23,0x13,8,0x64,0x62},{0x36,0x49,0x56,0x20,0x50},{0,0,7,0,0},
{0,0x1C,0x22,0x41,0},{0,0x41,0x22,0x1C,0},{0x2A,0x1C,0x7F,0x1C,0x2A},{8,8,0x3E,8,8},{0,0x80,0x70,0x30,0},{8,8,8,8,8},{0,0,0x60,0x60,0},{0x20,0x10,8,4,2},
{0x3E,0x51,0x49,0x45,0x3E},{0,0x42,0x7F,0x40,0},{0x72,0x49,0x49,0x49,0x46},{0x21,0x41,0x49,0x4D,0x33},{0x18,0x14,0x12,0x7F,0x10},{0x27,0x45,0x45,0x45,0x39},{0x3C,0x4A,0x49,0x49,0x31},{0x41,0x21,0x11,9,7},{0x36,0x49,0x49,0x49,0x36},{0x46,0x49,0x49,0x29,0x1E},
{0,0,0x14,0,0},{0,0x40,0x34,0,0},{0,8,0x14,0x22,0x41},{0x14,0x14,0x14,0x14,0x14},{0,0x41,0x22,0x14,8},{2,1,0x59,9,6},{0x3E,0x41,0x5D,0x59,0x4E},
{0x7C,0x12,0x11,0x12,0x7C},{0x7F,0x49,0x49,0x49,0x36},{0x3E,0x41,0x41,0x41,0x22},{0x7F,0x41,0x41,0x41,0x3E},{0x7F,0x49,0x49,0x49,0x41},{0x7F,9,9,9,1},{0x3E,0x41,0x41,0x51,0x73},{0x7F,8,8,8,0x7F},{0,0x41,0x7F,0x41,0},{0x20,0x40,0x41,0x3F,1},{0x7F,8,0x14,0x22,0x41},{0x7F,0x40,0x40,0x40,0x40},{0x7F,2,0x1C,2,0x7F},
{0x7F,4,8,0x10,0x7F},{0x3E,0x41,0x41,0x41,0x3E},{0x7F,9,9,9,6},{0x3E,0x41,0x51,0x21,0x5E},{0x7F,9,0x19,0x29,0x46},{0x26,0x49,0x49,0x49,0x32},{3,1,0x7F,1,3},{0x3F,0x40,0x40,0x40,0x3F},{0x1F,0x20,0x40,0x20,0x1F},{0x3F,0x40,0x38,0x40,0x3F},{0x63,0x14,8,0x14,0x63},{3,4,0x78,4,3},{0x61,0x59,0x49,0x4D,0x43}};
static int clipY0 = 0, clipY1 = H;                           // vertical clip (used by the scrolling answer box)
static void rectFb(int x, int y, int w, int h, uint16_t c) { for (int j = 0; j < h; j++) { if (y + j < clipY0 || y + j >= clipY1) continue; for (int i = 0; i < w; i++) if (x + i >= 0 && x + i < W) fb[(size_t)(y + j) * W + x + i] = c; } }
static void rrect(int x, int y, int w, int h, int r, uint16_t c) { for (int j = 0; j < h; j++) { int dy = min(j, h - 1 - j), inset = 0; if (dy < r) inset = r - (int)sqrtf((float)(r * r - (r - dy) * (r - dy))); rectFb(x + inset, y + j, w - 2 * inset, 1, c); } }
static int textW(const char* s, int sc) { return (int)strlen(s) * 6 * sc - sc; }
static void textFb(int x, int y, const char* s, int sc, uint16_t c) {
  for (; *s; s++, x += 6 * sc) { char ch2 = toupper(*s); if (ch2 < 32 || ch2 > 90) ch2 = '?'; const uint8_t* g = FONT[ch2 - 32];
    for (int cx = 0; cx < 5; cx++) for (int cy = 0; cy < 7; cy++) if (g[cx] >> cy & 1) rectFb(x + cx * sc, y + cy * sc, sc, sc, c); }
}
static void textC(int y, const char* s, int sc, uint16_t c) { textFb((W - textW(s, sc)) / 2, y, s, sc, c); }
static void textWrap(int y, String s, int sc, uint16_t c, int maxLines) {          // word-wrap, centred
  int per = (W - 16) / (6 * sc); s.trim(); int line = 0;
  while (s.length() && line < maxLines) {
    int cut = s.length() <= per ? s.length() : s.lastIndexOf(' ', per); if (cut <= 0) cut = min((int)s.length(), per);
    String part = s.substring(0, cut); part.trim(); if (line == maxLines - 1 && s.length() > cut) part = part.substring(0, max(0, (int)part.length() - 2)) + "..";
    textC(y + line * (8 * sc + 4), part.c_str(), sc, c); s = s.substring(cut); s.trim(); line++;
  }
}

#define ANS_Y0 350
#define ANS_Y1 420
static int answerOff = 0, answerMax = 0; static bool autoScroll = true, dragging = false; static int dragY0 = 0, dragOff0 = 0;
static int ansLines(const String& s0, String* out, int maxN) { String s = s0; s.trim(); int per = (W - 100) / 12, n = 0;
  while (s.length() && n < maxN) { int cut = s.length() <= per ? s.length() : s.lastIndexOf(' ', per); if (cut <= 0) cut = min((int)s.length(), per); String p = s.substring(0, cut); p.trim(); out[n++] = p; s = s.substring(cut); s.trim(); }
  return n; }
static String answer, heard, notice; static bool autoListen = false, keepAns = false; static uint32_t autoListenAt = 0;   // autoListen: Nib asked a question, so the mic opens by itself
static void answerBox() {                                  // the answer, clipped to its box and scrolled by answerOff pixels
  static String L[40]; int n = ansLines(answer, L, 40); answerMax = max(0, n * 20 - (ANS_Y1 - ANS_Y0)); if (answerOff > answerMax) answerOff = answerMax;
  clipY0 = ANS_Y0; clipY1 = ANS_Y1; for (int i = 0; i < n; i++) textC(ANS_Y0 + i * 20 - answerOff, L[i].c_str(), 2, 0xFFFF); clipY0 = 0; clipY1 = H; }

// ---------- pages ----------
#define WHITE 0xFFFF
#define TEAL 0x47B9
#define DIM 0x8C71
#define GREEN 0x4EC9
#define RED 0xF2A5
static int page = 0;                                       // 0 = buddy, 1 = pocket, 2 = contacts
static bool serverOk = false; static String serverUrl = SERVER_URL;
extern const uint8_t rootca_crt_bundle_start[] asm("_binary_x509_crt_bundle_start"); extern const uint8_t rootca_crt_bundle_end[] asm("_binary_x509_crt_bundle_end");
static WiFiClientSecure tlsV, tlsN; static HTTPClient hV, hN;   // one persistent connection for voice, one for data (no TLS handshake on every request)
static void httpBegin(HTTPClient& h, WiFiClientSecure& c, const String& url) {   // https: certificate is VERIFIED against the Mozilla root bundle
  h.setReuse(true); h.setConnectTimeout(6000); if (url.startsWith("https")) h.begin(c, url); else h.begin(url);
#ifdef NIB_DEVKEY
  h.addHeader("x-nib-key", NIB_DEVKEY);
#endif
}
#define BAR_Y 424
static const char* TABS[3] = {"BUDDY", "POCKET", "CONTACTS"};
static int tabAt(int x, int y) { if (y < BAR_Y) return -1; return x * 3 / W; }
// ST77922 touch (vendor protocol): I2C 0x55 on SDA38/SCL39, 16-bit big-endian register addresses, RST 48, INT 47
static bool touchReg(uint16_t reg, uint8_t* buf, size_t n) { Wire.beginTransmission(0x55); Wire.write(reg >> 8); Wire.write(reg & 0xFF); if (Wire.endTransmission(false) != 0) return false; return Wire.requestFrom((uint8_t)0x55, (uint8_t)n) == n && Wire.readBytes(buf, n) == n; }
static void touchInit() {
  pinMode(48, OUTPUT); digitalWrite(48, HIGH); pinMode(47, INPUT); digitalWrite(48, LOW); delay(100); digitalWrite(48, HIGH); delay(100);
  uint8_t s = 0xFF; for (int i = 0; i < 20 && touchReg(0x0001, &s, 1) && (s & 0x0F); i++) delay(20);
  Serial.println("touch ready");
}
static volatile uint32_t tapAt = 0; static volatile bool tapFlag = false; static volatile int tapX = 0, tapY = 0; static volatile bool touchDown = false; static volatile int touchCurY = 0;
static void touchTask(void*) {                             // polls the chip on its own core; reads the whole point buffer like the vendor driver (else the chip stalls)
  uint8_t mp = 0; touchReg(0x0009, &mp, 1); if (mp < 1 || mp > 10) mp = 5; Serial.printf("touch max points %u\n", mp);
  bool down = false; uint32_t lastSeen = 0;
  for (;;) {
    uint8_t info = 0;
    if (touchReg(0x0010, &info, 1) && (info & 0x08)) { uint8_t p[70] = {0};
      if (touchReg(0x0014, p, 7 * mp)) { bool any = false; for (int i = 0; i < mp; i++) if (p[i * 7] & 0x80) { any = true; touchCurY = ((p[i * 7 + 2] & 0x3F) << 8) | p[i * 7 + 3]; if (!down) { tapX = ((p[i * 7] & 0x3F) << 8) | p[i * 7 + 1]; tapY = ((p[i * 7 + 2] & 0x3F) << 8) | p[i * 7 + 3]; tapFlag = true; tapAt = millis(); } break; }
        if (any) { down = true; touchDown = true; lastSeen = millis(); } else { down = false; touchDown = false; } } }   // touchDown: cleared only by a real "finger lifted" report (a still finger sends nothing)
    if (down && millis() - lastSeen > 150) down = false;
    if (touchDown && millis() - lastSeen > 2500) touchDown = false;
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}
static struct { bool ok = false; float usd = 0, cap = 0, perTx = 0, daily = 0; String addr; int qn = 0; uint8_t qr[45][45]; uint32_t at = 0; bool loading = false; bool goal = true; String gname = "Shopping"; float gtarget = 250, gsaved = 0; int gpct = 0; bool hungry = false; bool showQr = false; int tn = 0; char tsym[5][10]; char tchain[5][12]; float tamt[5], tusd[5]; } pk;
static int feedSeen = -1; static volatile bool feedFlag = false;
static void drawStatus(); static void drawBar(); static void goalBlock(); static void celebrate() {                                  // money arrived: happy Nib + confetti for ~3 s
  static float px[44], py[44], pv[44]; static uint16_t pc[44]; const uint16_t cols[] = {0xF800, 0xFD20, 0xFFE0, 0x07E0, 0x07FF, 0x781F, 0xF81F};
  for (int i = 0; i < 44; i++) { px[i] = random(W); py[i] = -random(300); pv[i] = 4 + random(60) / 10.0f; pc[i] = cols[random(7)]; }
  page = 0; Serial.println("FEED: yum");
  for (int f = 0; f < 50; f++) {
    fillFb(BG); goalBlock(); spriteFb(NIB_SET[ch][ST_HAPPY], (W - NIB_W * 10) / 2, 56 + ((f / 4) % 2 ? -6 : 0), 10); textC(302, NIB_NAMES[ch], 2, DIM); textC(340, "YUM! THANK YOU!", 2, WHITE);
    for (int i = 0; i < 44; i++) { py[i] += pv[i]; px[i] += sinf(f * 0.3f + i) * 2; if (py[i] > BAR_Y) py[i] = -10; if (py[i] >= 0) rectFb((int)px[i], (int)py[i], 7, 7, pc[i]); }
    drawStatus(); drawBar(); flush(); delay(20);
  }
}
static void drawBar() {
  rectFb(0, BAR_Y, W, H - BAR_Y, 0x0841);
  for (int i = 0; i < 3; i++) { int x0 = i * W / 3, w = W / 3; bool on = i == page; if (on) rectFb(x0 + 6, BAR_Y + 6, w - 12, H - BAR_Y - 12, 0x2A6B);
    textFb(x0 + (w - textW(TABS[i], 2)) / 2, BAR_Y + (H - BAR_Y - 14) / 2, TABS[i], 2, on ? WHITE : DIM); }
}
static bool hearing = false;
static void drawStatus() {                                 // top strip: HEY BUDDY (always listening) | AI server dot | Wi-Fi bars
  bool wifi = WiFi.status() == WL_CONNECTED; int bars = 0; if (wifi) { int r = WiFi.RSSI(); bars = r > -55 ? 4 : r > -65 ? 3 : r > -75 ? 2 : 1; }
  for (int i = 0; i < 4; i++) { int h = 4 + i * 3; rectFb(W - 30 + i * 6, 16 - h, 4, h, i < bars ? WHITE : 0x3186); }
  if (!wifi) textFb(W - 92, 5, "NO WIFI", 1, RED);
  rectFb(10, 6, 8, 8, TEAL); textFb(24, 6, "SAY HEY BUDDY", 1, DIM);
}
static void micBtn(bool on) {                              // mic button, bottom right of the buddy page: hold it and talk, let go to send
  int x = 254, y = 376, w = 58, h = 44; rrect(x, y, w, h, 12, on ? 0xFD20 : 0x2A6B);
  int cx = x + w / 2, cy = y + h / 2 - 2; rectFb(cx - 4, cy - 15, 8, 17, WHITE); rectFb(cx - 10, cy - 5, 3, 9, WHITE); rectFb(cx + 7, cy - 5, 3, 9, WHITE); rectFb(cx - 10, cy + 4, 20, 3, WHITE); rectFb(cx - 1, cy + 7, 3, 6, WHITE); rectFb(cx - 6, cy + 13, 12, 3, WHITE);
}
static uint32_t answerAt = 0, noticeAt = 0;
static void renderPocket(); static void renderPeople(); static void goalBlock();
static void show(int st) {
  fillFb(BG);
  if (page == 1) renderPocket();
  else if (page == 2) renderPeople();
  else { goalBlock(); spriteFb(NIB_SET[ch][st], (W - NIB_W * 10) / 2, 56, 10); textC(302, NIB_NAMES[ch], 2, DIM); if (st == ST_LISTENING) { if (!keepAns) textC(340, "LISTENING...", 2, TEAL); } else if (st == ST_THINKING) textC(340, "THINKING...", 2, WHITE); else if (notice.length() && millis() - noticeAt < 6000) textC(340, notice.c_str(), 2, RED); else if (pk.hungry && !(answer.length() && millis() - answerAt < 60000)) { textC(340, "I AM HUNGRY!", 2, 0xFD20); textC(364, "FEED ME: SEND ANY $", 2, WHITE); } if (answer.length() && millis() - answerAt < 60000 && (keepAns || (st != ST_LISTENING && st != ST_THINKING)) && !(notice.length() && millis() - noticeAt < 6000)) { if (heard.length()) textWrap(326, String("YOU: ") + heard, 1, TEAL, 2); answerBox(); } }
  if (page == 0) micBtn(st == ST_LISTENING); drawStatus(); drawBar(); flush();
}

// ---------- Wi-Fi ----------
static Preferences prefs; static bool mdnsOn = false;
static void serverFind() { if (serverUrl.startsWith("https")) return;   // tunnel address is fixed in the firmware
                                  // the Mac's address changes: look it up by name (Bonjour) every time something fails
  if (WiFi.status() != WL_CONNECTED) return;
  prefs.begin("nib", true); String host = prefs.getString("host", SERVER_HOST); prefs.end(); host.trim(); host.replace(".local", ""); if (!host.length()) return;
  if (!mdnsOn) mdnsOn = MDNS.begin("nib");
  IPAddress ip = MDNS.queryHost(host.c_str(), 2000);
  if (ip != IPAddress((uint32_t)0)) { String u = "http://" + ip.toString() + ":8899"; if (u != serverUrl) Serial.printf("server %s.local = %s\n", host.c_str(), u.c_str()); serverUrl = u; }
  else Serial.printf("server: %s.local not found, keeping %s\n", host.c_str(), serverUrl.c_str());
}
static void portal() {
  Serial.println("Wi-Fi setup: join the network \"Nib-Setup\" on your phone, a page opens (or go to 192.168.4.1)");
  WiFi.mode(WIFI_AP); WiFi.softAP("Nib-Setup"); DNSServer dns; dns.start(53, "*", WiFi.softAPIP()); WebServer web(80);
  auto page = [&]() { String h = "<meta name=viewport content='width=device-width,initial-scale=1'><body style='font-family:sans-serif;max-width:420px;margin:30px auto;padding:0 16px'><h2>Nib Wi-Fi</h2><form method=post action=/save>"
    "<p>Wi-Fi name (2.4 GHz)<br><input name=s style='width:100%;font-size:18px' list=n>"; int n = WiFi.scanNetworks(); h += "<datalist id=n>"; for (int i = 0; i < n && i < 15; i++) h += "<option value='" + WiFi.SSID(i) + "'>"; h += "</datalist></p>"
    "<p>Password<br><input name=p type=password style='width:100%;font-size:18px'></p>"; prefs.begin("nib", true); String hh = prefs.getString("host", SERVER_HOST); prefs.end(); h += "<p>Mac name (for the AI server)<br><input name=h value='" + hh + "' style='width:100%;font-size:18px'></p><button style='font-size:20px;padding:8px 20px'>Save</button></form>"; web.send(200, "text/html", h); };
  web.on("/", page); web.onNotFound(page);
  web.on("/save", HTTP_POST, [&]() { prefs.begin("nib", false); prefs.putString("ssid", web.arg("s")); prefs.putString("pass", web.arg("p")); if (web.arg("h").length()) prefs.putString("host", web.arg("h")); prefs.end(); web.send(200, "text/html", "<meta name=viewport content='width=device-width'><h2>Saved. Nib restarts...</h2>"); delay(1500); ESP.restart(); });
  web.begin(); static const int mood[] = {ST_ASK, ST_LOOKL, ST_BLINK, ST_LOOKR, ST_WINK, ST_HAPPY, ST_SURPRISED, ST_YAWN}; int f = 0; uint32_t t = 0; bool down = false;
  while (true) {
    dns.processNextRequest(); web.handleClient();
    bool b = digitalRead(BTN) == LOW; if (down && !b) { ch = (ch + 1) % NIB_CHARS; Serial.printf("character %s\n", NIB_NAMES[ch]); show(ST_HAPPY); t = millis() + 800; } down = b;   // BOOT = next character, also while waiting for Wi-Fi
    if (millis() > t + 700) { t = millis(); show(mood[f++ % 8]); }
  }
}
static bool wifiUp(bool allowPortal) {
  if (WiFi.status() == WL_CONNECTED) return true;
  prefs.begin("nib", true); String ssid = prefs.getString("ssid", ""), pass = prefs.getString("pass", ""); prefs.end();
  if (!ssid.length()) { if (allowPortal) portal(); return false; }
  Serial.printf("Wi-Fi: joining %s ...\n", ssid.c_str()); WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.begin(ssid.c_str(), pass.c_str());   // no modem power-save: it drops packets
  uint32_t t = millis(); while (WiFi.status() != WL_CONNECTED && millis() - t < 20000) { delay(300); Serial.print("."); }
  if (WiFi.status() == WL_CONNECTED) { Serial.printf("\nWi-Fi OK, IP %s, signal %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI()); return true; }
  Serial.println("\nWi-Fi FAILED"); if (allowPortal) { show(ST_SAD); delay(1500); portal(); } return false;
}

// ---------- pocket / people / goal ----------
static struct { bool ok = false; int n = 0; String name[8], addr[8]; uint32_t at = 0; } ct;
static String httpGet(const String& path) {
  HTTPClient& h = hN; int c = 0; String b; for (int a = 0; a < 3; a++) { h.setTimeout(8000); httpBegin(h, tlsN, serverUrl + path); c = h.GET(); if (c == 200) b = h.getString(); h.end(); if (c > 0) break; tlsN.stop(); }   // a stale kept-alive connection fails once: retry on a fresh one
  serverOk = c == 200; if (!serverOk) { char eb[100] = ""; int le = tlsN.lastError(eb, sizeof eb); Serial.printf("GET %s%s -> %d (tls %d: %s) rssi %d heap %u\n", serverUrl.c_str(), path.c_str(), c, le, eb, WiFi.RSSI(), (unsigned)ESP.getFreeHeap()); }
  if (!serverOk) { static uint32_t lastFind = 0; if (millis() - lastFind > 15000) { lastFind = millis(); serverFind(); } }
  return b;
}
static void pocketFetchImpl();
static void pocketFetch() { pk.loading = true; pocketFetchImpl(); pk.loading = false; }
static void pocketFetchImpl() {
  pk.at = millis(); pk.ok = false; if (WiFi.status() != WL_CONNECTED) { serverOk = false; return; }
  JsonDocument d; String b = httpGet("/summary"); if (!b.length() || deserializeJson(d, b)) return;
  pk.usd = d["pocket"]["usd"] | 0.0f; pk.cap = d["pocket"]["cap"] | 100.0f; pk.perTx = d["pocket"]["perTx"] | 10.0f; pk.daily = d["pocket"]["daily"] | 100.0f;
  { pk.tn = 0; JsonArray tk = d["pocket"]["tokens"].as<JsonArray>(); for (JsonObject t : tk) { if (pk.tn >= 4) break; snprintf(pk.tsym[pk.tn], 10, "%s", (const char*)(t["token"] | "?")); snprintf(pk.tchain[pk.tn], 12, "%s", (const char*)(t["chain"] | "")); for (char* c = pk.tchain[pk.tn]; *c; c++) *c = toupper(*c); pk.tamt[pk.tn] = t["amount"] | 0.0f; pk.tusd[pk.tn] = t["usd"] | 0.0f; pk.tn++; } }
  pk.goal = !d["goal"].isNull(); if (pk.goal) { pk.gname = String((const char*)(d["goal"]["name"] | "")); pk.gtarget = d["goal"]["target"] | 0.0f; pk.gsaved = d["goal"]["saved"] | 0.0f; pk.gpct = d["goal"]["pct"] | 0; prefs.begin("nib", false); prefs.putString("gn", pk.gname); prefs.putFloat("gt", pk.gtarget); prefs.putFloat("gs", pk.gsaved); prefs.putInt("gp", pk.gpct); prefs.end(); }
  pk.hungry = d["feed"]["hungry"] | false; { int sq = d["feed"]["seq"] | 0; if (feedSeen >= 0 && sq > feedSeen) feedFlag = true; feedSeen = sq; }
  if (!pk.addr.length()) { b = httpGet("/pocket-address"); JsonDocument a; if (b.length() && !deserializeJson(a, b)) pk.addr = String((const char*)(a["address"] | "")); }
  if (pk.addr.length() && !pk.qn) { b = httpGet("/qr?text=" + pk.addr); JsonDocument q; if (b.length() && !deserializeJson(q, b)) { int n = q["size"] | 0; if (n > 0 && n <= 45) { pk.qn = n; for (int r = 0; r < n; r++) { const char* row = q["rows"][r] | ""; for (int c = 0; c < n; c++) pk.qr[r][c] = row[c] == '1'; } } } }
  pk.ok = true;
}
static void contactsFetch() {
  ct.at = millis(); ct.ok = false; if (WiFi.status() != WL_CONNECTED) return;
  String b = httpGet("/contacts.json"); JsonDocument d; if (!b.length() || deserializeJson(d, b)) return;
  ct.n = 0; for (JsonObject o : d.as<JsonArray>()) { if (ct.n >= 8) break; ct.name[ct.n] = String((const char*)(o["name"] | "")); ct.addr[ct.n] = String((const char*)(o["address"] | "")); ct.n++; }
  ct.ok = true;
}
static void goalBlock() {                                  // piggy bank: one small line + thin bar, right under the status strip
  if (!pk.goal) return; char s[48]; snprintf(s, sizeof s, "%s  $%.0f / $%.0f", pk.gname.c_str(), pk.gsaved, pk.gtarget); textC(24, s, 1, WHITE);
  int bw = 200, bx = (W - bw) / 2; rectFb(bx, 36, bw, 6, 0x2104); rectFb(bx, 36, bw * min(100, pk.gpct) / 100, 6, TEAL);
}
static void renderPocket() {
  const uint16_t CARD = 0x10C5;
  if (pk.showQr) {                                                              // full-screen QR, opened by the ADD MONEY button
    textC(24, "ADD MONEY", 3, WHITE);
    if (pk.qn) { int sc = 232 / (pk.qn + 4); if (sc < 3) sc = 3; int sz = (pk.qn + 4) * sc; int x0 = (W - sz) / 2, y0 = 64; rrect(x0 - 6, y0 - 6, sz + 12, sz + 12, 12, WHITE);
      for (int r = 0; r < pk.qn; r++) for (int c = 0; c < pk.qn; c++) if (pk.qr[r][c]) rectFb(x0 + (c + 2) * sc, y0 + (r + 2) * sc, sc, sc, 0x0000);
      int by = y0 + sz + 22; textC(by, "USDC / USDT ON BASE, ETH, ARB", 1, WHITE);
      if (pk.addr.length() > 12) { String a = pk.addr.substring(0, 8) + "..." + pk.addr.substring(pk.addr.length() - 6); textC(by + 18, a.c_str(), 1, DIM); } }
    else textC(200, "LOADING...", 2, WHITE);
    textC(398, "TAP TO CLOSE", 1, DIM); return;
  }
  textC(24, "POCKET", 3, WHITE); textC(52, "NIB'S OWN SPENDING MONEY", 1, DIM);
  if (!pk.ok) { rrect(30, 150, W - 60, 110, 12, CARD); if (pk.loading) { textC(190, "LOADING...", 2, WHITE); } else { textC(176, "NO CONNECTION", 2, WHITE); textC(206, "CHECK WI-FI AND SERVER", 1, DIM); } return; }
  rrect(16, 70, W - 32, 92, 14, CARD);                                          // balance card
  char s[48]; snprintf(s, sizeof s, "$%.2f", pk.usd); textC(84, s, 7, TEAL); textC(144, "TOTAL BALANCE", 1, DIM);
  rrect(16, 172, W - 32, 200, 14, CARD); textFb(28, 182, "TOKENS", 1, DIM);       // what is inside
  if (!pk.tn) textC(268, "NO TOKENS YET", 2, DIM);
  for (int i = 0; i < pk.tn; i++) { int y = 198 + i * 42; char a[24], u[16];
    if (pk.tamt[i] >= 1) snprintf(a, sizeof a, "%.2f", pk.tamt[i]); else snprintf(a, sizeof a, "%.4f", pk.tamt[i]); snprintf(u, sizeof u, "$%.2f", pk.tusd[i]);
    textFb(28, y, pk.tsym[i], 2, WHITE); textFb(28, y + 20, pk.tchain[i], 1, DIM); textFb(W - 28 - textW(a, 2), y, a, 2, WHITE); textFb(W - 28 - textW(u, 1), y + 20, u, 1, DIM);
    if (i < pk.tn - 1) rectFb(28, y + 36, W - 56, 1, 0x2104); }
  int bx = W - 16 - 120, by = 382; rrect(bx, by, 120, 34, 10, 0x2A6B);          // ADD MONEY button with a small QR icon
  int ix = bx + 10, iy = by + 9; for (int k = 0; k < 3; k++) { int ox = ix + (k == 1 ? 10 : 0), oy = iy + (k == 2 ? 10 : 0); rectFb(ox, oy, 6, 6, WHITE); rectFb(ox + 2, oy + 2, 2, 2, 0x2A6B); } rectFb(ix + 10, iy + 10, 3, 3, WHITE); rectFb(ix + 14, iy + 13, 2, 2, WHITE);
  textFb(bx + 34, by + 13, "ADD MONEY", 1, WHITE);
}
static void renderPeople() {
  textC(26, "CONTACTS", 3, WHITE);
  if (!ct.ok) { textC(200, "NO CONNECTION", 2, DIM); return; }
  if (!ct.n) { textC(150, "NO CONTACTS YET", 2, WHITE); textC(190, "THEN SAY: SEND $5 TO MOM", 1, DIM); textC(210, "ADD CONTACTS ON YOUR PHONE:", 1, DIM); String u = serverUrl; u.replace("http://", ""); u += "/CONTACTS"; textC(226, u.c_str(), 1, TEAL); return; }
  for (int i = 0; i < ct.n; i++) { int y = 76 + i * 42; textFb(24, y, ct.name[i].c_str(), 3, WHITE); textFb(24, y + 26, ct.addr[i].c_str(), 1, DIM); }
}
static volatile int netReq = 0; static volatile bool netDirty = false;       // network refreshes run in their own task so the touch keeps answering
static void netTask(void*) { for (;;) { int r = netReq; if (r) { netReq = 0; if (r & 1) pocketFetch(); if (r & 2) contactsFetch(); netDirty = true; } vTaskDelay(pdMS_TO_TICKS(30)); } }
static void goPage(int p) { page = p; if (p == 1) pk.loading = true; show(ST_IDLE); if (p == 1) netReq |= 1; if (p == 2) netReq |= 2; Serial.printf("page %d\n", page); }

// ---------- audio ----------
static DriverDeviceInfo pins; static AudioBoard board(AudioDriverES8311, pins); static I2SClass i2s;
static void wr(uint8_t reg, uint8_t val) { Wire.beginTransmission(0x18); Wire.write(reg); Wire.write(val); Wire.endTransmission(); }
static void audioInit() {
  pinMode(PIN_PA, OUTPUT); digitalWrite(PIN_PA, HIGH); pins.addI2C(PinFunction::CODEC, PIN_SCL, PIN_SDA, 0x18); i2s.setPins(PIN_BCLK, PIN_WS, PIN_DOUT, PIN_DIN, PIN_MCLK);
  if (!i2s.begin(I2S_MODE_STD, RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) { Serial.println("I2S FAILED"); return; }
  CodecConfig cfg; cfg.input_device = ADC_INPUT_LINE1; cfg.output_device = DAC_OUTPUT_ALL; cfg.i2s.bits = BIT_LENGTH_16BITS; cfg.i2s.rate = RATE_16K; cfg.i2s.fmt = I2S_NORMAL; cfg.i2s.mode = MODE_SLAVE;
  Serial.println(board.begin(cfg) ? "codec OK" : "codec FAILED"); wr(0x16, MIC_GAIN_REG16);
}
// ---------- always listening: say "Hey Buddy ..." ----------
#define VMAX (RATE * 6)
static int16_t* vb = nullptr; static size_t vn = 0;
static bool vadReset = false;
static bool vadStep() {                                    // reads 16 ms of mic; true when a whole utterance (speech then 0.8 s silence) is in vb[0..vn)
  static int16_t chunk[1024], pre[512]; static int state = 0, hot = 0; static uint32_t lastLoud = 0; static float floorRms = 15;
  if (vadReset) { vadReset = false; state = 0; hot = 0; }
  int n = i2s.readBytes((char*)chunk, sizeof(chunk)) / 4; if (n <= 0) { delay(5); return false; }
  double eL = 0, eR = 0; for (int i = 0; i < n; i++) { eL += (double)chunk[2 * i] * chunk[2 * i]; eR += (double)chunk[2 * i + 1] * chunk[2 * i + 1]; }
  int c = eL >= eR ? 0 : 1; float rms = sqrt((c ? eR : eL) / n); float thr = max(220.0f, floorRms * 5); micLevel = rms; micThr = thr; micHot = rms >= thr;
  if (state == 0) {
    if (rms < thr) { floorRms = floorRms * 0.98f + rms * 0.02f; hot = 0; for (int i = 0; i < n && i < 512; i++) pre[i] = chunk[2 * i + c]; return false; }
    if (++hot < 2) return false;
    state = 1; vn = 0; lastLoud = millis(); for (int i = 0; i < 512 && vn < VMAX; i++) vb[vn++] = pre[i];
  }
  for (int i = 0; i < n && vn < VMAX; i++) vb[vn++] = chunk[2 * i + c];
  if (rms > thr * 0.5f) lastLoud = millis();
  if (vn >= VMAX || millis() - lastLoud > 800) { state = 0; hot = 0; return vn > RATE / 2; }
  return false;
}
static String postPcm(const int16_t* pcm, size_t n, bool wake, int& code) {
  HTTPClient& http = hV; String b; for (int a = 0; a < 3; a++) { http.setTimeout(40000); httpBegin(http, tlsV, serverUrl + (wake ? "/voice?wake=1" : "/voice")); http.addHeader("Content-Type", "application/octet-stream");
    code = http.POST((uint8_t*)pcm, n * 2); if (code == 200) b = http.getString(); http.end(); if (code > 0) break; tlsV.stop(); }
  serverOk = code == 200; return b;
}
static void showAnswer(JsonDocument& d) {
  Serial.printf("YOU SAID : %s\nNIB SAYS : %s [%s]\n", d["heard"] | "(nothing)", d["say"] | "(no answer)", d["state"] | "?");
  page = 0; answerOff = 0; autoScroll = true; dragging = false; heard = String((const char*)(d["heard"] | "")); answer = String((const char*)(d["say"] | "")); answerAt = millis(); show(stateOf(d["state"] | "happy"));
  { String t = answer; t.trim(); autoListen = t.endsWith("?"); autoListenAt = millis() + 1800; }   // Nib asked something: open the mic after a moment
}
// voice runs in its own task, so the microphone keeps recording while the server thinks (nothing you say after "Hey Buddy" is lost)
static int16_t *vb2 = nullptr, *vsend = nullptr; static size_t vn2 = 0, vsn = 0; static bool pend = false;
static volatile int vjob = 0, vcode = 0; static String vres; static bool vWakeJob = true; static uint32_t vT0 = 0;
static void voiceTask(void*) { int c = 0; String b = postPcm(vsend, vsn, vWakeJob, c); vres = b; vcode = c; vjob = 2; vTaskDelete(NULL); }
static void startJob(const int16_t* src, size_t n, bool wake) {
  if (WiFi.status() != WL_CONNECTED) return;
  memcpy(vsend, src, n * 2); vsn = n; vWakeJob = wake; vT0 = millis(); vjob = 1; Serial.printf("VAD: utterance %u ms, sending (%s)\n", (unsigned)(n * 1000 / RATE), wake ? "wake check" : "question");
  xTaskCreatePinnedToCore(voiceTask, "voice", 16384, NULL, 1, NULL, 0);
}
static bool holdRecord() {                                 // mic button held: record until you let go (max 6 s), with the level meter
  static int16_t ch2[1024]; static float sm = 0; uint32_t mAt = 0; vadReset = true; vn = 0;
  while (touchDown && vn < VMAX) { int n = i2s.readBytes((char*)ch2, sizeof(ch2)) / 4; if (n <= 0) { delay(5); continue; }
    double eL = 0, eR = 0; for (int i = 0; i < n; i++) { eL += (double)ch2[2 * i] * ch2[2 * i]; eR += (double)ch2[2 * i + 1] * ch2[2 * i + 1]; }
    int c = eL >= eR ? 0 : 1; float rms = sqrt((c ? eR : eL) / n); for (int i = 0; i < n && vn < VMAX; i++) vb[vn++] = ch2[2 * i + c];
    if (millis() - mAt > 90) { mAt = millis(); float v = rms / 3000.0f; if (v > 1) v = 1; sm = sm * 0.5f + v * 0.5f; rectFb(0, 362, W, 14, BG); rectFb(20, 366, W - 40, 8, 0x2104); rectFb(20, 366, (int)((W - 40) * sm), 8, 0xFD20); flushRows(360, 384); } }
  return vn > RATE / 3;
}
static bool listenWindow(bool meter = true, uint32_t ms = 6000) {                               // after "Hey Buddy": wait up to 6 s for the question, with a level meter
  uint32_t t0 = millis(), mAt = 0; static float sm = 0;
  while (millis() - t0 < ms) { if (vadStep()) return true;
    if (meter && millis() - mAt > 90) { mAt = millis(); float v = micLevel / (micThr * 3.0f); if (v > 1) v = 1; sm = sm * 0.5f + v * 0.5f; rectFb(0, 362, W, 14, BG); rectFb(20, 366, W - 40, 8, 0x2104); rectFb(20, 366, (int)((W - 40) * sm), 8, micHot ? 0xFD20 : TEAL); flushRows(360, 384); } }
  return false;
}
static void finishJob() {
  vjob = 0; int code = vcode; Serial.printf("VOICE %s -> %d in %u ms\n", vWakeJob ? "wake" : "ask", code, (unsigned)(millis() - vT0));
  if (code != 200) { Serial.printf("server HTTP %d, heap %u\n", code, (unsigned)ESP.getFreeHeap()); notice = "CANNOT REACH SERVER"; noticeAt = millis(); pend = false; show(ST_SAD); return; }
  JsonDocument d; if (deserializeJson(d, vres)) { pend = false; return; }
  if (!vWakeJob) { showAnswer(d); return; }
  if (d["ignored"] | false) { Serial.println("not Hey Buddy: dropped"); if (pend) { pend = false; startJob(vb2, vn2, true); } return; }   // dropped, never stored
  Serial.println("Hey Buddy!");
  if (d["woke"] | false) {                                 // only the wake phrase
    if (pend) { pend = false; show(ST_THINKING); startJob(vb2, vn2, false); return; }   // you already said the question while the server was thinking
    page = 0; show(ST_LISTENING); if (!listenWindow()) { show(ST_CONFUSED); delay(1200); show(ST_IDLE); return; }
    show(ST_THINKING); startJob(vb, vn, false); return;
  }
  showAnswer(d);                                           // wake phrase and question in one breath
}

void setup() {
  Serial.begin(115200); Serial.setTxTimeoutMs(0);   // never wait for a USB host that is not reading (that stalled the whole loop 100 ms per print) delay(1200); Serial.println("\n=== Nib ===");
  pinMode(BTN, INPUT_PULLUP); screenInit(); show(ST_IDLE);
  if (digitalRead(BTN) == LOW) { uint32_t t = millis(); while (digitalRead(BTN) == LOW && millis() - t < 8000) delay(20); if (digitalRead(BTN) == LOW) { prefs.begin("nib", false); prefs.clear(); prefs.end(); Serial.println("Wi-Fi forgotten"); show(ST_SURPRISED); delay(1500); } }
  vb = (int16_t*)ps_malloc(VMAX * 2); vb2 = (int16_t*)ps_malloc(VMAX * 2); vsend = (int16_t*)ps_malloc(VMAX * 2); tlsV.setCACertBundle(rootca_crt_bundle_start, rootca_crt_bundle_end - rootca_crt_bundle_start); tlsN.setCACertBundle(rootca_crt_bundle_start, rootca_crt_bundle_end - rootca_crt_bundle_start); audioInit(); touchInit(); xTaskCreatePinnedToCore(touchTask, "touch", 4096, NULL, 2, NULL, 0); wifiUp(true); serverFind(); xTaskCreatePinnedToCore(netTask, "net", 8192, NULL, 1, NULL, 0); { prefs.begin("nib", true); String gn = prefs.getString("gn", ""); if (gn.length()) { pk.gname = gn; pk.gtarget = prefs.getFloat("gt", 250); pk.gsaved = prefs.getFloat("gs", 0); pk.gpct = prefs.getInt("gp", 0); } prefs.end(); } netReq |= 1; show(ST_IDLE); Serial.println("Ready: say Hey Buddy. BOOT: tap = next character, hold = next page.");
}

void loop() {
  { static uint32_t lastIt = 0; uint32_t now0 = millis(); if (lastIt && now0 - lastIt > 250) Serial.printf("LAG: loop gap %u ms (display timeouts %u, heap %u)\n", (unsigned)(now0 - lastIt), (unsigned)blitTO, (unsigned)ESP.getFreeHeap()); lastIt = now0; }
  static uint32_t next = 0, pressed = 0, scrAt = 0; static int st = ST_IDLE; static bool held = false;
  if (tapFlag) { tapFlag = false; uint32_t lat0 = millis() - tapAt; int tx = tapX, ty = tapY, tab = tabAt(tx, ty); Serial.printf("touch %d,%d tab %d (waited %u ms)\n", tx, ty, tab, (unsigned)lat0);
    if (tab >= 0) { if (tab != page) { pk.showQr = false; goPage(tab); st = ST_IDLE; } else if (page == 1 && pk.showQr) { pk.showQr = false; show(st); } }
    else if (page == 1) { if (pk.showQr) { pk.showQr = false; show(st); } else if (tx >= 176 && ty >= 372) { pk.showQr = true; show(st); } }
    else if (page == 0 && tx >= 244 && ty >= 368 && ty < 424) { if (vjob == 0) { Serial.println("mic button"); show(ST_LISTENING); uint32_t t0 = millis(); bool ok = holdRecord(); Serial.printf("mic hold %u ms, %u samples\n", (unsigned)(millis() - t0), (unsigned)vn);   // hold the button and talk, let go to send
        if (!ok) { if (millis() - t0 < 600) { notice = "HOLD THE BUTTON AND TALK"; noticeAt = millis(); st = ST_IDLE; show(st); } else { show(ST_CONFUSED); delay(1200); st = ST_IDLE; show(st); } } else { show(ST_THINKING); startJob(vb, vn, false); } } }
    else if (page == 0 && tx < 244 && ty >= 340 && ty < 424 && answer.length() && answerMax > 0) { dragging = true; autoScroll = false; dragY0 = ty; dragOff0 = answerOff; }   // drag the answer up / down by hand
    else if (page == 0 && ty > 60) { ch = (ch + 1) % NIB_CHARS; st = ST_HAPPY; show(st); next = millis() + 1200; Serial.printf("character %s\n", NIB_NAMES[ch]); } }   // tap the buddy = next character
  if (autoListen && vjob == 0 && !dragging && !touchDown && page == 0 && millis() >= autoListenAt) { autoListen = false; Serial.println("auto listen (Nib asked a question)"); keepAns = true; show(ST_LISTENING); bool ok = listenWindow(false, 9000); keepAns = false;
    if (ok) { show(ST_THINKING); startJob(vb, vn, false); } else { st = ST_IDLE; show(st); } }
  if (dragging) { if (!touchDown) dragging = false; else { int o = dragOff0 + (dragY0 - touchCurY); if (o < 0) o = 0; if (o > answerMax) o = answerMax; if (o != answerOff) { answerOff = o; rectFb(0, ANS_Y0, W, ANS_Y1 - ANS_Y0, BG); answerBox(); micBtn(false); flushRows(ANS_Y0, ANS_Y1); } } }
  bool down = digitalRead(BTN) == LOW;
  if (down) { if (!pressed) { pressed = millis(); held = false; } if (!held && millis() - pressed > 600) { held = true; goPage((page + 1) % 3); st = ST_IDLE; } }
  else if (pressed) { if (!held) { ch = (ch + 1) % NIB_CHARS; page = 0; st = ST_HAPPY; show(st); next = millis() + 1200; Serial.printf("character %s\n", NIB_NAMES[ch]); } pressed = 0; }
  if (millis() - pk.at > (page == 1 ? 15000 : 30000)) { pk.at = millis(); netReq |= 1; }           // balance + goal stay fresh
  if (page == 2 && millis() - ct.at > 60000) { ct.at = millis(); netReq |= 2; }
  { static uint32_t rl = 0; if (millis() - rl > 10000) { rl = millis(); Serial.printf("NET rssi %d server %s\n", WiFi.RSSI(), serverOk ? "OK" : "FAIL"); } }
  if (feedFlag) { feedFlag = false; celebrate(); pk.hungry = false; st = ST_IDLE; show(st); }
  if (netDirty) { netDirty = false; show(st); }
  if (vadStep()) { if (vjob == 0) startJob(vb, vn, true); else if (vWakeJob) { memcpy(vb2, vb, vn * 2); vn2 = vn; pend = true; } }
  if (vjob == 2) finishJob();
  if (page == 0 && !pressed && answer.length() && millis() - answerAt < 60000 && autoScroll && answerMax > 0 && millis() - scrAt > 45 && millis() - answerAt > 2500 && vjob == 0) { scrAt = millis(); int o = (millis() - answerAt - 2500) / 40; if (o >= answerMax) { o = answerMax; autoScroll = false; } if (o != answerOff) { answerOff = o; rectFb(0, ANS_Y0, W, ANS_Y1 - ANS_Y0, BG); answerBox(); micBtn(false); flushRows(ANS_Y0, ANS_Y1); } }                                                              // always listening (this call also paces the loop, 16 ms)
  if (page == 0 && !pressed && millis() >= next) {                                           // idle life: blink, look around, yawn
    int r = random(100); int prev = st;
    st = (st == ST_BLINK || st == ST_LOOKL || st == ST_LOOKR || st == ST_HAPPY || st == ST_YAWN) ? ST_IDLE : r < 45 ? ST_BLINK : r < 65 ? ST_LOOKL : r < 85 ? ST_LOOKR : r < 95 ? ST_WINK : ST_YAWN;
    if (st != prev) show(st); next = millis() + (st == ST_IDLE ? 1600 + random(2500) : 700);
  }
}
