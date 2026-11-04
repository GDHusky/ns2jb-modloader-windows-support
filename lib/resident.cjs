'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Bridge}=require('./native/bridge.cjs');
const {openSource,pin,unpin}=require('./native/source.cjs');
const {attachGame,createGameFiles,readRomfs}=require('./game-files/mount-api.cjs');
const {openSelected}=require('./content.cjs'),{check,sha,writeJson}=require('./common.cjs');
const {layout,buildContext}=require('./context.cjs'),{buildAll,validateCapture}=require('./native.cjs');
function sampleRanges(size){
 if(!size)return[];if(size<=768)return[{offset:0,length:size}];
 return[0,Math.floor((size-256)/2),size-256].map(offset=>({offset,length:256}));
}
async function verifyResources(run,plan,payloadFile){
 const a=await attachGame(run),files=createGameFiles(a),deferred=new Set((plan.deferredGames||[]).map(game=>game.titleId)),report={romfs:[],exefs:[],deferredGames:[...deferred]};let mount,file,payload;
 function payloadBytes(offset,length){if(payload===undefined)payload=fs.openSync(payloadFile,'r');const bytes=Buffer.alloc(length);check(fs.readSync(payload,bytes,0,length,offset)===length,'Short local routing sample');return bytes;}
 try{
  for(const v of plan.views){
   if(deferred.has(v.titleId))continue;
   mount=await openSelected(a,files,v.selection);check(mount.source.contentId===v.source.contentId&&mount.source.version===v.source.version&&mount.size===v.virtualSize,'Mounted virtual RomFS identity/size differs');
   const entries=await readRomfs((off,n)=>files.read(mount,off,n),mount.size);
   for(const r of v.resources){
    const e=entries.find(e=>e.type==='file'&&e.path===r.path);check(e&&e.offset===r.overlayOffset&&e.size===r.modifiedSize,'Native RomFS entry differs: '+r.path);let sampledBytes=0;
    for(const sample of sampleRanges(e.size)){
     const offset=e.offset+sample.offset,segment=v.segments.find(s=>offset>=s.offset&&offset+sample.length<=s.offset+s.length);check(segment,'Routing sample is outside the prepared RomFS');
     const bytes=await files.read(mount,offset,sample.length);check(bytes.equals(payloadBytes(segment.sourceOffset+offset-segment.offset,sample.length)),'Native RomFS routing differs: '+r.path);sampledBytes+=sample.length;
    }
    report.romfs.push({titleId:v.titleId,path:r.path,verified:true,sampledBytes});
   }
   await files.close(mount);mount=null;
  }
  for(const group of plan.namespaces){
   if(deferred.has(group.titleId))continue;
   mount=await openSelected(a,files,group.selection,'exefs');check(mount.source.contentId===group.source.contentId&&mount.source.version===group.source.version,'CodeFS selection changed');
   const expected=plan.exefs.filter(e=>e.titleId===group.titleId),listed=await files.list(mount,'/',()=>false);
   check(listed.length===expected.length&&listed.every(e=>e.type==='file'&&expected.some(x=>x.name===e.name&&x.replacement.size===e.size)),'Native CodeFS directory does not match the complete mirror');
   for(const e of expected){
   const type=await a.filesystem.pathMethod(a.s,mount.handle,7,'/'+e.name);check(!type.result&&type.data.readUInt32LE()===1,'Native CodeFS entry type differs: '+e.name);
   const opened=await a.filesystem.openFile(a.s,mount.handle,'/'+e.name);check(!opened.result,'Cannot verify ExeFS module '+e.name);file=opened.handle;
   const size=Number(await a.filesystem.fileSize(a.s,file));check(size===e.replacement.size,'Native ExeFS size differs: '+e.name);
   // Upload verified every mirror in full. Bounded reads now check routing
   // through the installed hooks, without transferring each file again.
   let sampledBytes=0;
   if(e.modified||!e.original)for(const sample of sampleRanges(size)){
    const bytes=await a.filesystem.readFile(a.s,file,sample.offset,sample.length);check(bytes.equals(payloadBytes(e.replacement.sourceOffset+sample.offset,sample.length)),'Native ExeFS routing differs: '+e.name);sampledBytes+=sample.length;
   }
   await a.s.close(file);file=null;report.exefs.push({titleId:e.titleId,name:e.name,verified:true,sampledBytes,newFile:!e.original});
   }
   await files.close(mount);mount=null;
  }
  return report;
 }finally{try{if(file)await a.s.close(file);if(mount)await files.close(mount);await a.close();}finally{if(payload!==undefined)fs.closeSync(payload);}}
}
async function install(run,plan,directory,captureFile){
 check(plan.session===path.basename(run)&&plan.schema===4,'Wrong overlay session');const data=fs.readFileSync(captureFile);validateCapture(data);
 const journal=path.join(directory,'resident-install.json');check(!fs.existsSync(journal),'A resident installation already exists for this session');
 const r={session:plan.session,titleIds:plan.titleIds,started:new Date().toISOString(),verified:false,active:false,hooks:[],hookMayBeAttached:false,resourcesRetained:false,installedNcasChanged:false,requiresPcAfterHandoff:false};
 const save=()=>writeJson(journal,r);save();let b,source,allocation;const l=layout(plan);
 try{
  b=new Bridge();await b.open(run,{captureFile});r.base=String(b.base);
  source=await openSource(run,b,{path:plan.payload.sdPath,size:plan.payload.size});
  allocation=await b.call(0x694c0,[l.bytes],'allocate-layeredfs-context');check(allocation>=0x100000000n&&allocation<0x8000000000n,'Native context allocation failed');
  const mapping=await b.c.info(b.h,allocation,8n);check(!mapping.result&&mapping.memory.permissions===3&&mapping.memory.attributes===0&&allocation+BigInt(l.bytes)<=BigInt(mapping.memory.address)+BigInt(mapping.memory.size),'Native context is not backed by sufficient RW memory');
  r.context=String(allocation);r.contextBytes=l.bytes;r.file=source.fileObject;r.filesystem=source.filesystem;save();
  const native=await buildAll(b.base,allocation,plan,{capture:captureFile,directory:path.join(directory,'build')});r.native={romfsBytes:native.romfsBytes,exefsBytes:native.codefsBytes,sha256:sha(native.code)};
  await pin(b,source.filesystem);await pin(b,source.fileObject);await source.close();source.closed=true;r.clientSessionClosed=true;save();check(await b.m.u32(source.fileObject.object+0x20)===1,'SD file pin did not survive client cleanup');
  const context=buildContext(plan,source,b.base,allocation,native,0);for(let off=0;off<context.length;off+=4096){const part=context.subarray(off,off+4096),at=Number(allocation)+off;await b.m.write(at,await b.m.read(at,part.length),part);}
  await b.stage(Buffer.alloc(0));
  if(native.code.length>b.previous.length){const tail=await b.read(b.cave+BigInt(b.previous.length),native.code.length-b.previous.length);check(tail.every(v=>v===0),'Native resident padding is already occupied');b.previous=Buffer.concat([b.previous,tail]);}
  r.codeMayBeStaged=true;save();await b.stage(native.code);r.codeStaged=true;save();
  for(const hook of native.hooks){check((await b.read(BigInt(hook.target),16)).toString('hex')===hook.originalHex,'Native entry changed: '+hook.name);r.hooks.push({...hook,attached:false});r.hookMayBeAttached=true;save();await b.patch(BigInt(hook.target),Buffer.from(hook.originalHex,'hex'),Buffer.from(hook.replacementHex,'hex'));r.hooks.at(-1).attached=true;save();}
  r.hookAttached=true;
  if(l.exefs){r.exefsContext=String(allocation+BigInt(l.romfs));await b.m.write(Number(allocation)+l.romfs,Buffer.alloc(4),Buffer.from('01000000','hex'));}
  await b.m.write(Number(allocation)+8,Buffer.alloc(4),Buffer.from('01000000','hex'));r.active=true;r.resourcesRetained=true;save();
  r.verification=await verifyResources(run,plan,path.join(directory,'prepared',plan.payload.filename));
  // Read diagnostics through the separate process-memory helper. The retained
  // IStorage endpoint observes its own in-flight Read in the active counter.
  const counters=await b.read(allocation,104);r.counters=Object.fromEntries([['calls',16],['matched',24],['sourceReads',80],['errors',88],['active',96]].map(([k,off])=>[k,String(counters.readBigUInt64LE(off))]));check(r.counters.errors==='0'&&r.counters.active==='0','Resident RomFS reader is failed or busy');
  if(l.exefs){const bytes=await b.read(allocation+BigInt(l.romfs),112);r.exefsCounters={calls:String(bytes.readBigUInt64LE(80)),matched:String(bytes.readBigUInt64LE(88)),errors:String(bytes.readBigUInt64LE(96)),active:String(bytes.readBigUInt64LE(104))};check(r.exefsCounters.errors==='0'&&r.exefsCounters.active==='0'&&(!r.verification.exefs.length||BigInt(r.exefsCounters.matched)>0n),'Resident ExeFS verification failed');}
  r.verified=true;r.residentUntilReboot=true;r.readyForGameHandoff=false;r.finished=new Date().toISOString();save();
  // The resident owns its source references, contexts and shared RX page.
  // Closing a controller must not clear the installed code or restore X-only.
  b.readable=false;await b.c.close();r.controllerHandlesClosed=true;save();return r;
 }catch(error){
  r.error=error.stack;
  if(b?.c&&!b.c.pending&&!b.previous){await b.c.close();}
  else if(b?.c&&!b.c.pending&&!r.codeMayBeStaged&&!r.hookMayBeAttached&&!source?.closed){
   if(source){await unpin(b,source.fileObject,true);await unpin(b,source.filesystem,true);await source.close();}
   if(allocation)await b.call(0x69580,[allocation,l.bytes],'free-unused-layeredfs-context');await b.close();
  }else if(b){r.resourcesRetained=true;r.requiresInspectionOrReboot=true;}
  save();throw error;
 }
}
module.exports={install,verifyResources,sampleRanges};
