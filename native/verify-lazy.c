/* Host regression checks for the on-mount reader. Build and run:
 * cc -I native native/verify-lazy.c native/{romfs,namespace,diagnostics,lazy,lazy-romfs,lazy-codefs,lazy-nso}.c -o /tmp/verify-lazy
 * /tmp/verify-lazy
 * Add -fsanitize=address,undefined for allocation and bounds checks. */
#include "lazy.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>

struct object {void **vt; uint64_t pad[3];uint32_t refs,kind;uint64_t cursor;uint8_t *data;uint64_t size;const char *name;uint64_t reserved[8];};
struct input {const char *path;uint8_t *data;uint64_t size;};
static struct lfs_context context;
static struct ns_context ns;
static struct lfs_lazy_config lazy;
static struct input inputs[20];static unsigned input_count;
static struct object *source,*gamefs;
static void *vt[16];
static uint64_t blocks,block_bytes,objects,fail_at,allocations,source_opens;
static uint64_t writes,flushes;static uint32_t write_error;
static uint8_t npdm[192];
static struct input codefiles[12];static unsigned codecount;
extern uint32_t lfs_file_read(void *,uint64_t *,int64_t,const struct ns_buffer *,int64_t,uint32_t);
extern uint32_t lfs_file_size(void *,uint64_t *);
extern void lfs_storage_release(void *);
extern void lfs_filesystem_release(void *);
extern void lfs_directory_release(void *);
extern uint32_t lfs_directory_read(void *,uint64_t *,const struct ns_buffer *);
struct lfs_context *lfs_context(void){return &context;}
struct lfs_lazy_config *lfs_lazy_config(void){return &lazy;}
#ifndef QA_REAL_ZBIC
void *lfs_zbic_create(void){return 0;}
void lfs_zbic_release(void *s){(void)s;}
uint32_t lfs_zbic_read(void *s,void *n,uint32_t (*read)(void *,uint64_t,void *,uint64_t),uint64_t o,uint64_t p,uint64_t z,uint64_t a,void *d,uint64_t l){(void)s;(void)n;(void)read;(void)o;(void)p;(void)z;(void)a;(void)d;(void)l;return 0xd401;}
#endif
static uint32_t allocate_block(void *manager,void **out,uint64_t bytes){(void)manager;if(fail_at&&++allocations==fail_at)return 0xd401;*out=calloc(1,bytes);if(!*out)return 0xd401;blocks++;block_bytes+=bytes;return 0;}
static uint32_t free_block(void *manager,void *memory,uint64_t bytes){(void)manager;assert(memory&&blocks&&bytes<=block_bytes);blocks--;block_bytes-=bytes;free(memory);return 0;}
static void *allocate(uint64_t bytes){return calloc(1,bytes);}
static void sdk_free(void *memory,uint64_t bytes){(void)bytes;free(memory);}
static void retain(void *memory){struct object *o=memory;assert(o->vt==vt&&o->refs);o->refs++;}
static void release(void *memory){struct object *o=memory;assert(o->vt==vt&&o->refs);if(!--o->refs){objects--;free(o);}}
static struct object *object(uint32_t kind,uint8_t *data,uint64_t size){struct object *o=calloc(1,sizeof(*o));assert(o);o->vt=vt;o->refs=1;o->kind=kind;o->data=data;o->size=size;objects++;return o;}
static uint32_t file_read(void *memory,uint64_t *count,int64_t offset,const struct ns_buffer *buffer,int64_t size,uint32_t options){(void)options;struct object *o=memory;assert(o->refs);if(offset<0||size<0||(uint64_t)offset>o->size||(uint64_t)size>buffer->capacity)return 0xd401;uint64_t n=o->size-(uint64_t)offset;if(n>(uint64_t)size)n=(uint64_t)size;memcpy(buffer->data,o->data+offset,n);*count=n;return 0;}
static uint32_t storage_read(void *memory,int64_t offset,const struct ns_buffer *buffer,int64_t size){struct object *o=(void *)((uint8_t *)memory-8);uint64_t count;uint32_t r=file_read(o,&count,offset,buffer,size,0);return r?r:count==(uint64_t)size?0:0xd401;}
static uint32_t file_size(void *memory,uint64_t *size){*size=((struct object *)memory)->size;return 0;}
static uint32_t open_file(void *memory,struct ns_out *out,const char *name,uint32_t mode){assert(mode==1);struct object *fs=(void *)((uint8_t *)memory-8);*out->value=0;struct input *list=fs==source?inputs:codefiles;unsigned n=fs==source?input_count:codecount;for(unsigned i=0;i<n;i++)if(!strcmp(name,list[i].path)){*out->value=object(1,list[i].data,list[i].size);if(fs==source)source_opens++;return 0;}return 0x202;}
static uint32_t open_directory(void *memory,struct ns_out *out,const char *name,uint32_t mode){(void)memory;(void)mode;assert(!strcmp(name,"/"));*out->value=object(2,0,0);return 0;}
static uint32_t directory_read(void *memory,uint64_t *count,const struct ns_buffer *buffer){struct object *o=memory;uint64_t capacity=buffer->capacity/0x310,n=0;while(n<capacity&&o->cursor<codecount){struct input *entry=&codefiles[o->cursor++];uint8_t *row=(uint8_t *)buffer->data+n++*0x310;memset(row,0,0x310);strcpy((char *)row,entry->path+1);row[0x304]=1;*(uint64_t *)(row+0x308)=entry->size;}*count=n;return 0;}
static uint32_t type(void *memory,uint32_t *out,const char *name){void *file=0;struct ns_out p={&file};uint32_t r=open_file(memory,&p,name,1);if(!r){*out=1;release(file);}return r;}
static void setup(void){assert(!blocks&&!block_bytes&&!objects);source_opens=input_count=codecount=0;fail_at=allocations=0;writes=flushes=write_error=0;memset(&context,0,sizeof(context));memset(&ns,0,sizeof(ns));memset(&lazy,0,sizeof(lazy));memset(vt,0,sizeof(vt));vt[0]=retain;vt[1]=release;context.enabled=ns.enabled=1;ns.magic=0x34465343;context.allocate=allocate;context.free=sdk_free;context.original_read=storage_read;context.original_size=file_size;context.read=file_read;context.open_file=open_file;context.codefs=&ns;context.sdk=(struct lfs_sdk){file_read,file_size,release,release,release,directory_read,file_size,release};ns.open_file=open_file;ns.open_directory=open_directory;ns.get_type=type;ns.read=file_read;ns.size=file_size;ns.release=release;lazy.allocate_block=allocate_block;lazy.free_block=free_block;source=object(3,0,0);gamefs=object(3,0,0);context.source_fs=source;ns.source_fs=(uint8_t *)source+8;}
static void cleanup(void){release(source);release(gamefs);struct lfs_life *next;for(struct lfs_life *life=context.objects;life;life=next){assert(!life->active);next=life->next;free(life);}assert(!blocks&&!block_bytes&&!objects);}
static void failure_test(void){setup();memset(npdm,0,sizeof(npdm));memcpy(npdm,"META",4);*(uint32_t *)(npdm+0x70)=128;memcpy(npdm+128,"ACI0",4);*(uint64_t *)(npdm+144)=0x0100000000000000;codefiles[0]=(struct input){"/main.npdm",npdm,sizeof(npdm)};codecount=1;uint8_t malformed[16]={0};inputs[0]=(struct input){"/sd/image",malformed,sizeof(malformed)};input_count=1;struct lfs_lazy_file image={.name="exefs.nsp",.source={.path="/sd/image"},.size=sizeof(malformed),.kind=LAZY_EXEFS_IMAGE};struct lfs_lazy_game game={0x0100000000000000,1,&image};lazy.count=1;lazy.games=&game;for(unsigned i=0;i<20;i++){uint32_t value;assert(!lfs_namespace_type((uint8_t *)gamefs+8,&value,"/main.npdm",&ns)&&value==1);}assert(source_opens==1);lfs_filesystem_release(gamefs);gamefs=object(3,0,0);cleanup();fprintf(stderr,"malformed ExeFS is reported once and does not repeat preparation: passed\n");}

