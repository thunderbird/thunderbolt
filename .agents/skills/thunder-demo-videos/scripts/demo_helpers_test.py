# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Exercise recipe validation and transactional publication without media encoding."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from demo import child_path, publish_files, validate_clip


class RecipeTests(unittest.TestCase):
    metadata = {'duration': 4, 'width': 160, 'height': 100}

    def test_valid_boundary_values(self):
        for clip in (
            {'keep': [[0, 4]]},
            {'keep': [[0, 1], [1, 4]], 'posterAt': 0},
            {'keep': [[0, 1]], 'crop': {'x': 0, 'y': 0, 'width': 160, 'height': 100}},
        ):
            with self.subTest(clip=clip):
                validate_clip(clip, self.metadata)

    def test_invalid_edit_inputs(self):
        cases = [
            ({'keep': []}, 'explicit keep ranges'),
            ({'keep': [[0, float('nan')]]}, 'finite numbers'),
            ({'keep': [[0, float('inf')]]}, 'finite numbers'),
            ({'keep': [[0, 1]], 'crop': {'x': .5, 'y': 0, 'width': 10, 'height': 10}}, 'integers'),
            ({'keep': [[0, 1]], 'crop': {'x': 0, 'y': 0, 'width': 9, 'height': 10}}, 'must be even'),
            ({'keep': [[0, 1]], 'removeOverlays': [{'x': -1, 'y': 0, 'width': 10, 'height': 10}]}, 'outside'),
            ({'keep': [[0, 1]], 'outputWidth': 0}, 'positive even integer'),
            ({'keep': [[0, 1]], 'outputWidth': 3}, 'positive even integer'),
            ({'keep': [[0, 1]], 'outputWidth': 10.5}, 'positive even integer'),
            ({'keep': [[0, 1]], 'posterAt': 1}, 'edited timeline'),
            ({'keep': [[0, 1]], 'posterAt': -1}, 'edited timeline'),
            ({'keep': [[0, 1]], 'posterAt': float('nan')}, 'edited timeline'),
        ]
        for clip, message in cases:
            with self.subTest(clip=clip), self.assertRaisesRegex(ValueError, message):
                validate_clip(clip, self.metadata)

    def test_paths_cannot_escape_through_parents_absolute_paths_or_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inside, outside = root / 'inside', root / 'outside'
            inside.mkdir()
            outside.mkdir()
            (inside / 'link').symlink_to(outside, target_is_directory=True)
            self.assertEqual(child_path(inside, 'nested/video.mp4'), (inside / 'nested/video.mp4').resolve())
            for path in ('../outside/video.mp4', str(inside / 'absolute.mp4'), 'link/video.mp4'):
                with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'Recipe paths'):
                    child_path(inside, path)


class PublicationTests(unittest.TestCase):
    def test_rollback_removes_new_outputs_and_restores_existing_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source'
            source.write_text('new')
            existing, new, report = root / 'existing', root / 'new-output', root / 'report'
            existing.write_text('original')
            report.write_text('old provenance')
            replace = Path.replace

            def fail_report(staged, target):
                if staged.name == 'new' and target == report:
                    raise OSError('report failure')
                return replace(staged, target)

            with patch.object(Path, 'replace', fail_report), self.assertRaisesRegex(OSError, 'report failure'):
                publish_files([(source, existing), (source, new), (source, report)])
            self.assertEqual(existing.read_text(), 'original')
            self.assertFalse(new.exists())
            self.assertEqual(report.read_text(), 'old provenance')

    def test_failed_rollback_keeps_recovery_copies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, existing, report = root / 'source', root / 'existing', root / 'report'
            source.write_text('new')
            existing.write_text('original')
            report.write_text('old provenance')
            replace = Path.replace

            def fail_publication_and_restore(staged, target):
                if target == report or staged.name == 'previous':
                    raise OSError('filesystem unavailable')
                return replace(staged, target)

            with patch.object(Path, 'replace', fail_publication_and_restore):
                with self.assertRaisesRegex(RuntimeError, 'recovery files retained'):
                    publish_files([(source, existing), (source, report)])
            backups = [path.read_text() for path in root.glob('.demo-publish-*/previous')]
            self.assertIn('original', backups)
            self.assertIn('old provenance', backups)

    def test_preparation_failure_does_not_replace_anything(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, existing = root / 'source', root / 'existing'
            source.write_text('new')
            existing.write_text('original')
            with self.assertRaises(FileNotFoundError):
                publish_files([(source, existing), (root / 'missing', root / 'other')])
            self.assertEqual(existing.read_text(), 'original')


if __name__ == '__main__':
    unittest.main()
