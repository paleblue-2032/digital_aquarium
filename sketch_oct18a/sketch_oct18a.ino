#include <Arduino.h>
#include <Wire.h>
#include <MMA8653.h> 
#include <Studuino.h>

Studuino st;

const int TOUCH_SENSOR_PORT = PORT_A0;
const int ACCEL_X_PORT      = PORT_A4;
const int ACCEL_Y_PORT      = PORT_A5;

void setup() {  
  Serial.begin(9600);
  st.InitI2CPort(PIDACCELEROMETER);  
  st.InitSensorPort(TOUCH_SENSOR_PORT, PIDPUSHSWITCH); 
}

void loop() {
  int x_val = st.GetAccelerometerValue(X_AXIS);
  int y_val = st.GetAccelerometerValue(Y_AXIS);
  byte touch_val = st.GetPushSwitchValue(TOUCH_SENSOR_PORT);

  Serial.print("STICK,");
  Serial.print(x_val);
  Serial.print(",");
  Serial.print(y_val);
  Serial.print(",");
  Serial.println(touch_val == 0 ? 0 : 1);

  delay(50);
}
