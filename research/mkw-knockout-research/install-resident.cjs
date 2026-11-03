'use strict';
// Reversible, RAM-only MKWorld resource overlay, owned by native FS until reboot.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {Bridge,CAVE}=require('../superstars-mod/native-bridge.cjs');
const {openSource,pin,unpin}=require('../superstars-mod/source-file.cjs');
const {attachGame,createGameFiles,discoverUpdates,readRomfs}=require('../superstars-mod/inspect-game.cjs');
const {buildContext,loadPlan}=require('./resident-context.cjs'),{build}=require('./build-reader.cjs');
const {pythonCommand}=require('../../lib/toolchain.cjs');
const check=(x,s)=>{if(!x)throw Error(s);};
async function main(run,planFile=path.join(__dirname,'prepared/probe-pack/overlay.json')){
 run=path.resolve(run);const session=path.basename(run),out=path.join(__dirname,'captures',session),journal=path.join(out,'resident-install.json');
 try{const old=JSON.parse(await fs.readFile(journal));check(!old.hookMayBeAttached,'This boot already has a resident MKWorld installation');}catch(e){if(e.code!=='ENOENT')throw e;}
 planFile=path.resolve(planFile);const plan=await loadPlan(planFile);
 const trial=plan.schema===3&&plan.hardwareTrial?.ready===true&&plan.hardwareTrial.payloadSha256===plan.payload.sha256;
 check(plan.schema===2||plan.deployable===true||trial,'Extended-index plan requires independent qualification before a console trial');
 if(trial){
  const verification=JSON.parse(await fs.readFile(path.join(path.dirname(planFile),'resident-verification.json')));
  check(verification.pass&&verification.payloadSha256===plan.payload.sha256&&plan.independentVerification?.pass&&plan.independentVerification.session===session,'Current complete-pack offline qualifications required');
  if(plan.hardwareTrial.mainPatchRequiredBeforeHandoff){
   const native=JSON.parse(await fs.readFile(path.join(out,'codefs-resident-install.json')));
   check(native.session===session&&native.installed&&native.mode==='redirect'&&native.sourceSha256===plan.hardwareTrial.mainSha256,'Mega native CodeFS delivery must be qualified and enabled first');
  }
 }
 const upload=JSON.parse(await fs.readFile(path.join(out,'sd-payload.json')));
 check(plan.session===session&&upload.session===session&&upload.verified&&upload.sha256===plan.payload.sha256&&upload.sdPath===plan.payload.sdPath,'SD pack qualification required');
 const r={session,titleId:plan.titleId,started:new Date().toISOString(),verified:false,
  installedNcasChanged:false,requiresPcAfterHandoff:false,resourcesRetained:false,hooks:[],
  experimentalHardwareTrial:trial,gameplayVerified:false};
 const save=()=>fs.writeFile(journal,JSON.stringify(r,null,2)+'\n',{mode:0o600});await save();
 const b=await new Bridge().open(run);let source,allocation,game,mount;
 try{
  source=await openSource(run,b,{path:plan.payload.sdPath,size:plan.payload.size});
  const digest=crypto.createHash('sha256');
  for(let off=0;off<plan.payload.size;off+=0x40000)digest.update(await source.a.filesystem.readFile(source.a.s,source.file,off,Math.min(0x40000,plan.payload.size-off)));
  check(digest.digest('hex')===plan.payload.sha256,'Pinned SD pack differs');
  allocation=await b.call(0x694c0,[4096],'mkw-resident-context');check(allocation>=0x100000000n&&allocation<0x8000000000n,'Native allocation failed');
  const mapping=await b.c.info(b.h,allocation,8n);
  check(!mapping.result&&mapping.memory.permissions===3&&mapping.memory.attributes===0&&Number(allocation)+4096<=Number(mapping.memory.address)+Number(mapping.memory.size),'Context lacks native RW backing');
  r.context=String(allocation);r.file=source.fileObject;r.filesystem=source.filesystem;await save();
  await pin(b,source.filesystem);await pin(b,source.fileObject);await source.close();source.closed=true;
  r.clientSessionClosed=true;
  check(await b.m.u32(source.fileObject.object+0x20)===1,'Source file did not survive client cleanup');
  const context=buildContext(plan,source,b.base,allocation,0),at=Number(allocation);await b.m.write(at,await b.m.read(at,4096),context);
  const {code,layout}=await build(b.base,allocation);r.code=layout;
  r.localTests=cp.execFileSync(pythonCommand(),[path.join(__dirname,'test-reader.py'),'--plan',planFile],{encoding:'utf8'}).trim();await save();
  await b.stage(Buffer.alloc(0));const width=(code.length+15)&~15;
  if(width>b.previous.length){const tail=await b.read(b.cave+BigInt(b.previous.length),width-b.previous.length);check(tail.every(v=>v===0),'Native text padding is occupied');b.previous=Buffer.concat([b.previous,tail]);}
  await b.stage(code);
  for(const [name,offset,destination]of [['Read',0x107570,0],['GetSize',0x107600,layout.offsets.mkw_size]]){
   const original=await b.read(b.base+BigInt(offset),16);check(original.equals(b.capture.subarray(offset,offset+16)),'Native '+name+' differs');
   if(name==='Read')check(original.readUInt32LE()===0x91002000,'Unexpected Read thunk');
   else check(original.readUInt32LE()===0xd503237f,'Unexpected GetSize PAC prologue');
   const replacement=Buffer.from(original);replacement.writeUInt32LE((0x14000000|((CAVE+destination-offset)/4))>>>0);
   const hook={name,target:String(b.base+BigInt(offset)),originalHex:original.toString('hex'),replacementHex:replacement.toString('hex')};
   r.hooks.push(hook);r.hookMayBeAttached=true;await save();await b.patch(BigInt(hook.target),original,replacement);hook.attached=true;await save();
  }
  r.hookAttached=true;
  await b.m.write(at+8,Buffer.alloc(4),Buffer.from('01000000','hex'));r.active=true;await save();
  game=await attachGame(run);const files=createGameFiles(game),updates=await discoverUpdates({...game,title:plan.titleId});
  const update=updates.find(v=>v.version===plan.sourceVersion);check(update,'Expected installed update disappeared');
  mount=await files.open({title:plan.titleId,storage:4,update});const view=plan.views[0];
  check(mount.size===view.virtualSize&&mount.source.contentId===plan.sourceContentId,'Virtual storage size or source differs');
  const entries=await readRomfs((offset,length)=>files.read(mount,offset,length),mount.size);r.trials=[];
  for(const resource of plan.resources){
   const entry=entries.find(e=>e.type==='file'&&e.path===resource.path);check(entry&&entry.offset===resource.overlayOffset&&entry.size===resource.modifiedSize,'Overlaid RomFS record differs: '+resource.path);
   const hash=crypto.createHash('sha256');for(let off=0;off<entry.size;off+=0x40000)hash.update(await files.read(mount,entry.offset+off,Math.min(0x40000,entry.size-off)));
   const digest=hash.digest('hex');check(digest===resource.modifiedSha256,'Native resource hash differs: '+resource.path);
   r.trials.push({path:resource.path,size:entry.size,sha256:digest,verified:true});await save();console.log('Native overlaid resource verified',resource.path,entry.size);
  }
  await files.close(mount);mount=null;await game.close();game=null;
  const result=await b.c.read(b.h,8n,allocation,104);check(!result.result&&!result.unmapResult,'Counter read failed');const state=Buffer.from(result.hex,'hex');
  r.counters=Object.fromEntries([['calls',16],['matched',24],['sourceReads',80],['errors',88],['active',96]].map(([k,v])=>[k,String(state.readBigUInt64LE(v))]));
  check(r.counters.errors==='0'&&r.counters.active==='0'&&BigInt(r.counters.sourceReads)>0n,'Native reader reported an error');
  r.verified=true;r.resourcesRetained=true;r.residentUntilReboot=true;r.stockRoRestored=false;r.readyForGameHandoff=false;await save();
  await b.c.close();r.controllerHandlesClosed=true;r.finished=new Date().toISOString();await save();
  console.log(JSON.stringify({journal,verified:true,counters:r.counters,stockRoRestorationPending:true}));
 }catch(error){
  r.error=error.stack;
  if(game&&!b.c.pending){if(mount)await game.s.close(mount.handle);await game.close();}
  if(!b.c.pending&&!r.hookMayBeAttached){
   if(source){await unpin(b,source.fileObject,!source.closed);await unpin(b,source.filesystem,!source.closed);if(!source.closed)await source.close();}
   if(allocation)await b.call(0x69580,[allocation,4096],'free-unused-mkw-context');await b.close();
  }else{r.resourcesRetained=true;r.requiresInspectionOrReboot=true;}
  await save();throw error;
 }
}
if(require.main===module)main(process.argv[2],process.argv[3]).catch(e=>{console.error(e.stack);process.exitCode=1;});
