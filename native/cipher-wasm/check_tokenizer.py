#!/usr/bin/env python3
"""Compare cipher.c's pretokenizer + BPE with tokenizer.json.

The browser wasm calls the same cipher_encode as native/cipher-serve/runtime/cipher.c.
This does not load weights. Role ids below are tokenizer.json added-token ids.
Whether a .ctern's tok.special array stores those ids is not decided here.
"""
import json
import sys
from pathlib import Path

from tokenizers import Tokenizer

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures"
TOKENIZER = FIX / "tokenizer.json"
PACK = FIX / "general-v1.json"
TRACES = FIX / "prompt-traces.json"
TOKENIZER_SHA = "e4bc6fd60a641f62ac614865fb8c8d6034a090123cb565ee7d87d977b52d185e"


def bytes_to_unicode():
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, [chr(c) for c in cs]))


def load_encoder(raw):
    vocab = raw["model"]["vocab"]
    u2b = {v: k for k, v in bytes_to_unicode().items()}
    byte_id = [-1] * 256
    for s, i in vocab.items():
        if len(s) == 1 and s in u2b and byte_id[u2b[s]] < 0:
            byte_id[u2b[s]] = i
    if any(i < 0 for i in byte_id):
        raise SystemExit("tokenizer is missing a byte piece")
    rank, merge_to = {}, {}
    for r, pair in enumerate(raw["model"]["merges"]):
        a, b = pair
        res = a + b
        rank[(vocab[a], vocab[b])] = r
        merge_to[(vocab[a], vocab[b])] = vocab[res]
    special_bytes = {t["id"]: t["content"].encode() for t in raw["added_tokens"]}
    return byte_id, rank, merge_to, special_bytes


def is_space(c):
    return c == 32 or 9 <= c <= 13 or c in (0x85, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000) or 0x2000 <= c <= 0x200A


def is_num(c):
    return (48 <= c <= 57) or c in (0xB2, 0xB3, 0xB9) or 0xBC <= c <= 0xBE or 0x660 <= c <= 0x669 or 0x6F0 <= c <= 0x6F9 or 0x966 <= c <= 0x96F or 0x2070 <= c <= 0x2079 or 0x2080 <= c <= 0x2089 or 0x2150 <= c <= 0x218B or 0x2460 <= c <= 0x249B or 0xFF10 <= c <= 0xFF19


def is_letter(c):
    if c < 0x80:
        return ord("a") <= (c | 32) <= ord("z")
    if is_space(c) or is_num(c):
        return False
    if 0xA1 <= c <= 0xBF:
        return c in (0xAA, 0xB5, 0xBA)
    if c in (0xD7, 0xF7):
        return False
    if (0x2000 <= c <= 0x2BFF) or (0x3000 <= c <= 0x303F) or (0xFE30 <= c <= 0xFE4F) or (0x1F000 <= c <= 0x1FAFF) or (0xE000 <= c <= 0xF8FF) or c in (0xFE0F, 0x200D):
        return False
    if 0xFF00 <= c <= 0xFFEF:
        return (0xFF21 <= c <= 0xFF3A) or (0xFF41 <= c <= 0xFF5A) or c >= 0xFF66
    if 0x300 <= c <= 0x36F:
        return False
    return True


def utf8_dec(s, i):
    c = s[i]
    if c < 0x80:
        return c, 1
    length = 4 if c >= 0xF0 else 3 if c >= 0xE0 else 2 if c >= 0xC0 else 1
    if length > len(s) - i or length == 1:
        return c, 1
    v = c & (0x3F >> (length - 1))
    for k in range(1, length):
        v = (v << 6) | (s[i + k] & 0x3F)
    return v, length


