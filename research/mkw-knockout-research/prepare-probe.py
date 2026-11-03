"""Pack verified local resource probes into a virtual RomFS overlay.

The installed storage is not edited. Larger resources are placed after the
original virtual storage extent; its selected GetSize/Read views are extended.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

HERE=Path(__file__).resolve().parent
def sha(b):return hashlib.sha256(b).hexdigest()
def align(x,n=4096):return(x+n-1)&-n


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('capture',type=Path)
    p.add_argument('--resources',type=Path,nargs='+',required=True)
    p.add_argument('--out',type=Path,default=HERE/'prepared/probe-pack')
    args=p.parse_args();capture=args.capture.resolve();out=args.out.resolve();inv=json.loads((capture/'mkw-inventory.json').read_text())
    if not inv.get('complete')or not inv.get('temporarySessionClosed')or inv.get('cleanupErrors'):raise ValueError('Incomplete source acquisition')
    view=next(v for v in inv['mounts']if v['label']=='update');entries={x['path']:x for x in view['entries']if x['type']=='file'}
    resources={}
    for directory in args.resources:
        for file in sorted((directory/'romfs').rglob('*')):
            if not file.is_file():continue
            name='/'+file.relative_to(directory/'romfs').as_posix()
            if name in resources:raise ValueError('Multiple probes modify '+name)
            if name not in entries:raise ValueError('Probe resource is not in the current game')
            resources[name]=file.read_bytes()
    if not resources:raise ValueError('No probe resources')
    def captured(offset,length):
        parts=[];at=offset
        while at<offset+length:
            row=next((r for r in view['metadata']if r['offset']<=at<r['offset']+r['length']),None)
            if row is None:raise ValueError('Metadata interval not captured')
            blob=(capture/view['label']/row['filename']).read_bytes()
            if len(blob)!=row['length']or sha(blob)!=row['sha256']:raise ValueError('Captured metadata differs')
            n=min(offset+length-at,row['offset']+row['length']-at)
            parts.append(blob[at-row['offset']:at-row['offset']+n]);at+=n
        return b''.join(parts)
    header=captured(0,80);h=struct.unpack('<10Q',header)
    table=captured(h[7],h[8]);records={}
    at=0
    while at<len(table):
        if at+32>len(table):raise ValueError('Truncated file table')
        n=struct.unpack_from('<I',table,at+28)[0]
        if n>0x300 or at+32+n>len(table):raise ValueError('Bad RomFS filename')
        basename=table[at+32:at+32+n].decode();offset,size=struct.unpack_from('<QQ',table,at+8)
        records.setdefault((basename,h[9]+offset,size),[]).append(at)
        at=align(at+32+n,4)
    pack=bytearray();segments=[];reports=[];virtual_size=view['size']
    def source(data):
        pack.extend(b'\0'*(-len(pack)%16));at=len(pack);pack.extend(data);return at
    for name,data in sorted(resources.items()):
        entry=entries[name];original=(capture/'update/romfs'/name.lstrip('/')).read_bytes()
        if len(original)!=entry['size']:raise ValueError('Original resource missing or truncated')
        matches=records.get((Path(name).name,entry['offset'],entry['size']),[])
        if len(matches)!=1:raise ValueError('Resource file record is not unique')
        record_at=matches[0];file_entry_offset=h[7]+record_at
        offset=entry['offset']if len(data)<=len(original)else align(virtual_size)
        if offset>=view['size']:virtual_size=align(offset+len(data),16)
        segments.append({'kind':'resource','offset':offset,'length':len(data),'sourceOffset':source(data),'path':name})
        metadata=struct.pack('<QQ',offset-h[9],len(data));old=table[record_at+8:record_at+24]
        if old!=metadata:segments.append({'kind':'metadata','offset':file_entry_offset+8,'length':16,'sourceOffset':source(metadata),'path':name})
        reports.append({'path':name,'originalOffset':entry['offset'],'overlayOffset':offset,
                        'fileEntryOffset':file_entry_offset,'originalFileEntryHex':table[record_at:record_at+32].hex(),
                        'originalPrefixHex':original[:128].hex(),'originalSize':len(original),'modifiedSize':len(data),
                        'sourceSha256':sha(original),'modifiedSha256':sha(data),'usesVirtualExtension':offset>=view['size']})
    segments.sort(key=lambda r:r['offset'])
    for left,right in zip(segments,segments[1:]):
        if left['offset']+left['length']>right['offset']:raise ValueError('Overlapping overlay segments')
    identity=reports[0]
    if len(bytes.fromhex(identity['originalPrefixHex']))!=128:raise ValueError('Identity resource too short')
    plan={'schema':2,'titleId':inv['title'],'session':inv['session'],
          'status':'Locally built, awaiting native verification and game test',
          'sourceContentId':view['source']['contentId'],'sourceVersion':view['source']['version'],
          'payload':{'filename':'probe-pack.bin','size':len(pack),'sha256':sha(pack),
                     'sdPath':'/roms/mkw_probe_'+sha(pack)[:12]+'.bin'},
          'views':[{'label':'update','storageSize':view['size'],'virtualSize':virtual_size,'headerHex':header.hex(),
                    'fingerprintFileEntryOffset':identity['fileEntryOffset'],
                    'fingerprintDataOffset':identity['originalOffset'],
                    'originalFileEntryHex':identity['originalFileEntryHex'],
                    'originalPrefixHex':identity['originalPrefixHex'],'segments':segments}],
          'resources':reports,'installed':False,'inGameVerified':False}
    out.mkdir(parents=True,exist_ok=True);(out/'probe-pack.bin').write_bytes(pack)
    (out/'overlay.json').write_text(json.dumps(plan,indent=2)+'\n')
    print(json.dumps({'out':str(out),'payload':plan['payload'],'resourceCount':len(reports),
                      'segments':len(segments),'originalStorageSize':view['size'],'virtualStorageSize':virtual_size,
                      'installed':False},indent=2))


if __name__=='__main__':main()
