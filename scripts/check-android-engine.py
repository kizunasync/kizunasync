#!/usr/bin/env python3
"""Verify that an APK embeds the current engine, allowing AGP to strip symbols."""

import argparse
import hashlib
from pathlib import Path
import struct
import zipfile


ABIS = {'arm64-v8a': 183, 'armeabi-v7a': 40, 'x86_64': 62}
REPO_ROOT = Path(__file__).resolve().parent.parent


def loadable_image(data: bytes):
    if data[:4] != b'\x7fELF' or data[5] != 1 or data[4] not in (1, 2):
        raise ValueError('Expected a little-endian Android ELF library')
    bits = data[4]
    machine = struct.unpack_from('<H', data, 18)[0]
    if bits == 2:
        phoff, shoff = struct.unpack_from('<QQ', data, 32)
        phsize, phnum, shsize, shnum, names_index = struct.unpack_from('<HHHHH', data, 54)
        section_format = '<IIQQQQIIQQ'
        program_format = '<IIQQQQQQ'
    else:
        phoff, shoff = struct.unpack_from('<II', data, 28)
        phsize, phnum, shsize, shnum, names_index = struct.unpack_from('<HHHHH', data, 42)
        section_format = '<IIIIIIIIII'
        program_format = '<IIIIIIII'
    if not shnum or not 0 < names_index < shnum:
        raise ValueError('ELF section table is missing or unsupported')
    sections = [struct.unpack_from(section_format, data, shoff + i * shsize) for i in range(shnum)]
    names_header = sections[names_index]
    names = data[names_header[4]:names_header[4] + names_header[5]]
    image = []
    for section in sections:
        name_offset, kind, flags, address, offset, size = section[:6]
        if not flags & 2:  # SHF_ALLOC: memory loaded by Android, excluding debug/symbol tables.
            continue
        end = names.index(0, name_offset)
        name = names[name_offset:end].decode('ascii')
        digest = None if kind == 8 else hashlib.sha256(data[offset:offset + size]).hexdigest()
        image.append((name, kind, flags, address, size, digest))
    if not any(section[0] == '.text' for section in image):
        raise ValueError('ELF has no executable code')
    for index in range(phnum):
        program = struct.unpack_from(program_format, data, phoff + index * phsize)
        if program[0] == 1 and machine in (62, 183) and program[7] < 16384:
            raise ValueError('64-bit engine is not aligned for Android 16 KB pages')
    return bits, machine, sorted(image)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('apk', type=Path)
    parser.add_argument('--jni-dir', type=Path, default=REPO_ROOT / 'crates/kizunasync-ffi/bindings/kotlin/engine/src/main/jniLibs')
    args = parser.parse_args()
    with zipfile.ZipFile(args.apk) as apk, args.apk.open('rb') as source:
        for abi, machine in ABIS.items():
            filename = f'lib/{abi}/libkizunasync_ffi.so'
            expected = loadable_image((args.jni_dir / abi / 'libkizunasync_ffi.so').read_bytes())
            actual = loadable_image(apk.read(filename))
            if expected[1] != machine or actual != expected:
                raise ValueError(f'{abi}: APK does not contain the freshly built engine')
            entry = apk.getinfo(filename)
            if machine in (62, 183) and entry.compress_type == zipfile.ZIP_STORED:
                source.seek(entry.header_offset + 26)
                name_size, extra_size = struct.unpack('<HH', source.read(4))
                if (entry.header_offset + 30 + name_size + extra_size) % 16384:
                    raise ValueError(f'{abi}: uncompressed engine is not 16 KB aligned in the APK')
            print(f'{abi}: current engine verified, including loadable data and page alignment')


if __name__ == '__main__':
    main()
