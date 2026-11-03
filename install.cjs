#!/usr/bin/env node
'use strict';
// MKWorld-only RomFS installer. Every action is performed against a NEW
// ns2jb session. Never retry a potentially attached native hook in place.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=__dirname,mkw=path.join(root,'research/mkw-knockout-research');
const fail=message=>{throw new Error(message);};
const check=(yes,message)=>{if(!yes)fail(message);};
const modArg=process.argv[2],runArg=process.argv[3];
if(!modArg||!runArg){
 console.error('Usage: node install.cjs mods/MyMod /path/to/current/ns2jb/runs/switch2-XXXXXX');
 process.exit(2);
}
process.env.NS2_WORKSPACE=root;
const mod=path.resolve(modArg),run=path.resolve(runArg);
const session=path.basename(run),capture=path.join(mkw,'captures',session);
const planDir=path.join(mkw,'prepared','probe-pack');
const plan=path.join(planDir,'overlay.json');
function cmd(name,args){
 console.log('\n> '+[name,...args].join(' '));
 const result=cp.spawnSync(name,args,{cwd:root,stdio:'inherit',env:process.env});
 if(result.error)throw result.error;
 check(result.status===0,'Command failed: '+name+' '+args[0]);
}
function json(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function filesUnder(dir,base=dir){
 const out=[];
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const at=path.join(dir,entry.name);
  check(!entry.isSymbolicLink(),'Symlinks are not supported: '+at);
  if(entry.isDirectory())out.push(...filesUnder(at,base));
  else if(entry.isFile())out.push('/'+path.relative(base,at).split(path.sep).join('/'));
  else fail('Unsupported mod entry: '+at);
 }
 return out;
}
async function main(){
 check(fs.existsSync(mod)&&fs.statSync(mod).isDirectory(),'Mod folder not found: '+mod);
 const romfs=path.join(mod,'romfs');
 check(fs.existsSync(romfs)&&fs.statSync(romfs).isDirectory(),'Expected a romfs/ subfolder in '+mod);
 const resources=filesUnder(romfs);
 check(resources.length>0,'romfs/ is empty');
 check(new Set(resources).size===resources.length,'Duplicate mod paths');
 check(fs.existsSync(run),'ns2jb run directory not found: '+run);
 check(process.env.NS2_UPSTREAM&&fs.existsSync(path.join(process.env.NS2_UPSTREAM,'run.cjs')),'Set NS2_UPSTREAM to your Kurumuz ns2jb checkout');
 check(process.env.OUNCECAKE_ENGINE&&fs.existsSync(path.join(process.env.OUNCECAKE_ENGINE,'mounts.cjs')),'Set OUNCECAKE_ENGINE to the OunceCake engine directory');
 check(fs.existsSync(path.join(root,'research/superstars-mod/.venv/bin/python')),'Install the Python dependencies as shown in README');
 check(process.env.ZIG,'Set ZIG to the zig compiler path');
 const active=path.join(run,'switch2/fs-execution-current.json');
 check(fs.existsSync(active),'No qualified FS execution in this run. Finish ns2jb FS 4/4 first.');
 const current=json(active);
 check(current.file&&fs.existsSync(current.file),'FS execution proof is missing');
 const proof=json(current.file);
 check(proof.verified&&proof.session===session,'FS proof does not match this verified session');
 check(!fs.existsSync(path.join(capture,'resident-install.json')),'A resident installation already exists in this session. Reboot before retrying.');
 console.log('Mario Kart World — '+resources.length+' RomFS replacement(s):');
 for(const p of resources)console.log('  '+p);
 cmd('node',['research/superstars-mod/capture-fs.cjs',run]);
 cmd('node',['research/mkw-knockout-research/read-content.cjs',run,'--metadata-only']);
 const inventory=json(path.join(capture,'mkw-inventory.json'));
 check(inventory.complete&&inventory.temporarySessionClosed&&!inventory.cleanupErrors?.length,'MKWorld metadata capture failed');
 const view=inventory.mounts.find(v=>v.label==='update');
 check(view&&inventory.title==='0400c3f00006e000','Unexpected game or missing installed update');
 const originals=resources.map(file=>{
  const found=view.entries.filter(entry=>entry.type==='file'&&entry.path===file);
  check(found.length===1,'This RomFS path was not found in your installed Mario Kart World: '+file);
  check(found[0].size<=32*1024*1024,'Original file exceeds the current 32 MiB capture limit: '+file);
  return {file,size:found[0].size};
 });
 // read-more has a 32 MiB cap per call; keep each batch under that limit.
 let batch=[],bytes=0;
 const flush=()=>{if(batch.length){cmd('node',['research/mkw-knockout-research/read-more.cjs',run,...batch]);batch=[];bytes=0;}};
 for(const {file,size} of originals){
  if(bytes+size>32*1024*1024)flush();
  batch.push(file);bytes+=size;
 }
 flush();
 cmd('python3',['research/mkw-knockout-research/prepare-probe.py',capture,'--resources',mod,'--out',planDir]);
 const prepared=json(plan);
 check(prepared.session===session&&prepared.titleId==='0400c3f00006e000'&&prepared.resources?.length===resources.length,'Prepared pack does not match this session or resource set');
 cmd('node',['research/mkw-knockout-research/upload-pack.cjs',run,plan]);
 cmd('node',['research/mkw-knockout-research/install-resident.cjs',run,plan]);
 const journal=json(path.join(capture,'resident-install.json'));
 check(journal.verified&&journal.active&&journal.hookAttached,'Native reader did not qualify; do not proceed');
 const {apply}=require('./research/superstars-mod/restore-stock-ro.cjs');
 console.log('\n> Restore the stock RO service');
 const handoff=await apply(run,{residentDirectory:capture,contextMagic:'MKWFS002'});
 check(handoff.stockRoProtocolVerified,'Stock RO protocol verification failed');
 console.log('\nREADY — Mod installed for this boot.');
 console.log('1. Stop the ns2jb host normally (Ctrl+C); wait for cleanup.');
 console.log('2. Close SmileBASIC. Do not reboot.');
 console.log('3. Open Mario Kart World with the microSD inserted.');
}
main().catch(error=>{
 console.error('\nINSTALL STOPPED: '+(error?.stack||error));
 console.error('If an FS hook may have been installed, do NOT retry in this boot. Restart the console first.');
 process.exitCode=1;
});
