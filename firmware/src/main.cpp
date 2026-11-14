// Nib firmware skeleton: pet on screen, push-to-talk -> server, buddy picker saved in flash.
// Controls (BOOT button): short tap = next buddy, hold = talk. (Touch picker: see readTouch() TODO.)
// TODO per board: TFT pins (User_Setup), I2S/codec pins in voice.h, touch controller. Fill WIFI_*/SERVER.
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <TFT_eSPI.h>
#include "nib_sprites.h"
#include "voice.h"
#include "wifi_setup.h"
#define WIFI_SSID "..."
#define WIFI_PASS "..."
#define SERVER "http://192.168.0.10:8787"
#define BG 0x1883
TFT_eSPI tft; Preferences prefs; int buddy = 0;

bool qrShown=false;
NibState stateFrom(const String& s){ if(s=="ask")return ST_ASK; if(s=="happy")return ST_HAPPY; if(s=="sad")return ST_SAD; if(s=="thinking")return ST_THINKING; if(s=="listening")return ST_LISTENING; if(s=="blink")return ST_BLINK; if(s=="sleepy")return ST_SLEEPY; if(s=="surprised")return ST_SURPRISED; if(s=="love")return ST_LOVE; if(s=="wink")return ST_WINK; if(s=="laugh")return ST_LAUGH; if(s=="confused")return ST_CONFUSED; return ST_IDLE; }
void drawNib(NibState st, int scale=12){ qrShown=false; const uint16_t* f = NIB_SET[buddy][st];
  for(int j=0;j<NIB_H;j++)for(int i=0;i<NIB_W;i++){ uint16_t c=pgm_read_word(&f[j*NIB_W+i]); tft.fillRect(16+i*scale,50+j*scale,scale,scale, c==NIB_KEY?BG:c);} }
// Answer box: long text auto-scrolls (pause at top, glide, pause at bottom, repeat) so it can be read in full.
#define TXT_X 10
#define TXT_Y 368
#define TXT_W 300
#define TXT_H 100
TFT_eSprite txt(&tft); String curText; uint32_t scrollT=0; int textOv=0;
void renderText(int off){ txt.fillSprite(BG); txt.setTextColor(TFT_WHITE,BG); txt.setTextWrap(true); txt.setCursor(0,-off); txt.print(curText);
  if(textOv>0){ int y=(int)((float)off/textOv*(TXT_H-16)); txt.fillRect(TXT_W-3,y,3,16,0xFEA7); } txt.pushSprite(TXT_X,TXT_Y); }
void say(const String& s){ curText=s; scrollT=0; if(!txt.created()) txt.createSprite(TXT_W,TXT_H);
  txt.fillSprite(BG); txt.setTextWrap(true); txt.setCursor(0,0); txt.print(curText);                 // dry run to measure height
  textOv=max(0, txt.getCursorY()+txt.fontHeight()-TXT_H); renderText(0); }
void tickText(){ static uint32_t last=0; if(millis()-last<40||textOv<=0) return; last=millis();
  const float HOLD=45, PX=0.84f, glide=textOv/PX, cyc=HOLD*2+glide; float tt=fmodf((float)scrollT++,cyc);
  renderText(tt<HOLD?0:(int)min((float)textOv,(tt-HOLD)*PX)); }
// Top bar: [Wi-Fi state, time, battery]  [Nib's pocket]
float pocketUsd=-1; int pocketMax=10; uint32_t barT=0;
int batteryPercent(){ return -1; }   // TODO per board: ADC divider or PMIC (e.g. AXP2101). -1 = unknown / USB powered
void chip(int x0,const char* l,uint16_t c,const String& a,const String& n){ tft.fillRect(x0,6,148,46,0x2104); tft.drawRect(x0,6,148,46,c);
  tft.setTextColor(c,0x2104); tft.setCursor(x0+8,12); tft.print(l); tft.setTextColor(TFT_WHITE,0x2104); tft.setCursor(x0+8,24); tft.print(a); tft.setTextColor(0xAD55,0x2104); tft.setCursor(x0+8,38); tft.print(n); }
