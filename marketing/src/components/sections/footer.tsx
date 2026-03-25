import { Zap } from 'lucide-react'

const links = {
  Product: ['Features', 'Security', 'Enterprise', 'Pricing'],
  Developers: ['Documentation', 'GitHub', 'API Reference', 'Self-Hosting Guide'],
  Company: ['About', 'Blog', 'Careers', 'Contact'],
  Legal: ['Privacy Policy', 'Terms of Service', 'Security Policy'],
}

export const Footer = () => (
  <footer className="border-t border-black/[0.06] bg-neutral-50">
    <div className="w-full px-6 py-16 lg:px-10">
      <div className="grid gap-12 md:grid-cols-[1.5fr_1fr_1fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-black">
              <Zap className="size-4 text-white" fill="currentColor" />
            </div>
            <span className="text-lg font-semibold tracking-tight text-black">
              Thunderbolt
            </span>
          </div>
          <p className="mt-5 max-w-xs leading-relaxed text-black/40">
            Privacy-first AI assistant from the Thunderbird team at Mozilla.
            Your data, your models, your infrastructure.
          </p>
          <div className="mt-6">
            <div className="inline-flex items-center gap-2 rounded-md border border-black/[0.06] bg-white px-3 py-1.5">
              <span className="font-mono text-xs font-semibold tracking-tight text-black">
                mozilla
              </span>
              <span className="text-[10px] text-black/20">|</span>
              <span className="font-mono text-xs text-black/50">
                thunderbird
              </span>
            </div>
          </div>
        </div>

        {Object.entries(links).map(([category, items]) => (
          <div key={category}>
            <h4 className="font-mono text-xs font-medium tracking-[0.1em] uppercase text-black/40">
              {category}
            </h4>
            <ul className="mt-5 space-y-3">
              {items.map((item) => (
                <li key={item}>
                  <a
                    href="#"
                    className="text-sm text-black/50 transition-colors hover:text-black"
                  >
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="mt-16 flex flex-col items-start justify-between gap-4 border-t border-black/[0.06] pt-8 md:flex-row md:items-center">
        <p className="text-xs text-black/30">
          &copy; {new Date().getFullYear()} MZLA Technologies Corporation. All
          rights reserved.
        </p>
        <p className="font-mono text-xs text-black/30">
          A Thunderbird product, powered by Mozilla
        </p>
      </div>
    </div>
  </footer>
)
