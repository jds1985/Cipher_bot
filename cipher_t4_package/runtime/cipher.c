/* Cipher 2.0 ternary CPU runtime. Ternary weights stay 2-bit packed (I2 layout, see convert.py);
   matmuls are int8 activations x {0,1,2} codes (u*x - sum x), per-token absmax/p99-clip quant as in
   training. KV cache in fp32. Kernels: AVX2, ARM NEON (aarch64), scalar fallback. */
#define _GNU_SOURCE
#include "cipher.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#if defined(__AVX2__)
#include <immintrin.h>
#elif defined(__ARM_NEON)
#include <arm_neon.h>
#endif

/* ---------------- fp16 ---------------- */
static inline float h2f(uint16_t h) {
    uint32_t s = (uint32_t)(h & 0x8000) << 16, e = (h >> 10) & 0x1f, m = h & 0x3ff, f;
    if (e == 0) { if (!m) f = s; else { e = 127 - 14; while (!(m & 0x400)) { m <<= 1; e--; } m &= 0x3ff; f = s | (e << 23) | (m << 13); } }
    else if (e == 31) f = s | 0x7f800000 | (m << 13);
    else f = s | ((e + 112) << 23) | (m << 13);
    float r; memcpy(&r, &f, 4); return r;
}

/* ---------------- model file ---------------- */
enum { DT_F32, DT_F16, DT_I8, DT_I2, DT_U8, DT_I32 };
typedef struct { char name[48]; uint32_t dtype, ndim; uint64_t shape[4], off, nbytes; } tdir;
typedef struct { const uint8_t *w; float s; int n, k; } tern_w;
typedef struct { const void *w; const float *s; int dtype; } emb_w;  /* i8 + row scales, or f16 */
typedef struct { const float *n1w, *n1b, *n2w, *n2b; tern_w qkv, out, ffn, ffn_out; } layer_w;
struct cipher_model {
    uint8_t *map; size_t size;
    int V, d, L, H, ML, F;
    emb_w embed, head; const uint16_t *pos; const float *nfw, *nfb, *hb;
    layer_w *layers;
    /* tokenizer */
    const uint8_t *vb; const int32_t *voff; const int32_t *merges; int n_merges; int special[5];
    int byte_id[256]; uint64_t *mkey; int32_t *mval; uint32_t mmask;
};
static const tdir *find(cipher_model *m, const char *name) {
    uint32_t n; memcpy(&n, m->map + 8, 4);
    const tdir *d = (const tdir *)(m->map + 64);
    for (uint32_t i = 0; i < n; i++) if (!strncmp(d[i].name, name, 48)) return &d[i];
    return NULL;
}
static const void *T(cipher_model *m, const char *name) {
    const tdir *d = find(m, name);
    if (!d) { fprintf(stderr, "missing tensor %s\n", name); exit(1); }
    return m->map + d->off;
}
static void load_emb(cipher_model *m, emb_w *e, const char *name) {
    const tdir *d = find(m, name); char sn[64]; snprintf(sn, 64, "%s.scale", name);
    e->w = m->map + d->off; e->dtype = d->dtype; e->s = d->dtype == DT_I8 ? (const float *)T(m, sn) : NULL;
}
static void load_tern(cipher_model *m, tern_w *t, const char *name) {
    const tdir *d = find(m, name); char sn[64]; snprintf(sn, 64, "%s.scale", name);
    if (!d) { fprintf(stderr, "missing %s\n", name); exit(1); }
    t->w = m->map + d->off; t->n = (int)d->shape[0]; t->k = (int)d->shape[1] * 128;  /* shape [N,K/128,32] */
    t->s = *(const float *)T(m, sn);
}
static inline uint64_t mhash(uint64_t k) { k ^= k >> 33; k *= 0xff51afd7ed558ccdULL; k ^= k >> 33; return k; }
cipher_model *cipher_load(const char *path) {
    int fd = open(path, O_RDONLY); if (fd < 0) { perror(path); return NULL; }
    struct stat st; fstat(fd, &st);
    cipher_model *m = calloc(1, sizeof *m); m->size = st.st_size;
    m->map = mmap(NULL, m->size, PROT_READ, MAP_PRIVATE, fd, 0); close(fd);
    if (m->map == MAP_FAILED || memcmp(m->map, "CTRN", 4)) { fprintf(stderr, "bad file\n"); free(m); return NULL; }
    uint32_t h[9]; memcpy(h, m->map, 36);
    m->V = h[3]; m->d = h[4]; m->L = h[5]; m->H = h[6]; m->ML = h[7]; m->F = h[8];
    load_emb(m, &m->embed, "embed"); load_emb(m, &m->head, "head");
    m->pos = T(m, "pos_embed"); m->nfw = T(m, "norm_f.weight"); m->nfb = T(m, "norm_f.bias"); m->hb = T(m, "head.bias");
    m->layers = calloc(m->L, sizeof(layer_w)); char nm[64];
    for (int i = 0; i < m->L; i++) {
        layer_w *l = &m->layers[i];
#define G(f, s) snprintf(nm, 64, "layers.%d." s, i); l->f = T(m, nm);
        G(n1w, "norm1.weight") G(n1b, "norm1.bias") G(n2w, "norm2.weight") G(n2b, "norm2.bias")
#define GT(f, s) snprintf(nm, 64, "layers.%d." s, i); load_tern(m, &l->f, nm);
        GT(qkv, "attn.qkv") GT(out, "attn.out") GT(ffn, "ffn") GT(ffn_out, "ffn_out")
    }
    m->vb = T(m, "tok.vocab"); m->voff = T(m, "tok.offsets"); m->merges = T(m, "tok.merges");
    m->n_merges = (int)find(m, "tok.merges")->shape[0]; memcpy(m->special, T(m, "tok.special"), 20);
    for (int b = 0; b < 256; b++) m->byte_id[b] = -1;
    for (int i = 0; i < m->V; i++) if (m->voff[i + 1] - m->voff[i] == 1 && !cipher_is_special(m, i)) {
        int b = m->vb[m->voff[i]]; if (m->byte_id[b] < 0) m->byte_id[b] = i; }
    uint32_t cap = 1; while (cap < (uint32_t)m->n_merges * 2) cap <<= 1;
    m->mmask = cap - 1; m->mkey = malloc(cap * 8); m->mval = malloc(cap * 4); memset(m->mkey, 0xff, cap * 8);
    for (int r = 0; r < m->n_merges; r++) {
        uint64_t k = ((uint64_t)(uint32_t)m->merges[3 * r] << 32) | (uint32_t)m->merges[3 * r + 1];
        uint32_t j = mhash(k) & m->mmask; while (m->mkey[j] != ~0ULL && m->mkey[j] != k) j = (j + 1) & m->mmask;
        if (m->mkey[j] == ~0ULL) { m->mkey[j] = k; m->mval[j] = r; }
    }
    return m;
}
void cipher_free_model(cipher_model *m) { munmap(m->map, m->size); free(m->layers); free(m->mkey); free(m->mval); free(m); }
int cipher_vocab(const cipher_model *m) { return m->V; }
int cipher_max_len(const cipher_model *m) { return m->ML; }
int cipher_special(const cipher_model *m, int w) { return m->special[w]; }
int cipher_is_special(const cipher_model *m, int id) { for (int i = 0; i < 5; i++) if (m->special[i] == id) return 1; return 0; }
int cipher_token_bytes(const cipher_model *m, int id, const char **b) { *b = (const char *)m->vb + m->voff[id]; return m->voff[id + 1] - m->voff[id]; }