static uint32_t log_write(void *file,int64_t at,const struct ns_buffer *buffer,int64_t size,uint32_t mode){(void)mode;struct object *o=file;writes++;if(write_error)return write_error;assert(at>=0&&size>=0&&(uint64_t)size<=buffer->capacity&&(uint64_t)at<=o->size&&(uint64_t)size<=o->size-at);memcpy(o->data+at,buffer->data,size);return 0;}
static uint32_t log_flush(void *file){(void)file;flushes++;return 0;}
static void logs(void){setup();uint8_t *data=calloc(1,1024*1024),*buffer=malloc(0x4000);context.log_file=object(1,data,1024*1024);context.write=log_write;context.flush=log_flush;lazy.log_buffer=buffer;lazy.log_limit=1024*1024;lazy.log_cursor=100;
 for(unsigned i=0;i<20000;i++)lfs_lazy_log("RomFS mounted",i,25,0,"/path/file");lfs_lazy_log_flush();assert(lazy.log_cursor<=1024*1024-4096&&writes<100);lfs_lazy_log("First native error",1,0,0x1234,"/path/failure");lfs_lazy_log_flush();assert(strstr((char *)data+1024*1024-4096,"00001234 /path/failure"));uint64_t old=writes;for(unsigned i=0;i<10000;i++)lfs_lazy_log("Late event",i,0,0,"/full");lfs_lazy_log_flush();assert(writes==old);lazy.log_cursor=100;write_error=0x55;lfs_lazy_log("One failed flush",1,1,0,0);lfs_lazy_log_flush();assert(lazy.log_failed);old=writes;for(unsigned i=0;i<10000;i++){lfs_lazy_log("Disabled logger",i,0,0,0);lfs_lazy_log_flush();}assert(writes==old);release(context.log_file);context.log_file=0;free(data);free(buffer);cleanup();fprintf(stderr,"bounded logs and disabled-on-write-error: passed\n");}
