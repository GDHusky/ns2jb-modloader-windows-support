"""Exercise the actual compiled ARM64 overlay, including virtual-size reads.

Original SDK calls are modeled. PAC and atomic instructions are modeled where
Unicorn lacks support. This tests the reader, not the game's rescue/item logic.
"""
import argparse,hashlib,json,struct,random,subprocess
from pathlib import Path
from unicorn import Uc,UC_ARCH_ARM64,UC_MODE_ARM,UC_HOOK_CODE
from unicorn.arm64_const import *
from capstone import Cs,CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN

HERE=Path(__file__).resolve().parent
layout=json.loads((HERE/'build/reader-layout.json').read_text())
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--plan',type=Path,default=HERE/'prepared/probe-pack/overlay.json')
parser.add_argument('--capture',type=Path)
args=parser.parse_args()
# Use the production serializer, including schema-3 capture qualification.
bootstrap="""const {loadPlan,buildContext}=require('./resident-context.cjs');
(async()=>{const p=await loadPlan(process.argv[1],process.argv[2]);
const c=buildContext(p,{fileObject:{object:0x5200000180n},filesystem:{object:0x5200000200n}},BigInt(process.argv[3]),BigInt(process.argv[4]),1);
console.log(JSON.stringify({plan:p,contextHex:c.toString('hex')}));})().catch(e=>{console.error(e.stack);process.exitCode=1;});"""
serialized=json.loads(subprocess.check_output(['node','-e',bootstrap,str(args.plan.resolve()),str(args.capture.resolve())if args.capture else '',layout['base'],layout['context']],cwd=HERE))
plan=serialized['plan'];context=bytes.fromhex(serialized['contextHex'])
payload=(args.plan.parent/plan['payload'].get('filename','probe-pack.bin')).read_bytes()
code=(HERE/'build/resident-reader.bin').read_bytes()
assert len(code)==layout['codeBytes'] and hashlib.sha256(code).hexdigest()==layout['sha256']
BASE=int(layout['base']);ENTRY=int(layout['entry']);CONTEXT=int(layout['context'])
STACK=0x5000000000;OUTPUT=0x5100000100;OBJECT=0x5200000100;RETURN=0x5300000000
md=Cs(CS_ARCH_ARM64,CS_MODE_LITTLE_ENDIAN);insns={i.address:i for i in md.disasm(code,ENTRY)}
regs={f'x{i}':UC_ARM64_REG_X0+i for i in range(29)};count=0
captured_regions=[]
if plan['schema']==3:
    capture=args.capture or HERE/'captures'/plan['session']
    inventory=json.loads((capture/'mkw-inventory.json').read_text())
    mount=next(v for v in inventory['mounts']if v['label']=='update')
    for row in mount['metadata']:
        blob=(capture/'update'/row['filename']).read_bytes()
        assert len(blob)==row['length'] and hashlib.sha256(blob).hexdigest()==row['sha256']
        captured_regions.append((row['offset'],blob))
    for view in plan['views']:
        fp=view['fingerprint'];blob=(capture/fp['localPath']).read_bytes()
        assert hashlib.sha256(blob).hexdigest()==fp['sha256']
        captured_regions.append((view['fingerprintDataOffset'],blob))