float goalSaved=0, goalTarget=0; String goalName=""; bool pocketFrozen=false; int lastEv=-1; uint32_t evT=0;
void drawBar(){ bool wifi=WiFi.status()==WL_CONNECTED; struct tm ti; char hm[8]="--:--"; if(getLocalTime(&ti,0)) strftime(hm,8,"%H:%M",&ti); int b=batteryPercent();
  tft.fillRect(0,0,320,52,BG);
  tft.setTextColor(TFT_WHITE,BG); tft.setTextSize(2); tft.setCursor(18,7); tft.print(hm); tft.setTextSize(1);                          // time (left)
  String amt=pocketUsd>=0?String("$")+String(pocketUsd,2):String("--"); int pw=34+amt.length()*7; uint16_t coin=pocketFrozen?0x8410:0xFEA0;   // coin pill: the pocket balance (grey when auto-pay is paused)
  tft.fillRoundRect(72,6,pw,18,9,0x2104); tft.fillCircle(85,15,6,coin); tft.setTextColor(0x0000,coin); tft.setCursor(83,12); tft.print("$");
  tft.setTextColor(TFT_WHITE,0x2104); tft.setCursor(96,12); tft.print(amt);
  int rssi=wifi?WiFi.RSSI():-100, bars=!wifi?0:rssi>-60?4:rssi>-70?3:rssi>-80?2:1;                                                       // Wi-Fi: 4 rising bars
  for(int i=0;i<4;i++){ int h=3+i*2; tft.fillRect(254+i*4,20-h,3,h, i<bars?TFT_WHITE:0x4208); }
  int lvl=b<0?100:b; tft.drawRoundRect(280,10,20,10,2,TFT_WHITE); tft.fillRect(300,13,2,4,TFT_WHITE); tft.fillRect(282,12,max(2,16*lvl/100),6, lvl<20?0xF9A6:0x7FEA);   // battery
  if(goalTarget>0){ tft.setTextColor(0xCE7F,BG); tft.setCursor(10,34); tft.print(goalName.substring(0,22)); String r=String("$")+String((int)goalSaved)+" / $"+String((int)goalTarget); tft.setCursor(312-r.length()*6,34); tft.print(r);   // savings goal
    tft.fillRoundRect(8,44,304,5,2,0x2104); int w=(int)(304.0f*min(1.0f,goalSaved/goalTarget)); if(w>0) tft.fillRoundRect(8,44,max(5,w),5,2, goalSaved>=goalTarget?0x7FEA:0xFEA0); } }
void refreshPocket(){ if(WiFi.status()!=WL_CONNECTED) return; HTTPClient h; h.begin(String(SERVER)+"/summary"); if(h.GET()==200){ JsonDocument d; deserializeJson(d,h.getString()); pocketUsd=d["pocket"]["usd"]|-1.0; pocketMax=d["pocket"]["perTx"]|10; pocketFrozen=d["pocket"]["frozen"]|false;
    if(d["goal"].is<JsonObject>()){ goalName=d["goal"]["name"].as<String>(); goalSaved=d["goal"]["saved"]|0.0; goalTarget=d["goal"]["target"]|0.0; } else goalTarget=0; } }
void tickEvents(){ if(WiFi.status()!=WL_CONNECTED||millis()-evT<4000) return; evT=millis();   // the pet celebrates money arriving in the pocket and reaching the goal
  HTTPClient h; h.begin(String(SERVER)+"/events?since="+String(lastEv<0?1000000000:lastEv)); if(h.GET()!=200) return; JsonDocument d; deserializeJson(d,h.getString());
  if(lastEv<0){ lastEv=d["last"]|0; return; }
  for(JsonObject e : d["events"].as<JsonArray>()){ lastEv=max(lastEv,(int)e["id"]); String t=e["type"].as<String>();
    if(t=="money_in"){ drawNib(ST_HAPPY); say(String("+$")+String((float)e["usd"],2)+" arrived! My pocket has $"+String((float)e["total"],2)+"."); }
    if(t=="goal_done"){ drawNib(ST_HAPPY); say(String("Goal reached: ")+e["name"].as<String>()+"!"); } } barT=0; }
void tickBar(){ tickEvents(); if(barT && millis()-barT<20000) return; barT=millis(); refreshPocket(); drawBar(); }
void waitMs(uint32_t ms){ uint32_t t=millis(); while(millis()-t<ms){ tickText(); delay(5); } }
// Life: blink / look around / yawn, fall asleep after 2 minutes of nothing, wake up surprised. (Never redraws over a QR code.)
uint32_t lastAct=0, nextIdle=0, idleUntil=0; bool asleep=false;
void markActive(){ lastAct=millis(); if(asleep){ asleep=false; drawNib(ST_SURPRISED); delay(700); drawNib(ST_IDLE); } }
void idleTick(){ uint32_t now=millis(); if(!lastAct) lastAct=now; if(qrShown) return;
  if(!asleep && now-lastAct>120000){ asleep=true; drawNib(ST_SLEEPY); return; }
  if(asleep) return;
  if(idleUntil && now>idleUntil){ idleUntil=0; drawNib(ST_IDLE); }
  if(!idleUntil && now>nextIdle){ int r=random(100); NibState s=r<38?ST_LOOKL:r<76?ST_LOOKR:ST_YAWN; drawNib(s); idleUntil=now+(s==ST_YAWN?1800:1300); nextIdle=now+3500+random(4500); } }