static void codefs_test(void){
 for(unsigned image=0;image<2;image++){
 setup();uint8_t original[4]={1,2,3,4},replacement[4]={8,7,6,5},extra[5]={9,8,7,6,5};memset(npdm,0,sizeof(npdm));memcpy(npdm,"META",4);*(uint32_t *)(npdm+0x70)=128;memcpy(npdm+128,"ACI0",4);*(uint64_t *)(npdm+144)=0x0100000000000000;
 codefiles[0]=(struct input){"/main.npdm",npdm,sizeof(npdm)};codefiles[1]=(struct input){"/main",original,4};codefiles[2]=(struct input){"/sdk",original,4};codefiles[3]=(struct input){"/subsdk1",original,4};codecount=4;uint8_t pfs[512]={0};const char names[]="main\0main.npdm\0subsdk7\0";unsigned start=16+72+sizeof(names);memcpy(pfs,"PFS0",4);*(uint32_t *)(pfs+4)=3;*(uint32_t *)(pfs+8)=sizeof(names);memcpy(pfs+88,names,sizeof(names));unsigned offsets[3]={0,4,4+sizeof(npdm)},sizes[3]={4,sizeof(npdm),5},name_at[3]={0,5,15};for(unsigned i=0;i<3;i++){*(uint64_t *)(pfs+16+i*24)=offsets[i];*(uint64_t *)(pfs+24+i*24)=sizes[i];*(uint32_t *)(pfs+32+i*24)=name_at[i];}memcpy(pfs+start,replacement,4);memcpy(pfs+start+4,npdm,sizeof(npdm));memcpy(pfs+start+4+sizeof(npdm),extra,5);
 inputs[0]=(struct input){"/sd/main",replacement,4};inputs[1]=(struct input){"/sd/image",pfs,start+4+sizeof(npdm)+5};input_count=2;struct lfs_lazy_file mods[3]={{.name="/main",.source={.path="/sd/main"},.size=4,.kind=LAZY_EXEFS},{.name="sdk",.kind=LAZY_STUB},{.name="exefs.nsp",.source={.path="/sd/image"},.size=inputs[1].size,.kind=LAZY_EXEFS_IMAGE}};struct lfs_lazy_game game={0x0100000000000000, image?1:2,image?mods+2:mods};lazy.games=&game;lazy.count=1;
 void *file=0;struct ns_out out={&file};assert(!lfs_namespace_open((uint8_t *)gamefs+8,&out,"/main",1,&ns));uint8_t data[16];struct ns_buffer b={data,sizeof(data)};uint64_t count;assert(!lfs_file_read(file,&count,0,&b,16,0)&&count==4&&!memcmp(data,replacement,4));lfs_file_release(file);uint32_t t;assert(lfs_namespace_type((uint8_t *)gamefs+8,&t,"/sdk",&ns)==0x202);void *directory=0;out.value=&directory;assert(!lfs_namespace_directory((uint8_t *)gamefs+8,&out,"/",2,&ns));uint8_t rows[4*0x310];b=(struct ns_buffer){rows,sizeof(rows)};assert(!lfs_directory_read(directory,&count,&b)&&count==3);for(uint64_t i=0;i<count;i++)assert(strcmp((char *)rows+i*0x310,"sdk"));lfs_directory_release(directory);lfs_filesystem_release(gamefs);gamefs=object(3,0,0);assert(!blocks);cleanup();}
 fprintf(stderr,"native ExeFS replacement, stub and PFS0 namespace: passed\n");
}

