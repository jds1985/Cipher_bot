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
    path = path or os.environ.get("CIPHER2_TOKENIZER")
    if not path:
        raise FileNotFoundError("pack out/cipher2_tokenizer/tokenizer.json is not set")
    return Tokenizer.from_file(path), path
