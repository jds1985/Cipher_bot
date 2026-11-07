"""CipherTern model (same math as the ciphertern-1024 kernel).

- TernaryLinear: absmean ternary weights {-1,0,+1}*scale with STE; per-token 8-bit
  activation quant with 99th-percentile (kthvalue) clipping and STE  x + (q-x).detach().
- Pre-LN decoder blocks: causal attention + 4x GELU FFN, learned positional embedding,
  final LayerNorm. Token embedding, positional embedding, LayerNorms and LM head stay
  full precision (only the attention/FFN projections are ternary), as in the original code.
- Only change vs the original: attention uses F.scaled_dot_product_attention(is_causal=True),
  which is mathematically identical to the explicit mask+softmax but faster / less memory.
  Quantizer math runs in fp32 even under AMP autocast.
"""
import math, torch
import torch.nn as nn
import torch.nn.functional as F


class TernaryLinear(nn.Module):
    def __init__(self, in_features, out_features, bias=False, quantize_act=True):
        super().__init__()
        self.in_features, self.out_features, self.quantize_act = in_features, out_features, quantize_act
        self.weight = nn.Parameter(torch.randn(out_features, in_features) * 0.02)
        self.bias = nn.Parameter(torch.zeros(out_features)) if bias else None
        # Set by export/reload: frozen dequantized ternary weight (codes*scale). When present
        # it is used directly (no re-ternarization), so exported models reproduce logits.
        self.register_buffer("frozen_w", None, persistent=False)

    @staticmethod
    def ternarize(w):
        scale = w.abs().mean().clamp(min=1e-5)
        codes = torch.round(w / scale).clamp(-1, 1)
        return codes, scale

    def quant_act(self, x):
        xf = x.float()
        k = max(1, int((1 - 0.99) * xf.size(-1)))
        thresh = xf.abs().kthvalue(xf.size(-1) - k, dim=-1, keepdim=True).values
        xc = xf.clamp(-thresh, thresh)
        scale = 127.0 / xc.abs().amax(dim=-1, keepdim=True).clamp(min=1e-5)
        q = torch.round(xc * scale).clamp(-128, 127) / scale
        return (xf + (q - xf).detach()).to(x.dtype)

    def forward(self, x):
        if self.frozen_w is not None:
            w = self.frozen_w
        else:
            codes, scale = self.ternarize(self.weight.float())
            w = self.weight + (codes * scale - self.weight).detach()   # STE
        if self.quantize_act:
            x = self.quant_act(x)
        return F.linear(x, w, self.bias)  # autocast handles dtype under AMP


def make_linear(i, o, ternary, quantize_act):
    return TernaryLinear(i, o, quantize_act=quantize_act) if ternary else nn.Linear(i, o)


class CausalAttention(nn.Module):
    def __init__(self, d_model, n_heads, ternary=True, quantize_act=True):
        super().__init__()
        self.n_heads, self.head_dim = n_heads, d_model // n_heads
        self.qkv = make_linear(d_model, 3 * d_model, ternary, quantize_act)
        self.out = make_linear(d_model, d_model, ternary, quantize_act)

    def forward(self, x):
        B, T, C = x.shape
        q, k, v = self.qkv(x).reshape(B, T, 3, self.n_heads, self.head_dim).unbind(2)
        q, k, v = (t.transpose(1, 2) for t in (q, k, v))
        o = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        return self.out(o.transpose(1, 2).reshape(B, T, C))


class Block(nn.Module):
    def __init__(self, d, h, ternary, qa):
        super().__init__()
        self.norm1, self.norm2 = nn.LayerNorm(d), nn.LayerNorm(d)
        self.attn = CausalAttention(d, h, ternary, qa)
        self.ffn = make_linear(d, 4 * d, ternary, qa)
        self.ffn_out = make_linear(4 * d, d, ternary, qa)

    def forward(self, h):
        h = h + self.attn(self.norm1(h))
        return h + self.ffn_out(F.gelu(self.ffn(self.norm2(h))))


class CipherTern(nn.Module):
    def __init__(self, vocab_size, d_model=384, n_layers=4, n_heads=6, max_len=256, ternary=True, quantize_act=True, **_):
        super().__init__()
        self.max_len = max_len
        self.embed = nn.Embedding(vocab_size, d_model)
        self.pos_embed = nn.Embedding(max_len, d_model)
        self.layers = nn.ModuleList([Block(d_model, n_heads, ternary, quantize_act) for _ in range(n_layers)])
        self.norm_f = nn.LayerNorm(d_model)
        self.head = nn.Linear(d_model, vocab_size)

    def forward(self, idx, targets=None):
        B, T = idx.shape
        h = self.embed(idx) + self.pos_embed(torch.arange(T, device=idx.device))[None]
        for l in self.layers:
            h = l(h)
        logits = self.head(self.norm_f(h))
        if targets is None:
            return logits
        return logits, F.cross_entropy(logits.float().view(-1, logits.size(-1)), targets.view(-1))

    @torch.no_grad()
    def generate(self, idx, max_new_tokens, temperature=0.8, top_k=50, eos_id=None, generator=None):
        for _ in range(max_new_tokens):
            logits = self(idx[:, -self.max_len:])[:, -1].float() / max(temperature, 1e-5)
            if top_k:
                v, _ = torch.topk(logits, min(top_k, logits.size(-1)))
                logits[logits < v[:, [-1]]] = -float("inf")
            nxt = torch.multinomial(F.softmax(logits, -1), 1, generator=generator)
            idx = torch.cat([idx, nxt], 1)
            if eos_id is not None and nxt.item() == eos_id:
                break
        return idx


def count_params(m):
    tot = sum(p.numel() for p in m.parameters())
    tern = sum(mod.weight.numel() for mod in m.modules() if isinstance(mod, TernaryLinear))
    return tot, tern