def run(view,offset,length,*,method='read',matches=True,active=True,original_error=0,source_error=0,short=False,identity_mismatch=None):
    global count
    uc=Uc(UC_ARCH_ARM64,UC_MODE_ARM)
    regions=[(ENTRY&~4095,4096),(CONTEXT&~4095,8192),(STACK,0x10000),
             (OUTPUT&~4095,0x202000),(OBJECT&~4095,8192),(RETURN,4096),
             (BASE+0x107000,4096),(BASE+0x104000,4096)]
    for at,size in regions:uc.mem_map(at,size)
    uc.mem_write(ENTRY,code);ctx=bytearray(context)
    struct.pack_into('<I',ctx,8,int(active))
    uc.mem_write(CONTEXT,bytes(ctx));uc.mem_write(OBJECT,struct.pack('<QQ',OUTPUT,length))
    uc.mem_write(OUTPUT-32,b'G'*32);uc.mem_write(OUTPUT+length,b'H'*32)
    sp=STACK+0xf000;uc.reg_write(UC_ARM64_REG_SP,sp)
    args=[OBJECT,OBJECT+64]if method=='size'else[OBJECT,offset,OBJECT,length]
    for i,v in enumerate(args):uc.reg_write(UC_ARM64_REG_X0+i,v)
    uc.reg_write(UC_ARM64_REG_X30,RETURN)
    preserved={i:0x1234560000+i for i in range(18,29)}
    for i,v in preserved.items():uc.reg_write(UC_ARM64_REG_X0+i,v)
    calls=[];native_reads=[];comparisons=[];trail=[]
    def original_bytes(at,n):
        out=bytearray([0x6b])*n
        regions=captured_regions or [(0,bytes.fromhex(view['headerHex'])),
                        (view['fingerprintFileEntryOffset'],bytes.fromhex(view['originalFileEntryHex'])),
                        (view['fingerprintDataOffset'],bytes.fromhex(view['originalPrefixHex']))]
        for start,b in regions:
            lo=max(at,start);hi=min(at+n,start+len(b))
            if hi>lo:out[lo-at:hi-at]=b[lo-start:hi-start]
        if not matches and at==0 and n:out[0]^=1
        if identity_mismatch:
            target=view['fingerprintFileEntryOffset']if identity_mismatch=='entry'else view['fingerprintDataOffset']
            if at<=target<at+n:out[target-at]^=1
        return bytes(out)
    def ret(value):uc.reg_write(UC_ARM64_REG_X0,value);uc.reg_write(UC_ARM64_REG_PC,uc.reg_read(UC_ARM64_REG_X30))
    def hook(_,pc,size,user):
        if pc==RETURN:uc.emu_stop();return
        if pc==BASE+0x107604:
            assert uc.reg_read(UC_ARM64_REG_X0)==OBJECT
            if original_error and method=='size':ret(original_error);return
            uc.mem_write(uc.reg_read(UC_ARM64_REG_X1),struct.pack('<Q',view['storageSize']));ret(0);return
        if pc==BASE+0x1077b0:
            obj,at,pair,n=[uc.reg_read(UC_ARM64_REG_X0+i)for i in range(4)]
            native_reads.append((at,n))
            assert obj==OBJECT+8
            ptr,cap=struct.unpack('<QQ',uc.mem_read(pair,16));assert n<=cap
            if original_error:ret(original_error);return
            if at+n>view['storageSize']:ret(0xc102);return
            uc.mem_write(ptr,original_bytes(at,n));ret(0);return
        if pc==BASE+0x104ef0:
            obj,result,at,pair,n,option=[uc.reg_read(UC_ARM64_REG_X0+i)for i in range(6)]
            assert obj==OBJECT+128 and option==0 and at+n<=len(payload)
            ptr,cap=struct.unpack('<QQ',uc.mem_read(pair,16));assert n<=cap
            calls.append((at,n))
            if source_error:ret(source_error);return
            uc.mem_write(ptr,payload[at:at+n]);uc.mem_write(result,struct.pack('<Q',n-int(short)));ret(0);return
        ins=insns.get(pc)
        if ins and not ins.mnemonic in ['ldrb','cmp','b.ne','subs']:
            trail.append((hex(pc-ENTRY),ins.mnemonic,ins.op_str,uc.reg_read(UC_ARM64_REG_X11),uc.reg_read(UC_ARM64_REG_X25)))
            if len(trail)>28:trail.pop(0)
        if ins and ins.mnemonic=='cmp'and ins.op_str=='w12, w13':
            left=uc.reg_read(UC_ARM64_REG_X12);right=uc.reg_read(UC_ARM64_REG_X13)
            if left!=right:comparisons.append((uc.reg_read(UC_ARM64_REG_X8),uc.reg_read(UC_ARM64_REG_X9),left,right))
        if ins and ins.mnemonic=='pacibsp':uc.reg_write(UC_ARM64_REG_PC,pc+4)
        elif ins and ins.mnemonic=='retab':uc.reg_write(UC_ARM64_REG_PC,uc.reg_read(UC_ARM64_REG_X30))
        elif ins and ins.mnemonic in ['stadd','ldadd']:
            parts=ins.op_str.replace('[','').replace(']','').split(', ')
            src=uc.reg_read(regs[parts[0]]);addr=uc.reg_read(regs[parts[-1]])
            old=struct.unpack('<Q',uc.mem_read(addr,8))[0]
            uc.mem_write(addr,struct.pack('<Q',(old+src)&0xffffffffffffffff))
            if ins.mnemonic=='ldadd'and parts[1]!='xzr':uc.reg_write(regs[parts[1]],old)
            uc.reg_write(UC_ARM64_REG_PC,pc+4)
    uc.hook_add(UC_HOOK_CODE,hook)
    entry=ENTRY+layout['offsets']['mkw_size']if method=='size'else ENTRY
    uc.emu_start(entry,RETURN,count=2000000)
    result=uc.reg_read(UC_ARM64_REG_X0)&0xffffffff
    expected_error=original_error or(source_error if calls else 0)or(0xd401 if calls and short else 0)
    effective_matches=matches and not identity_mismatch
    if method=='read'and(offset+length>view['virtualSize']or((not active or not effective_matches)and offset+length>view['storageSize'])):
        expected_error=original_error or 0xc102
    assert result==expected_error,(method,offset,length,result,expected_error)
    assert uc.reg_read(UC_ARM64_REG_SP)==sp
    assert struct.unpack('<Q',uc.mem_read(CONTEXT+96,8))[0]==0
    for i,v in preserved.items():assert uc.reg_read(UC_ARM64_REG_X0+i)==v,('clobbered',i)
    assert bytes(uc.mem_read(OUTPUT-32,32))==b'G'*32
    assert bytes(uc.mem_read(OUTPUT+length,32))==b'H'*32
    if method=='size'and not expected_error:
        got=struct.unpack('<Q',uc.mem_read(OBJECT+64,8))[0]
        assert got==(view['virtualSize']if active and matches and not original_error else view['storageSize'])
    if method=='read'and not expected_error:
        expected=bytearray(original_bytes(offset,length))
        if active and effective_matches:
            for j in range(length):
                if offset+j>=view['storageSize']:expected[j]=0
            for s in view['segments']:
                lo=max(offset,s['offset']);hi=min(offset+length,s['offset']+s['length'])
                if hi>lo:expected[lo-offset:hi-offset]=payload[s['sourceOffset']+lo-s['offset']:s['sourceOffset']+hi-s['offset']]
        actual=bytes(uc.mem_read(OUTPUT,length))
        if actual!=expected:
            at=next(i for i,(x,y)in enumerate(zip(actual,expected))if x!=y)
            raise AssertionError((offset,length,'mismatchAt',at,'actual',actual[at:at+16].hex(),
                                  'expected',expected[at:at+16].hex(),'sourceCalls',calls,
                                  'matches',struct.unpack('<Q',uc.mem_read(CONTEXT+24,8))[0],
                                  'nativeReads',native_reads,'comparisons',comparisons,'trail',trail))
    count+=1
    return bytes(uc.mem_read(OUTPUT,length))if method=='read'and not expected_error else None


