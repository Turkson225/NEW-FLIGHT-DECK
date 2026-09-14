/*
 FLIGHT DECK transmitter Nano
 RF24 library by TMRh20 is required.

 CH1 elevator = joystick 1 Y
 CH2 rudder = joystick 1 X
 CH3 left aileron = joystick 2 X
 CH4 right aileron = joystick 2 Y
 CH5 throttle = slider
 CH6/CH7 = potentiometers
 CH8 = parachute event
 D2/D3 = mix ON/OFF, D4 = parachute, D5 = spare
*/
#include <SPI.h>
#include <nRF24L01.h>
#include <RF24.h>

RF24 radio(9, 10);
const byte ADDRESS[6] = "FD001";

const uint8_t MIX_ON=2, MIX_OFF=3, PARACHUTE=4, SPARE=5;
const uint8_t LINK_LED=6, BUZZER=7, MIX_LED=8;
const float TX_DIVIDER_RATIO=2.0f;
const float LOW_BATTERY_V=7.0f;

struct __attribute__((packed)) ControlPacket {
  uint8_t version;
  uint16_t sequence;
  int16_t elevator;
  int16_t rudder;
  int16_t leftAileron;
  int16_t rightAileron;
  uint16_t throttle;
  uint16_t pot1;
  uint16_t pot2;
  uint8_t mixEnabled;
  uint8_t parachuteEvent;
  uint8_t spareEvent;
  uint16_t txBatteryMv;
};

struct __attribute__((packed)) TelemetryPacket {
  uint8_t version;
  uint16_t sequence;
  uint16_t rxBatteryMv;
  uint16_t txBatteryMv;
  int16_t pitchCdeg;
  int16_t rollCdeg;
  int16_t temperatureCdeg;
  uint8_t mixConfirmed;
  uint8_t flags;
  uint8_t parachuteReported;
};

struct Button {
  uint8_t pin;
  bool stable;
  bool lastRaw;
  unsigned long changed;

  void begin(uint8_t p) {
    pin=p; pinMode(pin, INPUT_PULLUP);
    stable=false; lastRaw=false; changed=millis();
  }

  bool pressedEvent() {
    bool raw=digitalRead(pin)==LOW;
    if(raw!=lastRaw) { lastRaw=raw; changed=millis(); }
    if(millis()-changed>25 && raw!=stable) {
      stable=raw;
      return stable;
    }
    return false;
  }

  bool held() { return stable; }
};

ControlPacket packet{};
TelemetryPacket telemetry{};
Button bMixOn,bMixOff,bParachute,bSpare;
bool mixEnabled=false, linkLost=true, lowBattery=false;
uint8_t parachuteEvent=0, spareEvent=0;
uint16_t sequence=0;
unsigned long lastSend=0, lastAck=0, lastAlert=0;

int16_t axis(uint8_t pin) {
  long v=map(analogRead(pin),0,1023,-1000,1000);
  if(abs(v)<35) v=0;
  return constrain(v,-1000,1000);
}

uint16_t level(uint8_t pin) {
  return constrain(map(analogRead(pin),0,1023,0,1000),0,1000);
}

float txVoltage() {
  return analogRead(A7)*5.0f/1023.0f*TX_DIVIDER_RATIO;
}

void beep(uint16_t hz,uint16_t ms) { tone(BUZZER,hz,ms); }

void buttons() {
  if(bMixOn.pressedEvent() && !bMixOff.held()) { mixEnabled=true; beep(1700,70); }
  if(bMixOff.pressedEvent() && !bMixOn.held()) { mixEnabled=false; beep(1000,70); }

  if(bParachute.pressedEvent()) {
    parachuteEvent++;
    if(parachuteEvent==0) parachuteEvent=1;
    beep(2200,120);
  }

  if(bSpare.pressedEvent()) {
    spareEvent++;
    if(spareEvent==0) spareEvent=1;
    beep(1300,70);
  }
}

void fillPacket() {
  float v=txVoltage();
  packet.version=1;
  packet.sequence=sequence++;
  packet.elevator=axis(A1);
  packet.rudder=axis(A0);
  packet.leftAileron=axis(A2);
  packet.rightAileron=axis(A3);
  packet.throttle=level(A6);
  packet.pot1=level(A4);
  packet.pot2=level(A5);
  packet.mixEnabled=mixEnabled;
  packet.parachuteEvent=parachuteEvent;
  packet.spareEvent=spareEvent;
  packet.txBatteryMv=(uint16_t)constrain((long)(v*1000.0f),0L,65535L);
  lowBattery=(v>0.1f && v<LOW_BATTERY_V);
}

void readTelemetry() {
  if(radio.isAckPayloadAvailable()) {
    radio.read(&telemetry,sizeof(telemetry));
    if(telemetry.version==1) lastAck=millis();
  }
}

void setupRadio() {
  if(!radio.begin()) {
    beep(300,1000);
    while(true) digitalWrite(LINK_LED,(millis()/150)%2);
  }
  radio.setChannel(108);
  radio.setDataRate(RF24_250KBPS);
  radio.setPALevel(RF24_PA_HIGH);
  radio.setRetries(3,5);
  radio.setAutoAck(true);
  radio.enableAckPayload();
  radio.openWritingPipe(ADDRESS);
  radio.openReadingPipe(1,ADDRESS);
  radio.stopListening();
}

void alerts() {
  bool lost=millis()-lastAck>900;
  if(lost!=linkLost) {
    linkLost=lost;
    beep(lost?650:1800,lost?350:80);
    lastAlert=millis();
  }

  if(lowBattery && millis()-lastAlert>5000) {
    beep(500,180); lastAlert=millis();
  }

  digitalWrite(MIX_LED,mixEnabled);
  digitalWrite(LINK_LED,linkLost ? (millis()/300)%2 : HIGH);
}

void setup() {
  pinMode(LINK_LED,OUTPUT); pinMode(MIX_LED,OUTPUT); pinMode(BUZZER,OUTPUT);
  bMixOn.begin(MIX_ON); bMixOff.begin(MIX_OFF);
  bParachute.begin(PARACHUTE); bSpare.begin(SPARE);
  setupRadio();
  beep(1600,100); delay(140); beep(2100,120);
  lastAck=millis();
}

void loop() {
  buttons();

  if(millis()-lastSend>=40) {
    lastSend=millis();
    fillPacket();
    if(radio.write(&packet,sizeof(packet))) lastAck=millis();
    readTelemetry();
  }

  alerts();
}

