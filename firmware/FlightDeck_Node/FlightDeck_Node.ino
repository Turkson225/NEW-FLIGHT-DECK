/*
  FLIGHT DECK aircraft NodeMCU
  MPU6050: SDA D2, SCL D1
  A0: verified aircraft battery divider
  RX/TX: receiver Nano UART through bidirectional level shifter

  The Receiver Nano remains the flight-control authority.
  This NodeMCU only measures, forwards telemetry, and serves a local read-only page.

  Cloud path:
  NodeMCU -> HTTPS POST -> Supabase telemetry-ingest -> fd_telemetry -> dashboard

  IMPORTANT:
  1. Replace DEVICE_SHARED_TOKEN with the same 32+ character token configured
     as DEVICE_SHARED_TOKEN in the existing Supabase project.
  2. This sketch does not send actuator commands.
  3. ALLOW_INSECURE_TLS_FOR_BENCH_TEST is enabled only so the ESP8266 can
     connect without a certificate bundle. Pin a CA certificate before field use.
*/

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecureBearSSL.h>
#include <Wire.h>
#include <math.h>

// ================= WIFI =================
const char* WIFI_SSID = "YOUR_2_4_GHZ_HOTSPOT";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

const char* BACKUP_AP = "FLIGHT_DECK_NODE";
const char* BACKUP_PASSWORD = "12345678";

// ================= EXISTING SUPABASE PROJECT =================
const char* SUPABASE_TELEMETRY_URL =
  "https://zqhhoiqmnzmsrendkive.supabase.co/functions/v1/telemetry-ingest";

const char* DEVICE_ID = "FD-001";

// Do not commit a real device token to GitHub.
// Paste the same token used in the Supabase Edge Function secret.
const char* DEVICE_SHARED_TOKEN =
  "REPLACE_WITH_THE_EXISTING_SUPABASE_DEVICE_TOKEN_32_CHARS_MINIMUM";

#define ALLOW_INSECURE_TLS_FOR_BENCH_TEST 1

// ================= HARDWARE =================
const float DIVIDER_RATIO = 4.0f;
const float ADC_REFERENCE = 3.3f;
const unsigned long CLOUD_INTERVAL_MS = 1000UL;

ESP8266WebServer server(80);

uint8_t mpuAddress = 0;
bool mpuConnected = false;
bool backupAP = false;
bool receiverOnline = false;
bool cloudOnline = false;
bool lastCloudAccepted = false;

float ax = 0, ay = 0, az = 0;
float gx = 0, gy = 0, gz = 0;
float tempC = 0, pitch = 0, roll = 0;
float filteredPitch = 0, filteredRoll = 0;

uint16_t batteryMv = 0;
uint16_t txBatteryMv = 0;
uint8_t receiverFlags = 1;
uint8_t mixEnabled = 0;

unsigned long lastReceiver = 0;
unsigned long lastNodeSend = 0;
unsigned long lastCloudSend = 0;
unsigned long previousMicros = 0;
unsigned long receiverPackets = 0;
unsigned long cloudUploads = 0;
String bootId;

struct __attribute__((packed)) ReceiverStatus {
  uint16_t sequence;
  int16_t elevator;
  int16_t rudder;
  int16_t leftAileron;
  int16_t rightAileron;
  uint16_t throttle;
  uint8_t mixEnabled;
  uint8_t failsafe;
  uint8_t parachuteEvent;
  uint16_t txBatteryMv;
};

ReceiverStatus lastReceiverStatus{};

struct __attribute__((packed)) NodeTelemetry {
  uint16_t batteryMv;
  int16_t pitchCdeg;
  int16_t rollCdeg;
  int16_t temperatureCdeg;
  uint8_t flags;
};

