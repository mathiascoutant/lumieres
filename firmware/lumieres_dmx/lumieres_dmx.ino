// Lumières : passerelle Art-Net -> DMX512 pour Waveshare ESP32-S3-RS485-CAN.
//
// Reçoit l'univers en Wi-Fi (Art-Net, port UDP 6454) et le sort en continu sur le
// bornier RS485. Sans identifiants Wi-Fi valides, la carte ouvre le réseau
// "Lumieres-DMX" et une page de configuration sur http://192.168.4.1.
// Maintenir le bouton BOOT pendant 3 s au démarrage efface les identifiants.

#include <Arduino.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiUdp.h>

#include "driver/uart.h"
#include "esp_mac.h"
#include "rdm.h"

// Brochage de la carte (WS_GPIO.h de la démo Waveshare).
static const int PIN_RS485_TX = 17;
static const int PIN_RS485_RX = 18;
static const int PIN_RS485_EN = 21;
static const int PIN_BOOT = 0;
static const uart_port_t DMX_UART = UART_NUM_1;

static const uint16_t ARTNET_PORT = 6454;
static const uint16_t OP_POLL = 0x2000;
static const uint16_t OP_POLL_REPLY = 0x2100;
static const uint16_t OP_DMX = 0x5000;

// Timings DMX512-A : break >= 92 us, mark after break >= 12 us. 513 octets à 250 kbit/s
// durent 22,6 ms ; la pause complète une trame à environ 40 Hz.
static const uint32_t DMX_BREAK_US = 120;
static const uint32_t DMX_MAB_US = 16;
static const uint32_t DMX_FRAME_GAP_MS = 2;

// Sans nouvelles du serveur, tout s'éteint : une machine à fumée ou un laser ne doit
// jamais rester allumé parce que le Wi-Fi est tombé.
static const uint32_t SIGNAL_TIMEOUT_MS = 5000;

static const uint32_t WIFI_CONNECT_TIMEOUT_MS = 20000;

// RDM : break >= 176 us. Un appareil commence à répondre en moins de 2,8 ms ; le silence
// qui suit marque la fin de sa réponse.
static const uint32_t RDM_BREAK_US = 180;
static const uint32_t RDM_REPLY_WAIT_MS = 5;
static const uint32_t RDM_REPLY_IDLE_MS = 2;
static const uint32_t RDM_REPLY_MAX_MS = 40;
static const int RDM_STEPS_PER_FRAME = 4;

static uint8_t dmxShared[512];
static portMUX_TYPE dmxLock = portMUX_INITIALIZER_UNLOCKED;
static volatile uint32_t lastPacketMs = 0;
static volatile bool signalSeen = false;

static WiFiUDP udp;
static WebServer web(80);
static Preferences prefs;
static String wifiSsid, wifiPass;
static uint16_t universe = 0;
static bool apMode = false;
static uint32_t packetCount = 0;

// --- RDM ----------------------------------------------------------------------

static size_t rdmTransact(void*, const uint8_t* request, size_t length, uint8_t* response, size_t capacity) {
  uart_wait_tx_done(DMX_UART, pdMS_TO_TICKS(50));
  uart_set_line_inverse(DMX_UART, UART_SIGNAL_TXD_INV);
  delayMicroseconds(RDM_BREAK_US);
  uart_set_line_inverse(DMX_UART, UART_SIGNAL_INV_DISABLE);
  delayMicroseconds(DMX_MAB_US);
  uart_write_bytes(DMX_UART, request, length);
  uart_wait_tx_done(DMX_UART, pdMS_TO_TICKS(50));

  // La ligne doit être libérée tout de suite : l'appareil répond sur la même paire.
  digitalWrite(PIN_RS485_EN, LOW);
  uart_flush_input(DMX_UART);

  size_t got = 0;
  if (capacity > 0) {
    const uint32_t started = millis();
    uint32_t lastByte = started;
    while (got < capacity) {
      int n = uart_read_bytes(DMX_UART, response + got, capacity - got, pdMS_TO_TICKS(1));
      const uint32_t now = millis();
      if (n > 0) {
        got += n;
        lastByte = now;
      } else if (got > 0 ? now - lastByte >= RDM_REPLY_IDLE_MS : now - started >= RDM_REPLY_WAIT_MS) {
        break;
      }
      if (now - started >= RDM_REPLY_MAX_MS) break;
    }
  } else {
    delay(1);
  }
  digitalWrite(PIN_RS485_EN, HIGH);
  return got;
}

