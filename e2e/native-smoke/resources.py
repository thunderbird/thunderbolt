#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Read-only macOS resource samples; owned by the shell that starts this process."""

import datetime
import json
import os
import resource
import signal
import subprocess
import sys
import time
from pathlib import Path


def emit(stream, kind, **values):
    """Flush each record so failures retain the completed portion of a sample."""
    stream.write(json.dumps({"timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                             "kind": kind, **values}) + "\n")
    stream.flush()


def collect(stream, metric, command):
    """Bound each query and reap only its private process group, including on cancellation."""
    started = time.monotonic()
    process = None
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        stdout, stderr = process.communicate(timeout=15)
        if process.returncode:
            raise RuntimeError(f"exit {process.returncode}: {stderr.strip()}")
        if not stdout.strip():
            raise RuntimeError("empty output")
        if metric == "iostat":
            lines = stdout.strip().splitlines()
            if len(lines) != 4:
                raise RuntimeError("unexpected iostat format; interval sample unavailable")
            stdout = "\n".join([*lines[:2], lines[-1]])
        emit(stream, metric, status="available", duration_seconds=time.monotonic() - started,
             output=stdout.strip())
        return True
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        emit(stream, metric, status="unavailable", error=str(error),
             duration_seconds=time.monotonic() - started)
        return False
    finally:
        if process is not None:
            # The session belongs only to this query, never to the app or simulator.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def usage():
    """Measure collector and reaped query CPU cost, including the one-time baseline."""
    own = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {"cpu_seconds": own.ru_utime + own.ru_stime + children.ru_utime + children.ru_stime,
            "collector_peak_rss_bytes": own.ru_maxrss}


def stop(signum, _frame):
    """Unwind an active query immediately when the owning shell stops collection."""
    raise SystemExit(signum)


def main():
    """Capture identity once, then sample at most every five seconds until the owner exits."""
    directory = Path(sys.argv[1])
    owner = int(sys.argv[2])
    started = time.monotonic()
    errors = 0
    samples = 0
    reason = "unexpected_exit"
    partial_sample = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    with (directory / "metrics.jsonl").open("a") as stream:
        try:
            emit(stream, "identity", collector_pid=os.getpid(), owner_pid=owner,
                 image_os=os.environ.get("ImageOS", "unavailable"),
                 image_version=os.environ.get("ImageVersion", "unavailable"),
                 simulator_udid=os.environ.get("IOS_SIMULATOR_UDID", "unavailable"))
            for metric, command in [
                ("hardware", ["sysctl", "hw.model", "hw.ncpu", "hw.memsize", "machdep.cpu.brand_string"]),
                ("macos", ["sw_vers"]),
                ("xcode", ["xcodebuild", "-version"]),
                ("ios_runtimes", ["xcrun", "simctl", "list", "runtimes"]),
                ("maestro", ["maestro", "--version"]),
            ]:
                if os.getppid() != owner:
                    raise SystemExit("owner_exited")
                errors += not collect(stream, metric, command)
            previous = None
            while os.getppid() == owner:
                partial_sample = True
                sample_start = time.monotonic()
                emit(stream, "sample", index=samples,
                     gap_seconds=None if previous is None else sample_start - previous)
                previous = sample_start
                for metric, command in [
                    ("iostat", ["iostat", "-d", "-C", "-U", "-n", "8", "-w", "1", "-c", "2"]),
                    ("memory_pressure", ["memory_pressure", "-Q"]),
                    ("pressure_level", ["sysctl", "kern.memorystatus_vm_pressure_level"]),
                    ("vm_stat", ["vm_stat"]),
                    ("swap", ["sysctl", "vm.swapusage"]),
                    ("disk_free", ["df", "-k", "."]),
                    ("processes", ["ps", "-A", "-c", "-o", "pid=,ppid=,pcpu=,rss=,time=,comm="]),
                ]:
                    if os.getppid() != owner:
                        raise SystemExit("owner_exited")
                    errors += not collect(stream, metric, command)
                samples += 1
                partial_sample = False
                emit(stream, "sample_end", index=samples - 1, **usage())
                time.sleep(max(0, 5 - (time.monotonic() - sample_start)))
            reason = "owner_exited"
        except SystemExit as error:
            reason = f"signal_{error.code}"
        finally:
            emit(stream, "stopped", reason=reason, samples=samples, unavailable=errors,
                 partial_sample=partial_sample,
                 elapsed_seconds=time.monotonic() - started,
                 **usage())
    return int(errors > 0 or samples == 0 or reason != "signal_15")


if __name__ == "__main__":
    sys.exit(main())
