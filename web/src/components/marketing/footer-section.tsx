/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

type FooterSectionProps = {
  className?: string
}

export const FooterSection = ({ className = '' }: FooterSectionProps) => (
  <footer className={className}>
    <div className="mx-auto max-w-[1120px] px-6 lg:px-0">
      <div className="flex items-center justify-center gap-2">
        <img src="/enterprise/thunderbolt-logo.png" alt="Thunderbolt" className="size-[34px]" />
        <span className="text-xl font-medium tracking-tight text-[#101828]">Thunderbolt</span>
      </div>
      <div className="mx-auto mt-6 h-px max-w-[1118px] bg-[#eaecf0]" />
      <div className="mt-6 flex flex-col items-center justify-center gap-4 text-center lg:flex-row lg:gap-6">
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-3">
          <img src="/enterprise/mozilla-logo.svg" alt="Mozilla" className="h-6 w-auto" />
          <img src="/enterprise/thunderbird.svg" alt="Thunderbird" className="h-6 w-auto" />
        </div>
        <p className="max-w-[638px] text-center text-xs leading-4 text-[#667085] lg:text-left">
          Thunderbolt is a product of{' '}
          <a href="https://blog.thunderbird.net/2020/01/thunderbirds-new-home/" className="border-b border-[#667085]/40" target="_blank" rel="noopener noreferrer">
            MZLA Technologies Corporation
          </a>
          , a wholly owned subsidiary of Mozilla Foundation. Portions of this content are &copy;1998&ndash;2026 by individual contributors. Content available under a{' '}
          <a href="https://www.mozilla.org/foundation/licensing/website-content/" className="border-b border-[#667085]/40" target="_blank" rel="noopener noreferrer">
            Creative Commons license
          </a>
          .
        </p>
      </div>
    </div>
  </footer>
)
