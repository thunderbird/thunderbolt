# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Honor Semgrep suppressions before uploading to GitHub code scanning."""

import json
from pathlib import Path
import sys


def accepted_suppression(suppression):
    """Semgrep emits inSource without status for a recognized nosemgrep."""
    if "status" in suppression:
        return suppression["status"] == "accepted"
    return suppression.get("kind") == "inSource"


def filter_suppressed_results(report):
    """Remove accepted results in place, preserving all other SARIF content."""
    removed = 0
    for run in report["runs"]:
        if "results" not in run:
            continue
        results = run["results"]
        run["results"] = [
            result for result in results
            if not any(accepted_suppression(item) for item in result.get("suppressions", []))
        ]
        removed += len(results) - len(run["results"])
    return removed


if __name__ == "__main__":
    source, destination = map(Path, sys.argv[1:])
    report = json.loads(source.read_text())
    removed = filter_suppressed_results(report)
    destination.write_text(json.dumps(report) + "\n")
    print(f"Excluded {removed} accepted suppressed result(s) from the SARIF upload.")