/* ---------------- thread pool ---------------- */
typedef void (*job_fn)(void *arg, int ith, int nth);
typedef struct pool {
    int n; pthread_t *th; job_fn fn; void *arg;
    atomic_int gen, done; int stop; pthread_mutex_t mu; pthread_cond_t cv;
} pool;
typedef struct { pool *p; int id; } wk;
static void *worker(void *a) {
    wk *w = a; pool *p = w->p; int seen = 0;
    for (;;) {
        int spins = 0;
        while (atomic_load_explicit(&p->gen, memory_order_acquire) == seen) {
            if (++spins > 20000) {
                pthread_mutex_lock(&p->mu);
                while (atomic_load(&p->gen) == seen && !p->stop) pthread_cond_wait(&p->cv, &p->mu);
                pthread_mutex_unlock(&p->mu); spins = 0;
            }
#if defined(__x86_64__)
            __builtin_ia32_pause();
#endif
            if (p->stop) return NULL;
        }
        if (p->stop) return NULL;
        seen = atomic_load(&p->gen);
        p->fn(p->arg, w->id, p->n);
        atomic_fetch_add_explicit(&p->done, 1, memory_order_release);
    }
}
static pool *pool_new(int n) {
    pool *p = calloc(1, sizeof *p); p->n = n; p->th = calloc(n, sizeof(pthread_t));
    pthread_mutex_init(&p->mu, NULL); pthread_cond_init(&p->cv, NULL);
    for (int i = 1; i < n; i++) { wk *w = malloc(sizeof *w); w->p = p; w->id = i; pthread_create(&p->th[i], NULL, worker, w); }
    return p;
}
static void pool_run(pool *p, job_fn fn, void *arg) {
    if (p->n == 1) { fn(arg, 0, 1); return; }
    p->fn = fn; p->arg = arg; atomic_store(&p->done, 0);
    pthread_mutex_lock(&p->mu); atomic_fetch_add_explicit(&p->gen, 1, memory_order_release);
    pthread_cond_broadcast(&p->cv); pthread_mutex_unlock(&p->mu);
    fn(arg, 0, p->n);
    while (atomic_load_explicit(&p->done, memory_order_acquire) != p->n - 1) {
#if defined(__x86_64__)
        __builtin_ia32_pause();
#endif
    }
}
static void pool_free(pool *p) {
    pthread_mutex_lock(&p->mu); p->stop = 1; pthread_cond_broadcast(&p->cv); pthread_mutex_unlock(&p->mu);
    for (int i = 1; i < p->n; i++) pthread_join(p->th[i], NULL);
    free(p->th); free(p);
}

