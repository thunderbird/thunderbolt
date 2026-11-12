# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import copy
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("filter-semgrep-sarif.py")
filter_suppressed_results = runpy.run_path(str(SCRIPT))["filter_suppressed_results"]


class FilterSemgrepSarifTests(unittest.TestCase):
    def test_only_accepted_suppressions_are_removed(self):
        cases = [
            ("in-source", [{"kind": "inSource"}], True),
            ("accepted", [{"kind": "external", "status": "accepted"}], True),
            ("rejected", [{"kind": "inSource", "status": "rejected"}], False),
            ("under-review", [{"kind": "inSource", "status": "underReview"}], False),
            ("unknown-status", [{"kind": "inSource", "status": "future"}], False),
            ("unknown-kind", [{"kind": "future"}], False),
            ("external-unreviewed", [{"kind": "external"}], False),
            ("no-suppressions", [], False),
        ]
        report = {"runs": [{"results": [
            {"ruleId": name, "suppressions": suppressions}
            for name, suppressions, _ in cases
        ]}]}
        self.assertEqual(filter_suppressed_results(report), 2)
        self.assertEqual(
            [result["ruleId"] for result in report["runs"][0]["results"]],
            [name for name, _, removed in cases if not removed],
        )

    def test_unsuppressed_results_and_all_metadata_are_preserved_across_runs(self):
        retained = {"ruleId": "same-rule", "message": {"text": "real finding"},
                    "locations": [{"physicalLocation": {"artifactLocation": {"uri": "app.py"}}}]}
        removed = {"ruleId": "same-rule", "suppressions": [{"kind": "inSource"}]}
        report = {"$schema": "sarif-schema", "version": "2.1.0", "runs": [
            {"tool": {"driver": {"name": "Semgrep OSS", "rules": [{"id": "same-rule"}]}},
             "artifacts": [{"location": {"uri": "app.py"}}], "results": [removed, retained]},
            {"properties": {"custom": 1}, "results": [removed]},
            {"tool": {"driver": {"name": "empty run"}}},
        ]}
        expected = copy.deepcopy(report)
        expected["runs"][0]["results"] = [retained]
        expected["runs"][1]["results"] = []
        self.assertEqual(filter_suppressed_results(report), 2)
        self.assertEqual(report, expected)
        self.assertEqual(filter_suppressed_results(report), 0)

    def test_cli_preserves_original_report_and_writes_upload_report(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "semgrep.sarif"
            destination = Path(directory) / "semgrep-upload.sarif"
            report = {"runs": [{"results": [
                {"ruleId": "suppressed", "suppressions": [{"kind": "inSource"}]},
                {"ruleId": "unsuppressed"},
            ]}]}
            source.write_text(json.dumps(report))
            subprocess.run([sys.executable, str(SCRIPT), str(source), str(destination)],
                           check=True, capture_output=True)
            self.assertEqual(json.loads(source.read_text()), report)
            self.assertEqual(json.loads(destination.read_text()),
                             {"runs": [{"results": [{"ruleId": "unsuppressed"}]}]})

    def test_invalid_report_fails_without_creating_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "semgrep.sarif"
            destination = Path(directory) / "semgrep-upload.sarif"
            source.write_text("not JSON")
            result = subprocess.run([sys.executable, str(SCRIPT), str(source), str(destination)],
                                    capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
