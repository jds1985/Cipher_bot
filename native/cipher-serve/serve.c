/* cipher-serve: OpenAI-compatible chat completions server around the Cipher 2.0 ternary runtime.
   Loopback only (127.0.0.1). One request at a time (single KV cache); others wait in the listen backlog.
   Endpoints: GET /health, GET /v1/models, POST /v1/chat/completions (stream true|false).
   Chat template (same as the Android app): <|system|>S\n <|user|>U\n <|assistant|>A<|endoftext|> ... <|assistant|>
   Auth: if CIPHER_SERVE_TOKEN is set, every request needs "Authorization: Bearer <token>".
   On start prints "CIPHER_SERVE_LISTENING <port>" on stdout. SIGTERM/SIGINT: finish nothing new, exit 0. */
#define _GNU_SOURCE
#include "runtime/cipher.h"
#include <stdio.h>
#include <stdarg.h>
#include <strings.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <errno.h>
#include <signal.h>
#include <unistd.h>
#include <ctype.h>
#include <sys/socket.h>
#include <sys/resource.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif

#define MAX_BODY (1 << 20)
static volatile sig_atomic_t stop_flag = 0;
static void on_sig(int s) { (void)s; stop_flag = 1; }
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec * 1e-9; }

/* ---------------- sampling (identical to the CLI / Android sampler) ---------------- */
static uint64_t rng = 0x9E3779B97F4A7C15ULL;
static float frand(void) { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return (rng >> 40) * (1.0f / 16777216.0f); }
typedef struct { float p; int i; } pi_t;
static int cmp_pi(const void *a, const void *b) { float x = ((const pi_t *)a)->p, y = ((const pi_t *)b)->p; return x < y ? 1 : x > y ? -1 : 0; }
static int sample(float *l, int V, const unsigned char *seen, pi_t *buf, float temp, float top_p, float rep) {
    if (rep != 1.0f) for (int i = 0; i < V; i++) if (seen[i]) l[i] = l[i] > 0 ? l[i] / rep : l[i] * rep;
    int best = 0; for (int i = 1; i < V; i++) if (l[i] > l[best]) best = i;
    if (temp <= 0.0f) return best;
    float mx = l[best], sum = 0; for (int i = 0; i < V; i++) { l[i] = expf((l[i] - mx) / temp); sum += l[i]; }
    float cut = (1.0f - top_p) / (V - 1); int n = 0;
    for (int i = 0; i < V; i++) { float p = l[i] / sum; if (p >= cut) { buf[n].p = p; buf[n].i = i; n++; } }
    qsort(buf, n, sizeof(pi_t), cmp_pi);
    float cum = 0; int last = n - 1; for (int i = 0; i < n; i++) { if (cum > top_p) { last = i - 1; break; } cum += buf[i].p; }
    float tot = 0; for (int i = 0; i <= last; i++) tot += buf[i].p;
    float r = frand() * tot, c = 0; for (int i = 0; i <= last; i++) { c += buf[i].p; if (r < c) return buf[i].i; }
    return buf[last].i;
}

