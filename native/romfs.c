#include "namespace.h"
static void add(uint64_t *p,int64_t n){ __atomic_fetch_add(p,n,__ATOMIC_RELAXED); }
int lfs_equal(const void *left,const void *right,uint64_t n){
 const uint8_t *a=left,*b=right;
 for(uint64_t i=0;i<n;i++)if(a[i]!=b[i])return 0;
 return 1;
}
void lfs_zero(void *data,uint64_t n){
 uint8_t *p=data;
 while(n&&((uintptr_t)p&7)){*p++=0;n--;}
 while(n>=8){*(uint64_t *)p=0;p+=8;n-=8;}
 while(n--)*p++=0;
}
struct lfs_life *lfs_lookup(void *object,uint32_t kind){
 for(struct lfs_life *n=__atomic_load_n(&lfs_context()->objects,__ATOMIC_ACQUIRE);n;n=__atomic_load_n(&n->next,__ATOMIC_ACQUIRE))
  if(__atomic_load_n(&n->active,__ATOMIC_ACQUIRE)==1&&__atomic_load_n(&n->object,__ATOMIC_RELAXED)==object&&(!kind||__atomic_load_n(&n->kind,__ATOMIC_RELAXED)==kind))return n;
 return 0;
}
/* A retained reference keeps the SDK object alive while Release retires its
 * cache entry. The object's original destructor still owns its resources. */
