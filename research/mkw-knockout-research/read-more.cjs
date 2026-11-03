'use strict';
// Additional exact-path reads in a previously inventoried held session.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createGameFiles,attachGame,discoverUpdates}=require('../superstars-mod/inspect-game.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const check=(x,s)=>{if(!x)throw Error(s);};
async function main(run,requested) {
 check(run&&requested.length,'Usage: node read-more.cjs RUN /exact/romfs/path [...]');
 run=path.resolve(run);const session=path.basename(run),out=path.join(__dirname,'captures',session);
 const inventory=JSON.parse(await fs.readFile(path.join(out,'mkw-inventory.json')));
 check(inventory.complete&&inventory.temporarySessionClosed&&!inventory.cleanupErrors.length&&inventory.session===session,'Incomplete capture or wrong session');
 const view=inventory.mounts.find(x=>x.label==='update')??inventory.mounts[0];
 const entries=[...new Set(requested)].map(name=>{
  const match=view.entries.filter(x=>x.path===name&&x.type==='file');
  check(match.length===1,'No unique file: '+name);return match[0];
 });
 check(entries.reduce((n,x)=>n+x.size,0)<=32*1024*1024,'Additional reads exceed 32 MiB');
 const a=await attachGame(run),files=createGameFiles(a);let mount,error;
 const report={session,title:inventory.title,readOnly:true,started:new Date().toISOString(),files:[]};
 const filename=path.join(out,'additional-reads-'+Date.now()+'.json');
 try {
  const updates=await discoverUpdates({...a,title:inventory.title});
  const update=view.label==='update'?updates.find(x=>x.version===view.source.version):undefined;
  check(view.label!=='update'||update,'Previously inventoried update is absent');
  mount=await files.open({title:inventory.title,storage:inventory.storage,...(update?{update}:{})});
  check(mount.size===view.size&&mount.source.contentId===view.source.contentId&&mount.source.version===view.source.version,'Content changed since inventory');
  const header=await files.read(mount,0,80),before=view.metadata.find(x=>x.offset===0&&x.length===80);
  check(before&&hash(header)===before.sha256,'RomFS header identity changed');
  for(const entry of entries) {
   const parts=[];
   for(let offset=0;offset<entry.size;offset+=0x40000){
    const length=Math.min(0x40000,entry.size-offset),bytes=await files.read(mount,entry.offset+offset,length);
    check(bytes.length===length,'Short resource read');parts.push(bytes);
   }
   const bytes=Buffer.concat(parts),localPath=path.join(view.label,'romfs',entry.path.slice(1)),dest=path.join(out,localPath);
   await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o700});await fs.writeFile(dest,bytes,{mode:0o600});
   check(hash(await fs.readFile(dest))===hash(bytes),'Saved file hash differs');
   report.files.push({...entry,localPath,sha256:hash(bytes)});
   await fs.writeFile(filename,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(entry.path,entry.size);
  }
  report.complete=true;
 }catch(e){error=e;report.error=e.stack;}
 finally {
  report.cleanupErrors=[];
  if(mount)try{await files.close(mount);}catch(e){report.cleanupErrors.push(e.stack);}
  try{await a.close();report.temporarySessionClosed=true;}catch(e){report.cleanupErrors.push(e.stack);}
  report.finished=new Date().toISOString();await fs.writeFile(filename,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 }
 if(error)throw error;check(!report.cleanupErrors.length,'Temporary session cleanup failed');
 console.log(JSON.stringify({filename,complete:report.complete,temporarySessionClosed:report.temporarySessionClosed}));
}
if(require.main===module)main(process.argv[2],process.argv.slice(3)).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={main};
