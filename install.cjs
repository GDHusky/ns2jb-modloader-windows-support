#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {check,titleId,writeJson}=require('./lib/common.cjs');
const {collectMods}=require('./lib/mods.cjs');
const root=__dirname;
const USAGE=`Usage: node install.cjs --run-dir PATH [--title TITLE_ID] [--keep-rpc]
       node install.cjs --check [--title TITLE_ID]

Place contents/<TITLE_ID>/romfs/ or exefs/ in ns2jb-modloader/.
Start ns2jb separately and keep its verified FS 4/4 RPC host running.
--title can be repeated to select games or provide a target for global IPS patches.`;
function options(argv){
 const o={run:null,titles:[],check:false,keepRpc:false};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];if(a==='--check')o.check=true;else if(a==='--keep-rpc')o.keepRpc=true;else if(a==='--help')o.help=true;
  else{check(['--run-dir','--title'].includes(a),'Unknown option: '+a+'\n'+USAGE);const v=argv[++i];check(v&&!v.startsWith('--'),'Missing value after '+a);if(a==='--title')o.titles.push(titleId(v));else o.run=path.resolve(v);}
 }
 check(o.help||o.check||o.run,USAGE);return o;
}
function verifiedRun(run){
 const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));const result=read(path.join(run,'result.json'));
 check(result.verified&&result.rpc?.state==='listening'&&!result.completed,'Selected ns2jb run is not a verified listening RPC session');
 const current=read(path.join(run,'switch2/fs-execution-current.json')),proof=read(path.isAbsolute(current.file)?current.file:path.resolve(run,current.file));
 check(current.verified&&proof.verified&&proof.session===path.basename(run),'Selected run has no matching verified FS 4/4 proof');return run;
}
async function main(argv=process.argv.slice(2)){
 const o=options(argv);if(o.help){console.log(USAGE);return;}
 const collection=collectMods(root);
 if(o.titles.length){collection.games=collection.games.filter(g=>o.titles.includes(g.titleId));for(const id of o.titles)if(!collection.games.some(g=>g.titleId===id))collection.games.push({titleId:id,romfs:[],exefs:[],patches:[],mods:[]});}
 for(const g of collection.games)console.log(g.titleId+': '+g.romfs.filter(f=>f.type==='file').length+' RomFS files, '+g.exefs.length+' ExeFS replacements, '+g.patches.length+' module patches'+(g.romfsImage?', romfs.bin':''));
 if(collection.patches.length)console.log(collection.patches.length+' global ExeFS patch file(s); Build IDs will be matched to installed games.');
 if(o.check){console.log('Mod layout checked. No console connection was opened.');return;}
 const {checkPythonDependencies,checkNativeTools}=require('./lib/toolchain.cjs');checkPythonDependencies();checkNativeTools();
 const run=verifiedRun(o.run),session=path.basename(run),directory=path.join(root,'state',session);fs.mkdirSync(directory,{recursive:true,mode:0o700});
 // The shared run lock also prevents installation from a second checkout.
 const lock=path.join(run,'ns2jb-modloader-install.json');fs.writeFileSync(lock,JSON.stringify({session,directory,started:new Date().toISOString(),status:'preparing'})+'\n',{flag:'wx',mode:0o600});
 const update=value=>writeJson(lock,{session,directory,...value});
 try{
  console.log('Using ns2jb session '+session);
  const {captureNative}=require('./lib/native-capture.cjs'),capture=await captureNative(run,directory);
  if(collection.patches.length&&!o.titles.length){
   const {attachGame}=require('./lib/game-files/session.cjs'),{discoverApplications}=require('./lib/game-files/content.cjs'),a=await attachGame(run);
   try{for(const app of await discoverApplications(a))if(!collection.games.some(g=>g.titleId===app.contentTitle))collection.games.push({titleId:app.contentTitle,romfs:[],exefs:[],patches:[],stubs:[],autoForGlobalPatches:true});}finally{await a.close();}
  }
  const {captureGame}=require('./lib/content.cjs'),captures=[];
  for(const g of collection.games){const dir=path.join(directory,'games',g.titleId);console.log('Inspecting '+g.titleId);try{captures.push({directory:dir,inventory:await captureGame(run,g,dir,collection.patches)});}catch(error){if(!g.autoForGlobalPatches||error.code!=='CONTENT_UNAVAILABLE')throw error;g.unavailable=true;}}
  collection.games=collection.games.filter(g=>!g.unavailable);
  const {prepare}=require('./lib/prepare.cjs'),prepared=await prepare(collection,captures,path.join(directory,'prepared'),session);console.log('Prepared '+prepared.plan.views.length+' RomFS views and '+prepared.plan.exefs.length+' ExeFS modules');
  const packVerification=await require('./lib/verify-plan.cjs').verifyPlan(prepared.plan,prepared.file);writeJson(path.join(directory,'prepared/verification.json'),packVerification);
  // Compile and validate layout before changing a native instruction.
  const {buildAll}=require('./lib/native.cjs');
  const {buildContext}=require('./lib/context.cjs');const native=await buildAll(0x4000000000n,0x6000000000n,prepared.plan,{capture,directory:path.join(directory,'offline-build')});buildContext(prepared.plan,{fileObject:{object:0x6100000000n},filesystem:{object:0x6100001000n}},0x4000000000n,0x6000000000n,native);
  const {pythonCommand}=require('./lib/toolchain.cjs'),cp=require('node:child_process');
  const qualification=cp.spawnSync(pythonCommand(),[path.join(root,'native/verify.py'),path.join(directory,'prepared/overlay.json'),path.join(directory,'offline-build')],{stdio:'inherit'});if(qualification.error)throw qualification.error;check(qualification.status===0,'Compiled ARM64 reader qualification failed; no native hook was installed');
  const {upload}=require('./lib/upload.cjs');await upload(run,prepared.plan,prepared.file,directory);
  update({status:'installing',titleIds:prepared.plan.titleIds});
  const resident=await require('./lib/resident.cjs').install(run,prepared.plan,directory,capture);check(resident.verified,'Native overlay verification failed');
  if(o.keepRpc){update({status:'installed-rpc-held',titleIds:prepared.plan.titleIds});console.log('INSTALLED — RPC stays open. Stock RO restoration and game handoff have not run.');return;}
  const result=await require('./lib/native/handoff.cjs').apply(run,{residentDirectory:directory,contextMagic:'NS2LFS01'});check(result.stockRoProtocolVerified,'Stock RO verification failed');
  resident.stockRoRestored=true;resident.readyForGameHandoff=true;resident.handoff=result;writeJson(path.join(directory,'resident-install.json'),resident);
  update({status:'ready',titleIds:prepared.plan.titleIds});console.log('READY — Stop your ns2jb host with Ctrl+C and wait for cleanup. Close SmileBASIC without rebooting, then open your game.');
 }catch(error){update({status:'stopped',error:error.message,inspectBeforeRetry:true});throw error;}
}
module.exports={main,options,verifiedRun};
if(require.main===module)main().catch(error=>{console.error('INSTALL STOPPED: '+error.message);process.exitCode=1;});
