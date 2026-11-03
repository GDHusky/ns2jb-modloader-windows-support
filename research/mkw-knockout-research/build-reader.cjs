'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {assemble,CAVE}=require('../superstars-mod/native-bridge.cjs');
async function build(base=0x4000000000n,context=0x6000000100n){
 const dir=path.join(__dirname,'build/reader');
 const source=(await fs.readFile(path.join(__dirname,'resident-reader.S'),'utf8')).replace('MKW_CONTEXT',String(context));
 const code=await assemble(dir,source,base+BigInt(CAVE),{original_read:base+0x1077b0n,original_size_tail:base+0x107604n,source_read:base+0x104ef0n});
 if(code.length>0xf00)throw Error('Reader exceeds the FS text padding page');
 const symbols=cp.execFileSync('readelf',['-sW',path.join(dir,'native.o')],{encoding:'utf8'});
 const offsets={};
 for(const name of ['_start','mkw_size','original_size']){
  const line=symbols.split('\n').find(x=>x.trim().endsWith(' '+name));if(!line)throw Error('Missing native symbol '+name);
  offsets[name]=parseInt(line.trim().split(/\s+/)[1],16);
 }
 const layout={base:String(base),context:String(context),entry:String(base+BigInt(CAVE)),offsets,codeBytes:code.length,sha256:crypto.createHash('sha256').update(code).digest('hex')};
 await fs.writeFile(path.join(__dirname,'build/resident-reader.bin'),code,{mode:0o600});
 await fs.writeFile(path.join(__dirname,'build/reader-layout.json'),JSON.stringify(layout,null,2)+'\n');return{code,layout};
}
if(require.main===module)build(process.argv[2]?BigInt(process.argv[2]):undefined,process.argv[3]?BigInt(process.argv[3]):undefined).then(x=>console.log(JSON.stringify(x.layout))).catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={build};