static rdm::Scanner scanner(rdmTransact, nullptr);
static SemaphoreHandle_t scannerLock;
static volatile bool scanRequested = false;

static void runRdmSteps() {
  if (scanRequested) {
    xSemaphoreTake(scannerLock, portMAX_DELAY);
    scanner.start();
    scanRequested = false;
    xSemaphoreGive(scannerLock);
  }
  for (int i = 0; i < RDM_STEPS_PER_FRAME && scanner.running(); i++) {
    xSemaphoreTake(scannerLock, portMAX_DELAY);
    scanner.step();
    xSemaphoreGive(scannerLock);
  }
}

// --- Sortie DMX ---------------------------------------------------------------

static void dmxTask(void*) {
  uart_config_t config = {};
  config.baud_rate = 250000;
  config.data_bits = UART_DATA_8_BITS;
  config.parity = UART_PARITY_DISABLE;
  config.stop_bits = UART_STOP_BITS_2;
  config.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
  config.source_clk = UART_SCLK_DEFAULT;
  ESP_ERROR_CHECK(uart_driver_install(DMX_UART, 512, 1024, 0, nullptr, 0));
  ESP_ERROR_CHECK(uart_param_config(DMX_UART, &config));
  ESP_ERROR_CHECK(uart_set_pin(DMX_UART, PIN_RS485_TX, PIN_RS485_RX, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
  // Les réponses RDM sont courtes : elles doivent arriver sans attendre un FIFO plein.
  uart_set_rx_full_threshold(DMX_UART, 8);
  uart_set_rx_timeout(DMX_UART, 2);

  // Le transceiver reste en émission, sauf pendant l'écoute d'une réponse RDM.
  pinMode(PIN_RS485_EN, OUTPUT);
  digitalWrite(PIN_RS485_EN, HIGH);

  static uint8_t frame[513];
  frame[0] = 0;  // start code

  for (;;) {
    bool stale = !signalSeen || millis() - lastPacketMs > SIGNAL_TIMEOUT_MS;
    portENTER_CRITICAL(&dmxLock);
    if (stale) {
      memset(dmxShared, 0, sizeof(dmxShared));
    }
    memcpy(frame + 1, dmxShared, 512);
    portEXIT_CRITICAL(&dmxLock);

    // Le break est obtenu en inversant la ligne TX, ce qui garde des timings exacts
    // sans changer le débit de l'UART.
    uart_wait_tx_done(DMX_UART, pdMS_TO_TICKS(50));
    uart_set_line_inverse(DMX_UART, UART_SIGNAL_TXD_INV);
    delayMicroseconds(DMX_BREAK_US);
    uart_set_line_inverse(DMX_UART, UART_SIGNAL_INV_DISABLE);
    delayMicroseconds(DMX_MAB_US);
    uart_write_bytes(DMX_UART, frame, sizeof(frame));
    uart_wait_tx_done(DMX_UART, pdMS_TO_TICKS(50));
    // Entre deux trames, pour que les lumières continuent de recevoir leur signal.
    runRdmSteps();
    vTaskDelay(pdMS_TO_TICKS(DMX_FRAME_GAP_MS));
  }
}

// --- Art-Net ------------------------------------------------------------------

static void sendPollReply(IPAddress to) {
  uint8_t r[239] = {};
  memcpy(r, "Art-Net\0", 8);
  r[8] = OP_POLL_REPLY & 0xff;
  r[9] = OP_POLL_REPLY >> 8;
  IPAddress ip = apMode ? WiFi.softAPIP() : WiFi.localIP();
  for (int i = 0; i < 4; i++) r[10 + i] = ip[i];
  r[14] = ARTNET_PORT & 0xff;
  r[15] = ARTNET_PORT >> 8;
  r[18] = (universe >> 8) & 0x7f;
  r[19] = (universe >> 4) & 0x0f;
  strncpy(reinterpret_cast<char*>(r + 26), "Lumieres DMX", 17);
  strncpy(reinterpret_cast<char*>(r + 44), "Lumieres ESP32-S3 Art-Net vers DMX", 63);
  r[173] = 1;     // un port
  r[174] = 0x80;  // port de sortie DMX
  r[182] = 0x80;  // données en cours de sortie
  r[190] = universe & 0x0f;
  udp.beginPacket(to, ARTNET_PORT);
  udp.write(r, sizeof(r));
  udp.endPacket();
}

static void handleArtnet() {
  static uint8_t buf[600];
  // Tous les paquets en attente sont vidés d'un coup : seul le dernier univers compte.
  while (int size = udp.parsePacket()) {
    int n = udp.read(buf, sizeof(buf));
    if (n < 10 || size < 10 || memcmp(buf, "Art-Net\0", 8) != 0) continue;
    uint16_t op = buf[8] | (buf[9] << 8);
    if (op == OP_POLL) {
      sendPollReply(udp.remoteIP());
    } else if (op == OP_DMX && n >= 18) {
      uint16_t portAddress = buf[14] | (buf[15] << 8);
      uint16_t length = (buf[16] << 8) | buf[17];
      if (portAddress != universe || length == 0 || length > 512 || n < 18 + length) continue;
      portENTER_CRITICAL(&dmxLock);
      memcpy(dmxShared, buf + 18, length);
      if (length < 512) memset(dmxShared + length, 0, 512 - length);
      portEXIT_CRITICAL(&dmxLock);
      lastPacketMs = millis();
      signalSeen = true;
      packetCount++;
    }
  }
}

// --- Configuration ------------------------------------------------------------

static String htmlEscape(const String& in) {
  String out = in;
  out.replace("&", "&amp;");
  out.replace("<", "&lt;");
  out.replace(">", "&gt;");
  out.replace("\"", "&quot;");
  return out;
}

static void handleRoot() {
  bool live = signalSeen && millis() - lastPacketMs < SIGNAL_TIMEOUT_MS;
  IPAddress ip = apMode ? WiFi.softAPIP() : WiFi.localIP();
  String page;
  page.reserve(1600);
  page += F("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
            "<title>Lumieres DMX</title><style>body{font:16px system-ui;background:#0d0f14;color:#eef1f6;margin:0 auto;"
            "padding:20px;max-width:420px}input,button{width:100%;box-sizing:border-box;font-size:16px;padding:12px;"
            "margin:6px 0 14px;border-radius:8px;border:1px solid #333a47;background:#191d26;color:#eef1f6}"
            "button{background:#ffb020;color:#111;font-weight:600;border:0}small{color:#9aa3b2}</style>"
            "<h2>Passerelle DMX</h2><p><small>");
  page += apMode ? "Point d'accès" : ("Connectée à " + htmlEscape(wifiSsid));
  page += " - IP " + ip.toString() + "<br>Signal Art-Net : ";
  page += live ? "reçu" : "aucun";
  page += " - " + String(packetCount) + F(" paquets</small></p><form method=post action=/save>"
                                          "<label>Réseau Wi-Fi<input name=ssid maxlength=32 value=\"");
  page += htmlEscape(wifiSsid);
  page += F("\"></label><label>Mot de passe<input name=pass type=password maxlength=63></label>"
            "<label>Univers Art-Net<input name=universe type=number min=0 max=32767 value=\"");
  page += String(universe);
  page += F("\"></label><button>Enregistrer et redémarrer</button></form>");
  web.send(200, "text/html; charset=utf-8", page);
}

static void handleSave() {
  prefs.begin("lumieres", false);
  prefs.putString("ssid", web.arg("ssid"));
  // Un champ vide garde le mot de passe enregistré, qui n'est jamais réaffiché.
  if (web.arg("pass").length() > 0) prefs.putString("pass", web.arg("pass"));
  prefs.putUShort("universe", constrain(web.arg("universe").toInt(), 0, 32767));
  prefs.end();
  web.send(200, "text/html; charset=utf-8", "<meta charset=utf-8>Enregistré, redémarrage...");
  delay(500);
  ESP.restart();
}

static void jsonText(String& out, const char* text) {
  out += '"';
  for (const char* c = text; *c; c++) {
    const uint8_t b = static_cast<uint8_t>(*c);
    if (b == '"' || b == '\\') {
      out += '\\';
      out += *c;
    } else if (b >= 0x20 && b < 0x7F) {
      out += *c;  // les noms RDM sont en ASCII : le reste viendrait d'un appareil mal programmé
    }
  }
  out += '"';
}

static void handleRdmScan() {
  scanRequested = true;
  web.send(202, "application/json", "{\"state\":\"scanning\"}");
}

static void handleRdmDevices() {
  String json;
  json.reserve(512);
  xSemaphoreTake(scannerLock, portMAX_DELAY);
  const char* state = (scanRequested || scanner.running()) ? "scanning" : scanner.hasRun() ? "done" : "idle";
  json += "{\"state\":\"";
  json += state;
  json += "\",\"truncated\":";
  json += scanner.truncated() ? "true" : "false";
  json += ",\"devices\":[";
  for (size_t i = 0; i < scanner.count(); i++) {
    const rdm::Device& d = scanner.device(i);
    char uid[16];
    snprintf(uid, sizeof(uid), "%04x:%08lx", static_cast<unsigned>(d.uid >> 32), static_cast<unsigned long>(d.uid & 0xFFFFFFFFUL));
    if (i) json += ',';
    json += "{\"uid\":\"";
    json += uid;
    json += "\",\"manufacturer\":";
    jsonText(json, d.manufacturer);
    json += ",\"model\":";
    jsonText(json, d.model);
    json += ",\"label\":";
    jsonText(json, d.label);
    json += ",\"personalityName\":";
    jsonText(json, d.personalityName);
    json += ",\"address\":";
    json += d.address == 0xFFFF ? 0 : d.address;
    json += ",\"footprint\":";
    json += d.footprint;
    json += ",\"personality\":";
    json += d.personality;
    json += ",\"personalityCount\":";
    json += d.personalityCount;
    json += '}';
  }
  xSemaphoreGive(scannerLock);
  json += "]}";
  web.send(200, "application/json", json);
}

static void loadConfig() {
  prefs.begin("lumieres", true);
  wifiSsid = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
  universe = prefs.getUShort("universe", 0);
  prefs.end();
}

static void clearConfigIfBootHeld() {
  pinMode(PIN_BOOT, INPUT_PULLUP);
  uint32_t start = millis();
  while (digitalRead(PIN_BOOT) == LOW) {
    if (millis() - start > 3000) {
      prefs.begin("lumieres", false);
      prefs.clear();
      prefs.end();
      Serial.println("Configuration effacee");
      break;
    }
    delay(10);
  }
}

static bool connectWifi() {
  if (wifiSsid.isEmpty()) return false;
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_CONNECT_TIMEOUT_MS) return false;
    delay(100);
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  clearConfigIfBootHeld();
  loadConfig();

  scannerLock = xSemaphoreCreateMutex();
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  scanner.setSelf(0x7FF000000000ULL | (uint64_t)mac[2] << 24 | mac[3] << 16 | mac[4] << 8 | mac[5]);

  // Démarrée tout de suite : les appareils reçoivent du noir plutôt que rien.
  xTaskCreatePinnedToCore(dmxTask, "dmx", 8192, nullptr, configMAX_PRIORITIES - 2, nullptr, 1);

  if (connectWifi()) {
    Serial.printf("Wi-Fi connecte, IP %s\n", WiFi.localIP().toString().c_str());
  } else {
    apMode = true;
    WiFi.mode(WIFI_AP);
    WiFi.softAP("Lumieres-DMX");
    Serial.printf("Point d'acces Lumieres-DMX, IP %s\n", WiFi.softAPIP().toString().c_str());
  }
  // L'économie d'énergie du Wi-Fi retarde les paquets de plusieurs centaines de ms.
  WiFi.setSleep(false);

  udp.begin(ARTNET_PORT);
  web.on("/", HTTP_GET, handleRoot);
  web.on("/save", HTTP_POST, handleSave);
  web.on("/rdm/scan", HTTP_POST, handleRdmScan);
  web.on("/rdm/devices", HTTP_GET, handleRdmDevices);
  web.begin();
}

void loop() {
  handleArtnet();
  web.handleClient();
  if (!apMode && WiFi.status() != WL_CONNECTED) {
    static uint32_t lastRetry = 0;
    if (millis() - lastRetry > 5000) {
      lastRetry = millis();
      WiFi.reconnect();
    }
  }
  delay(1);
}
