#ifndef NS2_LFS_NAMESPACE_H
#define NS2_LFS_NAMESPACE_H
#include <stdint.h>
#include <stddef.h>
struct ns_out { void **value; };
struct ns_buffer { void *data; uint64_t capacity; };
typedef uint32_t (*ns_open_fn)(void *,struct ns_out *,const char *,uint32_t);
typedef uint32_t (*ns_type_fn)(void *,uint32_t *,const char *);
typedef uint32_t (*ns_read_fn)(void *,uint64_t *,int64_t,const struct ns_buffer *,int64_t,uint32_t);
typedef uint32_t (*ns_size_fn)(void *,uint64_t *);
typedef void (*ns_ref_fn)(void *);
struct lfs_segment { uint64_t offset,length,source_offset; const char *source_path; };
struct lfs_view {
 uint64_t original_size,size,entry_offset,prefix_offset;
 uint8_t header[80],entry[32],prefix[128];
 uint32_t count,prefix_length;
 const struct lfs_segment *segments;
};
struct ns_file { const char *name; uint64_t size; const char *source_path; uint64_t offset,source_size,flags; const struct lfs_segment *segments; uint64_t count; };
struct ns_group {
 uint64_t program_id,main_size;
 uint32_t program_offset,reserved;
 const struct ns_file *files;
 uint64_t count;
 uint8_t npdm_header[128],main_header[256];
};
struct ns_context {
 uint32_t enabled,magic;
 ns_open_fn open_file,open_directory;
 ns_type_fn get_type;
 void *source_fs;
 ns_read_fn read;
 ns_size_fn size;
 ns_ref_fn release;
 uint64_t count;
 const struct ns_group *groups;
 uint64_t calls,matched,errors,active;
};
struct lfs_life;
struct lfs_context {
 char magic[8];
 uint32_t enabled,count;
 uint64_t calls,matched;
 void *metadata,*source_fs;
 ns_read_fn read;
 struct ns_context *codefs;
 struct lfs_life *objects;
 uint64_t payload_size,source_reads,errors,active;
 void *(*allocate)(uint64_t);
 uint32_t (*original_read)(void *,int64_t,const struct ns_buffer *,int64_t);
 ns_size_fn original_size;
 ns_open_fn open_file;
 void (*free)(void *,uint64_t);
 uint32_t lock,reserved;
 uint64_t reserved2;
 struct lfs_view views[];
};
enum { LFS_STORAGE=1,LFS_CODEFS,LFS_SLICE,LFS_DIRECTORY };
struct lfs_life {
 struct lfs_life *next;
 void *object,**original;
 const void *owner;
 uint32_t ref_offset,active,release_ops,kind;
 uint64_t cursor,mode;
 void *table[16];
};
_Static_assert(sizeof(struct lfs_view)==288,"RomFS view ABI");
_Static_assert(sizeof(struct lfs_context)==160,"RomFS context ABI");
_Static_assert(sizeof(struct ns_file)==64,"CodeFS file ABI");
_Static_assert(sizeof(struct ns_group)==424,"CodeFS group ABI");
_Static_assert(offsetof(struct ns_group,npdm_header)==40,"NPDM ABI");
_Static_assert(sizeof(struct ns_context)==112,"CodeFS context ABI");
struct lfs_context *lfs_context(void);
struct lfs_life *lfs_lookup(void *,uint32_t);
struct lfs_life *lfs_track(void *,const void *,uint32_t);
void lfs_release(void *);
int lfs_equal(const void *,const void *,uint64_t);
void lfs_zero(void *,uint64_t);
uint32_t lfs_source_read(const char *,uint64_t,void *,uint64_t);
uint32_t lfs_read(void *,int64_t,const struct ns_buffer *,int64_t);
uint32_t lfs_size(void *,uint64_t *);
uint32_t lfs_namespace_open(void *,struct ns_out *,const char *,uint32_t,struct ns_context *);
uint32_t lfs_namespace_directory(void *,struct ns_out *,const char *,uint32_t,struct ns_context *);
uint32_t lfs_namespace_type(void *,uint32_t *,const char *,struct ns_context *);
#endif