void lfs_release(void *object,ns_ref_fn original){
 struct lfs_life *n=lfs_lookup(object,0);
 if(!n){original(object);return;}
 __atomic_fetch_add(&n->release_ops,1,__ATOMIC_ACQ_REL);
 original(object);
 if(__atomic_fetch_sub(&n->release_ops,1,__ATOMIC_ACQ_REL)==1&&
    __atomic_load_n((uint32_t *)((uint8_t *)object+n->ref_offset),__ATOMIC_ACQUIRE)==1){
  uint32_t active=1;
  if(__atomic_compare_exchange_n(&n->active,&active,2,0,__ATOMIC_ACQ_REL,__ATOMIC_ACQUIRE)){
   struct lfs_context *c=lfs_context();
   original(object);
   __atomic_store_n(&n->active,0,__ATOMIC_RELEASE);
   if(c->log_file&&!__atomic_load_n(&c->log_errors,__ATOMIC_RELAXED)&&__atomic_load_n(&c->revision,__ATOMIC_RELAXED)!=__atomic_load_n(&c->flushed_revision,__ATOMIC_RELAXED))lfs_flush();
  }
 }
}
void lfs_file_release(void *object){lfs_release(object,lfs_context()->sdk.file_release);}
void lfs_filesystem_release(void *object){lfs_release(object,lfs_context()->sdk.filesystem_release);}
void lfs_storage_release(void *object){lfs_release(object,lfs_context()->sdk.storage_release);}
void lfs_directory_release(void *object){lfs_release(object,lfs_context()->sdk.directory_release);}
struct lfs_life *lfs_track(void *object,const void *owner,uint32_t kind){
 struct lfs_context *c=lfs_context();
 while(__atomic_exchange_n(&c->lock,1,__ATOMIC_ACQUIRE))__asm__ volatile("yield");
 struct lfs_life *n=lfs_lookup(object,kind);
 if(n){__atomic_store_n(&c->lock,0,__ATOMIC_RELEASE);return n;}
 for(n=__atomic_load_n(&c->objects,__ATOMIC_ACQUIRE);n;n=n->next)if(!__atomic_load_n(&n->active,__ATOMIC_ACQUIRE))break;
 int fresh=!n;
 if(fresh)n=c->allocate(sizeof(*n));
 if(!n){__atomic_store_n(&c->lock,0,__ATOMIC_RELEASE);return 0;}
 if(fresh)lfs_zero(n,sizeof(*n));
 __atomic_store_n(&n->object,object,__ATOMIC_RELAXED);n->original=*(void ***)object;n->owner=owner;__atomic_store_n(&n->kind,kind,__ATOMIC_RELAXED);n->release_ops=0;n->cursor=n->mode=0;
 uint32_t before[16],after[16],offset=0,candidates=0;
 for(unsigned i=0;i<16;i++)before[i]=__atomic_load_n((uint32_t *)object+i,__ATOMIC_RELAXED);
 ((ns_ref_fn)n->original[0])(object);
 for(unsigned i=0;i<16;i++)after[i]=__atomic_load_n((uint32_t *)object+i,__ATOMIC_RELAXED);
 for(unsigned i=2;i<16;i++)if(before[i]&&before[i]<0x100000&&after[i]==before[i]+1){offset=i*4;candidates++;}
 if(candidates!=1){
  ((ns_ref_fn)n->original[1])(object);if(fresh)c->free(n,sizeof(*n));n=0;
 }else{
  n->ref_offset=offset;
  if(fresh){n->next=__atomic_load_n(&c->objects,__ATOMIC_RELAXED);__atomic_store_n(&c->objects,n,__ATOMIC_RELEASE);}
  __atomic_store_n(&n->active,1,__ATOMIC_RELEASE);
 }
 __atomic_store_n(&c->lock,0,__ATOMIC_RELEASE);return n;
}
uint32_t lfs_source_read(const char *path,uint64_t offset,void *data,uint64_t size){
 struct lfs_context *c=lfs_context();void *file=0;uint32_t result;
 if(!path||(uintptr_t)path==1){
  if(!path&&(offset>c->payload_size||size>c->payload_size-offset))return 0xd401;
  const uint8_t *from=(const uint8_t *)(path?(uintptr_t)offset:(uintptr_t)c->metadata+offset);uint8_t *to=data;
  for(uint64_t i=0;i<size;i++)to[i]=from[i];return 0;
 }
 if(path){
  struct ns_out out={&file};file=0;
  result=c->open_file((uint8_t *)c->source_fs+8,&out,((const struct lfs_source *)path)->path,1);
  if(result){lfs_note((struct lfs_source *)path,0,result);return result;}
  if(!file)return 0xd401;
 }
 struct ns_buffer buffer={data,size};uint64_t read=0;
 result=c->read(file,&read,(int64_t)offset,&buffer,(int64_t)size,0);
 c->sdk.file_release(file);
 add(&c->source_reads,1);
 result=result?result:(read==size?0:0xd401);lfs_note((struct lfs_source *)path,result?0:read,result);return result;
}
static void identity_mismatch(uint64_t stage){
 struct lfs_context *c=lfs_context();uint64_t empty=0;
 if(c->log_file&&!__atomic_load_n(&c->log_errors,__ATOMIC_RELAXED)&&__atomic_compare_exchange_n(&c->reserved2,&empty,stage,0,__ATOMIC_RELAXED,__ATOMIC_RELAXED)){
  __atomic_store_n(&c->identity_mismatches,1,__ATOMIC_RELAXED);__atomic_fetch_add(&c->revision,1,__ATOMIC_RELEASE);
 }
}
static const struct lfs_view *identify(void *object,uint64_t size){
 struct lfs_context *c=lfs_context();uint8_t bytes[128];
 for(uint32_t i=0;i<c->count;i++){
  const struct lfs_view *v=&c->views[i];if(v->original_size!=size)continue;
  struct ns_buffer buffer={bytes,sizeof(bytes)};
  if(c->original_read((uint8_t *)object+8,0,&buffer,80)||!lfs_equal(bytes,v->header,80)){identity_mismatch(1);continue;}
  if(c->original_read((uint8_t *)object+8,v->entry_offset,&buffer,32)||!lfs_equal(bytes,v->entry,32)){identity_mismatch(2);continue;}
  if(c->original_read((uint8_t *)object+8,v->prefix_offset,&buffer,v->prefix_length)||!lfs_equal(bytes,v->prefix,v->prefix_length)){identity_mismatch(3);continue;}
  lfs_track(object,v,LFS_STORAGE);return v;
 }
 if(c->log_file&&!__atomic_load_n(&c->log_errors,__ATOMIC_RELAXED)&&!__atomic_load_n(&c->unmatched_count,__ATOMIC_RELAXED)&&size>=80){
  struct ns_buffer b={bytes,sizeof(bytes)};
  if(!c->original_read((uint8_t *)object+8,0,&b,80)&&*(uint64_t *)bytes==80){uint64_t empty=0;if(__atomic_compare_exchange_n(&c->unmatched_count,&empty,1,0,__ATOMIC_RELAXED,__ATOMIC_RELAXED)){c->unmatched_size=size;__atomic_fetch_add(&c->revision,1,__ATOMIC_RELEASE);}lfs_track(object,0,LFS_STORAGE);}
 }
 return 0;
}
static uint32_t read_segment(void *object,const struct lfs_segment *s,uint64_t offset,void *data,uint64_t size){
 if((uintptr_t)s->source_path==2){struct ns_buffer b={data,size};return lfs_context()->original_read((uint8_t *)object+8,s->source_offset+offset,&b,size);}
 return lfs_source_read(s->source_path,s->source_offset+offset,data,size);
}
uint32_t lfs_size(void *object,uint64_t *size){
 struct lfs_context *c=lfs_context();add(&c->active,1);
 uint32_t result=c->original_size(object,size);
 if(!result&&c->enabled){
  struct lfs_life *n=lfs_lookup(object,LFS_STORAGE);
  const struct lfs_view *v=n?n->owner:identify(object,*size);
  if(v)*size=v->size;
 }
 add(&c->active,-1);return result;
}
uint32_t lfs_read(void *object,int64_t at,const struct ns_buffer *buffer,int64_t length){
 struct lfs_context *c=lfs_context();uint32_t result;uint64_t end=(uint64_t)at+(uint64_t)length;
 add(&c->active,1);add(&c->calls,1);
 if(!c->enabled||at<0||length<=0||end<(uint64_t)at||(uint64_t)length>buffer->capacity)goto original;
 struct lfs_life *n=lfs_lookup(object,LFS_STORAGE);const struct lfs_view *v;
 if(n)v=n->owner;
 else{uint64_t size;if(c->original_size(object,&size))goto original;v=identify(object,size);}
 if(!v||end>v->size)goto original;
 uint32_t lo=0,hi=v->count;
 while(lo<hi){uint32_t mid=lo+(hi-lo)/2;const struct lfs_segment *s=&v->segments[mid];if(s->offset+s->length<=(uint64_t)at)lo=mid+1;else hi=mid;}
 if(lo==v->count||v->segments[lo].offset>=end){
  if(end<=v->original_size)goto original;
 }else{
  const struct lfs_segment *s=&v->segments[lo];
  if(s->offset<=(uint64_t)at&&s->offset+s->length>=end){
   add(&c->matched,1);result=read_segment(object,s,(uint64_t)at-s->offset,buffer->data,(uint64_t)length);goto redirected;
  }
 }
 add(&c->matched,1);
 uint64_t original_length=(uint64_t)at<v->original_size?v->original_size-(uint64_t)at:0;
 if(original_length>(uint64_t)length)original_length=(uint64_t)length;
 if(original_length){result=c->original_read((uint8_t *)object+8,at,buffer,original_length);if(result)goto redirected;}
 lfs_zero((uint8_t *)buffer->data+original_length,(uint64_t)length-original_length);
 for(uint32_t i=lo;i<v->count&&v->segments[i].offset<end;i++){
  const struct lfs_segment *s=&v->segments[i];uint64_t start=s->offset>(uint64_t)at?s->offset:(uint64_t)at;
  uint64_t stop=s->offset+s->length<end?s->offset+s->length:end;
  if(stop>start){result=read_segment(object,s,start-s->offset,(uint8_t *)buffer->data+start-(uint64_t)at,stop-start);if(result)goto redirected;}
 }
 result=0;
redirected:
 lfs_note(&c->view_stats[v-c->views],result?0:(uint64_t)length,result);
 if(result)add(&c->errors,1);
 goto finish;
original:
 result=c->original_read((uint8_t *)object+8,at,buffer,length);
finish:
 add(&c->active,-1);return result;
}
