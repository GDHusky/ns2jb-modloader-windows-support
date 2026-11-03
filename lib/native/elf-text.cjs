'use strict';
const check=(ok,message)=>{if(!ok)throw Error(message);};
function textSection(elf,loadAddress=0n,externals={}) {
 const sh=Number(elf.readBigUInt64LE(40)),stride=elf.readUInt16LE(58),count=elf.readUInt16LE(60),strIndex=elf.readUInt16LE(62);
 const str=sh+stride*strIndex,so=Number(elf.readBigUInt64LE(str+24)),ss=Number(elf.readBigUInt64LE(str+32));
 const names=elf.subarray(so,so+ss);
 for(let i=0;i<count;i++) {
  const at=sh+i*stride,n=elf.readUInt32LE(at),end=names.indexOf(0,n);
  if(names.toString('utf8',n,end)==='.text') {
   const off=Number(elf.readBigUInt64LE(at+24)),size=Number(elf.readBigUInt64LE(at+32)),text=Buffer.from(elf.subarray(off,off+size));
   for(let j=0;j<count;j++) {
    const r=sh+j*stride;
    if(elf.readUInt32LE(r+4)!==4||elf.readUInt32LE(r+44)!==i)continue;
    const ro=Number(elf.readBigUInt64LE(r+24)),rs=Number(elf.readBigUInt64LE(r+32)),link=elf.readUInt32LE(r+40);
    const symbolTable=sh+link*stride,symbolOffset=Number(elf.readBigUInt64LE(symbolTable+24));
    for(let k=0;k<rs;k+=24) {
     const position=Number(elf.readBigUInt64LE(ro+k)),info=elf.readBigUInt64LE(ro+k+8),type=Number(info&0xffffffffn),index=Number(info>>32n);
     const sym=symbolOffset+index*24,section=elf.readUInt16LE(sym+6),value=elf.readBigUInt64LE(sym+8),addend=elf.readBigInt64LE(ro+k+16);
     check(type===282||type===283,'Unexpected trampoline relocation '+type);
     let symbol=value;
     if(section===0&&index!==0) {
      const strings=sh+elf.readUInt32LE(symbolTable+40)*stride,stringsOffset=Number(elf.readBigUInt64LE(strings+24));
      const begin=stringsOffset+elf.readUInt32LE(sym),end=elf.indexOf(0,begin),name=elf.toString('utf8',begin,end);
      check(Object.hasOwn(externals,name),'Undefined trampoline symbol: '+name);symbol=externals[name];
     }else check(section===0xfff1||index===0||section===i,'Nonlocal trampoline symbol');
     const target=(section===i?loadAddress:0n)+symbol+addend,delta=target-(loadAddress+BigInt(position));
     check(delta%4n===0n&&delta>=-0x8000000n&&delta<0x8000000n,'Branch outside native text reach');
     text.writeUInt32LE((text.readUInt32LE(position)&0xfc000000|Number(delta/4n&0x3ffffffn))>>>0,position);
    }
   }
   return text;
  }
 }
 throw Error('ELF has no text');
}
function sections(elf){
 check(elf.readUInt16LE(16)===2&&elf.readUInt16LE(18)===183,'Expected linked AArch64 ELF');
 const start=Number(elf.readBigUInt64LE(40)),stride=elf.readUInt16LE(58),count=elf.readUInt16LE(60),str=start+stride*elf.readUInt16LE(62),namesAt=Number(elf.readBigUInt64LE(str+24));
 const out=[];for(let i=0;i<count;i++){const at=start+stride*i,n=namesAt+elf.readUInt32LE(at);out.push({index:i,name:elf.toString('utf8',n,elf.indexOf(0,n)),type:elf.readUInt32LE(at+4),flags:elf.readBigUInt64LE(at+8),address:elf.readBigUInt64LE(at+16),offset:Number(elf.readBigUInt64LE(at+24)),size:Number(elf.readBigUInt64LE(at+32))});}return out;
}
module.exports={textSection,sections};
