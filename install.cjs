#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {check,titleId,writeJson}=require('./lib/common.cjs');
const {collectMods}=require('./lib/mods.cjs');
const root=__dirname;
const USAGE=`Usage: node load.cjs [--run-dir PATH] [--title TITLE_ID]
       node install.cjs [--run-dir PATH] [--title TITLE_ID] [--keep-rpc] [--sd]
       node install.cjs --check [--title TITLE_ID]

load.cjs reads SD:/ns2jb-modloader/contents/ and exefs_patches/.
install.cjs uses the same SD layout. --check checks local folders without a console.
Start ns2jb separately and keep its verified FS 4/4 RPC host running.
--title can be repeated to select game folders. Global IPS patches are matched when games open.`;
function options(argv){
 const o={run:null,titles:[],check:false,keepRpc:false,sd:false};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];if(a==='--check')o.check=true;else if(a==='--keep-rpc')o.keepRpc=true;else if(a==='--sd')o.sd=true;else if(a==='--help')o.help=true;
  else{check(['--run-dir','--title'].includes(a),'Unknown option: '+a+'\n'+USAGE);const v=argv[++i];check(v&&!v.startsWith('--'),'Missing value after '+a);if(a==='--title')o.titles.push(titleId(v));else o.run=path.resolve(v);}
 }
 return o;
}
function verifiedRun(run){
 const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));const result=read(path.join(run,'result.json'));
 check(result.verified&&result.rpc?.state==='listening'&&!result.completed,'Selected ns2jb run is not a verified listening RPC session');
 const current=read(path.join(run,'switch2/fs-execution-current.json')),proof=read(path.isAbsolute(current.file)?current.file:path.resolve(run,current.file));
 check(current.verified&&proof.verified&&proof.session===path.basename(run),'Selected run has no matching verified FS 4/4 proof');return run;
}
function warnIgnoredPatches(plan){
 const patches=plan.ignoredPatches||[];if(!patches.length)return;
 console.warn('WARNING: '+patches.length+' IPS patch'+(patches.length===1?' was':'es were')+' not applied (no matching installed NSO Build ID).');
 for(const patch of patches)console.warn('  '+patch);
}
async function main(argv=process.argv.slice(2)){
 const o=options(argv);if(o.help){console.log(USAGE);return;}
 function describe(collection){
  if(o.titles.length){collection.games=collection.games.filter(g=>o.titles.includes(g.titleId));for(const id of o.titles)if(!collection.games.some(g=>g.titleId===id))collection.games.push({titleId:id,romfs:[],exefs:[],patches:[],stubs:[]});}
  for(const g of collection.games)console.log(g.titleId+': '+g.romfs.filter(f=>f.type==='file').length+' RomFS files, '+g.exefs.length+' ExeFS replacements'+(g.romfsImage?', romfs.bin':''));
  if(collection.patches.length)console.log(collection.patches.length+' IPS patch file(s); Build IDs will be matched when each game opens.');
 }
 if(o.check){describe(collectMods(root));console.log('Mod layout checked. No console connection was opened.');return;}
 require('./lib/native/artifacts.cjs').artifacts();
 const run=verifiedRun(o.run||await require('./lib/find-session.cjs').findSession(verifiedRun)),session=path.basename(run),directory=path.join(root,'state',session);fs.mkdirSync(directory,{recursive:true,mode:0o700});
 // The shared run lock also prevents installation from a second checkout.
 const lock=path.join(run,'ns2jb-modloader-install.json');fs.writeFileSync(lock,JSON.stringify({session,directory,started:new Date().toISOString(),status:'preparing'})+'\n',{flag:'wx',mode:0o600});
 const update=value=>writeJson(lock,{session,directory,...value});
 let collection,prepared,captureSession;const diagnostics=require('./lib/diagnostics.cjs'),reportDate=new Date(),reportPath=diagnostics.logPath(session,reportDate);
 async function saveReport(plan,error){
  // A resident writer owns the normal report until reboot. Keep any later
  // installation failure in a separate report rather than reopening that file.
  const destination=error?diagnostics.logPath(session,new Date(Math.max(Date.now(),reportDate.getTime()+1000))):reportPath;
  try{const report=diagnostics.report({session,sdPath:destination,collection,plan,error,status:error?'stopped':'prepared'});await diagnostics.writeReport(run,report);return report;}
  catch(error){console.warn('WARNING: Could not save the SD report: '+error.message);return null;}
 }
 try{
  console.log('Using ns2jb session '+session);
  const {captureNative}=require('./lib/native-capture.cjs');captureSession=await captureNative(run,directory,{retainClient:true});const capture=captureSession.file;
  collection=await require('./lib/sd-mods.cjs').collectSdMods(run,path.join(directory,'sd-inputs'),'/ns2jb-modloader',{nativePreparation:true,client:captureSession.client,processHandle:captureSession.processHandle});describe(collection);
  const plan=require('./lib/lazy-context.cjs').plan(collection,session),preparedDirectory=path.join(directory,'prepared');fs.mkdirSync(preparedDirectory,{recursive:true,mode:0o700});
  const profile=JSON.parse(fs.readFileSync(path.join(directory,'native-fs/manifest.json')));
  plan.nativeProfile={sha256:profile.sha256,validatedRanges:profile.validatedRanges};
  plan.nativeRuntime=require('./lib/native/artifacts.cjs').artifacts().manifest.files['templates.json'];
  const file=path.join(preparedDirectory,plan.payload.filename);fs.writeFileSync(file,Buffer.alloc(0),{mode:0o600});prepared={plan,file};
  const report=await saveReport(plan);if(report)plan.diagnostics={...report,buffer:undefined,text:report.buffer.toString('utf8'),size:report.buffer.length};writeJson(path.join(preparedDirectory,'overlay.json'),plan);
  console.log('Registering '+plan.titleIds.length+' game folder(s); game files will be prepared on the console when opened.');
  // Validate relocation and the manifest before attaching native hooks.
  const {buildAll}=require('./lib/native.cjs'),{buildContext}=require('./lib/context.cjs');
  const native=await buildAll(0x4000000000n,0x6000000000n,plan,{capture,directory:path.join(directory,'offline-build')});
  buildContext(plan,{filesystem:{object:0x6100001000n},registry:0x6100003000n,...(plan.diagnostics?{logFile:{object:0x6100002000n,write:0x4000105000n,flush:0x4000105300n,setSize:0x4000105380n}}:{})},0x4000000000n,0x6000000000n,native);
  update({status:'installing',titleIds:prepared.plan.titleIds});
  const resident=await require('./lib/resident.cjs').install(run,prepared.plan,directory,capture,collection.bootstrap);check(resident.verified,'Native overlay verification failed');
  if(o.keepRpc){update({status:'installed-rpc-held',titleIds:prepared.plan.titleIds});console.log('INSTALLED — RPC stays open. Stock RO restoration and game handoff have not run.');return;}
  const result=await require('./lib/native/handoff.cjs').apply(run,{residentDirectory:directory,contextMagic:'NS2LFS02'});check(result.stockRoProtocolVerified,'Stock RO verification failed');
  resident.stockRoRestored=true;resident.readyForGameHandoff=true;resident.handoff=result;writeJson(path.join(directory,'resident-install.json'),resident);
  update({status:'ready',titleIds:prepared.plan.titleIds,nativeOnMount:true});console.log('READY — Stop your ns2jb host with Ctrl+C and wait for cleanup. Close SmileBASIC without rebooting, then open your game.');
 }catch(error){update({status:'stopped',error:error.message,inspectBeforeRetry:true});if(!/pending|timed out|disconnected/i.test(error.message)){if(collection?.reader){await collection.reader.close();collection.reader=null;}await saveReport(null,error);}throw error;}
 finally{if(!collection?.bootstrap?.bridge.c.pending){if(collection?.reader)await collection.reader.close();if(collection?.bootstrap&&!collection.bootstrap.transferred)await collection.bootstrap.release();}if(captureSession&&!collection?.bootstrap&&!captureSession.client.pending&&!captureSession.client.record.closed)await captureSession.client.close();}
}
module.exports={main,options,verifiedRun,warnIgnoredPatches};
if(require.main===module)main().catch(error=>{console.error('INSTALL STOPPED: '+error.message);process.exitCode=1;});
