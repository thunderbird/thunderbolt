#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Inspect authentic footage and export reproducible, edited marketing demos."""

import argparse
from contextlib import ExitStack
import hashlib
import io
import json
import math
from pathlib import Path
import statistics
import shutil
import subprocess
import tempfile
from PIL import Image, ImageDraw, ImageFont


def run(command):
    """Run media tools without a shell, retaining useful failure diagnostics."""
    result = subprocess.run(command, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace'))
    return result.stdout


def probe(path):
    """Read stream properties and actual frame timestamps rather than nominal FPS."""
    data = json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format',
                           '-of', 'json', str(path)]))
    video = next(stream for stream in data['streams'] if stream['codec_type'] == 'video')
    packets = json.loads(run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                              '-show_entries', 'packet=pts_time', '-of', 'json', str(path)]))
    times = sorted(float(packet['pts_time']) for packet in packets['packets'] if 'pts_time' in packet)
    intervals = sorted(b - a for a, b in zip(times, times[1:]) if b > a)
    duration = float(data['format']['duration'])
    return {
        'width': video['width'], 'height': video['height'], 'codec': video['codec_name'],
        'pixelFormat': video.get('pix_fmt'), 'duration': duration,
        'audio': any(stream['codec_type'] == 'audio' for stream in data['streams']),
        'frames': len(times), 'averageFps': round(len(times) / duration, 2),
        'medianFrameMs': round(statistics.median(intervals) * 1000, 2) if intervals else None,
        'p95FrameMs': round(intervals[min(len(intervals) - 1, math.ceil(len(intervals) * .95) - 1)] * 1000, 2) if intervals else None,
        'maxFrameMs': round(max(intervals) * 1000, 2) if intervals else None,
    }


