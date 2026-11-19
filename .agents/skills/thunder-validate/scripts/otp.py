"""Copy the newest email-matched development OTP to the macOS clipboard."""
import argparse
import pathlib
import re
import subprocess
import sys
from urllib.parse import parse_qs, urlsplit


def newest_code(text, email):
    """Match identity through the verify URL; reject an unpaired global OTP line."""
    clean = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    codes = []
    for line in clean.splitlines():
        if '[DEV] Verify URL (no email sent):' not in line:
            continue
        url = line.split('[DEV] Verify URL (no email sent):', 1)[1].strip().split()[0]
        query = parse_qs(urlsplit(url).query)
        if query.get('email', [''])[0].casefold() == email.casefold():
            code = query.get('otp', [''])[0]
            if re.fullmatch(r'\d{6,10}', code):
                codes.append(code)
    return codes[-1] if codes else None


def main():
    p = argparse.ArgumentParser(description=__doc__, epilog='Inputs: private backend log and test email. Output: status only; no codes. Side effect: replaces clipboard. Request a fresh code first: logs have no reliable event timestamps; lifetime is 10 minutes, resend cooldown 15 seconds.')
    p.add_argument('--log', required=True, type=pathlib.Path)
    p.add_argument('--email', required=True)
    a = p.parse_args()
    code = newest_code(a.log.read_text(), a.email)
    if not code:
        p.error('No matching dev verify URL/code. Request a fresh code, check RESEND_API_KEY is empty and the correct backend log is selected')
    subprocess.run(['pbcopy'], input=code.encode(), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('Newest matching code copied; paste, submit, then clear the clipboard. Freshness is not inferred from log order.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, subprocess.SubprocessError):
        print('Cannot read backend log or use pbcopy; check the path and macOS clipboard access.', file=sys.stderr)
        sys.exit(2)
