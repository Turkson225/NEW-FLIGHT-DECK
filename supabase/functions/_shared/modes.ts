import {z} from 'npm:zod@3.25.76';
import type {Frame,Mixer} from './flight.ts';
export const surfaces=['leftAileron','rightAileron','elevator','rudder'] as const;
export type Surface=typeof surfaces[number];
export type Angles=Record<Surface,number>;
export const neutral:Angles={leftAileron:0,rightAileron:0,elevator:0,rudder:0};
const finite=z.number().finite();
const anglesSchema=z.object({leftAileron:finite.min(-45).max(45),rightAileron:finite.min(-45).max(45),elevator:finite.min(-45).max(45),rudder:finite.min(-45).max(45)});
const preset=z.object({angles:anglesSchema,transitionSeconds:finite.min(1).max(15)});
export const modeSchema=z.object({version:z.number().int().positive(),presets:z.object({cruise:preset,takeoff:preset,landing:preset}),travelDegrees:z.object({leftAileron:finite.min(1).max(45),rightAileron:finite.min(1).max(45),elevator:finite.min(1).max(45),rudder:finite.min(1).max(45)}),maxDegreesPerSecond:finite.min(1).max(30),startup:z.object({enabled:z.boolean(),delaySeconds:z.literal(5),amplitudeDegrees:finite.min(1).max(10)})});
export type ModeConfig=z.infer<typeof modeSchema>;
export type ModeName=keyof ModeConfig['presets'];
export const defaultModes:ModeConfig={version:1,presets:{cruise:{angles:{...neutral},transitionSeconds:3},takeoff:{angles:{...neutral},transitionSeconds:4},landing:{angles:{...neutral},transitionSeconds:5}},travelDegrees:{leftAileron:20,rightAileron:20,elevator:20,rudder:20},maxDegreesPerSecond:10,startup:{enabled:true,delaySeconds:5,amplitudeDegrees:5}};
const limit=(v:number,n:number)=>Math.max(-n,Math.min(n,v));
export function boundedAngles(a:Angles,c:ModeConfig):Angles{return Object.fromEntries(surfaces.map(s=>[s,limit(a[s],c.travelDegrees[s])])) as Angles}
export function transitionDuration(from:Angles,to:Angles,seconds:number,rate:number){return Math.max(seconds,...surfaces.map(s=>1.5*Math.abs(to[s]-from[s])/rate))}
export function interpolateAngles(from:Angles,to:Angles,elapsed:number,duration:number):Angles{const t=Math.max(0,Math.min(1,elapsed/duration)),blend=t*t*(3-2*t);return Object.fromEntries(surfaces.map(s=>[s,from[s]+(to[s]-from[s])*blend])) as Angles}
export function previewOutputs(frame:Frame,angles:Angles,c:ModeConfig,m:Mixer):Frame{const out={...frame,outputs:{}} as Frame;for(const s of surfaces){const ch=m.channels[s],n=limit(angles[s]/c.travelDegrees[s]*(ch.reverse?-1:1)+ch.trim,1),p=ch.center+n*(n<0?ch.center-ch.min:ch.max-ch.center)+ch.subtrim;out.outputs[s]={normalized:n,pwm:Math.round(Math.max(ch.min,Math.min(ch.max,p))),saturated:Math.abs(angles[s])>c.travelDegrees[s]||p<ch.min||p>ch.max}}return out}
export type StartupGate={enabled:boolean;disarmed:boolean;throttleLow:boolean;localAuthorized:boolean;stationary:boolean;radioOverride:boolean;fresh:boolean};
export function startupAllowed(g:StartupGate){return g.enabled&&g.disarmed&&g.throttleLow&&g.localAuthorized&&g.stationary&&!g.radioOverride&&g.fresh}
export function startupAngles(elapsed:number,c:ModeConfig):Angles{if(elapsed<=5||elapsed>=13)return {...neutral};const t=(elapsed-5)/8,a=c.startup.amplitudeDegrees*Math.sin(t*2*Math.PI)**3;return boundedAngles({leftAileron:a,rightAileron:-a,elevator:a,rudder:a},c)}
