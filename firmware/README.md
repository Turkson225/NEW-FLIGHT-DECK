# FLIGHT DECK firmware

## Confirmed channel map

| Channel | Function |
| --- | --- |
| CH1 | Elevator, Joystick 1 Y |
| CH2 | Rudder, Joystick 1 X |
| CH3 | Left aileron, Joystick 2 X |
| CH4 | Right aileron, Joystick 2 Y |
| CH5 | Throttle slider |
| CH6 | Potentiometer 1 |
| CH7 | Potentiometer 2 |
| CH8 | Parachute request event |
| Spare | Discrete event flag in the radio packet |

The mix buttons are latched state requests. The parachute and spare buttons are event counters.

## Files

- FlightDeck_Transmitter/FlightDeck_Transmitter.ino
- FlightDeck_Receiver/FlightDeck_Receiver.ino
- FlightDeck_Node/FlightDeck_Node.ino

## Upload order

1. Remove the propeller and isolate ESC and parachute power.
2. Upload the receiver Nano sketch.
3. Upload the transmitter Nano sketch.
4. Upload the NodeMCU sketch.
5. Test the radio link and receiver failsafe on a bench.

## Libraries

Nano:

- RF24 by TMRh20
- Servo, included with the Arduino AVR board package

NodeMCU:

- ESP8266 board package
- ESP8266WiFi
- ESP8266WebServer
- Wire

## Pin summary

Both nRF24 modules:

- CE D9
- CSN D10
- MOSI D11
- MISO D12
- SCK D13

Receiver Nano:

- D2 left aileron
- D3 right aileron
- D4 elevator
- D5 rudder
- D6 ESC
- D8 parachute servo, locked in the current firmware
- D0/D1 binary UART to NodeMCU

NodeMCU:

- D1/GPIO5 MPU6050 SCL
- D2/GPIO4 MPU6050 SDA
- A0 verified aircraft battery divider
- RX/TX to receiver Nano through a bidirectional level shifter

## Mixing

Independent mode sends CH3 directly to the left aileron and CH4 directly to the right aileron.

Mixed mode treats CH3 as roll and CH4 as common/flaperon:

- left output = common + roll
- right output = common - roll

## Safety

The receiver owns radio-loss behavior. When the radio link is lost, the control surfaces return to neutral and the ESC returns to its safe pulse.

The parachute request is received and reported, but the parachute output is disabled by default. Do not enable it until the mechanism, safe position, release position, independent power, local arming procedure, and physical deployment have been validated.

The NodeMCU is for monitoring and telemetry. Internet connectivity must not be required for flight control.

## Battery calibration

Change the divider constants only after measuring the divider output with a multimeter:

- TX_DIVIDER_RATIO in the transmitter sketch
- DIVIDER_RATIO in the NodeMCU sketch

Never connect a battery directly to Nano A7 or NodeMCU A0.

The NodeMCU local telemetry endpoint is:

    http://NODEMCU_IP/api/telemetry

A public HTTPS GitHub Pages dashboard should use an authenticated HTTPS telemetry gateway rather than directly fetching the local HTTP IP.

