'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Bridge}=require('./native/bridge.cjs');
const {openSource,unpin}=require('./native/source.cjs');
const {attachGame,createGameFiles}=require('./game-files/mount-api.cjs');
const {openSelected}=require('./content.cjs'),{check,sha,writeJson}=require('./common.cjs');
const {layout,buildContext}=require('./context.cjs'),{buildAll,validateCapture}=require('./native.cjs');
function sampleRanges(size){
 if(!size)return[];if(size<=768)return[{offset:0,length:size}];
 return[0,Math.floor((size-256)/2),size-256].map(offset=>({offset,length:256}));
}
function sampleResources(resources){
 if(resources.length<=3)return resources;
 return[...new Set([resources[0],resources[Math.floor(resources.length/2)],resources.at(-1),resources.find(r=>r.added),resources.find(r=>!r.added)].filter(Boolean))];
}
async function verifyResources(run,plan,payloadFile){
 const a=await attachGame(run),files=createGameFiles(a),deferred=new Set((plan.deferredGames||[]).map(game=>game.titleId)),report={romfs:[],exefs:[],deferredGames:[...deferred]},payload=fs.readFileSync(payloadFile);let mount,file,sd;
 async function expected(name,offset,length){
  if(!sd)sd=a.domain.oneHandle(await a.s.ipc('Open routing samples on SD',a.root,18));const opened=await a.filesystem.openFile(a.s,sd,name);check(!opened.result,'Cannot open routing sample source');
  try{const bytes=await a.filesystem.readFile(a.s,opened.handle,offset,length);check(bytes.length===length,'Short mod sample');return bytes;}finally{await a.s.close(opened.handle);}
 }
 try{
  for(const v of plan.views){
   if(deferred.has(v.titleId))continue;
   mount=await openSelected(a,files,v.selection);check(mount.source.contentId===v.source.contentId&&mount.source.version===v.source.version&&mount.size===v.virtualSize,'Mounted virtual RomFS identity/size differs');
   const header=await files.read(mount,0,80),dataOffset=header.readBigUInt64LE(72);
   for(const r of sampleResources(v.resources)){
    const record=await files.read(mount,r.recordOffset+8,16);check(record.readBigUInt64LE()+dataOffset===BigInt(r.overlayOffset)&&record.readBigUInt64LE(8)===BigInt(r.modifiedSize),'Native RomFS replacement record differs');
    let sampledBytes=0;
    for(const sample of sampleRanges(r.modifiedSize)){
     const bytes=await files.read(mount,r.overlayOffset+sample.offset,sample.length);check(bytes.equals(await expected(r.sourcePath,r.sourceOffset+sample.offset,sample.length)),'Native RomFS routing differs: '+r.path);sampledBytes+=sample.length;
    }
    report.romfs.push({titleId:v.titleId,path:r.path,verified:true,sampledBytes});
   }
   await files.close(mount);mount=null;
  }
  for(const group of plan.namespaces){
   if(deferred.has(group.titleId))continue;
   mount=await openSelected(a,files,group.selection,'exefs');check(mount.source.contentId===group.source.contentId&&mount.source.version===group.source.version,'CodeFS selection changed');
   const wanted=plan.exefs.filter(e=>e.titleId===group.titleId),listed=await files.list(mount,'/',()=>false);
   check(listed.length===wanted.length&&listed.every(e=>e.type==='file'&&wanted.some(x=>x.name===e.name&&x.replacement.size===e.size)),'Native CodeFS directory differs');
   for(const e of wanted){
    if(!e.modified){report.exefs.push({titleId:e.titleId,name:e.name,verified:true,inheritedOriginal:true,sampledBytes:0});continue;}
    const type=await a.filesystem.pathMethod(a.s,mount.handle,7,'/'+e.name);check(!type.result&&type.data.readUInt32LE()===1,'Native CodeFS entry type differs');
    const opened=await a.filesystem.openFile(a.s,mount.handle,'/'+e.name);check(!opened.result,'Cannot verify ExeFS module '+e.name);file=opened.handle;
    const r=e.replacement;check(await a.filesystem.fileSize(a.s,file)===BigInt(r.size),'Native ExeFS size differs');let sampledBytes=0;
    if(r.segments){
     const ranges=r.segments.filter(s=>s.inline),selected=ranges.length<=4?ranges:[ranges[0],ranges[Math.floor(ranges.length/3)],ranges[Math.floor(2*ranges.length/3)],ranges.at(-1)];
     for(const segment of selected){const n=Math.min(256,segment.length),bytes=await a.filesystem.readFile(a.s,file,segment.offset,n);check(bytes.equals(payload.subarray(segment.sourceOffset,segment.sourceOffset+n)),'Native IPS data differs: '+e.name);sampledBytes+=n;}
    }else for(const sample of sampleRanges(r.size)){
     const bytes=await a.filesystem.readFile(a.s,file,sample.offset,sample.length);check(bytes.equals(await expected(r.sourcePath,r.sourceOffset+sample.offset,sample.length)),'Native ExeFS routing differs: '+e.name);sampledBytes+=sample.length;
    }
    await a.s.close(file);file=null;report.exefs.push({titleId:e.titleId,name:e.name,verified:true,sampledBytes});
   }
   await files.close(mount);mount=null;
  }
  return report;
 }finally{if(file)await a.s.close(file);if(mount)await files.close(mount);await a.close();}
}
async function install(run,plan,directory,captureFile){
 check(plan.session===path.basename(run)&&plan.schema===5,'Wrong overlay session');const data=fs.readFileSync(captureFile);validateCapture(data);
 const journal=path.join(directory,'resident-install.json');check(!fs.existsSync(journal),'A resident installation already exists for this session');
 const r={session:plan.session,titleIds:plan.titleIds,started:new Date().toISOString(),verified:false,active:false,hooks:[],hookMayBeAttached:false,resourcesRetained:false,installedNcasChanged:false,requiresPcAfterHandoff:false};
 const save=()=>writeJson(journal,r);save();let b,source,allocation;const l=layout(plan);
 try{
  b=new Bridge();await b.open(run,{captureFile});r.base=String(b.base);
  source=await openSource(run,b,plan.diagnostics);
  allocation=await b.call(0x694c0,[l.bytes],'allocate-layeredfs-context');check(allocation>=0x100000000n&&allocation<0x8000000000n,'Native context allocation failed');
  const mapping=await b.c.info(b.h,allocation,8n);check(!mapping.result&&mapping.memory.permissions===3&&mapping.memory.attributes===0&&allocation+BigInt(l.bytes)<=BigInt(mapping.memory.address)+BigInt(mapping.memory.size),'Native context is not backed by sufficient RW memory');
  r.context=String(allocation);r.contextBytes=l.bytes;r.filesystem=source.filesystem;if(source.logFile)r.logFile=source.logFile;r.diagnosticPath=plan.diagnostics?.sdPath;save();
  let native=await buildAll(b.base,allocation,plan,{capture:captureFile,directory:path.join(directory,'build')});
  const payload=fs.readFileSync(path.join(directory,'prepared',plan.payload.filename));const context=buildContext(plan,source,b.base,allocation,native,0,payload);
  for(let off=0;off<context.length;off+=4096){const part=context.subarray(off,off+4096),at=Number(allocation)+off;await b.m.write(at,await b.m.read(at,part.length),part);}
  const runtime=await b.mapRuntime(native.runtimeCode,record=>{r.runtime=record;return save();},allocation+152n);
  native=await buildAll(b.base,allocation,plan,{capture:captureFile,directory:path.join(directory,'build'),runtimeAddress:runtime.address});r.native={runtimeBytes:native.runtimeBytes,gatewayBytes:native.codeBytes,sha256:native.sha256,runtimeSha256:native.runtimeSha256};
  check(await b.m.u32(source.filesystem.object+source.filesystem.refOffset)===source.filesystem.baseline,'SD reference baseline changed');
  check(await b.callRuntime(native.offsets.lfs_initialize,[],'retain-resident-SD')===0n,'SD retention failed');
  check(await b.m.u32(source.filesystem.object+source.filesystem.refOffset)===source.filesystem.baseline+1,'SD reference did not retain once');source.filesystem.pinned=true;if(source.logFile)source.logFile.pinned=true;
  if(source.logFile)check(await b.m.u32(source.logFile.object+source.logFile.refOffset)===source.logFile.baseline+1,'Report reference did not retain once');
  await source.close();source.closed=true;r.clientSessionClosed=true;save();
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
  if(source.logFile){
   const controller=new Bridge();
   try{await controller.open(run,{captureFile,caveOffset:0x24d800});controller.runtime=runtime;check(await controller.callRuntime(native.offsets.lfs_game_observations,[],'start-game-observations')===0n,'Cannot begin game observations');}
   finally{if(controller.c&&!controller.c.pending)await controller.close();}
   const errors=await b.m.u64(Number(allocation)+256);r.diagnosticWriteErrors=String(errors);if(errors)console.warn('WARNING: The SD runtime report could not be updated; mods remain active.');
  }
  r.verified=true;r.residentUntilReboot=true;r.readyForGameHandoff=false;r.finished=new Date().toISOString();save();
  // The resident owns its source references, contexts and shared RX page.
  // Closing a controller must not clear the installed code or restore X-only.
  b.readable=false;await b.c.close();r.controllerHandlesClosed=true;save();return r;
 }catch(error){
  r.error=error.stack;
  if(b?.c&&!b.c.pending&&!b.previous){await b.c.close();}
  else if(b?.c&&!b.c.pending&&!r.runtime&&!r.codeMayBeStaged&&!r.hookMayBeAttached&&!source?.closed){
   if(source){if(source.logFile)await unpin(b,source.logFile,true);await unpin(b,source.filesystem,true);await source.close();}
   if(allocation)await b.call(0x69580,[allocation,l.bytes],'free-unused-layeredfs-context');await b.close();
  }else if(b){r.resourcesRetained=true;r.requiresInspectionOrReboot=true;}
  save();throw error;
 }
}
module.exports={install,verifyResources,sampleRanges,sampleResources};
