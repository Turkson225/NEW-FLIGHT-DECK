/*
 FLIGHT DECK receiver Nano
 D2 left aileron, D3 right aileron, D4 elevator, D5 rudder,
 D6 ESC, D8 parachute servo (locked by default).
 D0/D1 are binary UART to NodeMCU through a level shifter.
*/
#include <SPI.h>
#include <nRF24L01.h>
#include <RF24.h>
#include <Servo.h>

RF24 radio(9,10);
const byte ADDRESS[6]="FD001";
const uint8_t FAILSAFE_MS=600;
const bool PARACHUTE_OUTPUT_ENABLED=false;
const uint8_t CHUTE_SAFE=0, CHUTE_RELEASE=90;

struct __attribute__((packed)) ControlPacket {
  uint8_t version; uint16_t sequence;
  int16_t elevator, rudder, leftAileron, rightAileron;
  uint16_t throttle, pot1, pot2;
  uint8_t mixEnabled, parachuteEvent, spareEvent;
  uint16_t txBatteryMv;
};

struct __attribute__((packed)) TelemetryPacket {
  uint8_t version; uint16_t sequence;
  uint16_t rxBatteryMv, txBatteryMv;
  int16_t pitchCdeg, rollCdeg, temperatureCdeg;
  uint8_t mixConfirmed, flags, parachuteReported;
};

struct __attribute__((packed)) NodeTelemetry {
  uint16_t batteryMv;
  int16_t pitchCdeg, rollCdeg, temperatureCdeg;
  uint8_t flags;
};

struct __attribute__((packed)) ReceiverStatus {
  uint16_t sequence;
  int16_t elevator, rudder, leftAileron, rightAileron;
  uint16_t throttle;
  uint8_t mixEnabled, failsafe, parachuteEvent;
  uint16_t txBatteryMv;
};

Servo leftServo,rightServo,elevatorServo,rudderServo,escServo,chuteServo;
ControlPacket command{};
TelemetryPacket telemetry{};
NodeTelemetry node{};
bool failsafe=true, nodeOnline=false;
uint8_t lastChuteEvent=0;
uint16_t telemetrySequence=0;
unsigned long lastPacket=0,lastNode=0,lastNodeFrame=0;

uint8_t checksum(const uint8_t* data,uint8_t len) {
  uint8_t c=0; for(uint8_t i=0;i<len;i++) c^=data[i]; return c;
}

void sendFrame(uint8_t type,const uint8_t* data,uint8_t len) {
  Serial.write(0xFD); Serial.write(type); Serial.write(len);
  Serial.write(data,len); Serial.write(checksum(data,len));
}

bool receiveFrame(uint8_t& type,uint8_t* data,uint8_t maxLen,uint8_t& len) {
  static uint8_t state=0,t=0,n=0,pos=0,c=0;
  while(Serial.available()) {
    uint8_t b=Serial.read();
    if(state==0) { if(b==0xFD) state=1; }
    else if(state==1) { t=b; state=2; }
    else if(state==2) {
      n=b; pos=0; c=0;
      if(n>maxLen) state=0; else state=n?3:4;
    }
    else if(state==3) {
      data[pos++]=b; c^=b; if(pos>=n) state=4;
    }
    else {
      state=0;
      if(c==b) { type=t; len=n; return true; }
    }
  }
  return false;
}

void processNodeUart() {
  uint8_t type,len,data[32];
  if(!receiveFrame(type,data,sizeof(data),len)) return;
  if(type==0x20 && len==sizeof(NodeTelemetry)) {
    memcpy(&node,data,sizeof(node));
    nodeOnline=true; lastNode=millis();
  }
}

void sendStatusToNode() {
  ReceiverStatus s{};
  s.sequence=telemetrySequence++;
  s.elevator=command.elevator; s.rudder=command.rudder;
  s.leftAileron=command.leftAileron; s.rightAileron=command.rightAileron;
  s.throttle=command.throttle; s.mixEnabled=command.mixEnabled;
  s.failsafe=failsafe; s.parachuteEvent=command.parachuteEvent;
  s.txBatteryMv=command.txBatteryMv;
  sendFrame(0x10,reinterpret_cast<uint8_t*>(&s),sizeof(s));
}

