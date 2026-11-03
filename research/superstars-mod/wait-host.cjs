'use strict';
const os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(process.env.NS2_WORKSPACE || path.join(__dirname,'../..'));
async function main(){
 const upstream=process.env.NS2_UPSTREAM;
 if(!upstream||!require('node:fs').existsSync(path.join(upstream,'run.cjs')))throw Error('Set NS2_UPSTREAM to your Kurumuz ns2jb folder (containing run.cjs).');
 console.log('Waiting for LAN 192.168.50.1; upstream acquisition is unchanged.');
 while(!Object.values(os.networkInterfaces()).flat().some(x=>x.address==='192.168.50.1'))await new Promise(r=>setTimeout(r,2000));
 const child=cp.spawn(process.execPath,[path.join(path.resolve(upstream),'run.cjs'),'--rpc','192.168.50.1'],{cwd:root,stdio:'inherit'});
 child.once('error',error=>{console.error('Cannot start ns2jb: '+error.message);process.exitCode=1;});
 process.once('SIGINT',()=>child.kill('SIGINT'));
 process.once('SIGTERM',()=>child.kill('SIGTERM'));
 child.once('exit',code=>{process.exitCode=code??1;});
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
