#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Keep Playwright trace timing while removing all captured content and network data."""

import json
import base64
import io
import re
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

SAFE_FIELDS = {
    "version", "type", "origin", "browserName", "playwrightVersion", "platform",
    "wallTime", "monotonicTime", "sdkLanguage", "contextId", "pageId",
    "callId", "stepId", "parentId", "startTime", "endTime", "time", "class", "method",
}
SAFE_REPORT_FIELDS = {
    "startTime", "duration", "files", "projectNames", "stats", "fileId", "fileName",
    "tests", "testId", "title", "projectName", "location", "outcome", "path", "ok",
    "results", "retry", "status", "workerIndex", "name", "contentType", "file",
    "line", "column", "total", "expected", "unexpected", "flaky", "skipped",
}
EMBEDDED_REPORT = re.compile(rb"data:application/zip;base64,([A-Za-z0-9+/=]+)")


def sanitize_trace(data: bytes) -> bytes:
    events = (json.loads(line) for line in data.splitlines() if line)
    safe = ({key: value for key, value in event.items() if key in SAFE_FIELDS} for event in events)
    return b"\n".join(json.dumps(event, separators=(",", ":")).encode() for event in safe) + b"\n"


def sanitize_zip(path: Path) -> None:
    with tempfile.NamedTemporaryFile(dir=path.parent, suffix=".zip", delete=False) as temp:
        temp_path = Path(temp.name)
    try:
        with ZipFile(path) as source, ZipFile(temp_path, "w") as target:
            for name in source.namelist():
                if name.endswith(".trace"):
                    target.writestr(name, sanitize_trace(source.read(name)))
                elif name.endswith(".network"):
                    target.writestr(name, b"")
                elif name.endswith(".stacks"):
                    target.writestr(name, b'{"files":[],"stacks":[]}')
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)


def sanitize_report(value):
    if isinstance(value, list):
        return [sanitize_report(item) for item in value]
    if not isinstance(value, dict):
        return value
    safe = {key: sanitize_report(item) for key, item in value.items() if key in SAFE_REPORT_FIELDS}
    for key in ("steps", "errors", "annotations", "tags", "machines"):
        if key in value:
            safe[key] = []
    for key in ("metadata", "options"):
        if key in value:
            safe[key] = {}
    if "attachments" in value:
        safe["attachments"] = [
            sanitize_report(item) for item in value["attachments"]
            if item.get("name") in ("trace", "video") and item.get("path", "").endswith((".zip", ".webm"))
        ]
    return safe


def sanitize_html(path: Path) -> None:
    html = path.read_bytes()
    matches = list(EMBEDDED_REPORT.finditer(html))
    if len(matches) != 1:
        raise ValueError("Expected exactly one embedded Playwright report")
    report = io.BytesIO(base64.b64decode(matches[0].group(1)))
    sanitized = io.BytesIO()
    with ZipFile(report) as source, ZipFile(sanitized, "w") as target:
        for name in source.namelist():
            target.writestr(name, json.dumps(sanitize_report(json.loads(source.read(name)))))
    path.write_bytes(html[:matches[0].start(1)] + base64.b64encode(sanitized.getvalue()) + html[matches[0].end(1):])


def sanitize_directory(root: Path) -> None:
    if not root.exists():
        return
    for path in root.rglob("*.zip"):
        sanitize_zip(path)
    data = root / "data"
    if data.exists():
        for path in data.iterdir():
            if path.suffix not in (".zip", ".webm"):
                path.unlink()
    sanitize_html(root / "index.html")


def self_test() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "trace.zip"
        secret = b"session-secret-marker"
        with ZipFile(path, "w") as archive:
            archive.writestr("test.trace", b'{"type":"before","method":"fill","params":{"value":"' + secret + b'"}}\n')
            archive.writestr("0-trace.network", secret)
            archive.writestr("0-trace.stacks", secret)
            archive.writestr("resources/body.txt", secret)
        sanitize_zip(path)
        assert secret not in path.read_bytes()
        with ZipFile(path) as archive:
            assert set(archive.namelist()) == {"test.trace", "0-trace.network", "0-trace.stacks"}
            assert json.loads(archive.read("test.trace")) == {"type": "before", "method": "fill"}

        root = Path(directory) / "report"
        (root / "data").mkdir(parents=True)
        (root / "data" / "trace.zip").write_bytes(path.read_bytes())
        (root / "data" / "error.md").write_bytes(secret)
        report = io.BytesIO()
        with ZipFile(report, "w") as archive:
            archive.writestr("report.json", json.dumps({"errors": [secret.decode()], "stats": {"unexpected": 1}}))
            archive.writestr("file.json", json.dumps({"tests": [{"title": "public test", "results": [{"status": "failed", "errors": [secret.decode()], "attachments": [{"name": "trace", "path": "data/trace.zip"}, {"name": "error-context", "path": "data/error.md", "body": secret.decode()}]}]}]}))
        (root / "index.html").write_bytes(b'<html>data:application/zip;base64,' + base64.b64encode(report.getvalue()) + b'</html>')
        sanitize_directory(root)
        assert not (root / "data" / "error.md").exists()
        assert secret not in (root / "data" / "trace.zip").read_bytes()
        embedded = EMBEDDED_REPORT.search((root / "index.html").read_bytes())
        with ZipFile(io.BytesIO(base64.b64decode(embedded.group(1)))) as archive:
            assert secret not in b"".join(archive.read(name) for name in archive.namelist())
            test = json.loads(archive.read("file.json"))["tests"][0]
            assert test["title"] == "public test"
            assert test["results"][0]["status"] == "failed"
            assert test["results"][0]["attachments"] == [{"name": "trace", "path": "data/trace.zip"}]


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        sanitize_directory(Path(sys.argv[1]))
