import Link from 'next/link'
import { Facebook, Instagram, Linkedin, Youtube, Mail, Cookie } from 'lucide-react'
import ScrollReveal from './animations/ScrollReveal'
import { openCookieSettings } from '@/swisdex/components/CookieConsent'

const columns = {
  Trading: [
    { name: 'Forex',       path: '/trading/forex' },
    { name: 'Indices',     path: '/trading/indices' },
    { name: 'Commodities', path: '/trading/commodities' },
    { name: 'Crypto',      path: '/trading/crypto' },
  ],
  Services: [
    { name: 'AI Auto Trading',       path: '/services/ai-auto-trading' },
    { name: 'Portfolio Management',  path: '/services/portfolio-management' },
    { name: 'Market Research',       path: '/services/market-research' },
    { name: 'Education',             path: '/services/education' },
    { name: 'Automated Profit',      path: '/services/automated-profit' },
    { name: 'ICO (Coming Soon)',     path: '/services/ico-coming-soon' },
  ],
  Accounts: [
    { name: 'Standard', path: '/accounts/standard' },
    { name: 'Pro',      path: '/accounts/pro' },
    { name: 'Demo',     path: '/accounts/demo' },
  ],
  Academy: [
    { name: 'PDFs',   path: '/academy/pdfs' },
    { name: 'Blogs',  path: '/academy/blogs' },
  ],
  'Risk Management': [
    { name: 'Trading Calculators', path: '/risk-management/calculator' },
  ],
  Products: [
    { name: 'IB Referral',              path: '/products/ib-referral' },
    { name: 'AI-POWERED STAKING PROGRAM',   path: '/products/fixed-return-insurance' },
  ],
  Company: [
    { name: 'About Us',       path: '/company/about' },
    { name: 'Contact',        path: '/company/contact' },
  ],
}

const socials = [
  { icon: Facebook,  href: 'https://www.facebook.com/profile.php?id=61589880747321', label: 'Facebook' },
  { icon: Instagram, href: 'https://www.instagram.com/swisdex/',                     label: 'Instagram' },
  { icon: Linkedin,  href: 'https://www.linkedin.com/in/swis-dex-a62208410/',        label: 'LinkedIn' },
  { icon: Youtube,   href: 'https://youtube.com/@swisdex-u7q',                       label: 'YouTube' },
]

