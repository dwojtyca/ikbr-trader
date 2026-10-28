"""Install the checksum-pinned official SDK and retain its source/license."""
import hashlib
import pathlib
import sys
import urllib.request
import zipfile
import io

SHA256 = '50a459ed09f0030df25125a177e57b69bdf576ec3a89fcb1f81fdff95bbf6316'
URL = 'https://interactivebrokers.github.io/downloads/twsapi_macunix.1051.01.zip'

def install(destination):
    data = urllib.request.urlopen(URL, timeout=60).read(64 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise RuntimeError('SDK checksum mismatch')
    root = pathlib.Path(destination)
    root.mkdir(parents=True, exist_ok=True)
    # The complete original source archive accompanies the installed Python source.
    (root / 'twsapi_macunix.1051.01.zip').write_bytes(data)
    (root / 'SHA256').write_text(SHA256 + '\n')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for member in archive.infolist():
            name = member.filename
            if not (name.startswith('IBJts/source/pythonclient/ibapi/') or name == 'IBJts/LICENSE' or name.startswith('IBJts/THIRD_PARTY_LICENSES/')):
                continue
            relative = pathlib.PurePosixPath(name)
            if '..' in relative.parts or relative.is_absolute() or (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise RuntimeError('Unsafe SDK archive entry')
            target = root.joinpath(*relative.parts)
            if member.is_dir(): target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(member))

if __name__ == '__main__':
    install(sys.argv[1])
