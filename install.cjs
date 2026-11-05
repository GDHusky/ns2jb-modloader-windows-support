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
install.cjs reads contents/ and exefs_patches/ beside this script unless --sd is used.
Start ns2jb separately and keep its verified FS 4/4 RPC host running.
--title can be repeated to select games or provide a target for global IPS patches.`;
function options(argv){
 const o={run:null,titles:[],check:false,keepRpc:false,sd:false};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];if(a==='--check')o.check=true;else if(a==='--keep-rpc')o.keepRpc=true;else if(a==='--sd')o.sd=true;else if(a==='--help')o.help=true;
  else{check(['--run-dir','--title'].includes(a),'Unknown option: '+a+'\n'+USAGE);const v=argv[++i];check(v&&!v.startsWith('--'),'Missing value after '+a);if(a==='--title')o.titles.push(titleId(v));else o.run=path.resolve(v);}
 }
 check(!o.check||!o.sd,'--check only checks local mod folders; use node install.cjs --check');return o;
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
  if(collection.patches.length)console.log(collection.patches.length+' global ExeFS patch file(s); Build IDs will be matched to installed games.');
 }
 if(o.check){describe(collectMods(root));console.log('Mod layout checked. No console connection was opened.');return;}
 require('./lib/native/artifacts.cjs').artifacts();
 const run=verifiedRun(o.run||await require('./lib/find-session.cjs').findSession(verifiedRun)),session=path.basename(run),directory=path.join(root,'state',session);fs.mkdirSync(directory,{recursive:true,mode:0o700});
 // The shared run lock also prevents installation from a second checkout.
 const lock=path.join(run,'ns2jb-modloader-install.json');fs.writeFileSync(lock,JSON.stringify({session,directory,started:new Date().toISOString(),status:'preparing'})+'\n',{flag:'wx',mode:0o600});
 const update=value=>writeJson(lock,{session,directory,...value});
 let collection,captures=[];const diagnostics=require('./lib/diagnostics.cjs'),reportPath=diagnostics.logPath(session);
 async function saveReport(plan,error){
  try{const report=diagnostics.report({session,sdPath:reportPath,collection,captures,plan,error,status:error?'stopped':'prepared'});await diagnostics.writeReport(run,report);return report;}
  catch(error){console.warn('WARNING: Could not save the SD report: '+error.message);return null;}
 }
 try{
  console.log('Using ns2jb session '+session);
  const {captureNative}=require('./lib/native-capture.cjs'),capture=await captureNative(run,directory);
  collection=o.sd?await require('./lib/sd-mods.cjs').collectSdMods(run,path.join(directory,'sd-inputs')):collectMods(root);describe(collection);await saveReport();
  const {captureOrCachedGame,cachedTitles}=require('./lib/game-cache.cjs'),cacheRoot=path.join(root,'state/game-cache');
  if(collection.patches.length&&!o.titles.length)for(const id of cachedTitles(cacheRoot,collection.patches))if(!collection.games.some(g=>g.titleId===id))collection.games.push({titleId:id,romfs:[],exefs:[],patches:[],stubs:[],autoForGlobalPatches:true});
  const pendingGames=[],attempted=new Set(),matched=new Set(),{matchesPatch}=require('./lib/exefs.cjs');
  async function inspect(g){
   attempted.add(g.titleId);const dir=path.join(directory,'games',g.titleId);console.log('Inspecting '+g.titleId);
   const captureGame=(...args)=>require('./lib/content.cjs').captureGame(...args,collection.bootstrap);
   const entry=await captureOrCachedGame(run,g,dir,collection.patches,cacheRoot,captureGame);
   if(entry.pending){g.unavailable=true;pendingGames.push(entry);console.warn('PENDING '+g.titleId+': '+entry.reason);return;}
   captures.push(entry);if(entry.deferred)console.log(g.titleId+': using saved preparation; mods will be ready when this game is available.');
   for(const row of (entry.inventory.exefs||entry.inventory.exefsIndex)?.files||[])if(row.buildId)for(const patch of collection.patches)if(matchesPatch(patch,row.name,row.buildId))matched.add(patch.file);
  }
  for(const g of collection.games)await inspect(g);
  if(!o.titles.length&&collection.patches.some(p=>!matched.has(p.file))){
   const {attachGame}=require('./lib/game-files/session.cjs'),{discoverApplications}=require('./lib/game-files/content.cjs'),a=await attachGame(run);let apps;
   try{apps=await discoverApplications(a);}finally{await a.close();}
   for(const app of apps)if(!attempted.has(app.contentTitle)){
    const g={titleId:app.contentTitle,romfs:[],exefs:[],patches:[],stubs:[],autoForGlobalPatches:true};collection.games.push(g);await inspect(g);
   }
  }
  collection.games=collection.games.filter(g=>!g.unavailable);
  writeJson(path.join(directory,'pending-games.json'),pendingGames);
  if(!collection.games.length){update({status:'no-games-available',pendingGames});await saveReport({views:[],exefs:[],sources:[],pendingGames});console.log('No mods loaded. Make a pending game available for its first preparation.');return;}
  const {prepare}=require('./lib/prepare.cjs'),prepared=await prepare(collection,captures,path.join(directory,'prepared'),session);console.log('Prepared '+prepared.plan.views.length+' RomFS views and '+prepared.plan.exefs.length+' ExeFS modules');
  prepared.plan.pendingGames=pendingGames;const report=await saveReport(prepared.plan);if(report)prepared.plan.diagnostics={...report,buffer:undefined,text:report.buffer.toString('utf8'),size:report.buffer.length};writeJson(path.join(directory,'prepared/overlay.json'),prepared.plan);
  warnIgnoredPatches(prepared.plan);
  const packVerification=await require('./lib/verify-plan.cjs').verifyPlan(prepared.plan,prepared.file);writeJson(path.join(directory,'prepared/verification.json'),packVerification);
  if(collection.reader){await collection.reader.close();collection.reader=null;}
  // Relocate the release-qualified templates and validate the actual layout.
  const {buildAll}=require('./lib/native.cjs');
  const {buildContext}=require('./lib/context.cjs');const native=await buildAll(0x4000000000n,0x6000000000n,prepared.plan,{capture,directory:path.join(directory,'offline-build')});buildContext(prepared.plan,{filesystem:{object:0x6100001000n},...(prepared.plan.diagnostics?{logFile:{object:0x6100002000n,write:0x4000105000n,flush:0x4000105300n}}:{})},0x4000000000n,0x6000000000n,native,0,fs.readFileSync(prepared.file));
  const {upload}=require('./lib/upload.cjs');await upload(run,prepared.plan,prepared.file,directory);
  update({status:'installing',titleIds:prepared.plan.titleIds});
  const resident=await require('./lib/resident.cjs').install(run,prepared.plan,directory,capture,collection.bootstrap);check(resident.verified,'Native overlay verification failed');
  if(o.keepRpc){update({status:'installed-rpc-held',titleIds:prepared.plan.titleIds});console.log('INSTALLED — RPC stays open. Stock RO restoration and game handoff have not run.');return;}
  const result=await require('./lib/native/handoff.cjs').apply(run,{residentDirectory:directory,contextMagic:'NS2LFS02'});check(result.stockRoProtocolVerified,'Stock RO verification failed');
  resident.stockRoRestored=true;resident.readyForGameHandoff=true;resident.handoff=result;writeJson(path.join(directory,'resident-install.json'),resident);
  update({status:'ready',titleIds:prepared.plan.titleIds,deferredGames:prepared.plan.deferredGames,pendingGames});console.log('READY — Stop your ns2jb host with Ctrl+C and wait for cleanup. Close SmileBASIC without rebooting, then open your game.');
 }catch(error){update({status:'stopped',error:error.message,inspectBeforeRetry:true});if(!/pending|timed out|disconnected/i.test(error.message)){if(collection?.reader){await collection.reader.close();collection.reader=null;}await saveReport(null,error);}throw error;}
 finally{if(!collection?.bootstrap?.bridge.c.pending){if(collection?.reader)await collection.reader.close();if(collection?.bootstrap&&!collection.bootstrap.transferred)await collection.bootstrap.release();}}
}
module.exports={main,options,verifiedRun,warnIgnoredPatches};
if(require.main===module)main().catch(error=>{console.error('INSTALL STOPPED: '+error.message);process.exitCode=1;});