random.seed(72)
for view in plan['views']:
    for options in [{},{'matches':False},{'active':False},{'original_error':0x1234}]:run(view,0,0,method='size',**options)
    for options in [{},{'matches':False},{'active':False},{'original_error':0x1234}]:run(view,0,80,**options)
    for s in view['segments']:
        ranges=[(s['offset'],min(s['length'],0x10000)),(max(0,s['offset']-1),2),
                (s['offset']+s['length']-1,2),(max(0,s['offset']-16),min(s['length']+32,0x10000))]
        ranges +=[(s['offset']+random.randrange(s['length']),1)for _ in range(8)]
        for offset,n in ranges:run(view,offset,n)
        for options in [{'source_error':0xbeef},{'short':True},{'active':False},{'matches':False}]:
            run(view,s['offset'],min(s['length'],4096),**options)
    for offset,n in[(view['storageSize']-8,16),(view['storageSize'],32),(view['virtualSize'],1),
                    (0,0),(view['storageSize']-1,1)]:run(view,offset,n)
    for identity in ['entry','prefix']:
        run(view,0,80,identity_mismatch=identity)
        run(view,view['storageSize'],32,identity_mismatch=identity)
    if plan['schema']==3:
        assert run(view,0,80).hex()==plan['newHeaderHex']
        # All four relocated index regions: first, interior, and trailing reads.
        header=struct.unpack('<10Q',bytes.fromhex(plan['newHeaderHex']))
        for i in [1,3,5,7]:
            offset,n=header[i:i+2]
            for at,length in [(offset,min(n,4096)),(offset+n//2,min(n-n//2,4096)),(offset+n-16,16)]:
                run(view,at,length)
        # Exercise every added/replaced file through the compiled native reader.
        for resource in plan['resources']:
            for at,n in [(resource['offset'],min(resource['size'],4096)),(resource['offset']+resource['size']-16,16)]:
                run(view,at,n)
        fp=view['fingerprint']
        original=run(view,view['fingerprintDataOffset'],min(fp['size'],0x10000))
        assert original==(capture/fp['localPath']).read_bytes()[:len(original)]
        # One request spans native EOF, zero-filled alignment, and SD extension.
        extension=view['segments'][1]
        run(view,view['storageSize']-16,extension['offset']-view['storageSize']+32)
print(json.dumps({'passed':count,'codeBytes':len(code),'virtualSizeReads':True,'guardBytes':True,
                  'schema':plan['schema'],'capturedOriginalMetadata':bool(captured_regions),
                  'resourceReads':len(plan['resources'])if plan['schema']==3 else 0,
                  'x18AndCalleeSavedPreserved':True,'nativeSdkAndPacModeled':True,
                  'getSizeIdentity':'original size + header (inherited native behavior)'}))
