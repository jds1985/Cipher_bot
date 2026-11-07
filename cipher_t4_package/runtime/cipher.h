/* Cipher 2.0 ternary CPU runtime - public API (pure C11 + pthreads). */
#ifndef CIPHER_H
#define CIPHER_H
#include <stdint.h>
#include <stddef.h>
typedef struct cipher_model cipher_model;
typedef struct cipher_ctx cipher_ctx;
enum { TOK_EOT = 0, TOK_PAD, TOK_USER, TOK_ASSISTANT, TOK_SYSTEM };
cipher_model *cipher_load(const char *path);
void cipher_free_model(cipher_model *m);
int cipher_vocab(const cipher_model *m);
int cipher_max_len(const cipher_model *m);
int cipher_special(const cipher_model *m, int which);
/* n_ctx<=max_len; threads>=1 */
cipher_ctx *cipher_new_ctx(cipher_model *m, int n_ctx, int threads);
void cipher_free_ctx(cipher_ctx *c);
int cipher_n_past(const cipher_ctx *c);
void cipher_reset(cipher_ctx *c);
/* Feeds tokens at the current position. Writes logits of last token (all_logits=0) or of all
   tokens (all_logits=1, out must hold n*V floats). Returns 0 ok, -1 context full. */
int cipher_eval(cipher_ctx *c, const int *toks, int n, float *out, int all_logits);
/* tokenizer */
int cipher_encode(const cipher_model *m, const char *text, int *out, int max_out); /* parses special tokens */
int cipher_token_bytes(const cipher_model *m, int id, const char **bytes); /* returns len */
int cipher_is_special(const cipher_model *m, int id);
#endif