/* ---------------- tiny JSON reader (only what the request needs) ---------------- */
typedef struct { const char *p, *e; } js;
static void ws(js *j) { while (j->p < j->e && isspace((unsigned char)*j->p)) j->p++; }
static int skip_val(js *j);
/* Reads a JSON string into a malloc'd UTF-8 buffer (NULL on error). */
static char *read_str(js *j) {
    ws(j); if (j->p >= j->e || *j->p != '"') return NULL; j->p++;
    size_t cap = 64, n = 0; char *o = malloc(cap);
    while (j->p < j->e && *j->p != '"') {
        if (n + 8 > cap) { cap *= 2; o = realloc(o, cap); }
        char ch = *j->p++;
        if (ch != '\\') { o[n++] = ch; continue; }
        if (j->p >= j->e) break;
        ch = *j->p++;
        switch (ch) {
        case 'n': o[n++] = '\n'; break; case 't': o[n++] = '\t'; break; case 'r': o[n++] = '\r'; break;
        case 'b': o[n++] = '\b'; break; case 'f': o[n++] = '\f'; break;
        case 'u': {
            if (j->e - j->p < 4) { free(o); return NULL; }
            unsigned cp = (unsigned)strtoul((char[5]){j->p[0], j->p[1], j->p[2], j->p[3], 0}, NULL, 16); j->p += 4;
            if (cp >= 0xD800 && cp < 0xDC00 && j->e - j->p >= 6 && j->p[0] == '\\' && j->p[1] == 'u') {
                unsigned lo = (unsigned)strtoul((char[5]){j->p[2], j->p[3], j->p[4], j->p[5], 0}, NULL, 16);
                if (lo >= 0xDC00 && lo < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); j->p += 6; }
            }
            if (cp < 0x80) o[n++] = cp;
            else if (cp < 0x800) { o[n++] = 0xC0 | (cp >> 6); o[n++] = 0x80 | (cp & 63); }
            else if (cp < 0x10000) { o[n++] = 0xE0 | (cp >> 12); o[n++] = 0x80 | ((cp >> 6) & 63); o[n++] = 0x80 | (cp & 63); }
            else { o[n++] = 0xF0 | (cp >> 18); o[n++] = 0x80 | ((cp >> 12) & 63); o[n++] = 0x80 | ((cp >> 6) & 63); o[n++] = 0x80 | (cp & 63); }
            break; }
        default: o[n++] = ch;
        }
    }
    if (j->p >= j->e) { free(o); return NULL; }
    j->p++; o[n] = 0; return o;
}
static int skip_val(js *j) {
    ws(j); if (j->p >= j->e) return -1;
    char c = *j->p;
    if (c == '"') { char *s = read_str(j); if (!s) return -1; free(s); return 0; }
    if (c == '{' || c == '[') {
        char close = c == '{' ? '}' : ']'; j->p++; ws(j);
        if (j->p < j->e && *j->p == close) { j->p++; return 0; }
        for (;;) {
            if (c == '{') { char *k = read_str(j); if (!k) return -1; free(k); ws(j); if (j->p >= j->e || *j->p != ':') return -1; j->p++; }
            if (skip_val(j)) return -1; ws(j);
            if (j->p < j->e && *j->p == ',') { j->p++; continue; }
            if (j->p < j->e && *j->p == close) { j->p++; return 0; }
            return -1;
        }
    }
    while (j->p < j->e && !strchr(",}] \t\r\n", *j->p)) j->p++;
    return 0;
}
static double read_num(js *j, double dflt) { ws(j); char *end; double v = strtod(j->p, &end); if (end == j->p) { skip_val(j); return dflt; } j->p = end; return v; }
static int read_bool(js *j) { ws(j); int t = j->e - j->p >= 4 && !strncmp(j->p, "true", 4); skip_val(j); return t; }

