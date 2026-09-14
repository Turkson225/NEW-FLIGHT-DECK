/*
 FLIGHT DECK aircraft NodeMCU
 MPU6050: SDA D2, SCL D1
 A0: verified aircraft battery divider
 RX/TX: receiver Nano UART through bidirectional level shifter
 This board monitors; receiver Nano owns flight control and failsafe.
*/
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <Wire.h>
#include <math.h>

const char* WIFI_SSID="YOUR_2_4_GHZ_HOTSPOT";
const char* WIFI_PASSWORD="YOUR_WIFI_PASSWORD";
const char* BACKUP_AP="FLIGHT_DECK_NODE";
const char* BACKUP_PASSWORD="12345678";

const float DIVIDER_RATIO=4.0f; // Measure and calibrate
const float ADC_REFERENCE=3.3f;

ESP8266WebServer server(80);
uint8_t mpuAddress=0;
bool mpuConnected=false, backupAP=false, receiverOnline=false;
float ax=0,ay=0,az=0,gx=0,gy=0,gz=0,tempC=0,pitch=0,roll=0;
float filteredPitch=0,filteredRoll=0;
uint16_t batteryMv=0,txBatteryMv=0;
uint8_t receiverFlags=1,mixEnabled=0;
unsigned long lastReceiver=0,lastNodeSend=0,previousMicros=0;

struct __attribute__((packed)) ReceiverStatus {
  uint16_t sequence;
  int16_t elevator,rudder,leftAileron,rightAileron;
  uint16_t throttle;
  uint8_t mixEnabled,failsafe,parachuteEvent;
  uint16_t txBatteryMv;
};

struct __attribute__((packed)) NodeTelemetry {
  uint16_t batteryMv;
  int16_t pitchCdeg,rollCdeg,temperatureCdeg;
  uint8_t flags;
};

