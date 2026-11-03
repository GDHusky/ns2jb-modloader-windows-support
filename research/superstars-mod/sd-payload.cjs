'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {attachGame}=require('./inspect-game.cjs');
const {MOD_SHA,sha256}=require('./prepare-overlay.cjs');
const check=(ok,why)=>{if(!ok)throw Error(why);};
const SD_PATH='/roms/monopoly_party_cb5caabafe4d.bea';
const ptr=(b,o=0)=>Number(b.readBigUInt64LE(o));
async function main(run) {
 run=path.resolve(run);const session=path.basename(run),out=path.join(__dirname,'captures',session);
 const blob=await fs.readFile(path.join(__dirname,'prepared/hsbd01.nx.bea'));check(sha256(blob)===MOD_SHA,'Wrong staged mod');
 const report={session,sdPath:SD_PATH,bytes:blob.length,sha256:MOD_SHA,started:new Date().toISOString(),created:false,resourcesPinned:false};
 const save=()=>fs.writeFile(path.join(out,'sd-payload.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});await save();
 const {connect}=require(path.join(run,'switch2/tools/fs-memory.cjs'));const memory=await connect();
 const layout=JSON.parse(await fs.readFile(path.join(run,'switch2/ro',session+'-layout.json')));
 const a=await attachGame(run);const {s,domain,filesystem}=a;
 const {packet}=require(path.join(run,'shared/ipc.cjs'));
 let sd,file;
 const pathCall=async(id,input=Buffer.alloc(0))=>{
  const name=Buffer.alloc(0x301);name.write(SD_PATH);await s.write(s.base+0x2000,name);
  const wire=packet(id,input),p=BigInt(s.base+0x2000);
  wire.writeUInt32LE(4|1<<16);wire.writeUInt32LE(Number(0x301n<<16n|(p>>36n&7n)<<6n|(p>>32n&15n)<<12n),8);wire.writeUInt32LE(Number(p&0xffffffffn),12);
  return domain.send(s,'Monopoly SD path '+id,sd,wire);
 };
 async function locate(handle,label) {
  const clone=domain.oneHandle(await domain.send(s,'Locate '+label,handle,domain.wire.control(2)));
  try {
   const converted=await domain.send(s,'Convert '+label+' clone',clone,domain.wire.control(0));
   check(!converted.result,'Domain conversion failed');const id=converted.data.readUInt32LE();check(id>0&&id<=layout.count,'Invalid object id');
   const entry=await memory.read(layout.table+(id-1)*0x30,0x30),object=ptr(entry,0x20),raw=await memory.read(object,128),vptr=ptr(raw);
   const table=await memory.read(vptr,128);
   return {label,object,vptr,entryHex:entry.toString('hex'),rawHex:raw.toString('hex'),tableHex:table.toString('hex'),tableWords:Array.from({length:16},(_,i)=>table.readBigUInt64LE(i*8).toString())};
  }finally{await s.close(clone);}
 }
 try {
  sd=domain.oneHandle(await s.ipc('Open SD for Monopoly payload',a.root,18));
  const status=await pathCall(7);
  if(status.canonicalResult===0x202) {
   const input=Buffer.alloc(16);input.writeBigUInt64LE(BigInt(blob.length),8);
   const r=await pathCall(0,input);check(!r.result,'Cannot create owned SD payload: '+r.canonicalResult);report.created=true;await save();
   const mode=Buffer.alloc(4);mode.writeUInt32LE(3);file=domain.oneHandle(await pathCall(8,mode));
   for(let offset=0;offset<blob.length;offset+=0x40000) {
    const bytes=blob.subarray(offset,offset+0x40000),input=Buffer.alloc(24);
    input.writeBigUInt64LE(BigInt(offset),8);input.writeBigUInt64LE(BigInt(bytes.length),16);
    await s.write(s.base+0x6000,bytes);
    const r=await s.ipc('Write owned Monopoly payload',file,1,input,{send:[{address:s.base+0x6000,size:bytes.length,mode:1}]});
    check(!r.result,'SD write failed: '+r.canonicalResult);report.written=offset+bytes.length;
    if(offset%0x400000===0){await save();console.log('Uploaded',report.written,'/',blob.length);}
   }
   check(!(await s.ipc('Flush owned Monopoly payload',file,2)).result,'Flush failed');
   await s.close(file);file=null;
  }else check(!status.result&&status.data.readUInt32LE()===1,'Unexpected owned SD path');
  const opened=await filesystem.openFile(s,sd,SD_PATH);check(!opened.result,'Read-only SD open failed');file=opened.handle;
  check(await filesystem.fileSize(s,file)===BigInt(blob.length),'Existing file size differs; refusing overwrite');
  const digest=crypto.createHash('sha256');
  for(let offset=0;offset<blob.length;offset+=0x40000) digest.update(await filesystem.readFile(s,file,offset,Math.min(0x40000,blob.length-offset)));
  check(digest.digest('hex')===MOD_SHA,'SD payload hash differs; refusing overwrite');report.verified=true;await save();
  report.sd=await locate(sd,'owned-SD-filesystem');report.file=await locate(file,'owned-mod-file');await save();
 }catch(e){report.error=e.stack;throw e;}
 finally {await a.close();report.temporarySessionClosed=true;report.finished=new Date().toISOString();await save();}
 console.log(JSON.stringify({report:path.join(out,'sd-payload.json'),verified:report.verified,resourcesPinned:false}));
}
if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={main,SD_PATH};