/* ---------------- kernels ---------------- */
/* unpack one I2 row (K codes) into u8 {0,1,2} */
static inline void unpack_row(const uint8_t *w, int K, uint8_t *u) {
    for (int b = 0; b < K / 128; b++, w += 32, u += 128) {
#if defined(__AVX2__)
        __m256i x = _mm256_loadu_si256((const __m256i *)w), m3 = _mm256_set1_epi8(3);
        _mm256_storeu_si256((__m256i *)(u), _mm256_and_si256(_mm256_srli_epi16(x, 6), m3));
        _mm256_storeu_si256((__m256i *)(u + 32), _mm256_and_si256(_mm256_srli_epi16(x, 4), m3));
        _mm256_storeu_si256((__m256i *)(u + 64), _mm256_and_si256(_mm256_srli_epi16(x, 2), m3));
        _mm256_storeu_si256((__m256i *)(u + 96), _mm256_and_si256(x, m3));
#elif defined(__ARM_NEON)
        uint8x16_t m3 = vdupq_n_u8(3);
        for (int h = 0; h < 2; h++) {
            uint8x16_t x = vld1q_u8(w + 16 * h);
            vst1q_u8(u + 16 * h, vshrq_n_u8(x, 6));
            vst1q_u8(u + 32 + 16 * h, vandq_u8(vshrq_n_u8(x, 4), m3));
            vst1q_u8(u + 64 + 16 * h, vandq_u8(vshrq_n_u8(x, 2), m3));
            vst1q_u8(u + 96 + 16 * h, vandq_u8(x, m3));
        }
#else
        for (int j = 0; j < 32; j++) { u[j] = w[j] >> 6; u[32 + j] = (w[j] >> 4) & 3; u[64 + j] = (w[j] >> 2) & 3; u[96 + j] = w[j] & 3; }
#endif
    }
}
/* sum_k u[k]*q[k], u in {0,1,2}, q int8 */
static inline int32_t dot_u2s8(const uint8_t *u, const int8_t *q, int K) {
#if defined(__AVX2__)
    __m256i acc = _mm256_setzero_si256(), one = _mm256_set1_epi16(1);
    for (int k = 0; k < K; k += 64) {
        __m256i p0 = _mm256_maddubs_epi16(_mm256_loadu_si256((const __m256i *)(u + k)), _mm256_loadu_si256((const __m256i *)(q + k)));
        __m256i p1 = _mm256_maddubs_epi16(_mm256_loadu_si256((const __m256i *)(u + k + 32)), _mm256_loadu_si256((const __m256i *)(q + k + 32)));
        acc = _mm256_add_epi32(acc, _mm256_madd_epi16(_mm256_add_epi16(p0, p1), one));
    }
    __m128i s = _mm_add_epi32(_mm256_castsi256_si128(acc), _mm256_extracti128_si256(acc, 1));
    s = _mm_add_epi32(s, _mm_shuffle_epi32(s, 0x4e)); s = _mm_add_epi32(s, _mm_shuffle_epi32(s, 0xb1));
    return _mm_cvtsi128_si32(s);
#elif defined(__ARM_NEON) && defined(__ARM_FEATURE_DOTPROD)
    int32x4_t acc = vdupq_n_s32(0);
    for (int k = 0; k < K; k += 16) acc = vdotq_s32(acc, vreinterpretq_s8_u8(vld1q_u8(u + k)), vld1q_s8(q + k));
    return vaddvq_s32(acc);
#elif defined(__ARM_NEON)
    int32x4_t acc = vdupq_n_s32(0);
    for (int k = 0; k < K; k += 16) {
        int8x16_t a = vreinterpretq_s8_u8(vld1q_u8(u + k)), b = vld1q_s8(q + k);
        int16x8_t p = vmull_s8(vget_low_s8(a), vget_low_s8(b)); p = vmlal_s8(p, vget_high_s8(a), vget_high_s8(b));
        acc = vpadalq_s16(acc, p);
    }
    return vaddvq_s32(acc);
#else
    int32_t s = 0; for (int k = 0; k < K; k++) s += u[k] * q[k]; return s;
#endif
}
/* int8 x int8 dot (|values|<=127) */
static inline int32_t dot_s8s8(const int8_t *a, const int8_t *b, int K) {
#if defined(__AVX2__)
    __m256i acc = _mm256_setzero_si256(), one = _mm256_set1_epi16(1); int k = 0;
    for (; k + 32 <= K; k += 32) {
        __m256i x = _mm256_loadu_si256((const __m256i *)(a + k)), y = _mm256_loadu_si256((const __m256i *)(b + k));
        acc = _mm256_add_epi32(acc, _mm256_madd_epi16(_mm256_maddubs_epi16(_mm256_sign_epi8(x, x), _mm256_sign_epi8(y, x)), one));
    }
    __m128i s = _mm_add_epi32(_mm256_castsi256_si128(acc), _mm256_extracti128_si256(acc, 1));
    s = _mm_add_epi32(s, _mm_shuffle_epi32(s, 0x4e)); s = _mm_add_epi32(s, _mm_shuffle_epi32(s, 0xb1));
    int32_t r = _mm_cvtsi128_si32(s); for (; k < K; k++) r += a[k] * b[k]; return r;
#elif defined(__ARM_NEON) && defined(__ARM_FEATURE_DOTPROD)
    int32x4_t acc = vdupq_n_s32(0); int k = 0;
    for (; k + 16 <= K; k += 16) acc = vdotq_s32(acc, vld1q_s8(a + k), vld1q_s8(b + k));
    int32_t r = vaddvq_s32(acc); for (; k < K; k++) r += a[k] * b[k]; return r;
#elif defined(__ARM_NEON)
    int32x4_t acc = vdupq_n_s32(0); int k = 0;
    for (; k + 16 <= K; k += 16) { int8x16_t x = vld1q_s8(a + k), y = vld1q_s8(b + k);
        int16x8_t p = vmull_s8(vget_low_s8(x), vget_low_s8(y)); p = vmlal_s8(p, vget_high_s8(x), vget_high_s8(y)); acc = vpadalq_s16(acc, p); }
    int32_t r = vaddvq_s32(acc); for (; k < K; k++) r += a[k] * b[k]; return r;
#else
    int32_t r = 0; for (int k = 0; k < K; k++) r += a[k] * b[k]; return r;
#endif
}