typedef struct { char *role, *content; } msg_t;
typedef struct { msg_t *m; int n; int stream; int ignore_eos; int max_tokens; float temp, top_p, rep; long seed; int has_seed; } req_t;
static void free_req(req_t *r) { for (int i = 0; i < r->n; i++) { free(r->m[i].role); free(r->m[i].content); } free(r->m); }
static int parse_req(const char *body, size_t len, req_t *r) {
    memset(r, 0, sizeof *r); r->max_tokens = 300; r->temp = 0.7f; r->top_p = 0.9f; r->rep = 1.2f;
    js j = { body, body + len }; ws(&j); if (j.p >= j.e || *j.p != '{') return -1; j.p++;
    for (;;) {
        ws(&j); if (j.p < j.e && *j.p == '}') return 0;
        char *k = read_str(&j); if (!k) return -1; ws(&j); if (j.p >= j.e || *j.p != ':') { free(k); return -1; } j.p++;
        if (!strcmp(k, "messages")) {
            ws(&j); if (*j.p != '[') { free(k); return -1; } j.p++;
            int cap = 8; r->m = calloc(cap, sizeof(msg_t));
            for (;;) {
                ws(&j); if (*j.p == ']') { j.p++; break; }
                if (*j.p != '{') { free(k); return -1; } j.p++;
                msg_t mm = {0};
                for (;;) {
                    ws(&j); if (*j.p == '}') { j.p++; break; }
                    char *mk = read_str(&j); if (!mk) { free(k); return -1; } ws(&j); j.p++;
                    ws(&j);
                    if (!strcmp(mk, "role")) mm.role = read_str(&j);
                    else if (!strcmp(mk, "content") && *j.p == '"') mm.content = read_str(&j);
                    else if (skip_val(&j)) { free(mk); free(k); return -1; }
                    free(mk); ws(&j); if (*j.p == ',') j.p++;
                }
                if (!mm.role) mm.role = strdup("user");
                if (!mm.content) mm.content = strdup("");
                if (r->n == cap) { cap *= 2; r->m = realloc(r->m, cap * sizeof(msg_t)); }
                r->m[r->n++] = mm;
                ws(&j); if (*j.p == ',') j.p++;
            }
        } else if (!strcmp(k, "stream")) r->stream = read_bool(&j);
        else if (!strcmp(k, "ignore_eos")) r->ignore_eos = read_bool(&j); /* benchmarking only: never stop early */
        else if (!strcmp(k, "max_tokens") || !strcmp(k, "max_completion_tokens")) r->max_tokens = (int)read_num(&j, 300);
        else if (!strcmp(k, "temperature")) r->temp = (float)read_num(&j, 0.7);
        else if (!strcmp(k, "top_p")) r->top_p = (float)read_num(&j, 0.9);
        else if (!strcmp(k, "repetition_penalty")) r->rep = (float)read_num(&j, 1.2);
        else if (!strcmp(k, "seed")) { r->seed = (long)read_num(&j, 0); r->has_seed = 1; }
        else if (skip_val(&j)) { free(k); return -1; }
        free(k); ws(&j); if (j.p < j.e && *j.p == ',') j.p++;
        if (j.p >= j.e) return -1;
    }
}

/* ---------------- output helpers ---------------- */
typedef struct { char *b; size_t n, cap; } sb;
static void sb_put(sb *s, const char *x, size_t n) { if (s->n + n + 1 > s->cap) { s->cap = (s->n + n + 1) * 2; s->b = realloc(s->b, s->cap); } memcpy(s->b + s->n, x, n); s->n += n; s->b[s->n] = 0; }
static void sb_str(sb *s, const char *x) { sb_put(s, x, strlen(x)); }
static void sb_fmt(sb *s, const char *f, ...) { char t[1024]; va_list a; va_start(a, f); int n = vsnprintf(t, sizeof t, f, a); va_end(a); sb_put(s, t, n < (int)sizeof t ? n : (int)sizeof t - 1); }
static void sb_json(sb *s, const char *x, size_t n) {
    sb_str(s, "\"");
    for (size_t i = 0; i < n; i++) { unsigned char c = x[i];
        if (c == '"') sb_str(s, "\\\""); else if (c == '\\') sb_str(s, "\\\\"); else if (c == '\n') sb_str(s, "\\n");
        else if (c == '\r') sb_str(s, "\\r"); else if (c == '\t') sb_str(s, "\\t"); else if (c < 0x20) sb_fmt(s, "\\u%04x", c);
        else sb_put(s, (const char *)&c, 1); }
    sb_str(s, "\"");
}
static int send_all(int fd, const char *b, size_t n) {
    while (n) { ssize_t w = send(fd, b, n, MSG_NOSIGNAL); if (w <= 0) { if (w < 0 && errno == EINTR) continue; return -1; } b += w; n -= w; }
    return 0;
}
static void reply(int fd, int code, const char *ctype, const char *body) {
    sb s = {0}; const char *st = code == 200 ? "OK" : code == 400 ? "Bad Request" : code == 401 ? "Unauthorized" : code == 404 ? "Not Found" : code == 413 ? "Payload Too Large" : "Error";
    sb_fmt(&s, "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n", code, st, ctype, strlen(body));
    sb_str(&s, body); send_all(fd, s.b, s.n); free(s.b);
}
static void err(int fd, int code, const char *msg) { sb s = {0}; sb_str(&s, "{\"error\":{\"message\":"); sb_json(&s, msg, strlen(msg)); sb_str(&s, ",\"type\":\"invalid_request_error\"}}"); reply(fd, code, "application/json", s.b); free(s.b); }

