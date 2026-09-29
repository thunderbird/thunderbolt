#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Exercise the real collector/lifecycle with isolated OS command substitutes."""

import datetime
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path


root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory() as temporary:
    directory = Path(temporary)
    commands = directory / "bin"
    commands.mkdir()
    for name in ["sysctl", "sw_vers", "xcodebuild", "xcrun", "maestro", "iostat",
                 "memory_pressure", "vm_stat", "df", "ps"]:
        path = commands / name
        path.write_text('''#!/bin/bash
case "${0##*/}" in
  iostat) printf 'disk0 cpu load\nKB/t tps MB/s us sy id\n999 999 999 99 1 0\n4 2 1 10 5 85\n';;
  vm_stat) if [ "$FAIL_QUERY" = 1 ]; then echo 'unavailable fixture' >&2; exit 9; fi; echo 'Pages free: 123';;
  ps) if [ "$HANG_QUERY" = 1 ]; then
        sleep 60 &
        echo "$!" > "$RUNNER_TEMP/query-child"
        wait
      else echo '100 1 1.0 1234 0:01.00 fixture'; fi;;
  *) echo 'fixture metric';;
esac
''')
        path.chmod(0o755)
    unrelated = subprocess.Popen(["sleep", "60"])
    try:
        for mode, status in [("normal", 0), ("failure", 7), ("cancel", 143)]:
            output = directory / mode
            output.mkdir()
            environment = {**os.environ, "PATH": f"{commands}:{os.environ['PATH']}",
                           "RUNNER_TEMP": str(output), "FAIL_QUERY": str(int(mode == "failure")),
                           "HANG_QUERY": str(int(mode == "cancel"))}
            shell = subprocess.Popen(["bash", "-euc", '''
source e2e/native-smoke/resources.sh
trap 'status=$?; resource_stop "$status" || true; exit "$status"' EXIT
resource_marker smoke_start
while [ ! -f "$RUNNER_TEMP/finish" ]; do sleep 0.1; done
exit "$1"
''', "check", str(status)], cwd=root, env=environment)
            metrics = output / "native-ios-resources/metrics.jsonl"
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    content = metrics.read_text() if metrics.exists() else ""
                    if ('"kind": "sample_end"' in content or (output / "query-child").exists()):
                        break
                    time.sleep(0.05)
                else:
                    raise AssertionError("collector did not reach process sample")
                if mode == "cancel":
                    shell.terminate()
                else:
                    (output / "finish").touch()
                assert shell.wait(timeout=5) == status
                records = [json.loads(line) for line in metrics.read_text().splitlines()]
                assert all(datetime.datetime.fromisoformat(row["timestamp"]).tzinfo for row in records)
                assert any(row["kind"] == "sample" for row in records)
                assert "999" not in next(row["output"] for row in records if row["kind"] == "iostat")
                assert records[-1]["kind"] == "stopped"
                assert records[-1]["reason"] == "signal_15"
                assert f"step_exit={status}" in (metrics.parent / "phases.tsv").read_text()
                expected = "complete" if mode == "normal" else "incomplete"
                assert (metrics.parent / "status.txt").read_text().startswith(expected)
                if mode == "failure":
                    assert any(row.get("status") == "unavailable" and row["kind"] == "vm_stat" for row in records)
                for pid in [records[0]["collector_pid"], *([int((output / "query-child").read_text())] if mode == "cancel" else [])]:
                    # A reparented grandchild may briefly be a zombie before launchd reaps it.
                    state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
                    assert not state or state.startswith("Z"), (pid, state)
                assert unrelated.poll() is None
            finally:
                if shell.poll() is None:
                    shell.terminate()
                    shell.wait(timeout=5)
        # Startup failure must neither mask the build failure nor kill its services.
        failed_start = directory / "failed-start"
        failed_start.mkdir()
        (failed_start / "native-ios-resources").touch()
        result = subprocess.run(["bash", "-euc", '''
source e2e/native-smoke/resources.sh || echo '::warning::Resource collector startup failed'
trap 'status=$?; resource_stop "$status" || true; exit "$status"' EXIT
resource_marker build_start
exit 9
'''], cwd=root, env={**os.environ, "RUNNER_TEMP": str(failed_start)},
                                capture_output=True, text=True, timeout=5)
        assert result.returncode == 9
        assert "::warning::Resource collector startup failed" in result.stdout
        assert "::warning::iOS resource collector did not start" in result.stdout
        assert unrelated.poll() is None
        python_stub = commands / "python3"
        python_stub.write_text("#!/bin/bash\nexit 29\n")
        python_stub.chmod(0o755)
        result = subprocess.run(["bash", "-euc", '''
source e2e/native-smoke/resources.sh
trap 'status=$?; resource_stop "$status" || true; exit "$status"' EXIT
wait "$resource_pid" || true
exit 11
'''], cwd=root, env={**environment, "RUNNER_TEMP": str(directory / "python-failed")},
                                capture_output=True, text=True, timeout=5)
        assert result.returncode == 11
        assert "::warning::iOS resource collection incomplete" in result.stdout
        assert (directory / "python-failed/native-ios-resources/status.txt").read_text().startswith("incomplete")
    finally:
        unrelated.terminate()
        unrelated.wait()
print("PASS: timestamps, interval sample, partial errors, exit preservation, cancellation and isolation")
