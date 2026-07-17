import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, ShieldCheck, Target, TrendingUp, Award, Layers } from 'lucide-react'
import Button from '../components/Button'
import ScrollReveal, { ScrollRevealGroup, ScrollRevealItem } from '../components/animations/ScrollReveal'
import SuccessModal from '@/swisdex/components/SuccessModal'

const PropTrading = () => {
  const [showSuccess, setShowSuccess] = useState(false)

  return (
    <div className="min-h-screen pt-20">
      {/* Hero — Coming Soon */}
      <section className="section-padding hero-banner relative overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(ellipse 60% 50% at 50% 0%, rgba(85,166,48,0.18), transparent 70%)',
          }}
        />
        <div className="container-custom text-center">
          <ScrollReveal variant="fadeUp">
            <span className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-primary-accent/20 text-primary-accent text-[11px] uppercase tracking-[0.22em] font-semibold">
              <span className="relative inline-flex items-center justify-center">
                <span className="absolute size-2 rounded-full bg-primary-accent opacity-75 animate-ping" />
                <span className="relative size-2 rounded-full bg-primary-accent" />
              </span>
              Coming Soon
            </span>

            <h1 className="mt-7 text-5xl md:text-7xl font-bold text-white leading-[0.95]">
              Prop Trading <br className="hidden sm:block" />
              <span className="gradient-text">Program</span>
            </h1>

            <p className="mt-6 text-xl text-text-secondary max-w-3xl mx-auto">
              Prove your skills, get funded, and trade with our capital — keep up to 90% of the profits with zero personal risk.
              The SwisDex Prop Program is launching in <span className="text-primary-accent font-semibold">Q3 2026</span>.
              Join the early-access list to be the first to take the challenge.
            </p>

            <form
              className="mt-9 mx-auto max-w-xl"
              onSubmit={(e) => { e.preventDefault(); setShowSuccess(true) }}
            >
              <div className="glass-card rounded-full p-1.5 flex items-center gap-2">
                <input
                  type="email"
                  required
                  placeholder="you@email.com"
                  aria-label="Email address for Prop Program launch notification"
                  className="flex-1 bg-transparent px-4 py-2 text-sm text-white placeholder:text-text-secondary outline-none"
                />
                <Button variant="primary" className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold uppercase tracking-wider">
                  Notify Me <Bell size={14} />
                </Button>
              </div>
              <p className="mt-3 text-xs text-text-secondary">
                One email at launch. Unsubscribe in one click.
              </p>
            </form>
          </ScrollReveal>
        </div>
      </section>

      {/* What to expect */}
      <section className="section-padding bg-primary-secondary">
        <div className="container-custom">
          <ScrollReveal variant="fadeUp">
            <h2 className="text-3xl md:text-4xl font-bold text-white text-center mb-4">What to Expect at Launch</h2>
            <p className="text-text-secondary text-center max-w-2xl mx-auto mb-12">
              A modern evaluation, fair rules, and an industry-leading 90% profit split when you get funded.
            </p>
          </ScrollReveal>
          <ScrollRevealGroup className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { icon: Target,       title: 'Realistic Profit Targets', desc: 'Reach achievable profit targets without aggressive deadlines or hidden disqualification rules.' },
              { icon: ShieldCheck,  title: 'Transparent Risk Rules',   desc: 'Clear daily and total drawdown limits — every rule visible on your dashboard at all times.' },
              { icon: TrendingUp,   title: 'Up to 90% Profit Split',   desc: 'Keep up to 90% of the profits you generate on your funded account. Withdraw weekly.' },
              { icon: Award,        title: 'Scaling Plan',             desc: 'Consistently profitable traders can scale their account up to $500,000 in funded capital.' },
              { icon: Layers,       title: 'No Time Pressure (Funded)', desc: 'Once funded there is no evaluation clock. Trade at your own pace, your own way.' },
              { icon: Bell,         title: 'Early-Access Pricing',     desc: 'Subscribers on the launch list receive a discounted challenge fee for the first 30 days.' },
            ].map((b, i) => (
              <ScrollRevealItem key={i}>
                <div className="glass-card p-6 h-full">
                  <div className="feature-icon bg-primary-accent/10 text-primary-accent mb-4">
                    <b.icon size={20} />
                  </div>
                  <h3 className="text-white font-semibold text-lg mb-2">{b.title}</h3>
                  <p className="text-text-secondary text-sm leading-relaxed">{b.desc}</p>
                </div>
              </ScrollRevealItem>
            ))}
          </ScrollRevealGroup>
        </div>
      </section>

      {/* CTA */}
      <section className="section-padding bg-primary-bg">
        <div className="container-custom text-center">
          <ScrollReveal variant="fadeUp">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">Be First in Line</h2>
            <p className="text-text-secondary max-w-2xl mx-auto mb-8">
              Open a SwisDex account today — your trading history counts toward your early-access tier when the Prop Program goes live.
            </p>
            <Link to="/auth/register">
              <Button variant="primary">Open Account</Button>
            </Link>
          </ScrollReveal>
        </div>
      </section>

      <SuccessModal
        open={showSuccess}
        title="You're on the list"
        message="Thanks for your interest. We'll email you the moment the SwisDex Prop Program challenge opens in Q3 2026."
        ctaLabel="OK"
        onClose={() => setShowSuccess(false)}
        footnote="One email at launch. Unsubscribe in one click."
      />
    </div>
  )
}

export default PropTrading