/* per-token activation quant as in TernaryLinear.quant_act: clip at k-th largest |x| (p99), absmax to 127 */
static float kth_smallest(float *a, int n, int k) { /* quickselect, k 0-indexed */
    int lo = 0, hi = n - 1;
    while (lo < hi) {
        float piv = a[(lo + hi) / 2]; int i = lo, j = hi;
        while (i <= j) { while (a[i] < piv) i++; while (a[j] > piv) j--; if (i <= j) { float t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; } }
        if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
    }
    return a[k];
}
static void quant_act(const float *x, int K, int8_t *q, float *inv_scale, int32_t *sumq, float *tmp, int clip) {
    float t;
    if (clip) {
        int kk = (int)((1.0 - 0.99) * K); if (kk < 1) kk = 1;
        for (int i = 0; i < K; i++) tmp[i] = fabsf(x[i]);
        t = kth_smallest(tmp, K, K - kk - 1);
    } else { t = 0; for (int i = 0; i < K; i++) t = fmaxf(t, fabsf(x[i])); }
    float s = 127.0f / fmaxf(t, 1e-5f); int32_t sum = 0; int lo = clip ? -128 : -127;
    for (int i = 0; i < K; i++) {
        float v = fminf(fmaxf(x[i], -t), t) * s; int r = (int)nearbyintf(v);
        r = r < lo ? lo : r > 127 ? 127 : r; q[i] = (int8_t)r; sum += r;
    }
    *inv_scale = 1.0f / s; *sumq = sum;
}

