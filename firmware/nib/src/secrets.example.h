// Copy to secrets.h (git-ignored) and fill in.
// Wi-Fi name/password are NOT here: enter them once on your phone in the "Nib-Setup" portal.
#pragma once
#define SERVER_URL  "https://nib.example.com"   // your server: tunnel URL, or http://<mac-ip>:8899 on the LAN
#define SERVER_HOST "your-mac-hostname"         // LAN fallback: Nib finds the server by this mDNS name
#define NIB_DEVKEY  "same value as NIB_DEVICE_KEY in the server .env"
