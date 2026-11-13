"""Local deterministic checks. Uses only temporary files under this skill; no live DB/clipboard."""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'scripts'


def run(args, **kwargs):
    """Capture subprocess output; assertions print no private inputs."""
    return subprocess.run(args, capture_output=True, text=True, timeout=20, **kwargs)


def main():
    argparse.ArgumentParser(description=__doc__, epilog='Output: assertion summaries. Side effects: disposable fixtures/mocks under tests/, removed after execution; no installs or service startup.').parse_args()
    for script in sorted(SCRIPTS.iterdir()):
        if not script.is_file() or script.suffix not in ('.sh', '.py', '.mjs'):
            continue
        interpreter = 'bash' if script.suffix == '.sh' else 'python3' if script.suffix == '.py' else 'node'
        result = run([interpreter, str(script), '--help'])
        assert result.returncode == 0 and 'usage' in (result.stdout + result.stderr).lower(), script.name
    print('PASS: every helper --help')
    spec = importlib.util.spec_from_file_location('validation_otp', SCRIPTS / 'otp.py')
    otp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(otp)
    # Synthetic digit strings only; no live sign-in codes are read or persisted.
    text = '[DEV] Verify URL (no email sent): http://localhost/auth/verify?email=one%40example.test&otp=87654321\n[DEV] OTP code: 87654321\n[DEV] Verify URL (no email sent): http://localhost/auth/verify?email=two%40example.test&otp=23456789\n'
    assert otp.newest_code(text, 'ONE@example.test') == '87654321'
    assert otp.newest_code(text, 'missing@example.test') is None
    assert otp.newest_code('[DEV] OTP code: 87654321', 'one@example.test') is None
    print('PASS: OTP identity matching; no unpaired/global code fallback')
    with tempfile.TemporaryDirectory(dir=ROOT/'tests', prefix='helper-check-') as temp:
        tmp = Path(temp)
        log = tmp / 'backend.log'
        log.write_text('stack ready\n')
        command = ['bash', str(SCRIPTS/'log-marks.sh'), '--log', str(log)]
        before = run([*command, 'mark', 'before'])
        assert before.returncode == 0
        fixture = (ROOT/'tests/fixtures/proxy-colored.txt').read_bytes()
        log.write_bytes(fixture)
        after = run([*command, 'mark', 'after'])
        assert after.returncode == 0
        events = run([*command, 'events', 'before', 'after'])
        assert events.returncode == 0, events.stderr
        assert events.stdout.splitlines() == ['GET api.example.test 200', 'POST chat.example.test 429', 'POST api.example.test 201']
        print('PASS: multiline ANSI/JSON proxy fixture ->')
        print(events.stdout.strip())
        print(events.stderr.strip())
        empty = run([*command, 'events', 'before', 'before'])
        assert empty.returncode == 0 and not empty.stdout and '0 proxy_request' in empty.stderr
        assert run([*command, 'mark', 'after']).returncode != 0
        log.write_text('truncated\n')
        assert run([*command, 'events', 'before', 'after']).returncode != 0
        print('PASS: duplicate marks and truncated logs rejected')
        home = tmp/'home'
        (home/'.argent').mkdir(parents=True)
        dummy = 'synthetic-validation-value-ONLY'
        (home/'.argent/secrets.env').write_text('SYNTHETIC_KEY='+dummy+'\n')
        env = {**os.environ, 'HOME': str(home)}
        checker = ['python3', str(SCRIPTS/'secrets.py')]
        checked = run([*checker, 'check', 'SYNTHETIC_KEY', 'ABSENT_KEY'], env=env)
        assert checked.returncode == 1 and 'present' in checked.stdout and 'missing' in checked.stdout and dummy not in checked.stdout + checked.stderr
        artifacts = tmp/'artifacts'
        artifacts.mkdir()
        (artifacts/'hit.txt').write_text(dummy)
        scan = run([*checker, 'scan', str(artifacts)], env=env)
        assert scan.returncode == 1 and 'hit.txt' in scan.stdout and dummy not in scan.stdout
        (artifacts/'hit.txt').unlink()
        encoded_name = base64.b64encode(dummy.encode()).decode() + '.txt'
        (artifacts/encoded_name).write_text(dummy)
        scan = run([*checker, 'scan', str(artifacts)], env=env)
        assert scan.returncode == 1 and '<redacted>.txt' in scan.stdout and encoded_name not in scan.stdout
        (artifacts/encoded_name).unlink()
        assert run([*checker, 'scan', str(artifacts)], env=env).returncode == 0
        print('PASS: secret presence and scan hit/clean paths; values never emitted')
        mockbin = tmp/'bin'
        mockbin.mkdir()
        # Mock psql/docker capture proves safe SQL parameter binding without mutating a DB.
        docker = mockbin/'docker'
        docker.write_text('#!/usr/bin/env python3\nimport json,os,pathlib,sys\np=pathlib.Path(os.environ["CAPTURE"])\np.write_text(json.dumps({"args":sys.argv[1:],"sql":sys.stdin.read()}))\n')
        docker.chmod(0o700)
        env.update(PATH=str(mockbin)+os.pathsep+os.environ['PATH'], CAPTURE=str(tmp/'capture.json'))
        email = "o'hara@example.test"
        seed = run(['bash', str(SCRIPTS/'seed-waitlist-user.sh'), '--email', email, '--container', 'local-validation'], env=env)
        assert seed.returncode == 0 and seed.stdout.strip() == email
        capture = json.loads((tmp/'capture.json').read_text())
        assert 'email='+email in capture['args'] and email not in capture['sql'] and "lower(:'email')" in capture['sql'] and 'ON CONFLICT (email) DO UPDATE' in capture['sql']
        print('PASS: seed helper binds email safely and uses idempotent UPSERT (mock Docker)')
    queries = json.loads((ROOT/'tests/triggers.json').read_text())
    assert len(queries) >= 16 and {q['should_trigger'] for q in queries} == {True, False}
    assert len((ROOT/'SKILL.md').read_text().splitlines()) <= 250
    print(f'PASS: {len(queries)} trigger cases; router <=250 lines')


if __name__ == '__main__':
    main()
