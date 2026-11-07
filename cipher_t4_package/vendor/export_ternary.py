"""Export a trained CipherTern checkpoint to ternary codes + scales, and verify.

Output (OUT.pt + OUT.json manifest):
  for every TernaryLinear '<name>':  '<name>.codes' int8 {-1,0,1} (or '<name>.packed' uint8 with
  4 codes/byte when --pack2bit, values stored as code+1 in 2 bits), '<name>.scale' fp32 scalar,
  '<name>.bias' if any; everything else (embeddings, pos emb, LayerNorms, LM head) in fp16/fp32.
Verify: rebuild a model from the export (weights = codes*scale, frozen) and compare logits to the
original checkpoint's model on random token windows (fp32, eval mode).

  python export_ternary.py --ckpt run/ckpt/latest.pt --out export/cipher2 [--pack2bit] [--fp16]
"""
import argparse, json, os, torch
from model import CipherTern, TernaryLinear

def pack2(codes):
    u = (codes.flatten().to(torch.int16) + 1).to(torch.uint8)
    pad = (-u.numel()) % 4
    u = torch.cat([u, torch.ones(pad, dtype=torch.uint8)]) .view(-1, 4)   # pad with code 0
    return u[:, 0] | (u[:, 1] << 2) | (u[:, 2] << 4) | (u[:, 3] << 6)

def unpack2(p, shape):
    u = torch.stack([(p >> s) & 3 for s in (0, 2, 4, 6)], 1).flatten()[: int(torch.tensor(shape).prod())]
    return (u.to(torch.int8) - 1).view(shape)

def export(model, pack=False, fp16=False):
    sd, manifest = {}, {"ternary_layers": {}, "fp_tensors": []}
    tnames = set()
    for name, m in model.named_modules():
        if isinstance(m, TernaryLinear):
            codes, scale = TernaryLinear.ternarize(m.weight.detach().float())
            codes = codes.to(torch.int8); tnames.add(name + ".weight")
            if pack: sd[name + ".packed"] = pack2(codes)
            else: sd[name + ".codes"] = codes
            sd[name + ".scale"] = scale.reshape(1)
            manifest["ternary_layers"][name] = dict(shape=list(codes.shape), zero_frac=(codes == 0).float().mean().item(),
                                                    scale=scale.item(), quantize_act=m.quantize_act)
    for k, v in model.state_dict().items():
        if k not in tnames:
            sd[k] = v.half() if (fp16 and v.is_floating_point()) else v.float() if v.is_floating_point() else v
            manifest["fp_tensors"].append(k)
    manifest["packed_2bit"], manifest["fp16"] = pack, fp16
    return sd, manifest

def load_export(path, device="cpu"):
    blob = torch.load(path, map_location=device, weights_only=True)
    cfg, sd, man = blob["config"], blob["tensors"], blob["manifest"]
    model = CipherTern(blob["vocab_size"], **cfg).to(device)
    fp = {k: sd[k].float() if sd[k].is_floating_point() else sd[k] for k in man["fp_tensors"]}
    model.load_state_dict(fp, strict=False)
    for name, info in man["ternary_layers"].items():
        m = model.get_submodule(name)
        codes = unpack2(sd[name + ".packed"], info["shape"]) if man["packed_2bit"] else sd[name + ".codes"]
        m.frozen_w = (codes.float() * sd[name + ".scale"].float()).to(device)
    return model.eval(), blob

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True); ap.add_argument("--out", default="export/cipher2")
    ap.add_argument("--pack2bit", action="store_true"); ap.add_argument("--fp16", action="store_true")
    a = ap.parse_args()
    ck = torch.load(a.ckpt, map_location="cpu", weights_only=True)
    cfg, V = ck["config"], ck["meta"]["vocab_size"]
    model = CipherTern(V, **cfg); model.load_state_dict(ck["model"]); model.eval()
    sd, man = export(model, a.pack2bit, a.fp16)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    blob = dict(tensors=sd, manifest=man, config=cfg, vocab_size=V, step=ck["step"])
    torch.save(blob, a.out + ".pt")
    # verify
    re, _ = load_export(a.out + ".pt")
    g = torch.Generator().manual_seed(0); x = torch.randint(0, V, (4, cfg["max_len"]), generator=g)
    with torch.no_grad():
        l0, l1 = model(x), re(x)
    diff = (l0 - l1).abs()
    ce0 = torch.nn.functional.cross_entropy(l0[:, :-1].reshape(-1, V), x[:, 1:].reshape(-1)).item()
    ce1 = torch.nn.functional.cross_entropy(l1[:, :-1].reshape(-1, V), x[:, 1:].reshape(-1)).item()
    agree = (l0.argmax(-1) == l1.argmax(-1)).float().mean().item()
    tern_bytes = sum(v.numel() * v.element_size() for k, v in sd.items() if k.endswith((".codes", ".packed")))
    man["verify"] = dict(max_abs_logit_diff=diff.max().item(), mean_abs_logit_diff=diff.mean().item(),
                         argmax_agreement=agree, ce_original=ce0, ce_export=ce1)
    man["file_bytes"] = os.path.getsize(a.out + ".pt"); man["ternary_code_bytes"] = tern_bytes
    json.dump(dict(manifest=man, config=cfg, step=ck["step"]), open(a.out + ".json", "w"), indent=1)
    print("EXPORT", a.out + ".pt", json.dumps(dict(verify=man["verify"], file_bytes=man["file_bytes"],
          ternary_code_bytes=tern_bytes, packed=a.pack2bit)), flush=True)

if __name__ == "__main__":
    main()