uint16_t signedPulse(int16_t value) {
  value=constrain(value,-1000,1000);
  return (uint16_t)constrain(map(value,-1000,1000,1000,2000),1000,2000);
}

uint16_t throttlePulse(uint16_t value) {
  return (uint16_t)constrain(map(constrain(value,0,1000),0,1000,1000,2000),1000,2000);
}

void safeOutputs() {
  leftServo.writeMicroseconds(1500);
  rightServo.writeMicroseconds(1500);
  elevatorServo.writeMicroseconds(1500);
  rudderServo.writeMicroseconds(1500);
  escServo.writeMicroseconds(1000);
}

void applyOutputs() {
  if(failsafe) { safeOutputs(); return; }

  if(!command.mixEnabled) {
    leftServo.writeMicroseconds(signedPulse(command.leftAileron));
    rightServo.writeMicroseconds(signedPulse(command.rightAileron));
  } else {
    // Mixed mode: CH3 is roll, CH4 is common/flaperon.
    int16_t roll=command.leftAileron;
    int16_t common=command.rightAileron;
    leftServo.writeMicroseconds(signedPulse(constrain(common+roll,-1000,1000)));
    rightServo.writeMicroseconds(signedPulse(constrain(common-roll,-1000,1000)));
  }

  elevatorServo.writeMicroseconds(signedPulse(command.elevator));
  rudderServo.writeMicroseconds(signedPulse(command.rudder));
  escServo.writeMicroseconds(throttlePulse(command.throttle));
}

void parachuteRequest() {
  if(command.parachuteEvent==lastChuteEvent) return;
  lastChuteEvent=command.parachuteEvent;

  if(PARACHUTE_OUTPUT_ENABLED && !failsafe) {
    chuteServo.write(CHUTE_RELEASE);
    telemetry.parachuteReported=1;
  } else {
    telemetry.parachuteReported=2; // received but locked
  }
}

void updateTelemetry() {
  telemetry.version=1;
  telemetry.sequence=telemetrySequence++;
  telemetry.rxBatteryMv=node.batteryMv;
  telemetry.txBatteryMv=command.txBatteryMv;
  telemetry.pitchCdeg=node.pitchCdeg;
  telemetry.rollCdeg=node.rollCdeg;
  telemetry.temperatureCdeg=node.temperatureCdeg;
  telemetry.mixConfirmed=command.mixEnabled;
  telemetry.flags=0;
  if(failsafe) telemetry.flags|=0x01;
  if(nodeOnline) telemetry.flags|=0x02;
  if(command.spareEvent) telemetry.flags|=0x04;
}

void queueAck() {
  radio.writeAckPayload(1,&telemetry,sizeof(telemetry));
}

void processRadio() {
  while(radio.available()) {
    ControlPacket incoming{};
    radio.read(&incoming,sizeof(incoming));

    if(incoming.version!=1) continue;

    command=incoming;
    failsafe=false;
    lastPacket=millis();
    parachuteRequest();
    applyOutputs();
    updateTelemetry();
    queueAck();
  }
}

void failsafeUpdate() {
  if(millis()-lastPacket>FAILSAFE_MS && !failsafe) {
    failsafe=true;
    safeOutputs();
    updateTelemetry();
    queueAck();
  }

  if(millis()-lastNode>1200) nodeOnline=false;
}

void setup() {
  leftServo.attach(2); rightServo.attach(3);
  elevatorServo.attach(4); rudderServo.attach(5);
  escServo.attach(6); chuteServo.attach(8);
  chuteServo.write(CHUTE_SAFE);
  safeOutputs();

  Serial.begin(38400);
  radio.begin();
  radio.setChannel(108);
  radio.setDataRate(RF24_250KBPS);
  radio.setPALevel(RF24_PA_HIGH);
  radio.setAutoAck(true);
  radio.enableAckPayload();
  radio.openReadingPipe(1,ADDRESS);
  radio.startListening();

  lastPacket=millis(); lastNode=millis();
  updateTelemetry(); queueAck();
}

void loop() {
  processRadio();
  processNodeUart();
  failsafeUpdate();

  if(millis()-lastNodeFrame>=100) {
    lastNodeFrame=millis();
    sendStatusToNode();
  }
}