/* ---------------- model state ---------------- */
static cipher_model *M; static cipher_ctx *C; static int V, NCTX, T_EOT, T_U, T_A, T_S, T_PAD;
static const char *MODEL_ID = "cipher";
static int *cache; static int ncache; /* tokens currently in the KV cache */
static float *logits; static unsigned char *seen; static pi_t *pbuf;

/* Encodes one message with the chat template. Returns token count written to out. */
static int enc_msg(const msg_t *m, int *out, int max) {
    char *t = malloc(strlen(m->content) + 32); int n = 0;
    if (!strcmp(m->role, "system")) { out[n++] = T_S; sprintf(t, "%s\n", m->content); n += cipher_encode(M, t, out + n, max - n); }
    else if (!strcmp(m->role, "assistant")) { out[n++] = T_A; sprintf(t, "%s", m->content); n += cipher_encode(M, t, out + n, max - n - 1); out[n++] = T_EOT; }
    else if (!strcmp(m->role, "tool")) { out[n++] = T_U; sprintf(t, "Tool result:\n%s\n", m->content); n += cipher_encode(M, t, out + n, max - n); }
    else { out[n++] = T_U; sprintf(t, "%s\n", m->content); n += cipher_encode(M, t, out + n, max - n); }
    free(t); return n;
}
/* Builds the prompt so that prompt + max_new fits NCTX: keeps system messages, then the newest messages that fit;
   the newest message is cut from the left if it alone is too long. Returns token count, sets *dropped. */
static int build_prompt(const req_t *r, int max_new, int *out, int *dropped) {
    int budget = NCTX - max_new - 1; if (budget < 16) budget = 16;
    int *tmp = malloc(sizeof(int) * (NCTX * 8 + 64)); int **parts = calloc(r->n, sizeof(int *)); int *lens = calloc(r->n, sizeof(int));
    for (int i = 0; i < r->n; i++) { lens[i] = enc_msg(&r->m[i], tmp, NCTX * 8); parts[i] = malloc(sizeof(int) * (lens[i] + 1)); memcpy(parts[i], tmp, sizeof(int) * lens[i]); }
    int sys_n = 0; for (int i = 0; i < r->n; i++) if (!strcmp(r->m[i].role, "system")) sys_n += lens[i];
    if (sys_n > budget / 2) sys_n = budget / 2; /* a huge system prompt is cut so a reply can still fit */
    int left = budget - sys_n - 1, first = r->n; *dropped = 0;
    for (int i = r->n - 1; i >= 0; i--) { if (!strcmp(r->m[i].role, "system")) continue; if (lens[i] > left) break; left -= lens[i]; first = i; }
    int n = 0, sys_left = sys_n;
    for (int i = 0; i < r->n; i++) if (!strcmp(r->m[i].role, "system")) { int k = lens[i] < sys_left ? lens[i] : sys_left; memcpy(out + n, parts[i], sizeof(int) * k); n += k; sys_left -= k; }
    int last = -1; for (int i = r->n - 1; i >= 0; i--) if (strcmp(r->m[i].role, "system")) { last = i; break; }
    if (first == r->n && last >= 0) { /* newest message alone is too long: keep its role token + tail */
        int k = budget - n - 1; out[n++] = parts[last][0]; memcpy(out + n, parts[last] + lens[last] - (k - 1), sizeof(int) * (k - 1)); n += k - 1; first = last + 1; *dropped = last;
    } else { for (int i = 0; i < first; i++) if (strcmp(r->m[i].role, "system")) (*dropped)++; }
    for (int i = first; i < r->n; i++) if (strcmp(r->m[i].role, "system")) { memcpy(out + n, parts[i], sizeof(int) * lens[i]); n += lens[i]; }
    out[n++] = T_A;
    for (int i = 0; i < r->n; i++) free(parts[i]); free(parts); free(lens); free(tmp);
    return n;
}

