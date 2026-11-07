#define _GNU_SOURCE
/* Greedy next-token decode for one .ctern. No sampling.
   Input lines: id <tab> comma-separated token ids, already the full chat prompt.
   Stops on any of the five special ids, matching cipher-serve.
   Repetition penalty is optional and still deterministic: after the penalty, take argmax. */
#include "../runtime/cipher.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

static int argmax_rep(float *l, int V, const unsigned char *seen, float rep) {
    if (rep != 1.0f) for (int i = 0; i < V; i++) if (seen[i]) l[i] = l[i] > 0 ? l[i] / rep : l[i] * rep;
    int best = 0;
    for (int i = 1; i < V; i++) if (l[i] > l[best]) best = i;
    return best;
}

int main(int argc, char **argv) {
    const char *model = NULL, *ids_path = NULL, *out_path = NULL;
    int ctx = 512, threads = 2, max_new = 128;
    float rep = 1.0f;
    for (int i = 1; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--model")) model = argv[i + 1];
        else if (!strcmp(argv[i], "--ids")) ids_path = argv[i + 1];
        else if (!strcmp(argv[i], "--out")) out_path = argv[i + 1];
        else if (!strcmp(argv[i], "--ctx")) ctx = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--threads")) threads = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--max-new")) max_new = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--rep")) rep = (float)atof(argv[i + 1]);
        else { fprintf(stderr, "unknown %s\n", argv[i]); return 2; }
    }
    if (!model || !ids_path || !out_path) {
        fprintf(stderr, "usage: greedy_chat --model file.ctern --ids prompts.tsv --out out.jsonl [--ctx 512] [--threads 2] [--max-new 128] [--rep 1]\n");
        return 2;
    }
    cipher_model *M = cipher_load(model);
    if (!M) return 3;
    int V = cipher_vocab(M);
    int nctx = ctx > 0 && ctx < cipher_max_len(M) ? ctx : cipher_max_len(M);
    cipher_ctx *C = cipher_new_ctx(M, nctx, threads < 1 ? 1 : threads);
    int spec[5];
    for (int i = 0; i < 5; i++) spec[i] = cipher_special(M, i);
    float *logits = malloc(sizeof(float) * (size_t)V);
    unsigned char *seen = calloc((size_t)V, 1);
    int *prompt = malloc(sizeof(int) * (size_t)(nctx + 8));
    FILE *in = fopen(ids_path, "r");
    FILE *out = fopen(out_path, "w");
    if (!in || !out) { perror("open"); return 4; }
    char *line = NULL; size_t cap = 0;
    while (getline(&line, &cap, in) > 0) {
        char *tab = strchr(line, '\t');
        if (!tab) continue;
        *tab = 0;
        int n = 0;
        char *p = tab + 1;
        while (*p && n < nctx - 1) {
            char *end = NULL;
            long id = strtol(p, &end, 10);
            if (end == p) break;
            prompt[n++] = (int)id;
            p = end;
            if (*p == ',') p++;
        }
        cipher_reset(C);
        memset(seen, 0, (size_t)V);
        for (int i = 0; i < n; i++) if (prompt[i] >= 0 && prompt[i] < V) seen[prompt[i]] = 1;
        if (cipher_eval(C, prompt, n, logits, 0)) { fprintf(out, "{\"id\": \"%s\", \"error\": \"context\"}\n", line); continue; }
        fprintf(out, "{\"id\": \"%s\", \"prompt_tokens\": %d, \"tokens\": [", line, n);
        int gen = 0, stop = -1;
        char text[8192]; int tn = 0; text[0] = 0;
        for (; gen < max_new && cipher_n_past(C) < nctx; gen++) {
            int t = argmax_rep(logits, V, seen, rep);
            int special = 0;
            for (int s = 0; s < 5; s++) if (t == spec[s]) special = 1;
            if (special) { stop = t; break; }
            if (tn < (int)sizeof text - 8 && t >= 0 && t < V) {
                const char *b; int bn = cipher_is_special(M, t) ? 0 : cipher_token_bytes(M, t, &b);
                if (bn > 0 && tn + bn < (int)sizeof text - 1) { memcpy(text + tn, b, (size_t)bn); tn += bn; text[tn] = 0; }
            }
            if (gen) fputc(',', out);
            fprintf(out, "%d", t);
            if (t >= 0 && t < V) seen[t] = 1;
            if (cipher_eval(C, &t, 1, logits, 0)) break;
        }
        fprintf(out, "], \"stop\": %d, \"n\": %d, \"text\": ", stop, gen);
        fputc('"', out);
        for (int i = 0; i < tn; i++) {
            unsigned char c = (unsigned char)text[i];
            if (c == '"' || c == '\\') { fputc('\\', out); fputc(c, out); }
            else if (c == '\n') fputs("\\n", out);
            else if (c >= 32) fputc(c, out);
            else fprintf(out, "\\u%04x", c);
        }
        fprintf(out, "\", \"rep\": %.2f, \"rng\": false}\n", rep);
    }
    fclose(in); fclose(out);
    free(line); free(prompt); free(logits); free(seen);
    cipher_free_ctx(C); cipher_free_model(M);
    return 0;
}