def inspect_video(source, output, start=0, end=None, step=None):
    """Produce a cadence report and a chronological contact sheet for choosing cuts."""
    output.mkdir(parents=True, exist_ok=True)
    metadata = probe(source)
    end = metadata['duration'] if end is None else end
    step = max(1, (end - start) / 20) if step is None else step
    if not 0 <= start < end <= metadata['duration'] + .05 or step <= 0:
        raise ValueError('Inspection range/step must be positive and inside the source')
    samples = [start + index * step for index in range(math.ceil((end - start) / step))]
    thumbnails = []
    for timestamp in samples:
        png = run(['ffmpeg', '-v', 'error', '-ss', str(timestamp), '-i', str(source),
                   '-vf', 'scale=384:-2', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'])
        thumbnails.append(Image.open(io.BytesIO(png)).convert('RGB'))
    width, height = thumbnails[0].size
    sheet = Image.new('RGB', (width * 4, (height + 28) * math.ceil(len(samples) / 4)), '#121a27')
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=16)
    for index, (timestamp, thumbnail) in enumerate(zip(samples, thumbnails)):
        x, y = index % 4 * width, index // 4 * (height + 28)
        draw.text((x + 8, y + 5), f'{timestamp:.2f}s', font=font, fill='white')
        sheet.paste(thumbnail, (x, y + 28))
    sheet.save(output / 'contact-sheet.jpg', quality=88)
    metadata.update({'source': source.name, 'contactSheetStepSeconds': step, 'contactSheetSamples': samples})
    (output / 'inspection.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata, indent=2))


def validate_clip(clip, metadata):
    """Reject ambiguous cuts and destructive source-coordinate edits before encoding."""
    previous_end = -1
    if not clip.get('keep'):
        raise ValueError('Each clip needs explicit keep ranges in original-source seconds')
    for start, end in clip['keep']:
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (start, end)):
            raise ValueError('Keep ranges must contain finite numbers')
        if start < 0 or start < previous_end or end <= start or end > metadata['duration'] + .05:
            raise ValueError('Keep ranges must be ordered, non-overlapping, and within the source')
        previous_end = end
    crop = clip.get('crop')
    regions = clip.get('removeOverlays', []) + ([crop] if crop else [])
    for region in regions:
        x, y, width, height = [region[key] for key in ('x', 'y', 'width', 'height')]
        if any(not isinstance(value, int) for value in (x, y, width, height)):
            raise ValueError('Pixel coordinates must be integers')
        if min(x, y) < 0 or min(width, height) <= 0 or x + width > metadata['width'] or y + height > metadata['height']:
            raise ValueError('Crop/overlay rectangle lies outside the source')
        if region is crop and (width % 2 or height % 2):
            raise ValueError('H.264 crop dimensions must be even')
    width = clip.get('outputWidth', metadata['width'])
    if not isinstance(width, int) or width <= 0 or width % 2:
        raise ValueError('Output width must be a positive even integer')
    duration = sum(end - start for start, end in clip['keep'])
    poster_at = clip.get('posterAt', max(0, duration - 1))
    if not isinstance(poster_at, (int, float)) or not 0 <= poster_at < duration:
        raise ValueError('posterAt must be within the edited timeline')


def child_path(root, relative):
    """Keep a recipe's relative paths inside its explicit source/output directory."""
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Recipe paths must stay inside the supplied directory')
    return path


def source_hash(source):
    """Hash potentially large native recordings without loading them into memory."""
    digest = hashlib.sha256()
    with source.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def edit_clip(clip, source_dir, output_dir):
    """Apply source-coordinate cuts/cosmetic cleanup and derive the poster from that export."""
    source = child_path(source_dir, clip['source'])
    destination = child_path(output_dir, clip['output'])
    poster = child_path(output_dir, clip['poster'])
    if source in (destination, poster) or destination == poster:
        raise ValueError('Source, video, and poster paths must be distinct')
    if destination.suffix != '.mp4' or poster.suffix != '.webp':
        raise ValueError('Website outputs must be MP4 and WebP')
    metadata = probe(source)
    validate_clip(clip, metadata)
    filters = []
    labels = []
    for index, (start, end) in enumerate(clip['keep']):
        label = f'v{index}'
        filters.append(f'[0:v]trim=start={start}:end={end},setpts=PTS-STARTPTS[{label}]')
        labels.append(f'[{label}]')
    finishing = []
    for region in clip.get('removeOverlays', []):
        finishing.append(f"delogo=x={region['x']}:y={region['y']}:w={region['width']}:h={region['height']}")
    if clip.get('crop'):
        crop = clip['crop']
        finishing.append(f"crop={crop['width']}:{crop['height']}:{crop['x']}:{crop['y']}")
    finishing.append(f"scale={clip.get('outputWidth', metadata['width'])}:-2")
    filters.append(''.join(labels) + f"concat=n={len(labels)}:v=1:a=0," + ','.join(finishing) + '[out]')
    destination.parent.mkdir(parents=True, exist_ok=True)
    poster.parent.mkdir(parents=True, exist_ok=True)
    # Stage both outputs before replacing either website asset.
    with tempfile.TemporaryDirectory(prefix='.demo-edit-', dir=destination.parent) as temporary:
        video_temp = Path(temporary) / 'demo.mp4'
        poster_temp = Path(temporary) / 'poster.webp'
        run(['ffmpeg', '-v', 'error', '-y', '-i', str(source), '-filter_complex', ';'.join(filters),
             '-map', '[out]', '-an', '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'fast',
             '-crf', str(clip.get('crf', 22)), '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr',
             '-movflags', '+faststart', str(video_temp)])
        result = probe(video_temp)
        png = run(['ffmpeg', '-v', 'error', '-ss', str(clip.get('posterAt', max(0, result['duration'] - 1))),
                   '-i', str(video_temp), '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'])
        Image.open(io.BytesIO(png)).convert('RGB').save(poster_temp, 'WEBP', quality=88)
        video_temp.replace(destination)
        poster_temp.replace(poster)
    result.update({'id': clip['id'], 'source': clip['source'],
                   'sourceSha256': source_hash(source),
                   'keep': clip['keep'], 'crop': clip.get('crop'),
                   'removeOverlays': clip.get('removeOverlays', []), 'posterAt': clip.get('posterAt'),
                   'output': clip['output'], 'poster': clip['poster'], 'bytes': destination.stat().st_size})
    return result


def publish_files(files):
    """Replace assets and provenance together, restoring originals on a publish error."""
    with ExitStack() as stack:
        prepared = []
        for source, destination in files:
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = Path(stack.enter_context(tempfile.TemporaryDirectory(
                prefix='.demo-publish-', dir=destination.parent)))
            staged = temporary / 'new'
            shutil.copy2(source, staged)
            backup = temporary / 'previous' if destination.exists() else None
            if backup:
                shutil.copy2(destination, backup)
            prepared.append((staged, destination, backup))
        replaced = []
        try:
            for staged, destination, backup in prepared:
                staged.replace(destination)
                replaced.append((destination, backup))
        except OSError:
            for destination, backup in reversed(replaced):
                if backup:
                    backup.replace(destination)
                else:
                    destination.unlink()
            raise


def main():
    """Expose inspect, edit, and check commands without hardcoded project paths."""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    inspect = commands.add_parser('inspect')
    inspect.add_argument('source', type=Path)
    inspect.add_argument('--output', type=Path, required=True)
    inspect.add_argument('--start', type=float, default=0)
    inspect.add_argument('--end', type=float)
    inspect.add_argument('--step', type=float)
    check = commands.add_parser('check')
    check.add_argument('source', type=Path)
    edit = commands.add_parser('edit')
    edit.add_argument('recipe', type=Path)
    edit.add_argument('--source-dir', type=Path, required=True)
    edit.add_argument('--output-dir', type=Path, required=True)
    edit.add_argument('--report', type=Path, required=True)
    edit.add_argument('--only')
    args = parser.parse_args()
    if args.command == 'inspect':
        inspect_video(args.source, args.output, args.start, args.end, args.step)
        return
    if args.command == 'check':
        result = probe(args.source)
        print(json.dumps(result, indent=2))
        if result['codec'] != 'h264' or result['audio'] or result['pixelFormat'] != 'yuv420p':
            raise ValueError('Expected silent H.264/yuv420p website footage')
        return
    recipe = json.loads(args.recipe.read_text())
    if recipe.get('version') != 1:
        raise ValueError('Expected edit recipe version 1')
    clips = [clip for clip in recipe['clips'] if not args.only or clip['id'] == args.only]
    if not clips:
        raise ValueError('No matching clips in the recipe')
    sources = {child_path(args.source_dir, clip['source']) for clip in clips}
    outputs = [child_path(args.output_dir, clip[key]) for clip in clips for key in ('output', 'poster')]
    if args.report.resolve() in sources.union(outputs):
        raise ValueError('Report must be distinct from every source and output')
    if len(set(outputs)) != len(outputs) or sources.intersection(outputs):
        raise ValueError('Outputs must be unique and cannot overwrite any raw source in the batch')
    # A later clip's validation/encode failure must leave the whole published batch intact.
    with tempfile.TemporaryDirectory(prefix='thunder-demo-batch-') as temporary:
        staging = Path(temporary)
        report = [edit_clip(clip, args.source_dir, staging / 'assets') for clip in clips]
        staged_report = staging / 'report.json'
        staged_report.write_text(json.dumps(report, indent=2) + '\n')
        files = [(child_path(staging / 'assets', clip[key]), child_path(args.output_dir, clip[key]))
                 for clip in clips for key in ('output', 'poster')]
        publish_files(files + [(staged_report, args.report.resolve())])
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
