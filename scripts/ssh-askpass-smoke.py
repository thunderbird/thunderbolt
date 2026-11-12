# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Exercise the built desktop executable's headless SSH authentication mode."""

import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading


def run(binary):
    token = secrets.token_hex(32)
    prompt = "fixture@localhost's password:"
    # A non-ASCII fixture also checks that Windows writes UTF-8 to the inherited
    # pipe instead of attempting to use an unattached GUI console.
    secret = "disposable-password-🔑\n".encode()
    observed = []
    failures = []
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(10)

        def answer():
            try:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(5)
                    with connection.makefile("rb") as reader:
                        request = json.loads(reader.readline(8192))
                    if request != {"token": token, "prompt": prompt}:
                        raise AssertionError("The askpass request did not match its operation")
                    observed.append(True)
                    connection.sendall(secret)
            except Exception as error:
                failures.append(error)

        thread = threading.Thread(target=answer)
        thread.start()
        environment = {
            **os.environ,
            "THUNDERBOLT_SSH_ASKPASS_ENDPOINT": f"127.0.0.1:{listener.getsockname()[1]}",
            "THUNDERBOLT_SSH_ASKPASS_TOKEN": token,
        }
        try:
            result = subprocess.run(
                [str(binary), prompt], env=environment, capture_output=True, timeout=10
            )
        finally:
            thread.join(timeout=12)
        if failures:
            raise AssertionError("The askpass exchange failed") from failures[0]
        if thread.is_alive() or not observed:
            raise AssertionError("The desktop binary did not enter headless askpass mode")
        if result.returncode != 0 or result.stdout != secret or result.stderr:
            raise AssertionError("The desktop binary did not return the exact askpass response")

    for endpoint, invalid_token in [
        ("192.0.2.1:22", token),
        ("127.0.0.1:22", "invalid-token"),
    ]:
        environment["THUNDERBOLT_SSH_ASKPASS_ENDPOINT"] = endpoint
        environment["THUNDERBOLT_SSH_ASKPASS_TOKEN"] = invalid_token
        result = subprocess.run(
            [str(binary), prompt], env=environment, capture_output=True, timeout=5
        )
        if result.returncode != 1 or result.stdout or result.stderr:
            raise AssertionError("Invalid askpass requests must fail without starting the app")
    print("SSH askpass binary smoke passed")


if __name__ == "__main__":
    run(Path(sys.argv[1]).resolve(strict=True))