/* Emits complete UTF-8 only: holds back a trailing partial sequence until the next token completes it. */
typedef struct { char b[16]; int n; } utf8hold;
static int utf8_complete_len(const char *s, int n) {
    int i = n - 1, back = 0; while (i >= 0 && back < 4 && ((unsigned char)s[i] & 0xC0) == 0x80) { i--; back++; }
    if (i < 0) return n; unsigned char c = s[i]; int need = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
    return (n - i >= need) ? n : i;
}

static void handle_chat(int fd, const char *body, size_t blen) {
    req_t r; if (parse_req(body, blen, &r) || r.n == 0) { free_req(&r); err(fd, 400, "Expected a JSON body with a non-empty messages array."); return; }
    int max_new = r.max_tokens; if (max_new < 1) max_new = 1; if (max_new > NCTX / 2) max_new = NCTX / 2;
    if (r.has_seed) rng = 0x9E3779B97F4A7C15ULL ^ ((uint64_t)r.seed * 0x2545F4914F6CDD1DULL + 1);
    int *prompt = malloc(sizeof(int) * (NCTX + 8)); int dropped = 0;
    int np = build_prompt(&r, max_new, prompt, &dropped);
    double t0 = now();
    /* KV prefix reuse: if the cache is a prefix of the new prompt, only feed the new tail. */
    int common = 0; while (common < ncache && common < np - 1 && cache[common] == prompt[common]) common++;
    if (common < ncache) { cipher_reset(C); common = 0; ncache = 0; }
    memset(seen, 0, V); for (int i = 0; i < np; i++) seen[prompt[i]] = 1;
    if (cipher_eval(C, prompt + common, np - common, logits, 0)) { cipher_reset(C); ncache = 0; free(prompt); free_req(&r); err(fd, 500, "context full"); return; }
    memcpy(cache, prompt, sizeof(int) * np); ncache = np;
    char id[48]; snprintf(id, sizeof id, "chatcmpl-%lx%04x", (long)time(NULL), (unsigned)(frand() * 65535));
    long created = (long)time(NULL);
    if (r.stream) {
        const char *h = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        if (send_all(fd, h, strlen(h))) goto done_noreply;
        sb s = {0}; sb_fmt(&s, "data: {\"id\":\"%s\",\"object\":\"chat.completion.chunk\",\"created\":%ld,\"model\":\"%s\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n", id, created, MODEL_ID);
        send_all(fd, s.b, s.n); free(s.b);
    }
    sb full = {0}; sb_str(&full, ""); utf8hold hold = {{0}, 0}; int g = 0, aborted = 0; const char *finish = "length"; double t_first = 0;
    for (; g < max_new && ncache < NCTX; g++) {
        if (stop_flag) { finish = "stop"; break; }
        if (r.ignore_eos) { logits[T_EOT] = logits[T_U] = logits[T_PAD] = logits[T_S] = logits[T_A] = -1e30f; }
        int t = sample(logits, V, seen, pbuf, r.temp, r.top_p, r.rep);
        if (t == T_EOT || t == T_U || t == T_PAD || t == T_S || t == T_A) { finish = "stop"; break; }
        if (!g) t_first = now();
        seen[t] = 1;
        const char *bytes; int bn = cipher_is_special(M, t) ? 0 : cipher_token_bytes(M, t, &bytes);
        if (bn) {
            char tmp[64]; int tn = 0; memcpy(tmp, hold.b, hold.n); tn = hold.n; int cpy = bn < 48 ? bn : 48; memcpy(tmp + tn, bytes, cpy); tn += cpy;
            int ok = utf8_complete_len(tmp, tn); hold.n = tn - ok; memcpy(hold.b, tmp + ok, hold.n);
            if (ok) { sb_put(&full, tmp, ok);
                if (r.stream) { sb s = {0}; sb_fmt(&s, "data: {\"id\":\"%s\",\"object\":\"chat.completion.chunk\",\"created\":%ld,\"model\":\"%s\",\"choices\":[{\"index\":0,\"delta\":{\"content\":", id, created, MODEL_ID);
                    sb_json(&s, tmp, ok); sb_str(&s, "},\"finish_reason\":null}]}\n\n");
                    if (send_all(fd, s.b, s.n)) { aborted = 1; free(s.b); g++; break; } free(s.b); } }
        }
        if (cipher_eval(C, &t, 1, logits, 0)) { g++; break; }
        cache[ncache++] = t;
    }
    if (ncache < NCTX) { int e = T_EOT; if (!cipher_eval(C, &e, 1, logits, 0)) cache[ncache++] = e; } /* close the turn */
    double t_end = now(); double ttft = (t_first ? t_first : t_end) - t0; double gen_s = t_first ? t_end - t_first : 0;
    char stats[512]; snprintf(stats, sizeof stats, "\"usage\":{\"prompt_tokens\":%d,\"completion_tokens\":%d,\"total_tokens\":%d},"
        "\"cipher\":{\"n_ctx\":%d,\"prompt_eval_tokens\":%d,\"cached_tokens\":%d,\"dropped_messages\":%d,\"ttft_ms\":%.1f,\"gen_tok_s\":%.1f}",
        np, g, np + g, NCTX, np - common, common, dropped, ttft * 1000, g > 1 && gen_s > 0 ? (g - 1) / gen_s : 0.0);
    if (r.stream) {
        if (!aborted) { sb s = {0}; sb_fmt(&s, "data: {\"id\":\"%s\",\"object\":\"chat.completion.chunk\",\"created\":%ld,\"model\":\"%s\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"%s\"}],%s}\n\ndata: [DONE]\n\n", id, created, MODEL_ID, finish, stats);
            send_all(fd, s.b, s.n); free(s.b); }
    } else {
        sb s = {0}; sb_fmt(&s, "{\"id\":\"%s\",\"object\":\"chat.completion\",\"created\":%ld,\"model\":\"%s\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":", id, created, MODEL_ID);
        sb_json(&s, full.b, full.n); sb_fmt(&s, "},\"finish_reason\":\"%s\"}],%s}", finish, stats); reply(fd, 200, "application/json", s.b); free(s.b);
    }
    fprintf(stderr, "[cipher-serve] chat prompt=%d (cached %d) gen=%d ttft=%.0fms %.1f tok/s%s\n", np, common, g, ttft * 1000, g > 1 && gen_s > 0 ? (g - 1) / gen_s : 0.0, aborted ? " (client closed)" : "");
    free(full.b);
done_noreply:
    free(prompt); free_req(&r);
}

static const char *TOKEN;
static void handle(int fd) {
    char *buf = malloc(MAX_BODY + 8192); size_t n = 0; char *hend = NULL;
    struct timeval tv = { 30, 0 }; setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    while (!hend && n < 8192) { ssize_t r = recv(fd, buf + n, 8192 - n, 0); if (r <= 0) goto out; n += r; buf[n] = 0; hend = strstr(buf, "\r\n\r\n"); }
    if (!hend) { err(fd, 400, "bad request"); goto out; }
    *hend = 0; char *body = hend + 4; size_t have = n - (body - buf);
    char method[8] = {0}, path[256] = {0}; sscanf(buf, "%7s %255s", method, path);
    size_t clen = 0; int authed = TOKEN == NULL;
    for (char *l = strstr(buf, "\r\n"); l; l = strstr(l + 2, "\r\n")) {
        char *h = l + 2;
        if (!strncasecmp(h, "Content-Length:", 15)) clen = strtoul(h + 15, NULL, 10);
        if (TOKEN && !strncasecmp(h, "Authorization:", 14)) { char *v = h + 14; while (*v == ' ') v++; char *e = strstr(v, "\r\n"); size_t vl = e ? (size_t)(e - v) : strlen(v);
            size_t tl = strlen(TOKEN); if (vl == tl + 7 && !strncmp(v, "Bearer ", 7)) { unsigned d = 0; for (size_t i = 0; i < tl; i++) d |= (unsigned)(v[7 + i] ^ TOKEN[i]); authed = !d; } }
    }
    if (!authed) { err(fd, 401, "missing or wrong bearer token"); goto out; }
    if (clen > MAX_BODY) { err(fd, 413, "body too large"); goto out; }
    while (have < clen) { ssize_t r = recv(fd, body + have, clen - have, 0); if (r <= 0) goto out; have += r; }
    char *q = strchr(path, '?'); if (q) *q = 0;
    if (!strcmp(method, "GET") && !strcmp(path, "/health")) {
        char b[512]; snprintf(b, sizeof b, "{\"status\":\"ok\",\"model\":\"%s\",\"n_ctx\":%d,\"vocab\":%d,\"pid\":%d}", MODEL_ID, NCTX, V, (int)getpid()); reply(fd, 200, "application/json", b);
    } else if (!strcmp(method, "GET") && !strcmp(path, "/v1/models")) {
        char b[512]; snprintf(b, sizeof b, "{\"object\":\"list\",\"data\":[{\"id\":\"%s\",\"object\":\"model\",\"owned_by\":\"cipher\",\"context_length\":%d}]}", MODEL_ID, NCTX); reply(fd, 200, "application/json", b);
    } else if (!strcmp(method, "POST") && !strcmp(path, "/v1/chat/completions")) {
        handle_chat(fd, body, clen);
    } else err(fd, 404, "not found");
out:
    shutdown(fd, SHUT_RDWR); close(fd); free(buf);
}

int main(int argc, char **argv) {
    const char *mpath = NULL; int port = 0, threads = 4, ctx = 0;
    for (int i = 1; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--model")) mpath = argv[i + 1]; else if (!strcmp(argv[i], "--port")) port = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--threads")) threads = atoi(argv[i + 1]); else if (!strcmp(argv[i], "--ctx")) ctx = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--id")) MODEL_ID = argv[i + 1];
        else { fprintf(stderr, "unknown option %s\n", argv[i]); return 2; }
    }
    if (!mpath) { fprintf(stderr, "usage: cipher-serve --model file.ctern [--port 0] [--threads 4] [--ctx N] [--id name]\n"); return 2; }