static void handles(void){
 setup();const unsigned files=20;uint8_t values[20][128];char names[20][16];struct lfs_source sources[20];memset(sources,0,sizeof(sources));
 input_count=files;for(unsigned i=0;i<files;i++){snprintf(names[i],sizeof(names[i]),"/sd/file%u",i);for(unsigned j=0;j<128;j++)values[i][j]=(uint8_t)(i+j);inputs[i]=(struct input){names[i],values[i],128};sources[i].path=names[i];}
 struct lfs_arena *arena=0;void *owner=lfs_lazy_plan_allocate(&arena,32);assert(owner);lfs_lazy_plan_finish(owner,arena);
 for(unsigned i=0;i<1000;i++){unsigned n=i<500?0:i%files;uint8_t data[13];assert(!lfs_lazy_source_read(owner,&sources[n],17,data,sizeof(data)));assert(!memcmp(data,values[n]+17,sizeof(data)));assert(objects<=10);}
 assert(source_opens==500);lfs_lazy_owner_release(owner);assert(objects==2&&!blocks);cleanup();fprintf(stderr,"bounded file reuse, 20 sources, eviction, per-read ownership and cleanup: passed\n");
}
static void report_test(void){
 setup();uint8_t *data=calloc(1,1024*1024),*buffer=malloc(0x4000);context.log_file=object(1,data,1024*1024);context.write=log_write;context.flush=log_flush;lazy.log_buffer=buffer;lazy.log_limit=1024*1024;lazy.log_cursor=100;
 uint8_t sample[100];for(unsigned i=0;i<100;i++)sample[i]=(uint8_t)i;inputs[0]=(struct input){"/sd/audio.pak",sample,100};input_count=1;struct lfs_source entry={.path="/sd/audio.pak"};uint8_t output[80];
 assert(!lfs_source_read((const char *)&entry,7,output,sizeof(output)));lfs_lazy_log_flush();
 assert(strstr((char *)data+100,"Source first read")&&strstr((char *)data+100,"0000000000000050"));
 assert(strstr((char *)data+100,"Source offset")&&strstr((char *)data+100,"0000000000000007"));uint64_t hash=UINT64_C(14695981039346656037);for(unsigned i=7;i<71;i++){hash^=sample[i];hash*=UINT64_C(1099511628211);}char encoded[17];snprintf(encoded,sizeof(encoded),"%016llx",(unsigned long long)hash);assert(strstr((char *)data+100,encoded));
 uint64_t cursor=lazy.log_cursor;assert(!lfs_source_read((const char *)&entry,0,output,sizeof(output)));lfs_lazy_log_flush();assert(lazy.log_cursor==cursor);
 for(unsigned i=0;i<1000;i++)lfs_lazy_unconfigured(UINT64_C(0x0400000000010000)+i,1);assert(lazy.unconfigured_mounts==1000);assert(lazy.log_cursor-cursor<2048);
 release(context.log_file);context.log_file=0;free(data);free(buffer);cleanup();fprintf(stderr,"automatic source ranges/fingerprints, bounded identity reports and no repeated read logging: passed\n");
}

