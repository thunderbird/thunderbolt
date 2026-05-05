/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// 3.1 Pipe-to-shell: replaces only the shell name after a pipe, preserving the URL.
const pipeToShell =
  /(\|\s*(?:sudo\s+)?(?:\/(?:usr\/(?:local\/)?)?s?bin\/)?)(sh|bash|zsh|ash|dash|ksh|fish|tcsh|csh)\b/gi

// 3.2 Pipe-to-interpreter: install-script idiom (CRS 932120).
const pipeToInterpreter =
  /(\|\s*(?:sudo\s+)?(?:\/(?:usr\/(?:local\/)?)?bin\/)?)(python(?:[23](?:\.\d+)?)?|perl|ruby|node|php)\b/gi

// 3.3 Process substitution into shell: `<(curl ...)` / `<(wget ...)`.
const processSubstitutionFetch = /<\(\s*(?:curl|wget)\b[^)]*\)/gi

// 3.5 `eval $(curl ...)` and friends. The leading/trailing `"` is intentionally
// not matched: when the body is JSON-serialized those become `\"` and consuming
// only the `"` would leave an orphan `\` that corrupts the JSON envelope.
const evalNetworkFetch = /eval\s+\$\(\s*(?:curl|wget)\b[^)]*\)/gi

// 3.6 `bash -c $(curl ...)` / `sh -c $(curl ...)`. See note on 3.5: the
// surrounding `"` is deliberately excluded to keep the JSON envelope intact.
const shellDashCNetworkFetch = /(\b(?:sh|bash|zsh)\s+-c\s+)\$\(\s*(?:curl|wget)\b[^)]*\)/gi

// 3.7 Reverse shell via `>& /dev/tcp/HOST/PORT` (with optional `bash -i`/`sh -i`
// prefix). The host/port matcher is bounded to hostname/IPv4 + numeric port so
// it cannot consume JSON structural characters (`"`, `}`, `,`) when the body
// lacks the typical ` 0>&1` tail. IPv6 reverse shells are not covered.
const reverseShellDevTcp = /(?:\b(?:sh|bash)\s+-i\s+)?>\s*&\s*\/dev\/tcp\/[\w.-]+\/\d+/gi

// 3.8 Reverse shell via `nc -e /bin/sh` / `ncat -e /bin/bash`.
// Note: spec section 3.8 regex `\bn(?:cat)?\b...` doesn't match `nc` (no word
// boundary between `n` and `c`); matching the spec's intent (the table lists
// both `nc` and `ncat`) requires `\bnc(?:at)?\b`.
// JSON-envelope safety: the inner character class also excludes JSON
// structural characters (`"`, `,`, `{`, `}`, `[`, `]`) so the match cannot
// span two adjacent JSON values (e.g. `nc` in one message and `-e /bin/bash`
// in the next) and silently fuse them on replacement. Real `nc` invocations
// are space-separated flags + hostname + port and don't contain these chars.
const reverseShellNc = /\bnc(?:at)?\b[^|;\n",{}[\]]{0,120}-e\s+\/(?:usr\/)?bin\/(?:sh|bash)\b/gi

// 3.9 Language one-liner reverse shells (each requires both the language flag
// and specific networking keywords, so prose mentioning the language won't match).
// Split into Single (`'...'`) and Double (`"..."`) quote variants so each regex
// uses only one quote type internally — preserves JSON-envelope safety (can't
// consume a structural JSON `"`) while allowing real-world mixed-quote payloads
// (e.g. `php -r '$sock=fsockopen("10.0.0.1",4242);'`).
const reverseShellPythonSingle = /python[23]?(?:\.\d+)?\s+-c\s+'[^']*\bsocket\b[^']*\bsubprocess\b[^']*'/gi
const reverseShellPythonDouble = /python[23]?(?:\.\d+)?\s+-c\s+"[^"]*\bsocket\b[^"]*\bsubprocess\b[^"]*"/gi
const reverseShellPerlSingle = /perl\s+-e\s+'[^']*\buse\s+Socket\b[^']*'/gi
const reverseShellPerlDouble = /perl\s+-e\s+"[^"]*\buse\s+Socket\b[^"]*"/gi
const reverseShellPhpSingle = /php\s+-r\s+'[^']*\bfsockopen\b[^']*'/gi
const reverseShellPhpDouble = /php\s+-r\s+"[^"]*\bfsockopen\b[^"]*"/gi
const reverseShellRubySingle = /ruby\s+-rsocket\s+-e\s+'[^']*'/gi
const reverseShellRubyDouble = /ruby\s+-rsocket\s+-e\s+"[^"]*"/gi

/**
 * Sanitize a request body string by redacting shell-injection patterns that
 * trip Cloudflare's "Command Injection — Common Attack Commands" WAF rule.
 *
 * Broader patterns (whole-construct redactions) are applied first so they don't
 * get partially overwritten by the narrower pipe-to-shell rule.
 *
 * Spec: `.team/thu-445/sanitizer-spec.md`.
 */
export const sanitizeRequestBody = (body: string): string =>
  body
    .replace(shellDashCNetworkFetch, '$1{{redacted-network-exec}}')
    .replace(evalNetworkFetch, 'eval {{redacted-network-eval}}')
    .replace(processSubstitutionFetch, '<({{redacted-network-fetch}})')
    .replace(reverseShellDevTcp, '{{redacted-reverse-shell}}')
    .replace(reverseShellNc, '{{redacted-reverse-shell}}')
    .replace(reverseShellPythonSingle, '{{redacted-python-reverse-shell}}')
    .replace(reverseShellPythonDouble, '{{redacted-python-reverse-shell}}')
    .replace(reverseShellPerlSingle, '{{redacted-perl-reverse-shell}}')
    .replace(reverseShellPerlDouble, '{{redacted-perl-reverse-shell}}')
    .replace(reverseShellPhpSingle, '{{redacted-php-reverse-shell}}')
    .replace(reverseShellPhpDouble, '{{redacted-php-reverse-shell}}')
    .replace(reverseShellRubySingle, '{{redacted-ruby-reverse-shell}}')
    .replace(reverseShellRubyDouble, '{{redacted-ruby-reverse-shell}}')
    .replace(pipeToShell, '$1{{redacted-shell}}')
    .replace(pipeToInterpreter, '$1{{redacted-interpreter}}')
