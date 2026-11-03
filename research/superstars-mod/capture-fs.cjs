'use strict';
// Captures executable/readonly native FS mappings through upstream RO bulk read.
// Each temporary alias is removed by the upstream helper before it replies.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
async function main(run) {
  run=path.resolve(run);
  const {Client}=require(path.join(run,'switch2/process/client.cjs'));
  const c=await new Client().open();
  const out=path.join(__dirname,'captures',path.basename(run),'native-fs');
  await fs.mkdir(out,{recursive:true});
  const current=JSON.parse(await fs.readFile(path.join(run,'switch2/fs-execution-current.json')));
  const proof=JSON.parse(await fs.readFile(current.file));
  if(proof.session!==path.basename(run)||!proof.verified||!proof.mapping?.memory?.address)throw Error('Missing same-session FS execution proof');
  const record={session:path.basename(run),started:new Date().toISOString(),readOnly:true,
    scope:'native FS main text and adjacent rodata only',mappings:[]};
  try {
    const h=await c.fsProcess();
    let at=BigInt(proof.mapping.memory.address);
    // The third mapping is not part of this capture contract. Capture exactly
    // main text and adjacent rodata, rather than failing after valid captures.
    for(let i=0;i<2;i++) {
      const info=await c.info(h,at,8n);
      if(info.result || info.programId!=='0400000000000000' ||
         info.memory.type!==3 || info.memory.attributes ||
         !(i===0?[4,5]:[1]).includes(info.memory.permissions)) throw Error('Unexpected native FS mapping');
      const start=BigInt(info.memory.address), size=Number(info.memory.size);
      if(start!==at || size<=0 || size>0x2000000) throw Error('Capture mapping exceeds bound or is not adjacent');
      const row={...info,role:i===0?'text':'rodata',memory:{...info.memory},chunks:[]};record.mappings.push(row);
      const parts=[];
      console.log('Mapping',String(start),size,info.memory.permissions);
      for(let off=0;off<size;off+=0x200000) {
        const len=Math.min(0x200000,size-off),input=Buffer.alloc(32);
        [8n,start+BigInt(off),BigInt(len),0n].forEach((v,j)=>input.writeBigUInt64LE(v,j*8));
        const reply=await c.worker({kind:'ro-process',handle:c.handle,processHandle:h,id:0x524f0016,hex:input.toString('hex')},30000);
        if(reply.transport||reply.result||reply.kernelPid!==String(c.pid)||reply.length!==len)throw Error('Bulk read failed');
        const meta=Buffer.from(reply.data,'hex');
        if(meta.readBigUInt64LE(0)!==8n||meta.readBigUInt64LE(8)!==0x0400000000000000n||meta.readBigUInt64LE(32)!==0n||meta.readBigUInt64LE(40)!==0n)throw Error('Wrong FS identity or alias cleanup');
        const b=await fs.readFile(reply.outputFile);
        const hash=crypto.createHash('sha256').update(b).digest('hex');
        if(b.length!==len||hash!==reply.sha256)throw Error('Bulk output mismatch');
        const filename=(start+BigInt(off)).toString(16)+'.bin';
        await fs.writeFile(path.join(out,filename),b,{mode:0o600});
        row.chunks.push({offset:off,length:len,filename,sha256:hash,aliasUnmapped:true});
        parts.push(b);
      }
      const assembled=Buffer.concat(parts);
      if(assembled.length!==size)throw Error('Incomplete assembled FS mapping');
      row.assembled={filename:i===0?'fs-4.bin':'fs-rodata.bin',size,
        sha256:crypto.createHash('sha256').update(assembled).digest('hex')};
      await fs.writeFile(path.join(out,row.assembled.filename),assembled,{mode:0o600});
      at=start+BigInt(size);
    }
    record.complete=true;
  }catch(e){record.error=e.stack;throw e;}
  finally {await c.close();record.closed=!c.pending;record.finished=new Date().toISOString();await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});}
}
if(require.main===module)main(process.argv[2]).catch(e=>{console.error(e.stack);process.exitCode=1;});