const char PAGE[] PROGMEM=R"rawliteral(
<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FLIGHT DECK NODE</title><style>
body{font-family:Arial;background:#0b1118;color:#eef4f7;margin:20px}
h1{color:#c6f36b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.card{background:#121b24;border:1px solid #293744;border-radius:10px;padding:16px}
.label{font-size:11px;color:#8b9aa8}.value{font-size:24px;color:#c6f36b;margin-top:8px}
</style></head><body><h1>FLIGHT DECK AIRCRAFT NODE</h1>
<p id="state">Reading...</p><div class="grid">
<div class="card"><div class="label">PITCH</div><div class="value" id="pitch">--</div></div>
<div class="card"><div class="label">ROLL</div><div class="value" id="roll">--</div></div>
<div class="card"><div class="label">BATTERY</div><div class="value" id="battery">--</div></div>
<div class="card"><div class="label">TEMPERATURE</div><div class="value" id="temp">--</div></div>
<div class="card"><div class="label">RECEIVER</div><div class="value" id="rx">--</div></div>
<div class="card"><div class="label">FAILSAFE</div><div class="value" id="fs">--</div></div>
</div><script>
async function refresh(){try{let d=await (await fetch('/api/telemetry')).json();
document.getElementById('state').textContent='Node IP: '+d.ip;
document.getElementById('pitch').textContent=d.mpu.connected?d.mpu.pitch.toFixed(2)+'°':'Unknown';
document.getElementById('roll').textContent=d.mpu.connected?d.mpu.roll.toFixed(2)+'°':'Unknown';
document.getElementById('battery').textContent=d.battery.voltage_v===null?'Unknown':d.battery.voltage_v.toFixed(2)+' V';
document.getElementById('temp').textContent=d.mpu.connected?d.mpu.temperature.toFixed(2)+' °C':'Unknown';
document.getElementById('rx').textContent=d.receiver.online?'ONLINE':'STALE';
document.getElementById('fs').textContent=d.receiver.failsafe?'ACTIVE':'CLEAR';
}catch(e){document.getElementById('state').textContent='Connection error'}}
setInterval(refresh,500);refresh();
</script></body></html>
)rawliteral";

void writeReg(uint8_t r,uint8_t v){Wire.beginTransmission(mpuAddress);Wire.write(r);Wire.write(v);Wire.endTransmission();}
uint8_t readReg(uint8_t r){Wire.beginTransmission(mpuAddress);Wire.write(r);Wire.endTransmission(false);Wire.requestFrom((int)mpuAddress,1);return Wire.available()?Wire.read():0;}

bool detectMpu(uint8_t address){
  mpuAddress=address; Wire.beginTransmission(mpuAddress);
  if(Wire.endTransmission()!=0)return false;
  return readReg(0x75)==0x68;
}

void setupMpu(){writeReg(0x6B,0);delay(100);writeReg(0x1B,0);writeReg(0x1C,0);writeReg(0x1A,3);}

void readMpu(){
  if(!mpuConnected)return;
  Wire.beginTransmission(mpuAddress);Wire.write(0x3B);
  if(Wire.endTransmission(false)!=0){mpuConnected=false;return;}
  if(Wire.requestFrom((int)mpuAddress,14)!=14){mpuConnected=false;return;}

  int16_t rax=(Wire.read()<<8)|Wire.read();
  int16_t ray=(Wire.read()<<8)|Wire.read();
  int16_t raz=(Wire.read()<<8)|Wire.read();
  int16_t rt=(Wire.read()<<8)|Wire.read();
  int16_t rgx=(Wire.read()<<8)|Wire.read();
  int16_t rgy=(Wire.read()<<8)|Wire.read();
  int16_t rgz=(Wire.read()<<8)|Wire.read();

  ax=rax/16384.0f*9.80665f; ay=ray/16384.0f*9.80665f; az=raz/16384.0f*9.80665f;
  gx=rgx/131.0f; gy=rgy/131.0f; gz=rgz/131.0f; tempC=rt/340.0f+36.53f;

  float p=atan2(ay,sqrt(ax*ax+az*az))*180.0f/PI;
  float r=atan2(-ax,az)*180.0f/PI;
  unsigned long now=micros(); float dt=(now-previousMicros)/1000000.0f; previousMicros=now;

  if(dt>0 && dt<1){filteredPitch=0.98f*(filteredPitch+gx*dt)+0.02f*p;filteredRoll=0.98f*(filteredRoll+gy*dt)+0.02f*r;}
  pitch=filteredPitch; roll=filteredRoll;
}

void readBattery(){
  int raw=analogRead(A0);
  if(raw>=1020){batteryMv=0;return;}
  float pinV=raw*ADC_REFERENCE/1023.0f;
  if(pinV>=3.2f){batteryMv=0;return;}
  batteryMv=(uint16_t)constrain((long)(pinV*DIVIDER_RATIO*1000.0f),0L,65535L);
}

uint8_t crc(const uint8_t* data,uint8_t len){uint8_t c=0;for(uint8_t i=0;i<len;i++)c^=data[i];return c;}

void sendFrame(uint8_t type,const uint8_t* data,uint8_t len){
  Serial.write(0xFD);Serial.write(type);Serial.write(len);Serial.write(data,len);Serial.write(crc(data,len));
}

bool receiveFrame(uint8_t& type,uint8_t* data,uint8_t maxLen,uint8_t& len){
  static uint8_t state=0,t=0,n=0,pos=0,c=0;
  while(Serial.available()){
    uint8_t b=Serial.read();
    if(state==0){if(b==0xFD)state=1;}
    else if(state==1){t=b;state=2;}
    else if(state==2){n=b;pos=0;c=0;if(n>maxLen)state=0;else state=n?3:4;}
    else if(state==3){data[pos++]=b;c^=b;if(pos>=n)state=4;}
    else{state=0;if(c==b){type=t;len=n;return true;}}
  }
  return false;
}

void processReceiver(){
  uint8_t type,len,data[32];
  if(!receiveFrame(type,data,sizeof(data),len))return;
  if(type==0x10 && len==sizeof(ReceiverStatus)){
    ReceiverStatus s{};memcpy(&s,data,sizeof(s));
    txBatteryMv=s.txBatteryMv;mixEnabled=s.mixEnabled;receiverFlags=0;
    if(s.failsafe)receiverFlags|=1;
    receiverOnline=true;lastReceiver=millis();
  }
}

void sendTelemetry(){
  NodeTelemetry t{};
  t.batteryMv=batteryMv;
  t.pitchCdeg=(int16_t)constrain((long)(pitch*100),-32768L,32767L);
  t.rollCdeg=(int16_t)constrain((long)(roll*100),-32768L,32767L);
  t.temperatureCdeg=(int16_t)constrain((long)(tempC*100),-32768L,32767L);
  if(mpuConnected)t.flags|=1;if(batteryMv)t.flags|=2;
  sendFrame(0x20,reinterpret_cast<uint8_t*>(&t),sizeof(t));
}

void connectWiFi(){
  WiFi.mode(WIFI_STA);WiFi.begin(WIFI_SSID,WIFI_PASSWORD);
  unsigned long start=millis();
  while(WiFi.status()!=WL_CONNECTED && millis()-start<15000)delay(300);
  if(WiFi.status()==WL_CONNECTED)backupAP=false;
  else{WiFi.disconnect();WiFi.mode(WIFI_AP);WiFi.softAP(BACKUP_AP,BACKUP_PASSWORD);backupAP=true;}
}

String ip(){return backupAP?WiFi.softAPIP().toString():WiFi.localIP().toString();}

void cors(){server.sendHeader("Access-Control-Allow-Origin","*");}

void root(){server.send_P(200,"text/html",PAGE);}

void api(){
  cors();String j="{";
  j+="\"device\":\"FD-001\",\"ip\":\""+ip()+"\",";
  j+="\"mpu\":{\"connected\":"+String(mpuConnected?"true":"false")+",";
  j+="\"address\":\"0x"+String(mpuAddress,HEX)+"\",\"pitch\":"+String(pitch,3)+",";
  j+="\"roll\":"+String(roll,3)+",\"temperature\":"+String(tempC,3)+"},";
  j+="\"battery\":{\"voltage_v\":";
  j+=(batteryMv?String(batteryMv/1000.0f,3):"null");
  j+="},\"receiver\":{\"online\":"+String(receiverOnline?"true":"false")+",";
  j+="\"failsafe\":"+String((receiverFlags&1)?"true":"false")+",";
  j+="\"mix_enabled\":"+String(mixEnabled?"true":"false")+",";
  j+="\"tx_voltage_v\":"+String(txBatteryMv/1000.0f,3)+"},";
  j+="\"uptime_ms\":"+String(millis())+"}";
  server.send(200,"application/json",j);
}

void setup(){
  Wire.begin(D2,D1);Wire.setClock(400000);Serial.begin(38400);
  if(detectMpu(0x68)||detectMpu(0x69)){mpuConnected=true;setupMpu();}
  connectWiFi();server.on("/",HTTP_GET,root);server.on("/api/telemetry",HTTP_GET,api);server.begin();
  previousMicros=micros();
}

void loop(){
  readMpu();readBattery();processReceiver();
  if(millis()-lastReceiver>1500){receiverOnline=false;receiverFlags|=1;}
  if(millis()-lastNodeSend>=100){lastNodeSend=millis();sendTelemetry();}
  server.handleClient();
}

