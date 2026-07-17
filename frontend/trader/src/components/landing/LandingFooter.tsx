import Link from 'next/link'
import { Phone, Cookie } from 'lucide-react'
import { openCookieSettings } from '@/swisdex/components/CookieConsent'

/**
 * Dark-themed landing footer.
 *
 * Used by the deprecated app-root pages (/about, /contact, /platforms,
 * /white-label). Matches the rest of the SwisDex dark site palette so
 * the footer never looks like a white island under a dark page. The
 * canonical landing chrome lives in src/landing/components/Footer.jsx
 * — drop this file once those four pages are migrated into the
 * (landing) route group.
 *
 * Phone + WhatsApp pin to the live UK support line documented in
 * Contact.jsx — the previous "+1 (908) 228-0305" placeholder was an
 * unverified North-American number that never connected.
 */

/** Official WhatsApp glyph — lucide-react doesn't ship brand logos. */
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M.057 24l1.687-6.163a11.867 11.867 0 01-1.587-5.945C.16 5.335 5.495 0 12.05 0a11.82 11.82 0 018.413 3.488 11.82 11.82 0 013.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 01-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.82 9.82 0 001.671 5.475l-.999 3.648 3.817-1.002zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/>
    </svg>
  )
}

export default function LandingFooter() {
  return (
    <footer
      className="border-t py-12"
      style={{
        background: 'linear-gradient(180deg, #0a0c10 0%, #05070a 100%)',
        borderColor: 'rgba(255,255,255,0.08)',
        color: 'rgba(255,255,255,0.75)',
      }}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-10 mb-10">
          <div className="lg:col-span-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/swisdex_png.png" alt="SwisDex" className="h-10 w-auto mb-4" />
            <p className="text-sm leading-relaxed mb-3 max-w-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>
              Professional multi-asset trading platform. Licensed under Investment Dealer Licence
              No. MAK21098161, St. Lucia.
            </p>
            <p className="text-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>
              <span className="font-semibold" style={{ color: 'rgba(255,255,255,0.9)' }}>
                Scotland Office:
              </span>
              <br />
              SwisDex Office 23US, 18 Young St, UNIT LGE 1/1, Edinburgh EH2 4JB,
              Scotland, United Kingdom
            </p>
          </div>

          <div>
            <p className="font-semibold mb-4" style={{ color: 'rgba(255,255,255,0.95)' }}>
              Products
            </p>
            <ul className="space-y-2 text-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>
              <li><Link href="/platforms" className="hover:text-[#55a630] transition-colors">Trading Platforms</Link></li>
              <li><Link href="/white-label" className="hover:text-[#55a630] transition-colors">White Label</Link></li>
              <li><Link href="/auth/register" className="hover:text-[#55a630] transition-colors">Open Live Account</Link></li>
              <li><Link href="/auth/register" className="hover:text-[#55a630] transition-colors">Demo Account</Link></li>
            </ul>
          </div>

          <div>
            <p className="font-semibold mb-4" style={{ color: 'rgba(255,255,255,0.95)' }}>
              Company
            </p>
            <ul className="space-y-2 text-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>
              <li><Link href="/company/about" className="hover:text-[#55a630] transition-colors">About Us</Link></li>
              <li><Link href="/company/contact" className="hover:text-[#55a630] transition-colors">Contact</Link></li>
              <li><Link href="/white-label" className="hover:text-[#55a630] transition-colors">Partnerships</Link></li>
            </ul>
          </div>

          <div>
            <p className="font-semibold mb-4" style={{ color: 'rgba(255,255,255,0.95)' }}>
              Support
            </p>
            <ul className="space-y-2 text-sm" style={{ color: 'rgba(255,255,255,0.6)' }}>
              <li>
                <Link href="/company/contact" className="hover:text-[#55a630] transition-colors">
                  Contact Support
                </Link>
              </li>
              <li className="flex items-center gap-2">
                <Phone className="w-4 h-4 shrink-0" />
                <a
                  href="tel:+447737119978"
                  className="hover:text-[#55a630] transition-colors"
                >
                  +44 7737 119978
                </a>
              </li>
              <li className="flex items-center gap-2">
                <WhatsAppIcon className="w-4 h-4 shrink-0" />
                <a
                  href="https://wa.me/447737119978"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-[#55a630] transition-colors"
                >
                  WhatsApp
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div
          className="pt-8 flex flex-col md:flex-row justify-between items-center gap-4"
          style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
        >
          <p className="text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>
            &copy; {new Date().getFullYear()} SwisDex. All rights reserved.
          </p>
          <div className="flex items-center gap-5 text-sm" style={{ color: 'rgba(255,255,255,0.55)' }}>
            <Link href="/privacy" className="hover:text-[#55a630] transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-[#55a630] transition-colors">Terms of Service</Link>
            <Link href="/risk" className="hover:text-[#55a630] transition-colors">Risk Disclosure</Link>
            <button
              type="button"
              onClick={openCookieSettings}
              className="inline-flex items-center gap-1.5 hover:text-[#55a630] transition-colors"
              aria-label="Open cookie settings"
              // Silence the `fdprocessedid` mismatch from form-filler
              // extensions — matches the same pin on Footer.jsx.
              suppressHydrationWarning
            >
              <Cookie className="w-3.5 h-3.5" /> Cookie Settings
            </button>
          </div>
        </div>
      </div>
    </footer>
  )
}