const char PAGE[] PROGMEM = R"rawliteral(
<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FLIGHT DECK NODE</title>
<style>
body{font-family:Arial;background:#0b1118;color:#eef4f7;margin:20px}
h1{color:#c6f36b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.card{background:#121b24;border:1px solid #293744;border-radius:10px;padding:16px}
.label{font-size:11px;color:#8b9aa8}.value{font-size:24px;color:#c6f36b;margin-top:8px}
</style>
</head>
<body>
<h1>FLIGHT DECK AIRCRAFT NODE</h1>
<p id="state">Reading...</p>
<div class="grid">
<div class="card"><div class="label">PITCH</div><div class="value" id="pitch">--</div></div>
<div class="card"><div class="label">ROLL</div><div class="value" id="roll">--</div></div>
<div class="card"><div class="label">BATTERY</div><div class="value" id="battery">--</div></div>
<div class="card"><div class="label">TEMPERATURE</div><div class="value" id="temp">--</div></div>
<div class="card"><div class="label">RECEIVER</div><div class="value" id="rx">--</div></div>
<div class="card"><div class="label">CLOUD UPLINK</div><div class="value" id="cloud">--</div></div>
</div>
<script>
async function refresh(){
  try{
    const d=await (await fetch('/api/telemetry')).json();
    document.getElementById('state').textContent='Node IP: '+d.ip+' | Device: '+d.device;
    document.getElementById('pitch').textContent=d.mpu.connected?d.mpu.pitch.toFixed(2)+'°':'Unknown';
    document.getElementById('roll').textContent=d.mpu.connected?d.mpu.roll.toFixed(2)+'°':'Unknown';
    document.getElementById('battery').textContent=d.battery.voltage_v===null?'Unknown':d.battery.voltage_v.toFixed(2)+' V';
    document.getElementById('temp').textContent=d.mpu.connected?d.mpu.temperature.toFixed(2)+' °C':'Unknown';
    document.getElementById('rx').textContent=d.receiver.online?'ONLINE':'STALE';
    document.getElementById('cloud').textContent=d.cloud.online?'SYNCED':'OFFLINE';
  }catch(e){
    document.getElementById('state').textContent='Connection error';
  }
}
setInterval(refresh,1000);refresh();
</script>
</body>
</html>
)rawliteral";

void writeReg(uint8_t r, uint8_t v) {
  Wire.beginTransmission(mpuAddress);
  Wire.write(r);
  Wire.write(v);
  Wire.endTransmission();
}

uint8_t readReg(uint8_t r) {
  Wire.beginTransmission(mpuAddress);
  Wire.write(r);
  Wire.endTransmission(false);
  Wire.requestFrom((int)mpuAddress, 1);
  return Wire.available() ? Wire.read() : 0;
}

bool detectMpu(uint8_t address) {
  mpuAddress = address;
  Wire.beginTransmission(mpuAddress);
  if (Wire.endTransmission() != 0) return false;
  return readReg(0x75) == 0x68;
}

void setupMpu() {
  writeReg(0x6B, 0);
  delay(100);
  writeReg(0x1B, 0);
  writeReg(0x1C, 0);
  writeReg(0x1A, 3);
}

void readMpu() {
  if (!mpuConnected) return;

  Wire.beginTransmission(mpuAddress);
  Wire.write(0x3B);
  if (Wire.endTransmission(false) != 0) {
    mpuConnected = false;
    return;
  }

  if (Wire.requestFrom((int)mpuAddress, 14) != 14) {
    mpuConnected = false;
    return;
  }

  int16_t rax = (Wire.read() << 8) | Wire.read();
  int16_t ray = (Wire.read() << 8) | Wire.read();
  int16_t raz = (Wire.read() << 8) | Wire.read();
  int16_t rt  = (Wire.read() << 8) | Wire.read();
  int16_t rgx = (Wire.read() << 8) | Wire.read();
  int16_t rgy = (Wire.read() << 8) | Wire.read();
  int16_t rgz = (Wire.read() << 8) | Wire.read();

  ax = rax / 16384.0f * 9.80665f;
  ay = ray / 16384.0f * 9.80665f;
  az = raz / 16384.0f * 9.80665f;
  gx = rgx / 131.0f;
  gy = rgy / 131.0f;
  gz = rgz / 131.0f;
  tempC = rt / 340.0f + 36.53f;

  float p = atan2(ay, sqrt(ax * ax + az * az)) * 180.0f / PI;
  float r = atan2(-ax, az) * 180.0f / PI;
  unsigned long now = micros();
  float dt = (now - previousMicros) / 1000000.0f;
  previousMicros = now;

  if (dt > 0 && dt < 1) {
    filteredPitch = 0.98f * (filteredPitch + gx * dt) + 0.02f * p;
    filteredRoll = 0.98f * (filteredRoll + gy * dt) + 0.02f * r;
  }

  pitch = filteredPitch;
  roll = filteredRoll;
}

void readBattery() {
  int raw = analogRead(A0);
  if (raw >= 1020) {
    batteryMv = 0;
    return;
  }

  float pinV = raw * ADC_REFERENCE / 1023.0f;
  if (pinV >= 3.2f) {
    batteryMv = 0;
    return;
  }

  batteryMv = (uint16_t)constrain(
    (long)(pinV * DIVIDER_RATIO * 1000.0f),
    0L,
    65535L
  );
}

uint8_t crc(const uint8_t* data, uint8_t len) {
  uint8_t c = 0;
  for (uint8_t i = 0; i < len; i++) c ^= data[i];
  return c;
}

void sendFrame(uint8_t type, const uint8_t* data, uint8_t len) {
  Serial.write(0xFD);
  Serial.write(type);
  Serial.write(len);
  Serial.write(data, len);
  Serial.write(crc(data, len));
}

bool receiveFrame(uint8_t& type, uint8_t* data, uint8_t maxLen, uint8_t& len) {
  static uint8_t state = 0;
  static uint8_t t = 0;
  static uint8_t n = 0;
  static uint8_t pos = 0;
  static uint8_t c = 0;

  while (Serial.available()) {
    uint8_t b = Serial.read();

    if (state == 0) {
      if (b == 0xFD) state = 1;
    } else if (state == 1) {
      t = b;
      state = 2;
    } else if (state == 2) {
      n = b;
      pos = 0;
      c = 0;
      if (n > maxLen) state = 0;
      else state = n ? 3 : 4;
    } else if (state == 3) {
      data[pos++] = b;
      c ^= b;
      if (pos >= n) state = 4;
    } else {
      state = 0;
      if (c == b) {
        type = t;
        len = n;
        return true;
      }
    }
  }

  return false;
}

void processReceiver() {
  uint8_t type, len, data[32];
  if (!receiveFrame(type, data, sizeof(data), len)) return;

  if (type == 0x10 && len == sizeof(ReceiverStatus)) {
    ReceiverStatus s{};
    memcpy(&s, data, sizeof(s));
    lastReceiverStatus = s;
    txBatteryMv = s.txBatteryMv;
    mixEnabled = s.mixEnabled;
    receiverFlags = 0;
    if (s.failsafe) receiverFlags |= 1;
    receiverOnline = true;
    lastReceiver = millis();
    receiverPackets++;
  }
}

void sendTelemetryToNano() {
  NodeTelemetry t{};
  t.batteryMv = batteryMv;
  t.pitchCdeg = (int16_t)constrain((long)(pitch * 100), -32768L, 32767L);
  t.rollCdeg = (int16_t)constrain((long)(roll * 100), -32768L, 32767L);
  t.temperatureCdeg = (int16_t)constrain((long)(tempC * 100), -32768L, 32767L);
  if (mpuConnected) t.flags |= 1;
  if (batteryMv) t.flags |= 2;
  sendFrame(0x20, reinterpret_cast<uint8_t*>(&t), sizeof(t));
}

int safePwm(int value) {
  return constrain(value, 500, 2500);
}

float surfaceNormalized(int pwm) {
  return constrain((pwm - 1500) / 500.0f, -1.0f, 1.0f);
}

float throttleNormalized(int pwm) {
  return constrain((pwm - 1000) / 1000.0f, 0.0f, 1.0f);
}

String outputJson(int pwm) {
  return String("{\"normalized\":") + String(surfaceNormalized(pwm), 4)
    + ",\"pwm\":" + String(safePwm(pwm))
    + ",\"saturated\":null}";
}

String throttleOutputJson(int pwm) {
  return String("{\"normalized\":") + String(throttleNormalized(pwm), 4)
    + ",\"pwm\":" + String(safePwm(pwm))
    + ",\"saturated\":null}";
}

String inputsJson() {
  if (!receiverOnline) return "null";

  return String("{\"rudder\":") + String(surfaceNormalized(lastReceiverStatus.rudder), 4)
    + ",\"elevator\":" + String(surfaceNormalized(lastReceiverStatus.elevator), 4)
    + ",\"leftAileron\":" + String(surfaceNormalized(lastReceiverStatus.leftAileron), 4)
    + ",\"rightAileron\":" + String(surfaceNormalized(lastReceiverStatus.rightAileron), 4)
    + ",\"throttle\":" + String(throttleNormalized(lastReceiverStatus.throttle), 4)
    + ",\"aux1\":0,\"aux2\":0}";
}

String outputsJson() {
  if (!receiverOnline) return "{}";

  return String("{\"rudder\":") + outputJson(lastReceiverStatus.rudder)
    + ",\"elevator\":" + outputJson(lastReceiverStatus.elevator)
    + ",\"leftAileron\":" + outputJson(lastReceiverStatus.leftAileron)
    + ",\"rightAileron\":" + outputJson(lastReceiverStatus.rightAileron)
    + ",\"throttle\":" + throttleOutputJson(lastReceiverStatus.throttle)
    + "}";
}

String validityJson() {
  const char* imuState = mpuConnected ? "valid" : "invalid";
  const char* batteryState = batteryMv ? "valid" : "unknown";
  const char* txState = txBatteryMv ? "valid" : "unknown";
  const char* uartState = receiverOnline ? "valid" : "unknown";
  const char* sensorState = mpuConnected ? "valid" : "unknown";

  return String("{\"safety\":\"unknown\",\"imu\":\"") + imuState
    + "\",\"battery\":\"" + batteryState
    + "\",\"aircraftBattery\":\"" + batteryState
    + "\",\"transmitterBattery\":\"" + txState
    + "\",\"uart\":\"" + uartState
    + "\",\"attitude\":\"" + sensorState
    + "\",\"accel\":\"" + sensorState
    + "\",\"gyro\":\"" + sensorState
    + "\",\"linearAcceleration\":\"unsupported\",\"navigation\":\"not_installed\"}";
}

String buildTelemetryPayload() {
  String wifiLink = WiFi.status() == WL_CONNECTED ? "true" : "false";
  String radioLink = receiverOnline ? "true" : "false";
  String wifiRssi = WiFi.status() == WL_CONNECTED ? String(WiFi.RSSI()) : "null";
  String aircraftVoltage = batteryMv ? String(batteryMv / 1000.0f, 3) : "null";
  String transmitterVoltage = txBatteryMv ? String(txBatteryMv / 1000.0f, 3) : "null";
  unsigned long packetAge = receiverOnline ? millis() - lastReceiver : 999999UL;
  unsigned long expectedPackets = receiverPackets ? receiverPackets : 1UL;
  unsigned long receivedPackets = receiverOnline ? receiverPackets : 0UL;

  String frame = String("{\"schemaVersion\":1,\"source\":\"LIVE\",")
    + "\"deviceId\":\"" + DEVICE_ID
    + "\",\"bootId\":\"" + bootId
    + "\",\"seq\":" + String(cloudUploads)
    + ",\"uptimeMs\":" + String(millis())
    + ",\"receivedAt\":0"
    + ",\"attitude\":{\"pitch\":"
    + (mpuConnected ? String(pitch, 3) : "null")
    + ",\"roll\":" + (mpuConnected ? String(roll, 3) : "null")
    + ",\"yaw\":null}"
    + ",\"accel\":{\"x\":"
    + (mpuConnected ? String(ax, 3) : "null")
    + ",\"y\":" + (mpuConnected ? String(ay, 3) : "null")
    + ",\"z\":" + (mpuConnected ? String(az, 3) : "null") + "}"
    + ",\"gyro\":{\"x\":"
    + (mpuConnected ? String(gx, 3) : "null")
    + ",\"y\":" + (mpuConnected ? String(gy, 3) : "null")
    + ",\"z\":" + (mpuConnected ? String(gz, 3) : "null") + "}"
    + ",\"linearAcceleration\":null"
    + ",\"chipTemp\":" + (mpuConnected ? String(tempC, 3) : "null")
    + ",\"sampleHz\":1"
    + ",\"aircraftVoltage\":" + aircraftVoltage
    + ",\"transmitterVoltage\":" + transmitterVoltage
    + ",\"radio\":{\"received\":" + String(receivedPackets)
    + ",\"expected\":" + String(expectedPackets)
    + ",\"retries\":0,\"packetAge\":" + String(packetAge)
    + ",\"rpd\":null}"
    + ",\"links\":{\"radio\":" + radioLink
    + ",\"uart\":" + radioLink
    + ",\"wifi\":" + wifiLink
    + ",\"uplink\":" + (cloudOnline ? "true" : "false") + "}"
    + ",\"wifiRssi\":" + wifiRssi
    + ",\"imu\":" + (mpuConnected ? "true" : "false")
    + ",\"armed\":null,\"mode\":\"Manual RC\""
    + ",\"inputs\":" + inputsJson()
    + ",\"outputs\":" + outputsJson()
    + ",\"mixEnabled\":" + (receiverOnline ? (mixEnabled ? "true" : "false") : "null")
    + ",\"configVersion\":1"
    + ",\"validity\":" + validityJson()
    + "}";

  String capabilities = String("{\"schemaVersion\":1,\"deviceId\":\"") + DEVICE_ID
    + "\",\"bootId\":\"" + bootId
    + "\",\"firmware\":{\"nano\":\"flight-deck-receiver/1.0\",\"node\":\"flight-deck-node/1.1\"}"
    + ",\"features\":{\"parachute\":false,\"parachuteFeedback\":false"
    + ",\"flightFailureDetection\":false,\"takeoffReadiness\":false"
    + ",\"attitude\":true,\"relativeYaw\":false,\"linearAcceleration\":false"
    + ",\"gps\":false,\"airspeed\":false,\"barometer\":false"
    + ",\"stabilization\":false,\"autopilot\":false,\"servoFeedback\":false"
    + ",\"flightMixTransitions\":false,\"transmitterBuzzerConfig\":false}"
    + ",\"commands\":[]"
    + ",\"maintenance\":{\"authorized\":false,\"expiresAt\":0}"
    + ",\"units\":{\"acceleration\":\"m/s2\",\"angularVelocity\":\"deg/s\""
    + ",\"attitude\":\"deg\",\"voltage\":\"V\",\"pwm\":\"us\"}}";

  return String("{\"frame\":") + frame + ",\"capabilities\":" + capabilities + "}";
}

bool cloudCredentialsConfigured() {
  return String(DEVICE_SHARED_TOKEN).length() >= 32
    && String(DEVICE_SHARED_TOKEN).indexOf("REPLACE_WITH") < 0
    && String(SUPABASE_TELEMETRY_URL).indexOf("YOUR_PROJECT") < 0;
}

void uploadCloudTelemetry() {
  cloudOnline = false;
  lastCloudAccepted = false;

  if (!cloudCredentialsConfigured()) return;
  if (WiFi.status() != WL_CONNECTED || backupAP) return;

  BearSSL::WiFiClientSecure client;

#if ALLOW_INSECURE_TLS_FOR_BENCH_TEST
  client.setInsecure();
#else
  // Add a verified CA certificate here before enabling field operation.
  return;
#endif

  HTTPClient http;
  http.setTimeout(2500);

  if (!http.begin(client, SUPABASE_TELEMETRY_URL)) return;

  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-token", DEVICE_SHARED_TOKEN);

  int code = http.POST(buildTelemetryPayload());
  cloudOnline = code == 200 || code == 409;
  lastCloudAccepted = code == 200;
  if (cloudOnline) cloudUploads++;
  http.end();
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(300);
  }

  if (WiFi.status() == WL_CONNECTED) {
    backupAP = false;
  } else {
    WiFi.disconnect();
    WiFi.mode(WIFI_AP);
    WiFi.softAP(BACKUP_AP, BACKUP_PASSWORD);
    backupAP = true;
  }
}

String ip() {
  return backupAP ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
}

void cors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
}

