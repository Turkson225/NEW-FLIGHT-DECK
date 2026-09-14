import {z} from 'npm:zod@3.25.76';
import type {Capabilities,Environment,Frame,Settings} from './flight.ts';

/** Additive v1 telemetry extension. Missing fields never mean healthy. */
export const safetySchema=z.object({
  schemaVersion:z.literal(1),
  flightFailure:z.boolean().nullable(),
  failureReason:z.string().max(250).nullable(),
  readyForTakeoff:z.boolean().nullable(),
  parachute:z.object({
    installed:z.boolean().nullable(),ready:z.boolean().nullable(),
    state:z.enum(['unknown','stowed','released','deployed','fault']),
    feedback:z.enum(['none','release_sensor','deployment_sensor'])
  }).nullable()
});
export type SafetyReport=z.infer<typeof safetySchema>;
export const preflightKeys=['battery','surfaces','mixing','orientation','mechanical','failsafe'] as const;
export const checklistComplete=(s:Settings)=>preflightKeys.every(k=>s.preflight[k]===true);
export const freshFrame=(f:Frame,now:number)=>f.receivedAt>0&&now>=f.receivedAt&&now-Math.min(f.receivedAt,f.sampledAt??f.receivedAt)<=2000;

export function sanitizeSafety(f:Frame,c:Capabilities|null):SafetyReport|null {
  if(!f.safety||!c||c.deviceId!==f.deviceId||c.bootId!==f.bootId||f.validity.safety!=='valid'||f.links.uart!==true||['invalid','unknown','unsupported','not_installed'].includes(f.validity.uart))return null;
  const report=structuredClone(f.safety);
  if(!c.features.flightFailureDetection){report.flightFailure=null;report.failureReason=null;}
  if(!c.features.takeoffReadiness)report.readyForTakeoff=null;
  if(!c.features.parachute)report.parachute=null;
  const p=report.parachute;
  if(p){
    if(p.installed!==true){p.ready=null;p.state='unknown';p.feedback='none';}
    if(!c.features.parachuteFeedback)p.feedback='none';
    // Actuator acknowledgment cannot prove a canopy opened.
    if(p.state==='deployed'&&p.feedback!=='deployment_sensor')p.state='unknown';
  }
  return report;
}
export function readyForTakeoff(f:Frame,s:Settings,c:Capabilities|null,now:number):boolean {
  const safety=sanitizeSafety(f,c);
  return (!safety?.parachute||safety.parachute.installed!==true||(safety.parachute.state==='stowed'&&safety.parachute.ready===true))&&freshFrame(f,now)&&checklistComplete(s)&&safety?.readyForTakeoff===true&&safety.flightFailure===false&&
    f.armed===false&&f.inputs!==null&&f.inputs.throttle<.03&&f.imu===true&&f.validity.imu==='valid'&&
    f.links.radio===true&&f.links.uart===true&&f.links.wifi===true&&f.links.uplink===true&&
    f.aircraftVoltage!==null&&f.aircraftVoltage>=s.aircraftBattery.warning&&
    f.transmitterVoltage!==null&&f.transmitterVoltage>=s.transmitterBattery.warning&&
    !['invalid','unknown','unsupported','not_installed'].includes(f.validity.battery)&&
    !['invalid','unknown','unsupported','not_installed'].includes(f.validity.aircraftBattery)&&
    !['invalid','unknown','unsupported','not_installed'].includes(f.validity.transmitterBattery);
}
export function recoveryLabel(f:Frame,c:Capabilities|null,now:number):string {
  if(!f.receivedAt)return 'Unknown';
  if(!freshFrame(f,now))return 'Stale';
  const p=sanitizeSafety(f,c)?.parachute;
  if(!p)return c&&!c.features.parachute?'Unsupported':'Unknown';
  if(p.installed===false)return 'Not installed';
  if(p.state==='deployed')return f.source==='DEMO'?'Deployed · simulator':'Deployment feedback confirmed';
  if(p.state==='released')return 'Release reported · deployment unconfirmed';
  if(p.state==='fault')return 'Recovery system fault';
  if(p.state==='stowed')return p.ready===true?'Stowed · reported ready':'Stowed · readiness unconfirmed';
  return 'Unknown';
}
export type RecoveryContext={environment:Environment;frame:Frame;capabilities:Capabilities|null;now:number;role?:string;authenticated:boolean;guardOpen:boolean;deployed:boolean};
export function parachuteRejection(x:RecoveryContext):string|null {
  if(x.environment==='REPLAY')return 'Replay cannot control aircraft or the simulator.';
  if(x.environment==='LIVE'){
    if(!x.authenticated||!['owner','operator'].includes(x.role??''))return 'Authenticated Owner or Operator access is required.';
    if(!freshFrame(x.frame,x.now))return 'Fresh aircraft telemetry is required.';
    if(!x.capabilities?.features.parachute||!x.capabilities.commands.includes('parachute.deploy'))return 'Installed firmware does not report parachute command support.';
    // Intentionally unconditional: this release has no validated live dispatch path.
    return 'Live parachute dispatch is disabled in this release. Onboard implementation and validation are required.';
  }
  if(x.frame.source!=='DEMO')return 'Wait for a simulator sample.';
  if(x.frame.deviceId!==x.capabilities?.deviceId||x.frame.bootId!==x.capabilities?.bootId)return 'Wait for telemetry from the selected simulator aircraft.';
  if(!freshFrame(x.frame,x.now))return 'Fresh simulator telemetry is required.';
  if(x.deployed||x.frame.safety?.parachute?.state==='deployed')return 'Parachute already deployed in this simulation.';
  if(!x.guardOpen)return 'Lift the protective cover first.';
  return null;
}