def make_cipher_encode(byte_id, rank, merge_to, special_bytes):
    contr = [b"re", b"ve", b"ll", b"s", b"t", b"m", b"d"]

    def bpe_piece(bs):
        ids = [byte_id[b] for b in bs]
        while True:
            best, br = None, 10**9
            for i in range(len(ids) - 1):
                r = rank.get((ids[i], ids[i + 1]))
                if r is not None and r < br:
                    br, best = r, i
            if best is None:
                break
            ids[best] = merge_to[(ids[best], ids[best + 1])]
            del ids[best + 1]
        return [i for i in ids if i >= 0]

    def encode_plain(s):
        n, w, i = len(s), [], 0
        while i < n:
            c, ln = utf8_dec(s, i)
            if c == 39 and i + 1 < n:
                hit = False
                for q in contr:
                    if s[i + 1:i + 1 + len(q)] == q:
                        j = i + 1 + len(q)
                        hit = True
                        break
                if hit:
                    w += bpe_piece(s[i:j])
                    i = j
                    continue
            st = i
            if c == 32 and i + 1 < n:
                j = i + 1
                c2, _ = utf8_dec(s, j)
            else:
                j, c2 = i, c
            cls = 1 if is_letter(c2) else 2 if is_num(c2) else 0 if is_space(c2) else 3
            if cls:
                while j < n:
                    cc, ll = utf8_dec(s, j)
                    k2 = 1 if is_letter(cc) else 2 if is_num(cc) else 0 if is_space(cc) else 3
                    if k2 != cls:
                        break
                    j += ll
                w += bpe_piece(s[st:j])
                i = j
                continue
            j, last, cnt = i, i, 0
            while j < n:
                cc, ll = utf8_dec(s, j)
                if not is_space(cc):
                    break
                last = j
                j += ll
                cnt += 1
            if j < n and cnt > 1:
                j = last
            if j == i:
                j = i + ln
            w += bpe_piece(s[i:j])
            i = j
        return w

    def cipher_encode(text: bytes):
        n, w, i, st = len(text), [], 0, 0
        while i <= n:
            sp, sl = -1, 0
            if i < n and text[i] == ord("<"):
                for q in range(5):
                    blob = special_bytes[q]
                    if i + len(blob) <= n and text[i:i + len(blob)] == blob:
                        sp, sl = q, len(blob)
                        break
            if sp >= 0 or i == n:
                w += encode_plain(text[st:i])
                if sp >= 0:
                    w.append(sp)
                if i == n:
                    break
                i += sl
                st = i
            else:
                i += 1
        return w

    return cipher_encode


def build(cipher_encode, hf, pack):
    system = pack["system"]
    sys_ids = [4] + cipher_encode((system + "\n").encode())
    if hf(system + "\n") != sys_ids[1:]:
        raise SystemExit("system text diverges from the HF tokenizer")
    rows = []
    for item in pack["prompts"]:
        text = item["text"]
        plain = hf(text)
        body = cipher_encode((text + "\n").encode())
        if body != hf(text + "\n"):
            raise SystemExit(f"{item['id']} diverges from the HF tokenizer")
        user = [2] + body + [3]
        full = sys_ids + user
        n_past = len(sys_ids)
        fits = 512 > n_past + len(user) + 128
        rows.append({
            "id": item["id"],
            "family": item["family"],
            "plainStringIds": plain,
            "systemSegment": sys_ids,
            "userSegment": user,
            "fullPrompt": full,
            "nSystem": n_past,
            "nUserSegment": len(user),
            "nFull": len(full),
            "withMaxNew": n_past + len(user) + 128,
            "keepsSystemAtCtx512": fits,
        })
    return {
        "tokenizerSha256": TOKENIZER_SHA,
        "roleIdSource": "tokenizer.json added tokens. Wasm inserts model->special[4/2/3] from tok.special. Those file bytes were not read.",
        "roles": {"eot": 0, "pad": 1, "user": 2, "assistant": 3, "system": 4},
        "newlineId": sys_ids[-1],
        "system": system,
        "settings": {"ctx": 512, "maxNew": 128, "seed": 0},
        "prompts": rows,
    }


def main():
    import hashlib
    digest = hashlib.sha256(TOKENIZER.read_bytes()).hexdigest()
    if digest != TOKENIZER_SHA:
        raise SystemExit(f"tokenizer sha {digest} != {TOKENIZER_SHA}")
    raw = json.loads(TOKENIZER.read_text())
    tok = Tokenizer.from_file(str(TOKENIZER))
    cipher_encode = make_cipher_encode(*load_encoder(raw))
    hf = lambda s: tok.encode(s).ids
    extras = ["Hello", " Hello", "don't", "I'm", "a  b", "7:00 AM", "1.10", "Maple & Rye", "<|system|>Hi", "<|user|>Hi\n<|assistant|>"]
    for s in extras:
        if cipher_encode(s.encode()) != hf(s):
            raise SystemExit(f"edge case diverges: {s!r}")
    pack = json.loads(PACK.read_text())
    doc = build(cipher_encode, hf, pack)
    if "--write" in sys.argv:
        TRACES.write_text(json.dumps(doc, indent=2) + "\n")
        print(f"wrote {TRACES}")
        return
    have = json.loads(TRACES.read_text())
    if have != doc:
        raise SystemExit("prompt-traces.json does not match a fresh tokenizer run")
    if not all(p["keepsSystemAtCtx512"] for p in doc["prompts"]):
        raise SystemExit("a general prompt drops the system segment at ctx 512")
    print(f"tokenizer match {len(doc['prompts'])} prompts, system tokens {doc['prompts'][0]['nSystem']}")


if __name__ == "__main__":
    main()