/* ---------------- context / forward ---------------- */
#define CHUNK 64
struct cipher_ctx {
    cipher_model *m; pool *p; int n_ctx, n_past;
    float *kc, *vc;                          /* [L][n_ctx][d] */
    float *x, *xn, *qkv, *att, *ff, *logits; /* activation buffers [CHUNK][...] */
    int8_t *q8; float *qs; int32_t *qsum;    /* quantized activations [CHUNK][max(K)] */
    uint8_t *ubuf; float *tmp; float *sbuf;  /* per-thread scratch */
};
cipher_ctx *cipher_new_ctx(cipher_model *m, int n_ctx, int threads) {
    if (n_ctx <= 0 || n_ctx > m->ML) n_ctx = m->ML;
    cipher_ctx *c = calloc(1, sizeof *c); c->m = m; c->n_ctx = n_ctx; c->p = pool_new(threads < 1 ? 1 : threads);
    size_t d = m->d, F = m->F, nt = c->p->n;
    c->kc = calloc((size_t)m->L * n_ctx * d, 4); c->vc = calloc((size_t)m->L * n_ctx * d, 4);
    c->x = malloc(CHUNK * d * 4); c->xn = malloc(CHUNK * d * 4); c->qkv = malloc(CHUNK * 3 * d * 4);
    c->att = malloc(CHUNK * d * 4); c->ff = malloc(CHUNK * F * 4); c->logits = malloc((size_t)CHUNK * m->V * 4);
    c->q8 = malloc(CHUNK * F); c->qs = malloc(CHUNK * 4); c->qsum = malloc(CHUNK * 4);
    c->ubuf = malloc(nt * F); c->tmp = malloc(nt * F * 4); c->sbuf = malloc(nt * n_ctx * 4);
    return c;
}
void cipher_free_ctx(cipher_ctx *c) {
    pool_free(c->p); free(c->kc); free(c->vc); free(c->x); free(c->xn); free(c->qkv); free(c->att); free(c->ff);
    free(c->logits); free(c->q8); free(c->qs); free(c->qsum); free(c->ubuf); free(c->tmp); free(c->sbuf); free(c);
}
int cipher_n_past(const cipher_ctx *c) { return c->n_past; }
void cipher_reset(cipher_ctx *c) { c->n_past = 0; }