#ifdef __linux__
    prctl(PR_SET_PDEATHSIG, SIGTERM); /* die with the app, even if it crashes */
#endif
    TOKEN = getenv("CIPHER_SERVE_TOKEN"); if (TOKEN && !*TOKEN) TOKEN = NULL;
    struct sigaction sa = {0}; sa.sa_handler = on_sig; sigaction(SIGTERM, &sa, NULL); sigaction(SIGINT, &sa, NULL); signal(SIGPIPE, SIG_IGN);
    M = cipher_load(mpath); if (!M) { fprintf(stderr, "cannot load model %s\n", mpath); return 3; }
    V = cipher_vocab(M); NCTX = ctx > 0 && ctx < cipher_max_len(M) ? ctx : cipher_max_len(M);
    C = cipher_new_ctx(M, NCTX, threads);
    T_EOT = cipher_special(M, TOK_EOT); T_U = cipher_special(M, TOK_USER); T_A = cipher_special(M, TOK_ASSISTANT); T_S = cipher_special(M, TOK_SYSTEM); T_PAD = cipher_special(M, TOK_PAD);
    cache = malloc(sizeof(int) * (NCTX + 8)); logits = malloc(sizeof(float) * V); seen = calloc(V, 1); pbuf = malloc(sizeof(pi_t) * V);
    int s = socket(AF_INET, SOCK_STREAM, 0); int one = 1; setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in a = {0}; a.sin_family = AF_INET; a.sin_port = htons(port); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(s, (struct sockaddr *)&a, sizeof a) || listen(s, 16)) { perror("bind"); return 4; }
    socklen_t al = sizeof a; getsockname(s, (struct sockaddr *)&a, &al);
    printf("CIPHER_SERVE_LISTENING %d\n", ntohs(a.sin_port)); fflush(stdout);
    fprintf(stderr, "[cipher-serve] model=%s id=%s n_ctx=%d vocab=%d threads=%d port=%d\n", mpath, MODEL_ID, NCTX, V, threads, ntohs(a.sin_port));
    while (!stop_flag) {
        int fd = accept(s, NULL, NULL);
        if (fd < 0) { if (errno == EINTR) continue; break; }
        int nd = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nd, sizeof nd);
        handle(fd);
    }
    close(s); cipher_free_ctx(C); cipher_free_model(M);
    fprintf(stderr, "[cipher-serve] stopped\n");
    return 0;
}
