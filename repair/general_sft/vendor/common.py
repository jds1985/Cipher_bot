"""Shared helpers: locating Kaggle inputs and loading the tokenizer."""
import glob, os

def find_one(pattern, roots=("/kaggle/input", "/kaggle/working", ".")):
    for r in roots:
        hits = sorted(glob.glob(os.path.join(r, "**", pattern), recursive=True))
        if hits:
            return hits[0]
    return None

def load_tokenizer(path=None):
    from tokenizers import Tokenizer
    path = path or os.environ.get("CIPHER2_TOKENIZER") or find_one("cipher2_tokenizer/tokenizer.json")
    if not path:
        raise FileNotFoundError("cipher2_tokenizer/tokenizer.json not found (attach kernel jds1985/cipher2-tokenizer)")
    return Tokenizer.from_file(path), path