typedef struct { cipher_ctx *c; const float *in; int n, K, N, clip; } qjob;
static void quant_job(void *a, int ith, int nth) {
    qjob *j = a; cipher_ctx *c = j->c;
    for (int t = ith; t < j->n; t += nth)
        quant_act(j->in + (size_t)t * j->K, j->K, c->q8 + (size_t)t * j->K, &c->qs[t], &c->qsum[t], c->tmp + (size_t)ith * c->m->F, j->clip);
}
typedef struct { cipher_ctx *c; const tern_w *w; int n; float *out; int ldo; int mode; } mjob; /* mode 0 store,1 add,2 gelu */
static void tern_job(void *a, int ith, int nth) {
    mjob *j = a; cipher_ctx *c = j->c; const tern_w *w = j->w; int K = w->k, N = w->n;
    int per = (N + nth - 1) / nth, n0 = ith * per, n1 = n0 + per > N ? N : n0 + per;
    uint8_t *u = c->ubuf + (size_t)ith * c->m->F; size_t rb = (size_t)K / 4;
    for (int r = n0; r < n1; r++) {
        unpack_row(w->w + r * rb, K, u);
        for (int t = 0; t < j->n; t++) {
            float v = (float)(dot_u2s8(u, c->q8 + (size_t)t * K, K) - c->qsum[t]) * w->s * c->qs[t];
            float *o = j->out + (size_t)t * j->ldo + r;
            if (j->mode == 1) *o += v; else if (j->mode == 2) *o = 0.5f * v * (1.0f + erff(v * 0.70710678118654752f)); else *o = v;
        }
    }
}
static void tern_matmul(cipher_ctx *c, const tern_w *w, const float *in, int n, float *out, int mode) {
    qjob q = { c, in, n, w->k, w->n, 1 }; pool_run(c->p, quant_job, &q);
    mjob j = { c, w, n, out, w->n, mode }; pool_run(c->p, tern_job, &j);
}
static void layernorm(const float *x, float *y, const float *w, const float *b, int d) {
    float mu = 0, var = 0; for (int i = 0; i < d; i++) mu += x[i]; mu /= d;
    for (int i = 0; i < d; i++) { float t = x[i] - mu; var += t * t; } var /= d;
    float r = 1.0f / sqrtf(var + 1e-5f); for (int i = 0; i < d; i++) y[i] = (x[i] - mu) * r * w[i] + b[i];
}
typedef struct { cipher_ctx *c; int l, n, p0; } ajob;
static void attn_job(void *a, int ith, int nth) {
    ajob *j = a; cipher_ctx *c = j->c; cipher_model *m = c->m; int d = m->d, H = m->H, hd = d / H;
    float *kc = c->kc + (size_t)j->l * c->n_ctx * d, *vc = c->vc + (size_t)j->l * c->n_ctx * d, *s = c->sbuf + (size_t)ith * c->n_ctx;
    float sc = 1.0f / sqrtf((float)hd);
    for (int task = ith; task < j->n * H; task += nth) {
        int t = task / H, h = task % H, P = j->p0 + t + 1;
        const float *q = c->qkv + (size_t)t * 3 * d + h * hd; float mx = -INFINITY;
        for (int p = 0; p < P; p++) { const float *k = kc + (size_t)p * d + h * hd; float v = 0;
            float a8[8] = {0}; for (int i = 0; i < hd; i += 8) for (int e = 0; e < 8; e++) a8[e] += q[i + e] * k[i + e];
            for (int e = 0; e < 8; e++) v += a8[e]; v *= sc; s[p] = v; if (v > mx) mx = v; }
        float sum = 0; for (int p = 0; p < P; p++) { s[p] = expf(s[p] - mx); sum += s[p]; }
        float *o = c->att + (size_t)t * d + h * hd; for (int i = 0; i < hd; i++) o[i] = 0;
        for (int p = 0; p < P; p++) { const float *v = vc + (size_t)p * d + h * hd; float w = s[p] / sum;
            for (int i = 0; i < hd; i++) o[i] += w * v[i]; }
    }
}
typedef struct { cipher_ctx *c; int n, all; float *out; } hjob;
static void head_job(void *a, int ith, int nth) {
    hjob *j = a; cipher_ctx *c = j->c; cipher_model *m = c->m; int d = m->d, V = m->V;
    int per = (V + nth - 1) / nth, v0 = ith * per, v1 = v0 + per > V ? V : v0 + per; int t0 = j->all ? 0 : j->n - 1;
    float *tmp = c->tmp + (size_t)ith * m->F;
    for (int v = v0; v < v1; v++) {
        if (m->head.dtype == DT_I8) {
            const int8_t *w = (const int8_t *)m->head.w + (size_t)v * d; float ws = m->head.s[v];
            for (int t = t0; t < j->n; t++)
                j->out[(size_t)(t - t0) * V + v] = (float)dot_s8s8(w, c->q8 + (size_t)t * d, d) * ws * c->qs[t] + m->hb[v];
        } else {
            const uint16_t *w = (const uint16_t *)m->head.w + (size_t)v * d;
            for (int i = 0; i < d; i++) tmp[i] = h2f(w[i]);
            for (int t = t0; t < j->n; t++) { const float *x = c->xn + (size_t)t * d; float s = 0;
                for (int i = 0; i < d; i++) s += tmp[i] * x[i]; j->out[(size_t)(t - t0) * V + v] = s + m->hb[v]; }
        }
    }
}
static void forward_chunk(cipher_ctx *c, const int *toks, int n, float *out, int all) {
    cipher_model *m = c->m; int d = m->d, p0 = c->n_past;
    for (int t = 0; t < n; t++) {
        float *x = c->x + (size_t)t * d; const uint16_t *pe = m->pos + (size_t)(p0 + t) * d;
        if (m->embed.dtype == DT_I8) { const int8_t *e = (const int8_t *)m->embed.w + (size_t)toks[t] * d; float s = m->embed.s[toks[t]];
            for (int i = 0; i < d; i++) x[i] = e[i] * s + h2f(pe[i]); }
        else { const uint16_t *e = (const uint16_t *)m->embed.w + (size_t)toks[t] * d; for (int i = 0; i < d; i++) x[i] = h2f(e[i]) + h2f(pe[i]); }
    }
    for (int l = 0; l < m->L; l++) {
        layer_w *w = &m->layers[l];
        for (int t = 0; t < n; t++) layernorm(c->x + (size_t)t * d, c->xn + (size_t)t * d, w->n1w, w->n1b, d);
        tern_matmul(c, &w->qkv, c->xn, n, c->qkv, 0);
        for (int t = 0; t < n; t++) {
            memcpy(c->kc + ((size_t)l * c->n_ctx + p0 + t) * d, c->qkv + (size_t)t * 3 * d + d, d * 4);
            memcpy(c->vc + ((size_t)l * c->n_ctx + p0 + t) * d, c->qkv + (size_t)t * 3 * d + 2 * d, d * 4);
        }
        ajob aj = { c, l, n, p0 }; pool_run(c->p, attn_job, &aj);
        tern_matmul(c, &w->out, c->att, n, c->x, 1);
        for (int t = 0; t < n; t++) layernorm(c->x + (size_t)t * d, c->xn + (size_t)t * d, w->n2w, w->n2b, d);
        tern_matmul(c, &w->ffn, c->xn, n, c->ff, 2);
        tern_matmul(c, &w->ffn_out, c->ff, n, c->x, 1);
    }
    int t0 = all ? 0 : n - 1;
    for (int t = t0; t < n; t++) layernorm(c->x + (size_t)t * d, c->xn + (size_t)t * d, m->nfw, m->nfb, d);
    if (m->head.dtype == DT_I8) { qjob q = { c, c->xn + (size_t)t0 * d, n - t0, d, d, 0 }; pool_run(c->p, quant_job, &q);
        /* quant_job wrote at index 0..n-t0; shift so head_job indexes by t */
        if (t0) { memmove(c->q8 + (size_t)t0 * d, c->q8, d); c->qs[t0] = c->qs[0]; } }
    hjob h = { c, n, all, out }; pool_run(c->p, head_job, &h);
    c->n_past += n;
}
int cipher_eval(cipher_ctx *c, const int *toks, int n, float *out, int all) {
    if (c->n_past + n > c->n_ctx) return -1;
    for (int i = 0; i < n; i += CHUNK) {
        int k = n - i < CHUNK ? n - i : CHUNK;
        if (all) forward_chunk(c, toks + i, k, out + (size_t)i * c->m->V, 1);
        else if (i + k == n) forward_chunk(c, toks + i, k, out, 0);
        else forward_chunk(c, toks + i, k, c->logits, 0);
    }
    return 0;
}

