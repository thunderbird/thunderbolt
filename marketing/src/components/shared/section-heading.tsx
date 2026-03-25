import { AnimatedSection } from './animated-section'

type SectionHeadingProps = {
  label: string
  title: string
  description?: string
  align?: 'left' | 'center'
}

export const SectionHeading = ({
  label,
  title,
  description,
  align = 'left',
}: SectionHeadingProps) => (
  <AnimatedSection
    className={align === 'center' ? 'mx-auto max-w-3xl text-center' : ''}
  >
    <span className="mb-4 inline-block font-mono text-xs font-medium tracking-[0.1em] uppercase text-black/40">
      {label}
    </span>
    <h2 className="text-[clamp(2rem,3vw+0.5rem,3.5rem)] leading-[1.08] font-medium tracking-[-0.035em] text-black">
      {title}
    </h2>
    {description && (
      <p
        className={`mt-5 text-[clamp(1rem,0.5vw+0.9rem,1.25rem)] leading-relaxed text-black/50 ${
          align === 'center' ? '' : 'max-w-2xl'
        }`}
      >
        {description}
      </p>
    )}
  </AnimatedSection>
)