export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer
      className="relative"
      style={{
        background: 'linear-gradient(180deg, var(--fx-bg) 0%, #050608 100%)',
        borderTop: '1px solid var(--fx-line)',
      }}
    >
      <div className="fx-divider-gold" />

      <div className="fx-container py-14 md:py-20">
        {/* Top: brand + columns */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-10 lg:gap-8">
          {/* Brand block — spans more on mobile */}
          <div className="col-span-2 lg:col-span-2">
            <ScrollReveal variant="fadeLeft">
              <Link href="/" className="inline-block mb-5" aria-label="SwisDex home">
                <img src="/images/swisdex_png5.png" alt="SwisDex" className="h-10 w-auto hidden dark:block" />
                <img src="/images/swisdex_png.png" alt="SwisDex" className="h-10 w-auto dark:hidden" />
              </Link>
              <p className="text-sm leading-relaxed max-w-sm mb-6" style={{ color: 'var(--fx-text-2)' }}>
                SwisDex is an institutional-grade forex, CFD broker, and decentralized exchange
                built for serious traders. It offers fast execution, low spreads, transparent
                pricing, insured trades, and fully automated trading with no human intervention.
              </p>
              <p className="text-sm leading-relaxed max-w-sm mb-6" style={{ color: 'var(--fx-text-2)' }}>
                SwisDex also provides staking with fixed monthly income, anytime withdrawals,
                and a rewarding IB (Introducing Broker) program with profit-sharing opportunities
                for partners and affiliates.
              </p>

              <div className="flex items-center gap-2 text-sm mb-5" style={{ color: 'var(--fx-text-3)' }}>
                <Mail size={14} style={{ color: 'var(--fx-gold-light)' }} />
                <a href="mailto:info@swisdex.com" className="hover:underline" style={{ color: 'var(--fx-text-2)' }}>
                  info@swisdex.com
                </a>
              </div>

              <div className="flex items-center gap-2.5">
                {socials.map(({ icon: Icon, href, label }) => (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={label}
                    className="w-9 h-9 rounded-full flex items-center justify-center transition-colors"
                    style={{
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid var(--fx-line-strong)',
                      color: 'var(--fx-text-2)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = 'var(--fx-gold-light)'
                      e.currentTarget.style.borderColor = 'rgba(85,166,48,0.4)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = 'var(--fx-text-2)'
                      e.currentTarget.style.borderColor = 'var(--fx-line-strong)'
                    }}
                  >
                    <Icon size={15} />
                  </a>
                ))}
              </div>
            </ScrollReveal>
          </div>

          {/* Link columns */}
          {Object.entries(columns).map(([heading, links], i) => (
            <ScrollReveal key={heading} variant="fadeUp" delay={0.05 + i * 0.05}>
              <h3
                className="text-xs uppercase tracking-[0.16em] font-semibold mb-4"
                style={{ color: 'var(--fx-gold-light)' }}
              >
                {heading}
              </h3>
              <ul className="space-y-2.5">
                {links.map((link) => (
                  <li key={link.path}>
                    <Link
                      href={link.path}
                      className="text-sm transition-colors"
                      style={{ color: 'var(--fx-text-2)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--fx-text)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fx-text-2)' }}
                    >
                      {link.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </ScrollReveal>
          ))}
        </div>

        {/* Risk warning + Restricted regions */}
        <div
          className="mt-12 md:mt-16 p-6 md:p-8 rounded-2xl space-y-7"
          style={{
            background: 'var(--fx-bg-elev)',
            border: '1px solid var(--fx-line)',
          }}
        >
          <div>
            <h3
              className="text-lg md:text-xl font-semibold mb-3"
              style={{ color: 'var(--fx-text)' }}
            >
              Risk Warning
            </h3>
            <p className="text-xs md:text-[13px] leading-relaxed" style={{ color: 'var(--fx-text-3)' }}>
              Please note that forex trading and trading in other leveraged products involves a
              significant level of risk and is not suitable for all investors. Trading in financial
              instruments may result in losses as well as profits and your losses can be greater than
              your initial invested capital. Before undertaking any such transactions, you should
              ensure that you fully understand the risks involved and seek independent advice if
              necessary. SwisDex does not provide investment advice.
            </p>
          </div>

          <div>
            <h3
              className="text-lg md:text-xl font-semibold mb-3"
              style={{ color: 'var(--fx-text)' }}
            >
              Restricted Regions
            </h3>
            <p className="text-xs md:text-[13px] leading-relaxed" style={{ color: 'var(--fx-text-3)' }}>
              SwisDex Ltd does not provide services for citizens/residents of the USA, Cuba, Iraq,
              Myanmar, North Korea, and Sudan. The services of SwisDex Ltd are not intended for
              distribution to, or use by, any person in any country or jurisdiction where such
              distribution or use would be contrary to local law or regulation.
            </p>
          </div>
        </div>

        {/* Legal / Policy quick-links — each opens the official signed
            PDF in a new tab. Drop replacement files at /public/pdfs/terms/
            with the exact filenames used below. */}
        <nav
          aria-label="Legal documents"
          className="mt-10 pt-6 flex flex-wrap gap-x-7 gap-y-3"
          style={{ borderTop: '1px solid var(--fx-line)' }}
        >
          {[
            { name: 'Privacy Policy',              href: '/privacy' },
            { name: 'Terms & Conditions',          href: '/terms' },
            { name: 'Deposit & withdrawal Policy', href: '/deposit-withdrawal' },
            { name: 'Restricted Countries',        href: '/restricted-countries' },
            { name: 'Risk Warning',                href: '/risk-warning' },
            { name: 'Risk Disclosure',             href: '/risk' },
          ].map((doc) => (
            <a
              key={doc.name}
              href={doc.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold hover:underline transition-colors"
              style={{ color: 'var(--fx-text)' }}
            >
              {doc.name}
            </a>
          ))}
        </nav>

        {/* Bottom bar */}
        <div
          className="mt-6 pt-6 flex flex-col md:flex-row gap-3 md:gap-6 items-start md:items-center justify-between"
          style={{ borderTop: '1px solid var(--fx-line)' }}
        >
          <p className="text-xs" style={{ color: 'var(--fx-text-3)' }}>
            © {year} SwisDex Ltd. All rights reserved. · Founded in 2010
          </p>
          {/* Cookie Settings — surfaces the consent modal even after
              the user has already accepted/saved a preference, so the
              choice stays revisable per GDPR. */}
          <button
            type="button"
            onClick={openCookieSettings}
            className="inline-flex items-center gap-1.5 text-xs hover:underline transition-colors"
            style={{ color: 'var(--fx-text-2)' }}
            aria-label="Open cookie settings"
          >
            <Cookie size={13} /> Cookie Settings
          </button>
        </div>
      </div>
    </footer>
  )
}
