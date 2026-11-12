# Independent decryptor written from Omni's EncryptionFormat.md, to check the
# connector's encryptor. Usage: decrypt_ofocus.py <encrypted-key-file> <password> <file>...
# Prints "OK <file> <length> <sha256>" per file, or raises.
import sys, struct, plistlib, hmac, hashlib
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes, keywrap
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

meta = plistlib.load(open(sys.argv[1], "rb"))
if isinstance(meta, list):
    meta = meta[0]
H = {"sha1": hashes.SHA1, "sha256": hashes.SHA256, "sha512": hashes.SHA512}[meta.get("prf", "sha1")]
kek = PBKDF2HMAC(algorithm=H(), length=16, salt=meta["salt"], iterations=meta["rounds"]).derive(sys.argv[2].encode())
blob = keywrap.aes_key_unwrap(kek, meta["key"])
slots, i = {}, 0
while i + 4 <= len(blob) and blob[i] != 0:
    t, n, sid = blob[i], 4 * blob[i + 1], struct.unpack(">H", blob[i + 2:i + 4])[0]
    slots[sid] = (t, blob[i + 4:i + 4 + n])
    i += 4 + n

for path in sys.argv[3:]:
    data = open(path, "rb").read()
    assert data[:20] == b"OmniFileEncryption\0\0", "magic"
    info_len = struct.unpack(">H", data[20:22])[0]
    info = data[22:22 + info_len]
    pos = 22 + info_len
    pad = (16 - pos % 16) % 16
    assert data[pos:pos + pad] == b"\0" * pad, "padding"
    pos += pad
    t, key = slots[struct.unpack(">H", info[:2])[0]]
    assert t in (3, 4) and len(info) == 2, "key type"
    aes_key, mac_key = key[:16], key[16:]
    end = len(data) - 32
    fmac = hmac.new(mac_key, b"\x01", hashlib.sha256)
    out, idx = b"", 0
    while True:
        assert pos + 32 <= end, "truncated"
        n = min(65536, end - pos - 32)
        iv, smac, ct = data[pos:pos + 12], data[pos + 12:pos + 32], data[pos + 32:pos + 32 + n]
        calc = hmac.new(mac_key, iv + struct.pack(">I", idx) + ct, hashlib.sha256).digest()[:20]
        assert hmac.compare_digest(calc, smac), "segment mac %d" % idx
        fmac.update(smac)
        dec = Cipher(algorithms.AES(aes_key), modes.CTR(iv + b"\0\0\0\0")).decryptor()
        out += dec.update(ct) + dec.finalize()
        pos += 32 + n
        idx += 1
        if n < 65536 or pos >= end:
            break
    assert hmac.compare_digest(fmac.digest(), data[end:]), "file mac"
    print("OK", path.rsplit("/", 1)[-1], len(out), hashlib.sha256(out).hexdigest()[:16])