static void ips_test(void){
 for(unsigned source_kind=0;source_kind<3;source_kind++){
 setup();uint8_t raw[4096]={0},first[]={ 'P','A','T','C','H',0,1,8,0,4,'a','b','c','d','E','O','F' },second[]={ 'I','P','S','3','2',0,0,1,9,0,2,'X','Y','E','E','O','F' };
 memcpy(raw,"NSO0",4);raw[0x40]=0x12;for(unsigned i=0;i<3;i++){*(uint32_t *)(raw+16+i*16)=256+i*256;*(uint32_t *)(raw+20+i*16)=i*0x1000;*(uint32_t *)(raw+24+i*16)=64;}
 memset(npdm,0,sizeof(npdm));memcpy(npdm,"META",4);*(uint32_t *)(npdm+0x70)=128;memcpy(npdm+128,"ACI0",4);*(uint64_t *)(npdm+144)=0x0100000000000000;
 codefiles[0]=(struct input){"/main.npdm",npdm,sizeof(npdm)};codefiles[1]=(struct input){"/main",raw,sizeof(raw)};codecount=2;inputs[0]=(struct input){"/sd/first",first,sizeof(first)};inputs[1]=(struct input){"/sd/second",second,sizeof(second)};input_count=2;
 struct lfs_lazy_file patches[2]={{.name="12.ips",.source={.path="/sd/first"},.size=sizeof(first)},{.name="12.ips32",.source={.path="/sd/second"},.size=sizeof(second)}};lazy.patch_count=2;lazy.patches=patches;
 uint8_t image[4608]={0};const char names[]="main\0main.npdm";unsigned data_at=16+48+sizeof(names);memcpy(image,"PFS0",4);*(uint32_t *)(image+4)=2;*(uint32_t *)(image+8)=sizeof(names);*(uint64_t *)(image+24)=sizeof(raw);*(uint64_t *)(image+40)=sizeof(raw);*(uint64_t *)(image+48)=sizeof(npdm);*(uint32_t *)(image+56)=5;memcpy(image+64,names,sizeof(names));memcpy(image+data_at,raw,sizeof(raw));memcpy(image+data_at+sizeof(raw),npdm,sizeof(npdm));
 struct lfs_lazy_file replacement={.name=source_kind==2?"exefs.nsp":"/main",.source={.path="/sd/replacement"},.size=source_kind==2?data_at+sizeof(raw)+sizeof(npdm):sizeof(raw),.kind=source_kind==2?LAZY_EXEFS_IMAGE:LAZY_EXEFS};struct lfs_lazy_game game={0x0100000000000000,1,&replacement};if(source_kind){inputs[2]=(struct input){"/sd/replacement",source_kind==2?image:raw,replacement.size};input_count=3;lazy.games=&game;lazy.count=1;}
 void *directory=0,*file=0;struct ns_out out={&directory};assert(!lfs_namespace_directory((uint8_t *)gamefs+8,&out,"/",2,&ns));uint8_t rows[2*0x310];struct ns_buffer dirbuf={rows,sizeof(rows)};uint64_t count,listed=0;
 assert(!lfs_directory_read(directory,&count,&dirbuf)&&count==2);for(uint64_t i=0;i<count;i++)if(!strcmp((char *)rows+i*0x310,"main"))listed=*(uint64_t *)(rows+i*0x310+0x308);
 out.value=&file;assert(!lfs_namespace_open((uint8_t *)gamefs+8,&out,"/main",1,&ns));uint64_t size;assert(!lfs_file_size(file,&size)&&size==448&&listed==size);uint8_t bytes[4];struct ns_buffer b={bytes,sizeof(bytes)};
 assert(!lfs_file_read(file,&count,264,&b,4,0)&&count==4&&!memcmp(bytes,"aXYd",4));lfs_filesystem_release(gamefs);gamefs=object(3,0,0);
 lfs_lookup(directory,LFS_DIRECTORY)->cursor=0;assert(!lfs_directory_read(directory,&count,&dirbuf)&&count==2);assert(!lfs_file_read(file,&count,264,&b,4,0)&&!memcmp(bytes,"aXYd",4));lfs_file_release(file);lfs_directory_release(directory);cleanup();
 }
 fprintf(stderr,"IPS/IPS32 ordering, directory sizes, original/loose/PFS sources and object lifetime: passed\n");
}
int main(void){failure_test();codefs_test();ips_test();handles();logs();report_test();return 0;}