/* ---------------- tokenizer (GPT-2 byte-level BPE) ---------------- */
static int utf8_dec(const unsigned char *s, int n, uint32_t *cp) {
    unsigned c = s[0];
    if (c < 0x80) { *cp = c; return 1; }
    int len = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
    if (len > n || len == 1) { *cp = c; return 1; }
    uint32_t v = c & (0x3f >> (len - 1)); for (int i = 1; i < len; i++) v = (v << 6) | (s[i] & 0x3f);
    *cp = v; return len;
}
static int is_space(uint32_t c) { return c == ' ' || (c >= 9 && c <= 13) || c == 0x85 || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000; }
static int is_num(uint32_t c) { return (c >= '0' && c <= '9') || c == 0xb2 || c == 0xb3 || c == 0xb9 || (c >= 0xbc && c <= 0xbe) || (c >= 0x660 && c <= 0x669) || (c >= 0x6f0 && c <= 0x6f9) || (c >= 0x966 && c <= 0x96f) || (c >= 0x2070 && c <= 0x2079) || (c >= 0x2080 && c <= 0x2089) || (c >= 0x2150 && c <= 0x218b) || (c >= 0x2460 && c <= 0x249b) || (c >= 0xff10 && c <= 0xff19); }
static int is_letter(uint32_t c) {
    if (c < 0x80) return (c | 32) >= 'a' && (c | 32) <= 'z';
    if (is_space(c) || is_num(c)) return 0;
    if (c >= 0xa1 && c <= 0xbf) return c == 0xaa || c == 0xb5 || c == 0xba;
    if (c == 0xd7 || c == 0xf7) return 0;
    if ((c >= 0x2000 && c <= 0x2bff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0x1f000 && c <= 0x1faff) || (c >= 0xe000 && c <= 0xf8ff) || c == 0xfe0f || c == 0x200d) return 0;
    if (c >= 0xff00 && c <= 0xffef) return (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a) || c >= 0xff66;
    if (c >= 0x300 && c <= 0x36f) return 0; /* combining marks (\p{M}) */
    return 1;
}
static int bpe_piece(const cipher_model *m, const unsigned char *s, int n, int *out, int max_out) {
    int ids[1024], k = 0; if (n > 1024) n = 1024;
    for (int i = 0; i < n; i++) ids[k++] = m->byte_id[s[i]];
    for (;;) {
        int best = -1, br = 0x7fffffff;
        for (int i = 0; i + 1 < k; i++) {
            uint64_t key = ((uint64_t)(uint32_t)ids[i] << 32) | (uint32_t)ids[i + 1];
            uint32_t j = mhash(key) & m->mmask;
            while (m->mkey[j] != ~0ULL) { if (m->mkey[j] == key) { if (m->mval[j] < br) { br = m->mval[j]; best = i; } break; } j = (j + 1) & m->mmask; }
        }
        if (best < 0) break;
        ids[best] = m->merges[3 * br + 2]; memmove(ids + best + 1, ids + best + 2, (k - best - 2) * sizeof(int)); k--;
    }
    int w = 0; for (int i = 0; i < k && w < max_out; i++) if (ids[i] >= 0) out[w++] = ids[i];
    return w;
}
static int encode_plain(const cipher_model *m, const unsigned char *s, int n, int *out, int max_out) {
    int w = 0, i = 0;
    while (i < n && w < max_out) {
        uint32_t c, c2; int l = utf8_dec(s + i, n - i, &c), j = i;
        if (c == '\'' && i + 1 < n) {  /* contractions */
            static const char *ct[] = { "re", "ve", "ll", "s", "t", "m", "d" }; int hit = 0;
            for (int q = 0; q < 7; q++) { int cl = (int)strlen(ct[q]); if (i + 1 + cl <= n && !memcmp(s + i + 1, ct[q], cl)) { j = i + 1 + cl; hit = 1; break; } }
            if (hit) { w += bpe_piece(m, s + i, j - i, out + w, max_out - w); i = j; continue; }
        }
        int st = i; if (c == ' ' && i + 1 < n) { j = i + 1; utf8_dec(s + j, n - j, &c2); } else { j = i; c2 = c; }
        int cls = is_letter(c2) ? 1 : is_num(c2) ? 2 : !is_space(c2) ? 3 : 0;
        if (cls) {
            while (j < n) { uint32_t cc; int ll = utf8_dec(s + j, n - j, &cc);
                int k2 = is_letter(cc) ? 1 : is_num(cc) ? 2 : !is_space(cc) ? 3 : 0; if (k2 != cls) break; j += ll; }
            w += bpe_piece(m, s + st, j - st, out + w, max_out - w); i = j; continue;
        }
        /* whitespace run */
        j = i; int last = i, cnt = 0;
        while (j < n) { uint32_t cc; int ll = utf8_dec(s + j, n - j, &cc); if (!is_space(cc)) break; last = j; j += ll; cnt++; }
        if (j < n && cnt > 1) j = last;           /* \s+(?!\S): leave last ws for next token */
        if (j == i) j = i + l;
        w += bpe_piece(m, s + i, j - i, out + w, max_out - w); i = j;
    }
    return w;
}
int cipher_encode(const cipher_model *m, const char *text, int *out, int max_out) {
    const unsigned char *s = (const unsigned char *)text; int n = (int)strlen(text), w = 0, i = 0, st = 0;
    while (i <= n) {
        int sp = -1, sl = 0;
        if (i < n && s[i] == '<') for (int q = 0; q < 5; q++) { int id = m->special[q]; if (id < 0) continue;
            int len = m->voff[id + 1] - m->voff[id]; if (i + len <= n && !memcmp(s + i, m->vb + m->voff[id], len)) { sp = id; sl = len; break; } }
        if (sp >= 0 || i == n) {
            w += encode_plain(m, s + st, i - st, out + w, max_out - w);
            if (sp >= 0 && w < max_out) out[w++] = sp;
            if (i == n) break; i += sl; st = i;
        } else i++;
    }
    return w;
}
