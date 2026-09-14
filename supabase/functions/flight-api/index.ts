import {createClient} from 'npm:@supabase/supabase-js@2.116.0';
import {z} from 'npm:zod@3.25.76';
import {settingsSchema,recordingSchema,eventSchema,commandSchema} from '../_shared/contracts.ts';
const service=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
const allowed=(Deno.env.get('ALLOWED_ORIGINS')??'').split(',').map(x=>x.trim());
function checked<T>(r:{data:T;error:unknown}){if(r.error)throw Error('Database operation failed');return r.data}
Deno.serve(async req=>{
 const origin=req.headers.get('origin')??'',cors={'Access-Control-Allow-Origin':allowed.includes(origin)?origin:'null','Vary':'Origin','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'};
 const result=(data:unknown,status=200)=>Response.json({status,data},{headers:cors});
 const fail=(error:string,status:number)=>Response.json({error},{status,headers:cors});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 if(req.method!=='POST'||!allowed.includes(origin))return fail('Origin or method not allowed',403);
 try{
 const token=req.headers.get('authorization')?.replace(/^Bearer /i,'');if(!token)return fail('Sign in required',401);
 const {data:{user},error}=await service.auth.getUser(token);if(error||!user?.email_confirmed_at)return fail('Verified email required',401);
 const raw=await req.text();if(raw.length>25000000)return fail('Request too large',413);
 const input=z.object({resource:z.string(),method:z.enum(['GET','POST','PUT']),workspace:z.string().uuid().optional(),query:z.record(z.string()).default({}),body:z.unknown().nullable()}).parse(JSON.parse(raw));
 const w=input.workspace??user.id,{resource,method,query}=input;
 const member=checked(await service.from('fd_members').select('role').eq('workspace_id',w).eq('user_id',user.id).maybeSingle());if(!member)return fail('No access to this workspace',403);
 if(method!=='GET'&&!['owner','operator'].includes(member.role))return fail('Viewer access is read-only',403);
 const rows=async(kind:string)=>checked(await service.from('fd_records').select('id,payload').eq('workspace_id',w).eq('kind',kind).order('updated_at',{ascending:false}).limit(250));
 const get=async(kind:string,id:string)=>checked(await service.from('fd_records').select('payload').eq('workspace_id',w).eq('kind',kind).eq('id',id).maybeSingle())?.payload;
 const put=async(kind:string,id:string,payload:unknown)=>checked(await service.from('fd_records').upsert({workspace_id:w,kind,id,payload,updated_at:new Date().toISOString()},{onConflict:'workspace_id,kind,id'}));
 if(resource==='workspace'&&method==='GET')return result({account:{authenticated:true,user:{userId:user.id,displayName:user.email},role:member.role,workspace:w},settings:await get('settings','current')??null,recordings:(await rows('recordings')).map(r=>({...r.payload,frames:[],events:[],saved:true}))});
 if(resource==='workspace'&&method==='PUT'){const d=z.object({settings:settingsSchema}).parse(input.body);await put('settings','current',d.settings);return result({saved:true})}
 if(resource==='profiles'&&method==='GET')return result((await rows('profiles')).map(r=>r.payload));
 if(resource==='profiles'&&method==='POST'){const d=z.object({id:z.string().uuid(),name:z.string().min(1).max(80),settings:settingsSchema}).parse(input.body);await put('profiles',d.id,d);return result({saved:true})}
 if(resource==='recordings'&&method==='POST'){const d=recordingSchema.parse(input.body),key=`${w}/${d.id}.json`;checked(await service.storage.from('flight-recordings').upload(key,JSON.stringify(d),{contentType:'application/json',upsert:true}));const {frames,events,...metadata}=d;await put('recordings',d.id,{...metadata,sampleCount:frames.length,objectKey:key});return result({saved:true})}
 if(resource==='recordings'&&method==='GET'){const metadata=await get('recordings',z.string().uuid().parse(query.id));if(!metadata)return fail('Recording not found',404);const blob=checked(await service.storage.from('flight-recordings').download(metadata.objectKey));return result(JSON.parse(await blob.text()))}
 if(resource==='alerts'&&method==='GET')return result((await rows('alerts')).map(r=>r.payload));
 if(resource==='alerts'&&method==='POST'){const events=query.batch==='1'?z.object({events:z.array(eventSchema).min(1).max(250)}).parse(input.body).events:[eventSchema.parse(input.body)];if(new Set(events.map(e=>e.id)).size!==events.length)return fail('Duplicate event IDs',400);checked(await service.from('fd_records').upsert(events.map(e=>({workspace_id:w,kind:'alerts',id:e.id,payload:e,updated_at:new Date().toISOString()})),{onConflict:'workspace_id,kind,id'}));return result({saved:true})}
 if(resource==='telemetry'&&method==='GET'){const id=z.string().min(1).max(80).parse(query.aircraftId);const row=checked(await service.from('fd_telemetry').select('frame,capabilities').eq('workspace_id',w).eq('device_id',id).maybeSingle());return result({frame:row?.frame??null,capabilities:row?.capabilities??null,hardwareCommandsEnabled:false})}
 if(resource==='members'&&method==='POST'){if(member.role!=='owner')return fail('Owner required',403);const d=z.object({userId:z.string().uuid(),role:z.enum(['operator','viewer'])}).parse(input.body);if(d.userId===w)return fail('Cannot change owner role',400);const {data:{user:target}}=await service.auth.admin.getUserById(d.userId);if(!target?.email_confirmed_at)return fail('Member must verify their email first',404);checked(await service.from('fd_members').upsert({workspace_id:w,user_id:d.userId,role:d.role}));return result({saved:true,workspace:w})}
 if(resource==='commands'&&method==='GET')return result((await rows('commands')).map(r=>r.payload));
 if(resource==='commands'&&method==='POST'){const c=commandSchema.parse(input.body),reason='Live actuator transport is disabled. Device enforcement is not validated.',audit={...c,issuer:user.id,status:'Rejected',reason,sent:false,createdAt:Date.now()};const {error}=await service.from('fd_records').insert({workspace_id:w,kind:'commands',id:c.id,payload:audit});if(error)return fail('Duplicate or unavailable command audit; never sent',409);return result({id:c.id,status:'Rejected',reason,sent:false},422)}
 return fail('Endpoint not found',404);
 }catch(e){return fail(e instanceof z.ZodError?'Invalid request data':'Service unavailable. Unsaved work remains in this tab.',400)}
});
