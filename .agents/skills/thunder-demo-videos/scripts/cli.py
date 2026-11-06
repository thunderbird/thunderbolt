#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Record a real command's PTY output, or render its unchanged ANSI stream."""

import argparse
import codecs
import fcntl
import json
import math
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import struct
import subprocess
import sys
import termios
import time
import pyte
from PIL import Image, ImageDraw, ImageFont


def record(args):
    """Capture a command in the supplied working directory without resetting files or approvals."""
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        raise ValueError('Supply the real CLI invocation after --')
    if args.output.exists():
        raise ValueError('Choose a new capture path; raw recordings are immutable')
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', args.rows, args.columns, 0, 0))
    environment = dict(os.environ, TERM='xterm-256color', COLUMNS=str(args.columns), LINES=str(args.rows))
    process = subprocess.Popen(command, cwd=args.cwd, env=environment, stdin=slave, stdout=slave,
                               stderr=slave, start_new_session=True, close_fds=True)
    os.close(slave)
    start = time.monotonic()
    events = [[0, '❯ ' + shlex.join(command) + '\r\n\r\n']]
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    timed_out = False
    try:
        while True:
            ready, _, _ = select.select([master], [], [], .1)
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                text = decoder.decode(data)
                if text:
                    events.append([round(time.monotonic() - start, 4), text])
                    print(text, end='', flush=True)
            elif process.poll() is not None:
                break
            if time.monotonic() - start > args.timeout:
                timed_out = True
                break
    finally:
        os.close(master)
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
        exit_code = process.wait()
    tail = decoder.decode(b'', final=True)
    if tail:
        events.append([round(time.monotonic() - start, 4), tail])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'version': 1, 'columns': args.columns, 'lines': args.rows,
                                      'command': command, 'events': events, 'exit': exit_code,
                                      'timedOut': timed_out}, indent=2) + '\n')
    return 124 if timed_out else exit_code


def ansi_color(value, background=False):
    """Translate pyte ANSI colors while retaining the captured text and attributes."""
    colors = {'black': '#202631', 'red': '#f28e98', 'green': '#b6e88e', 'brown': '#efc788',
              'blue': '#90bcff', 'magenta': '#dcb0ff', 'cyan': '#83d6e4', 'white': '#e7ebf1',
              'brightblack': '#728198', 'brightred': '#ffa1a8', 'brightgreen': '#d6f7ac',
              'brightbrown': '#ffe1a7', 'brightblue': '#c3d9ff', 'brightmagenta': '#edcdff',
              'brightcyan': '#a0edfa', 'brightwhite': '#ffffff'}
    if value == 'default':
        return '#121a27' if background else '#e7ebf1'
    return colors.get(value, '#' + value if len(value) == 6 else '#e7ebf1')


def render(args):
    """Render every recorded output event; shorten inter-event waits without filtering text."""
    recording = json.loads(args.source.read_text())
    if args.output.resolve() == args.source.resolve():
        raise ValueError('Render to a separate file')
    font = ImageFont.truetype(str(args.font), args.font_size)
    cell_width = math.ceil(font.getlength('M'))
    cell_height = math.ceil(args.font_size * 1.35)
    width = (recording['columns'] * cell_width + 40) // 2 * 2
    height = (recording['lines'] * cell_height + 40) // 2 * 2
    screen = pyte.Screen(recording['columns'], recording['lines'])
    stream = pyte.Stream(screen)
    mapped = []
    clock = .4
    previous = 0
    for timestamp, text in recording['events']:
        if timestamp < previous:
            raise ValueError('PTY timestamps must be ordered')
        clock += min(timestamp - previous, args.idle_cap)
        mapped.append((clock, text))
        previous = timestamp
    duration = clock + args.final_hold
    args.output.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                                '-s', f'{width}x{height}', '-r', '30', '-i', 'pipe:0', '-an',
                                '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt',
                                'yuv420p', '-movflags', '+faststart', str(args.output)], stdin=subprocess.PIPE)
    index = 0
    cached_index = -1
    cached = None
    try:
        for frame in range(math.ceil(duration * 30)):
            now = frame / 30
            while index < len(mapped) and mapped[index][0] <= now:
                stream.feed(mapped[index][1])
                index += 1
            if index != cached_index:
                cached = Image.new('RGB', (width, height), '#121a27')
                draw = ImageDraw.Draw(cached)
                for row in range(recording['lines']):
                    for column, character in screen.buffer[row].items():
                        x, y = 20 + column * cell_width, 20 + row * cell_height
                        foreground, background = ansi_color(character.fg), ansi_color(character.bg, True)
                        if character.reverse:
                            foreground, background = background, foreground
                        if background != '#121a27':
                            draw.rectangle((x, y, x + cell_width, y + cell_height), fill=background)
                        if character.data.strip():
                            draw.text((x, y), character.data, font=font, fill=foreground)
                cached_index = index
            process.stdin.write(cached.tobytes())
    finally:
        process.stdin.close()
        status = process.wait()
    if status:
        raise RuntimeError(f'ffmpeg failed with status {status}')
    args.output.with_suffix('.replay.json').write_text(json.dumps({
        'source': args.source.name, 'duration': duration, 'width': width, 'height': height,
        'fps': 30, 'idleCapSeconds': args.idle_cap, 'finalHoldSeconds': args.final_hold,
        'notes': 'Real PTY replay; all output retained, idle waits shortened. Not a native screen recording.'
    }, indent=2) + '\n')
    return 0


def main():
    """Separate capture and replay so authentication/setup can happen before recording."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='mode', required=True)
    capture = commands.add_parser('record')
    capture.add_argument('--output', type=Path, required=True)
    capture.add_argument('--cwd', type=Path, required=True)
    capture.add_argument('--columns', type=int, default=100)
    capture.add_argument('--rows', type=int, default=28)
    capture.add_argument('--timeout', type=float, default=180)
    capture.add_argument('command', nargs=argparse.REMAINDER)
    replay = commands.add_parser('render')
    replay.add_argument('source', type=Path)
    replay.add_argument('--output', type=Path, required=True)
    replay.add_argument('--font', type=Path, required=True)
    replay.add_argument('--font-size', type=int, default=22)
    replay.add_argument('--idle-cap', type=float, default=1.2)
    replay.add_argument('--final-hold', type=float, default=2.5)
    args = parser.parse_args()
    return record(args) if args.mode == 'record' else render(args)


if __name__ == '__main__':
    sys.exit(main())
