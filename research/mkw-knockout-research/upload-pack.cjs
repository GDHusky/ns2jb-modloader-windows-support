'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {attachGame}=require('../superstars-mod/inspect-game.cjs');
const {loadPlan}=require('./resident-context.cjs');
const check=(x,s)=>{if(!x)throw Error(s);},sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function main(run,planFile=path.join(__dirname,'prepared/probe-pack/overlay.json')){
 run=path.resolve(run);planFile=path.resolve(planFile);const plan=await loadPlan(planFile),blob=await fs.readFile(path.join(path.dirname(planFile),plan.payload.filename||'probe-pack.bin'));
 check(plan.session===path.basename(run)&&blob.length===plan.payload.size&&sha(blob)===plan.payload.sha256,'Wrong prepared pack');
 check(/^\/roms\/mkw_[a-z0-9_]+\.(bin|pack)$/.test(plan.payload.sdPath),'Expected a scoped owned MKWorld SD path');
 if(plan.schema===3)check(plan.payload.sdPath==='/roms/mkw_knockout_'+plan.payload.sha256.slice(0,12)+'.bin','Extended payload path must be hash-addressed');
 const out=path.join(__dirname,'captures',plan.session),file=path.join(out,'sd-payload.json');
 await fs.mkdir(out,{recursive:true});
 const r={session:plan.session,sdPath:plan.payload.sdPath,size:blob.length,sha256:sha(blob),created:false,verified:false};
 const save=()=>fs.writeFile(file,JSON.stringify(r,null,2)+'\n',{mode:0o600});await save();
 const a=await attachGame(run),{s,domain,filesystem}=a,{packet}=require(path.join(run,'shared/ipc.cjs'));let sd,ownedFile;
 async function method(id,input=Buffer.alloc(0)){
  const name=Buffer.alloc(0x301);name.write(plan.payload.sdPath);await s.write(s.base+0x2000,name);
  const wire=packet(id,input),p=BigInt(s.base+0x2000);wire.writeUInt32LE(4|1<<16);
  wire.writeUInt32LE(Number(0x301n<<16n|(p>>36n&7n)<<6n|(p>>32n&15n)<<12n),8);wire.writeUInt32LE(Number(p&0xffffffffn),12);
  return domain.send(s,'Owned MKWorld pack path '+id,sd,wire);
 }
 try{
  sd=domain.oneHandle(await s.ipc('Open SD for owned MKWorld probe',a.root,18));const status=await method(7);
  if(status.canonicalResult===0x202){
   const input=Buffer.alloc(16);input.writeBigUInt64LE(BigInt(blob.length),8);
   check(!(await method(0,input)).result,'Cannot create owned SD pack');r.created=true;await save();
   const mode=Buffer.alloc(4);mode.writeUInt32LE(3);const handle=domain.oneHandle(await method(8,mode));ownedFile=handle;
   for(let offset=0;offset<blob.length;offset+=0x40000){
    const bytes=blob.subarray(offset,offset+0x40000),data=Buffer.alloc(24);data.writeBigUInt64LE(BigInt(offset),8);data.writeBigUInt64LE(BigInt(bytes.length),16);
    await s.write(s.base+0x6000,bytes);const reply=await s.ipc('Write owned MKWorld probe',handle,1,data,{send:[{address:s.base+0x6000,size:bytes.length,mode:1}]});
    check(!reply.result,'Owned SD pack write failed');
   }
   check(!(await s.ipc('Flush owned MKWorld probe',handle,2)).result,'SD flush failed');await s.close(handle);ownedFile=null;
  }else check(!status.result&&status.data.readUInt32LE()===1,'Unexpected SD pack path');
  const opened=await filesystem.openFile(s,sd,plan.payload.sdPath);check(!opened.result,'Cannot read SD pack');ownedFile=opened.handle;
  check(await filesystem.fileSize(s,opened.handle)===BigInt(blob.length),'Existing SD file has the wrong size; refusing overwrite');
  const hash=crypto.createHash('sha256');
  for(let offset=0;offset<blob.length;offset+=0x40000)hash.update(await filesystem.readFile(s,opened.handle,offset,Math.min(0x40000,blob.length-offset)));
  check(hash.digest('hex')===plan.payload.sha256,'SD read-back hash differs');r.verified=true;
 }catch(error){r.error=error.stack;throw error;}
 finally{if(ownedFile)await s.close(ownedFile);await a.close();r.temporarySessionClosed=true;await save();}
 console.log(JSON.stringify({file,...r}));
}
module.exports={main};
if(require.main===module)main(process.argv[2],process.argv[3]).catch(e=>{console.error(e.stack);process.exitCode=1;});