void root() {
  server.send_P(200, "text/html", PAGE);
}

void api() {
  cors();
  String j = "{";
  j += "\"device\":\"" + String(DEVICE_ID) + "\",";
  j += "\"ip\":\"" + ip() + "\",";
  j += "\"mpu\":{\"connected\":" + String(mpuConnected ? "true" : "false") + ",";
  j += "\"address\":\"0x" + String(mpuAddress, HEX) + "\",";
  j += "\"pitch\":" + String(pitch, 3) + ",";
  j += "\"roll\":" + String(roll, 3) + ",";
  j += "\"temperature\":" + String(tempC, 3) + "},";
  j += "\"battery\":{\"voltage_v\":";
  j += batteryMv ? String(batteryMv / 1000.0f, 3) : "null";
  j += "},\"receiver\":{\"online\":";
  j += String(receiverOnline ? "true" : "false");
  j += ",\"failsafe\":" + String((receiverFlags & 1) ? "true" : "false");
  j += ",\"mix_enabled\":" + String(mixEnabled ? "true" : "false");
  j += ",\"tx_voltage_v\":" + String(txBatteryMv / 1000.0f, 3) + "},";
  j += "\"cloud\":{\"online\":" + String(cloudOnline ? "true" : "false");
  j += ",\"last_accepted\":" + String(lastCloudAccepted ? "true" : "false");
  j += ",\"uploads\":" + String(cloudUploads) + "},";
  j += "\"uptime_ms\":" + String(millis()) + "}";
  server.send(200, "application/json", j);
}

void setup() {
  Wire.begin(D2, D1);
  Wire.setClock(400000);
  Serial.begin(38400);

  bootId = String("boot-") + String(ESP.getChipId(), HEX) + "-" + String(millis());

  if (detectMpu(0x68) || detectMpu(0x69)) {
    mpuConnected = true;
    setupMpu();
  }

  connectWiFi();
  server.on("/", HTTP_GET, root);
  server.on("/api/telemetry", HTTP_GET, api);
  server.begin();
  previousMicros = micros();
}

void loop() {
  readMpu();
  readBattery();
  processReceiver();

  if (millis() - lastReceiver > 1500) {
    receiverOnline = false;
    receiverFlags |= 1;
  }

  if (millis() - lastNodeSend >= 100) {
    lastNodeSend = millis();
    sendTelemetryToNano();
  }

  if (millis() - lastCloudSend >= CLOUD_INTERVAL_MS) {
    lastCloudSend = millis();
    uploadCloudTelemetry();
  }

  server.handleClient();
}
