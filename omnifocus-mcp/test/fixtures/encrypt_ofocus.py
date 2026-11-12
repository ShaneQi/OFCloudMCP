# Independent encryptor written from Omni's EncryptionFormat.md, for test fixtures.
import sys, os, shutil, struct, plistlib, hmac, hashlib
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes, keywrap
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

src, out, pw, rounds, prf = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
fmt = plistlib.FMT_BINARY if len(sys.argv) > 6 and sys.argv[6] == "binary" else plistlib.FMT_XML
H = {"sha1": hashes.SHA1, "sha256": hashes.SHA256, "sha512": hashes.SHA512}[prf]
salt = os.urandom(20)
kek = PBKDF2HMAC(algorithm=H(), length=16, salt=salt, iterations=rounds).derive(pw.encode())
key_id, material = 7, os.urandom(32)
slots = struct.pack(">BBH", 3, 32 // 4, key_id) + material
slots += b"\0" * ((8 - len(slots) % 8) % 8)
meta = [{"method": "password", "algorithm": "PBKDF2; aes128-wrap", "rounds": rounds, "salt": salt, "prf": prf,
         "key": keywrap.aes_key_wrap(kek, slots)}]
if os.path.exists(out):
    shutil.rmtree(out)
os.mkdir(out)
with open(os.path.join(out, "encrypted"), "wb") as f:
    plistlib.dump(meta, f, fmt=fmt)
aes_key, mac_key = material[:16], material[16:]
for name in sorted(os.listdir(src)):
    data = open(os.path.join(src, name), "rb").read()
    hdr = b"OmniFileEncryption\0\0" + struct.pack(">HH", 2, key_id)
    body = hdr + b"\0" * ((16 - len(hdr) % 16) % 16)
    fmac = hmac.new(mac_key, b"\x01", hashlib.sha256)
    for i in range(max(1, (len(data) + 65535) // 65536)):
        chunk = data[i * 65536:(i + 1) * 65536]
        iv = os.urandom(12)
        enc = Cipher(algorithms.AES(aes_key), modes.CTR(iv + b"\0\0\0\0")).encryptor()
        ct = enc.update(chunk) + enc.finalize()
        smac = hmac.new(mac_key, iv + struct.pack(">I", i) + ct, hashlib.sha256).digest()[:20]
        fmac.update(smac)
        body += iv + smac + ct
    open(os.path.join(out, name), "wb").write(body + fmac.digest())