void setBuddy(int i){ buddy=(i+NIB_CHARS)%NIB_CHARS; prefs.putInt("buddy",buddy); tft.fillScreen(BG); drawNib(ST_HAPPY); say(String("Hi, I'm ")+NIB_NAMES[buddy]); }
// QR instead of the pet while the phone is needed (wallet pairing, contacts, payment approval). QR text = wallet deep link, so a camera scan opens the page inside MetaMask.
String deepLink(const String& url){ String u=url; u.replace("http://",""); u.replace("https://",""); return "https://link.metamask.io/dapp/"+u; }
void showQR(const String& text, const String& cap){
  const uint8_t V=8; QRCode qr; uint8_t buf[qrcode_getBufferSize(V)]; qrcode_initText(&qr,buf,V,ECC_LOW,text.c_str());   // version 8 / L fits ~190 bytes (EIP-681 payment URIs are ~110)
  int S=288/(qr.size+6), px=S*(qr.size+6), ox=(320-px)/2, oy=50+(288-px)/2;
  tft.fillRect(0,40,320,310,BG); tft.fillRect(ox,oy,px,px,TFT_WHITE);
  for(int y=0;y<qr.size;y++)for(int x=0;x<qr.size;x++) if(qrcode_getModule(&qr,x,y)) tft.fillRect(ox+(3+x)*S,oy+(3+y)*S,S,S,TFT_BLACK);
  say(cap); qrShown=true; }
void startPairing(){ HTTPClient h; h.begin(String(SERVER)+"/pair-start"); h.POST(""); JsonDocument d; deserializeJson(d,h.getString());
  showQR(deepLink(d["url"].as<String>()+"?code="+d["code"].as<String>()), String("Scan with your phone. Code: ")+d["code"].as<String>()); }
bool readTouch(int& x,int& y){ return false; /* TODO: FT6236/GT911 read; then left third = prev, right third = next */ }
String ask(const String& text){ HTTPClient h; h.begin(String(SERVER)+"/ask"); JsonDocument d; d["text"]=text; String b; serializeJson(d,b); h.POST(b); return h.getString(); }
void handle(const String& json){ markActive(); JsonDocument r; deserializeJson(r,json);
  if(r["phone"] | false){ showQR(r["uri"].is<const char*>() ? r["uri"].as<String>() : deepLink(String(SERVER)+"/confirm/"+r["pendingId"].as<String>()), r["say"].as<String>()); }   // payment waits for the phone: QR instead of the pet
  else { drawNib(stateFrom(r["state"].as<String>())); say(r["say"].as<String>()); }
  if(r["pendingId"]){ String id=r["pendingId"]; for(;;){ waitMs(1000); HTTPClient h; h.begin(String(SERVER)+"/pending/"+id); h.GET(); JsonDocument p; deserializeJson(p,h.getString()); String st=p["status"]; if(st=="done"){drawNib(ST_HAPPY);say("Done!");break;} if(st=="rejected"||st=="failed"){drawNib(ST_SAD);say("Cancelled");break;} } } }
void setup(){ Serial.begin(115200); prefs.begin("nib",false); buddy=prefs.getInt("buddy",0); tft.init(); tft.setRotation(0); tft.fillScreen(BG); micBegin();
  drawNib(ST_IDLE); if(!wifiConnectSaved()){   // no saved network (or it failed): open the setup portal and show a QR instead of the pet
    String ap=String("Nib-Setup-")+String((uint32_t)(ESP.getEfuseMac()&0xFFFF),HEX); wifiStartPortal(ap);
    showQR(String("WIFI:T:nopass;S:")+ap+";;", String("Scan with your phone camera to join ")+ap+", then pick your Wi-Fi.");
    while(true){ wifiPortalTick(); delay(5); } }   // the portal restarts the device after a successful join
  configTzTime("CET-1CEST,M3.5.0,M10.5.0/3","pool.ntp.org"); say(String("Hi, I'm ")+NIB_NAMES[buddy]); }
void loop(){
  tickText(); tickBar(); idleTick();
  int tx,ty; if(readTouch(tx,ty)) setBuddy(buddy + (tx<107?-1:tx>213?1:0));
  if(digitalRead(PTT_PIN)==LOW){ markActive(); uint32_t t0=millis(); while(digitalRead(PTT_PIN)==LOW && millis()-t0<300) delay(5);
    if(digitalRead(PTT_PIN)==HIGH){ setBuddy(buddy+1); }            // short tap: next buddy
    else { drawNib(ST_LISTENING); uint8_t* buf; size_t n=micRecord(&buf);   // hold: talk
      if(n>8000){ drawNib(ST_THINKING); HTTPClient h; h.begin(String(SERVER)+"/voice"); h.POST(buf,n); handle(h.getString()); }
      free(buf); } }
  if(Serial.available()){ String t=Serial.readStringUntil('\n'); t.trim();
    if(t=="forgetwifi"){ wifiForget(); ESP.restart(); }
    else if(t=="pair") startPairing();                                   // TODO: bind to a button gesture (e.g. two quick taps)
    else { drawNib(ST_THINKING); handle(ask(t)); } } // serial debug
}
