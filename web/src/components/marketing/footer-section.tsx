/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type FooterSectionProps = {
  className?: string
}

const REPO_URL = 'https://github.com/thunderbird/thunderbolt'
const DISCORD_URL = 'https://discord.gg/chwSZCBC8V'
const LINKEDIN_URL = 'https://www.linkedin.com/company/mozilla-thunderbolt/'

const SocialGitHubIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
  </svg>
)

const SocialDiscordIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09c-.01-.02-.04-.03-.07-.03c-1.5.26-2.93.71-4.27 1.33c-.01 0-.02.01-.03.02c-2.72 4.07-3.47 8.03-3.1 11.95c0 .02.01.04.03.05c1.8 1.32 3.53 2.12 5.24 2.65c.03.01.06 0 .07-.02c.4-.55.76-1.13 1.07-1.74c.02-.04 0-.08-.04-.09c-.57-.22-1.11-.48-1.64-.78c-.04-.02-.04-.08-.01-.11c.11-.08.22-.17.33-.25c.02-.02.05-.02.07-.01c3.44 1.57 7.15 1.57 10.55 0c.02-.01.05-.01.07.01c.11.09.22.17.33.26c.04.03.04.09-.01.11c-.52.31-1.07.56-1.64.78c-.04.01-.05.06-.04.09c.32.61.68 1.19 1.07 1.74c.03.01.06.02.09.01c1.72-.53 3.45-1.33 5.25-2.65c.02-.01.03-.03.03-.05c.44-4.53-.73-8.46-3.1-11.95c-.01-.01-.02-.02-.04-.02ZM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.84 2.12-1.89 2.12Zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.83 2.12-1.89 2.12Z"/>
  </svg>
)

const SocialLinkedInIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.063 2.063 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
  </svg>
)

export const FooterSection = ({ className = '' }: FooterSectionProps) => (
  <footer className={className}>
    <div className="mx-auto max-w-[1120px] px-6 py-16 lg:px-0">
      <div className="grid grid-cols-1 gap-12 md:grid-cols-4">
        {/* Left Column - Logo & Legal */}
        <div className="md:col-span-1">
          <div className="flex items-center gap-2">
            <img src="/enterprise/thunderbolt-icon.svg" alt="Thunderbolt" className="size-6" />
            <span className="font-['IBM_Plex_Mono'] font-bold text-sm text-[#344054]">THUNDERBOLT</span>
          </div>
          <p className="mt-4 text-xs leading-5 text-[#667085]">
            Thunderbolt is a product of MZLA Technologies Corporation, a wholly owned subsidiary of Mozilla.org.
          </p>
          <div className="mt-6 flex gap-3">
            <img src="/enterprise/mozilla-logo.svg" alt="Mozilla" className="h-5 w-auto" />
            <img src="/enterprise/thunderbird.svg" alt="Thunderbird" className="h-5 w-auto" />
          </div>
        </div>

        {/* Product Links */}
        <div className="md:col-span-1">
          <h4 className="font-['IBM_Plex_Mono'] font-bold text-xs text-[#344054] uppercase tracking-wide">Product</h4>
          <ul className="mt-4 space-y-3">
            <li>
              <a href="/" className="font-['IBM_Plex_Mono'] text-xs text-[#667085] uppercase tracking-wide hover:text-[#344054]">
                Overview
              </a>
            </li>
            <li>
              <a href="#" className="font-['IBM_Plex_Mono'] text-xs text-[#667085] uppercase tracking-wide hover:text-[#344054]">
                Enterprise
              </a>
            </li>
            <li>
              <a href="https://docs.thunderbolt.io" target="_blank" rel="noopener noreferrer" className="font-['IBM_Plex_Mono'] text-xs text-[#667085] uppercase tracking-wide hover:text-[#344054]">
                Docs
              </a>
            </li>
            <li>
              <a href="/blog" className="font-['IBM_Plex_Mono'] text-xs text-[#667085] uppercase tracking-wide hover:text-[#344054]">
                Blog
              </a>
            </li>
          </ul>
        </div>

        {/* Community Links */}
        <div className="md:col-span-1">
          <h4 className="font-['IBM_Plex_Mono'] font-bold text-xs text-[#344054] uppercase tracking-wide">Community</h4>
          <ul className="mt-4 space-y-3">
            <li>
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="font-['IBM_Plex_Mono'] text-xs text-[#667085] uppercase tracking-wide hover:text-[#344054]">
                GitHub ↗
              </a>
            </li>
            <li>
              <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="font-['IBM_Plex_Mono'] text-xs text-[#667085] uppercase tracking-wide hover:text-[#344054]">
                Discord ↗
              </a>
            </li>
            <li>
              <a href={LINKEDIN_URL} target="_blank" rel="noopener noreferrer" className="font-['IBM_Plex_Mono'] text-xs text-[#667085] uppercase tracking-wide hover:text-[#344054]">
                LinkedIn ↗
              </a>
            </li>
          </ul>
        </div>

        {/* Company Links */}
        <div className="md:col-span-1">
          <h4 className="font-['IBM_Plex_Mono'] font-bold text-xs text-[#344054] uppercase tracking-wide">Company</h4>
          <ul className="mt-4 space-y-3">
            <li>
              <a href="https://www.mozilla.org" target="_blank" rel="noopener noreferrer" className="font-['IBM_Plex_Mono'] text-xs text-[#667085] uppercase tracking-wide hover:text-[#344054]">
                Mozilla ↗
              </a>
            </li>
            <li>
              <a href="https://www.thunderbird.net" target="_blank" rel="noopener noreferrer" className="font-['IBM_Plex_Mono'] text-xs text-[#667085] uppercase tracking-wide hover:text-[#344054]">
                Thunderbird ↗
              </a>
            </li>
            <li>
              <a href="https://www.thunderbird.net/en-US/privacy/" target="_blank" rel="noopener noreferrer" className="font-['IBM_Plex_Mono'] text-xs text-[#667085] uppercase tracking-wide hover:text-[#344054]">
                Privacy
              </a>
            </li>
          </ul>
        </div>
      </div>

      {/* Copyright */}
      <div className="mt-12 border-t border-[#eaecf0] pt-8 text-center">
        <p className="font-['IBM_Plex_Mono'] text-xs text-[#667085] uppercase tracking-wide">
          © 2026 MZLA TECHNOLOGIES CORPORATION
        </p>
      </div>
    </div>
  </footer>
)
