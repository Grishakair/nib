// Wi-Fi provisioning for the REAL device (uncompiled, needs testing on the board).
// First boot or after "Forget network": Nib opens its own temporary Wi-Fi ("Nib-Setup-XXXX") with a captive portal.
// The user joins it by scanning the QR on the pet's screen, picks the home network and types the password on the PHONE
// (typing on the 3.5" screen is miserable). Credentials are stored in NVS flash; after a successful join the device restarts.
#pragma once
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>

static WebServer portal(80);
static DNSServer dnsServer;
static bool portalOn = false;
static Preferences wprefs;

static String htmlEsc(const String& s) { String o; for (size_t i = 0; i < s.length(); i++) { char c = s[i]; if (c == '&') o += "&amp;"; else if (c == '<') o += "&lt;"; else if (c == '>') o += "&gt;"; else if (c == '"') o += "&quot;"; else o += c; } return o; }

bool wifiHasSaved() { wprefs.begin("wifi", true); bool h = wprefs.getString("ssid", "").length() > 0; wprefs.end(); return h; }
bool wifiConnectSaved(uint32_t timeoutMs = 12000) {
  wprefs.begin("wifi", true); String s = wprefs.getString("ssid", ""), p = wprefs.getString("pass", ""); wprefs.end();
  if (!s.length()) return false;
  WiFi.mode(WIFI_STA); WiFi.begin(s.c_str(), p.c_str());
  uint32_t t = millis(); while (WiFi.status() != WL_CONNECTED && millis() - t < timeoutMs) delay(200);
  return WiFi.status() == WL_CONNECTED;
}
void wifiForget() { wprefs.begin("wifi", false); wprefs.clear(); wprefs.end(); WiFi.disconnect(true, true); }

static String portalPage() {
  int n = WiFi.scanNetworks();                                       // fresh scan every time the page loads
  String o = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><body style='font:18px system-ui;max-width:420px;margin:0 auto;padding:20px;background:#1d1830;color:#fff'>"
             "<h2>Connect Nib to Wi-Fi</h2><form method=POST action=/join><p><select name=ssid style='width:100%;font-size:18px;padding:10px'>";
  for (int i = 0; i < n; i++) o += "<option>" + htmlEsc(WiFi.SSID(i)) + "</option>";
  o += "</select></p><p><input name=pass type=password placeholder='Password' style='width:100%;font-size:18px;padding:10px'></p><p><button style='font-size:20px;padding:12px 24px'>Connect</button></p></form>";
  return o;
}
static void portalJoin() {
  String s = portal.arg("ssid"), p = portal.arg("pass");
  WiFi.begin(s.c_str(), p.c_str());
  uint32_t t = millis(); while (WiFi.status() != WL_CONNECTED && millis() - t < 15000) delay(200);
  if (WiFi.status() == WL_CONNECTED) {
    wprefs.begin("wifi", false); wprefs.putString("ssid", s); wprefs.putString("pass", p); wprefs.end();
    portal.send(200, "text/html", "<body style='font:20px system-ui;padding:24px'>Connected! You can close this page. Nib is online now.");
    delay(1200); ESP.restart();
  } else {
    WiFi.disconnect();                                               // keep the portal running so the user can retry
    portal.send(200, "text/html", "<body style='font:20px system-ui;padding:24px'>Could not connect. Wrong password? <a href=/>Try again</a>");
  }
}
void wifiStartPortal(const String& apName) {
  WiFi.mode(WIFI_AP_STA); WiFi.softAP(apName.c_str());               // open temporary network (only reachable within a few metres, and only while pairing)
  dnsServer.start(53, "*", WiFi.softAPIP());                         // captive portal: every hostname resolves to the pet
  portal.on("/", HTTP_GET, []() { portal.send(200, "text/html", portalPage()); });
  portal.on("/join", HTTP_POST, portalJoin);
  portal.onNotFound([]() { portal.sendHeader("Location", "http://192.168.4.1/", true); portal.send(302, "text/plain", ""); });
  portal.begin(); portalOn = true;
}
void wifiPortalTick() { if (portalOn) { dnsServer.processNextRequest(); portal.handleClient(); } }
