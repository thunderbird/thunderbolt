"""Check secret names, use the clipboard, or scan artifacts; never emit values."""
import argparse
import base64
import json
import pathlib
import re
import subprocess
import sys
import urllib.parse

SECRET_FILE = pathlib.Path.home() / '.argent/secrets.env'


def load_secrets():
    """Read simple NAME=value lines without shell expansion."""
    if not SECRET_FILE.exists():
        return {}
    values = {}
    for line in SECRET_FILE.read_text().splitlines():
        match = re.fullmatch(r'(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)', line.strip())
        if not match:
            continue
        name, value = match.groups()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if value:
            values[name] = value
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog='Inputs: ~/.argent/secrets.env. Outputs: names/status or artifact paths. Side effects: clip/clear replace the macOS clipboard; scan/check are read-only. Exit 1: missing name or detected secret; 2: operational error.')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('check').add_argument('names', nargs='+')
    sub.add_parser('clip').add_argument('name')
    sub.add_parser('clear')
    sub.add_parser('scan').add_argument('directory', type=pathlib.Path)
    args = parser.parse_args()
    values = load_secrets()
    if args.command == 'check':
        for name in args.names:
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
                parser.error('Use secret variable names only')
            print(f'{name}: {"present" if name in values else "missing"}')
        return int(not all(n in values for n in args.names))
    if args.command in ('clip', 'clear'):
        if args.command == 'clip' and args.name not in values:
            parser.error('Secret missing; add it in your terminal with a no-echo read')
        subprocess.run(['pbcopy'], input=values[args.name].encode() if args.command == 'clip' else b'', check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print('Clipboard copied' if args.command == 'clip' else 'Clipboard cleared')
        return 0
    if not args.directory.is_dir():
        parser.error('scan requires an existing artifact directory')
    needles = set()
    for value in values.values():
        needles.update(s.encode() for s in (value, urllib.parse.quote(value, safe=''), json.dumps(value)[1:-1], base64.b64encode(value.encode()).decode()))
    hits = []
    for path in sorted(args.directory.rglob('*')):
        if path.is_symlink():
            parser.error('Artifact symlink found; scan a materialized artifact directory')
        if not path.is_file():
            continue
        content = path.read_bytes()
        if any(v in content for v in needles):
            safe_path = str(path)
            for value in values.values():
                safe_path = safe_path.replace(value, '<redacted>')
            hits.append(safe_path)
    for path in hits:
        print('SECRET HIT: ' + path)
    print(f'Scan: {len(hits)} file(s) with hits; {len(values)} configured nonempty value(s).')
    if not values:
        print('No configured values: this does not certify artifacts free of unknown credentials.')
    return int(bool(hits))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, subprocess.SubprocessError):
        print('Operation failed; check file permissions or macOS pbcopy availability. No values emitted.', file=sys.stderr)
        sys.exit(2)
