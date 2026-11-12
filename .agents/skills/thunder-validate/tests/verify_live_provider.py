"""Run the requested live curl smoke on the bundled fake; stop only this child process."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser(description=__doc__, epilog='Inputs: Node and curl on PATH, free loopback port. Output: safe response text on stdout. Side effects: temporary provider log, briefly listens on the selected port; always stops its own child. Exit 2 if session forbids listening.')
    p.add_argument('--port', type=int, default=18999)
    a = p.parse_args()
    if not 1 <= a.port <= 65535:
        p.error('Port must be 1..65535')
    base = f'http://127.0.0.1:{a.port}'
    lines = []
    with tempfile.TemporaryFile(mode='w+') as stream:
        proc = subprocess.Popen(['node', str(ROOT/'scripts/fake-openai-provider.mjs'), '--port', str(a.port), '--reply', 'Thunderbolt validation SSE verified.'], stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            for attempt in range(40):
                if proc.poll() is not None:
                    stream.seek(0)
                    raise RuntimeError('Fake provider exited before readiness: ' + stream.read().strip())
                ready = subprocess.run(['curl', '-fsS', '--max-time', '1', base+'/v1/models'], capture_output=True, text=True)
                if ready.returncode == 0:
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('Fake provider not reachable; check local networking and free port')
            def curl(args):
                return subprocess.run(['curl', '-fsS', '--max-time', '10', *args], capture_output=True, text=True, check=True).stdout
            models = curl([base+'/v1/models'])
            assert json.loads(models)['data'][0]['id'] == 'thunder-validate-fake'
            lines.extend(['GET /v1/models:', models])
            sse = curl(['-N', '-H', 'Content-Type: application/json', '-d', '{"model":"thunder-validate-fake","messages":[{"role":"user","content":"hello"}],"stream":true}', base+'/v1/chat/completions'])
            events = [json.loads(line[6:]) for line in sse.splitlines() if line.startswith('data: {')]
            assert len(events) > 3 and ''.join(event['choices'][0]['delta'].get('content', '') for event in events) == 'Thunderbolt validation SSE verified.' and 'data: [DONE]' in sse
            lines.extend(['SSE POST /v1/chat/completions:', sse])
            plain = curl(['-H', 'Content-Type: application/json', '-d', '{"stream":false,"messages":[]}', base+'/v1/chat/completions'])
            assert json.loads(plain)['choices'][0]['message']['content'] == 'Thunderbolt validation SSE verified.'
            cors = curl(['-i', '-X', 'OPTIONS', '-H', 'Access-Control-Request-Headers: authorization,content-type', base+'/v1/chat/completions'])
            assert '204' in cors and 'Access-Control-Allow-Origin: *' in cors
            lines.append('PASS: live models, SSE, non-stream and CORS')
            returncode = 0
        except RuntimeError as error:
            lines.append('BLOCKED: ' + str(error))
            returncode = 2
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            lines.append(f'Owned child stopped: exit {proc.returncode}')
    output = '\n'.join(lines)+'\n'
    print(output, end='')
    return returncode


if __name__ == '__main__':
    sys.exit(main())
