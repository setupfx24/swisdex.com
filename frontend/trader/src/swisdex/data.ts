/**
 * Static content for the SwisDex marketing home page.
 *
 * The single CTA target across the page is `/auth/register` so every
 * "Get Started" / "Create Account" / "Start Investing" link drops the
 * user onto the trader signup flow regardless of which CTA they click.
 */

export const SIGNUP_HREF = '/auth/register';

export const BRAND = {
  name: 'SwisDex',
  tagline: 'Trade Smarter. Grow Faster. Invest with Confidence.',
  logo: '/images/swisdex_png5.png',
};

// Nav targets all resolve to public landing routes. /markets and
// /account-types are explicit pages with their own content; AuthProvider
// allow-lists them so unauthenticated visitors are not bounced to login.
// Items with `children` render as a dropdown.
export type NavItem = {
  label: string;
  href: string;
  children?: { label: string; href: string }[];
};

export const NAV_ITEMS: NavItem[] = [
  { label: 'Home',         href: '/' },
  { label: 'Markets',      href: '/markets' },
  { label: 'Accounts',     href: '/account-types' },
  {
    label: 'Risk Management',
    href: '/risk-management/calculator',
    children: [
      { label: 'Trading Calculators', href: '/risk-management/calculator' },
    ],
  },
  {
    label: 'Products',
    href: '/products/ib-referral',
    children: [
      { label: 'IB',           href: '/products/ib-referral' },
      { label: 'Referral',     href: '/products/referral' },
      { label: 'AI-POWERED STAKING PROGRAM', href: '/products/fixed-return-insurance' },
      { label: 'Insurance',    href: '/products/insurance' },
    ],
  },
  { label: 'About',        href: '/company/about' },
  { label: 'Contact',      href: '/company/contact' },
];

export const HERO = {
  pill: 'Crypto & Forex Investment Platform',
  pillBadge: 'Live',
  headline: 'Trade Smarter Grow Faster',
  sub: 'SwisDex is a decentralized exchange with on-chain insured trades and licensed broker-grade execution — your funds stay in your wallet, your trades stay protected.',
  ctaPrimary: 'Details',
  ctaSecondary: 'Learn How It Works',
  ctaHref: '/bonus',
  ctaSecondaryHref: '/how-it-works',
};

/**
 * Three trust pills rendered above the hero CTAs — the first words a
 * first-time visitor reads. Communicates "what we do" before any scroll:
 * decentralized execution, on-chain trade insurance, regulated broker.
 *
 * Icon names are lucide-react component names — resolved in Hero.tsx via
 * an iconMap so we don't ship the entire icon catalog client-side.
 */
export const HERO_TRUST_PILLS = [
  { icon: 'Network',    label: 'Decentralized Exchange', sub: 'Non-custodial. Your wallet, your keys.' },
  { icon: 'ShieldCheck', label: 'Insured Trade',          sub: 'Every position is policy-backed.' },
  { icon: 'BadgeCheck', label: 'Licensed Broker',         sub: 'Institutional-grade execution.' },
] as const;

export const LIVE_TICKER = [
  { pair: 'BTC/USD',   price: '67,420',  change: '+1.82%', up: true },
  { pair: 'ETH/USD',   price: '3,580',   change: '+0.94%', up: true },
  { pair: 'EUR/USD',   price: '1.0842',  change: '+0.12%', up: true },
  { pair: 'XAU/USD',   price: '2318.50', change: '+0.45%', up: true },
  { pair: 'SOL/USD',   price: '168.20',  change: '+2.31%', up: true },
  { pair: 'GBP/USD',   price: '1.2654',  change: '-0.08%', up: false },
  { pair: 'USD/JPY',   price: '149.82',  change: '+0.23%', up: true },
  { pair: 'XRP/USD',   price: '0.5423',  change: '-0.15%', up: false },
  { pair: 'ADA/USD',   price: '0.4612',  change: '+0.72%', up: true },
  { pair: 'AUD/USD',   price: '0.6512',  change: '+0.08%', up: true },
  { pair: 'MATIC/USD', price: '0.8120',  change: '+1.05%', up: true },
  { pair: 'DOT/USD',   price: '7.42',    change: '-0.21%', up: false },
];

export const INSTRUMENTS = [
  { icon: 'Cpu',        title: 'AI-Driven Auto Trading',         badge: '24/7 Active',       body: 'Our intelligent algorithms monitor markets 24/7 and execute high-frequency trades to maximise your returns with minimal risk.', href: '/services/ai-auto-trading' },
  { icon: 'BarChart2',  title: 'Portfolio Management',           badge: 'MAM / PAMM',        body: 'Expert asset allocation and continuous rebalancing — choose MAM for managed-account models or PAMM for percentage-based allocations.', href: '/services/portfolio-management' },
  { icon: 'TrendingUp', title: 'Market Research & Analysis',     badge: 'Daily Reports',     body: 'In-depth technical and fundamental analysis reports, updated daily to keep your investment decisions sharp.',                  href: '/services/market-research' },
  { icon: 'Layers',     title: 'Educational Resources',          badge: 'Beginner Friendly', body: 'Learn trading strategies, crypto fundamentals, and market dynamics through curated workshops, guides, and webinars.',          href: '/services/education' },
  { icon: 'Gem',        title: 'ICO & Early-Stage Investments',  badge: 'Coming Soon',       body: 'Early access to promising new blockchain projects, vetted by SwisDex before they hit the wider market. Launching soon.',     href: '/services/ico-coming-soon', comingSoon: true },
  { icon: 'Building',   title: 'Automated Profit Generation',    badge: 'Algo Powered',      body: 'Beyond standard trading, SwisDex deploys advanced algorithmic bots designed to generate consistent returns even in volatile markets.', href: '/services/automated-profit' },
] as const;

export const WHY_US = [
  { icon: 'Network',      title: 'Decentralized Exchange',            body: 'Trade directly from your own wallet with non-custodial, on-chain execution — no intermediaries, no counterparty risk. Your keys, your funds.' },
  { icon: 'ShieldCheck',  title: 'Insurance for Traders',             body: 'Every trade is policy-backed with on-chain insurance. If the market moves against you beyond defined thresholds, your insured amount is protected.' },
  { icon: 'Gift',         title: 'Bonus & Rewards',                   body: 'Get a 100% welcome bonus up to $200 on your first deposit — credited within minutes and fully tradeable on a decentralized exchange with insured trades. Stacks with referral commissions and trading cashback.' },
  { icon: 'Lock',         title: 'Fixed Rate Return',                 body: 'Lock in guaranteed AI-POWERED STAKING PROGRAMs with our structured investment plans — predictable income with transparent terms and no hidden fees.' },
  { icon: 'Brain',        title: 'AI Trading Software — 90% Accuracy', body: 'Our proprietary AI engine analyses thousands of market signals per second, achieving a verified 90% accuracy rate across forex and crypto pairs.' },
  { icon: 'ShieldPlus',   title: 'Insured Trading',                   body: 'All positions carry built-in trade insurance. Your capital is safeguarded with multi-layer protection — cold storage, encryption, and smart-contract coverage.' },
  { icon: 'Gauge',        title: 'Risk Management',                   body: 'Advanced risk controls including adjustable leverage (up to 1:500), stop-loss automation, margin-call alerts, and real-time exposure monitoring.' },
  { icon: 'TrendingDown', title: 'Loss Protection',                   body: 'Smart stop-out mechanisms, hedging tools, and AI-driven drawdown limits ensure your losses are minimised even in the most volatile market conditions.' },
] as const;

export const HOW_IT_WORKS = [
  { n: '1', title: 'Create Free Account', body: 'Sign up in under three minutes and claim your $200 welcome bonus on first deposit. Verification completed within 24 hours.' },
  { n: '2', title: 'Choose Your Plan',    body: 'Select the investment tier that matches your goals — Starter, Growth, Premium, or Elite. Upgrade anytime as you scale.' },
  { n: '3', title: 'Fund Your Wallet',    body: 'Deposit via crypto, bank transfer, or card. Funds are credited instantly and held in fully insured cold-storage wallets.' },
  { n: '4', title: 'Watch Profits Grow',  body: 'Our AI engine takes over from there — executing trades, rebalancing your portfolio, and generating returns 24/7.' },
] as const;

export const STATS = [
  { value: '90%',     label: 'Profitable Trades' },
  { value: '50,000+', label: 'Active Traders Worldwide' },
  { value: 'Upto 7%', label: 'Monthly Return' },
  { value: '24/7',    label: 'Automated Trading, Always On' },
] as const;

/**
 * Investor portraits — curated randomuser.me IDs, one per testimonial.
 *
 * Each `avatar` URL is a stable portrait that's been hand-picked to
 * approximately match the name + country combination, so an Indian name
 * gets a South-Asian-looking face, a Nigerian name gets a sub-Saharan
 * African face, etc. (Best-effort — randomuser.me doesn't expose an
 * ethnicity filter so swap any portrait that lands wrong.)
 *
 * To replace with real client-branded photos: drop the file at
 * /public/images/testimonials/<slug>.webp and update the URL here.
 * Testimonials.tsx falls back to initials if the image fails to load.
 */
export const TESTIMONIALS = [
  { name: 'Aarav Sharma',   role: 'India',                avatar: 'https://randomuser.me/api/portraits/men/40.jpg',   quote: 'The interface is clean and easy to navigate.' },
  { name: 'Maria Lopez',    role: 'Spain',                avatar: 'https://randomuser.me/api/portraits/women/44.jpg', quote: 'Account setup was straightforward and quick.' },
  { name: 'Hiroshi Tanaka', role: 'Japan',                avatar: 'https://randomuser.me/api/portraits/men/47.jpg',   quote: 'I like how simple the trading dashboard feels.' },
  { name: 'Sofia Müller',   role: 'Germany',              avatar: 'https://randomuser.me/api/portraits/women/22.jpg', quote: 'The platform performance has been smooth so far.' },
  { name: 'Liam O\'Connor', role: 'Ireland',              avatar: 'https://randomuser.me/api/portraits/men/12.jpg',   quote: 'Good mobile experience and responsive layout.' },
  { name: 'Priya Iyer',     role: 'India',                avatar: 'https://randomuser.me/api/portraits/women/65.jpg', quote: 'Transactions appeared quickly in the dashboard.' },
  { name: 'Tunde Okafor',   role: 'Nigeria',              avatar: 'https://randomuser.me/api/portraits/men/16.jpg',   quote: 'Customer support replied within a reasonable time.' },
  { name: 'Emma Wilson',    role: 'United Kingdom',       avatar: 'https://randomuser.me/api/portraits/women/8.jpg',  quote: 'The verification process was simple to complete.' },
  { name: 'Daniel Roberts', role: 'Canada',               avatar: 'https://randomuser.me/api/portraits/men/77.jpg',   quote: 'Professional interface with a strong focus on usability.' },
  { name: 'Aisha Khan',     role: 'United Arab Emirates', avatar: 'https://randomuser.me/api/portraits/women/49.jpg', quote: 'Efficient execution and a polished trading environment.' },
  { name: 'Marco Rossi',    role: 'Italy',                avatar: 'https://randomuser.me/api/portraits/men/85.jpg',   quote: 'A modern platform built with simplicity in mind.' },
] as const;

export const FAQ = [
  {
    q: 'What is the minimum deposit required to start trading?',
    a: 'Only $50. A $50 first deposit unlocks the Standard live account or the IB partner account; ECN starts at $200. A free Demo account with $100,000 in virtual funds is also available — no commitment. Every first deposit also receives a 100% Welcome Bonus (up to $200).',
  },
  {
    q: 'How do I get the 100% Welcome Bonus?',
    a: 'The 100% Welcome Bonus is applied automatically to your first qualifying deposit — no promo code required. Deposit $100 → get a $100 bonus; deposit $200 → get a $200 bonus. The bonus is fully tradeable from the moment it lands in your account. See the /bonus page for the full tier breakdown.',
  },
  {
    q: 'Which deposit and withdrawal methods are available, and how long do they take?',
    a: 'We support bank wire transfers, Visa/Mastercard, Skrill, Neteller, and cryptocurrency. Card and e-wallet deposits are typically instant; bank wires and crypto withdrawals usually settle within 1–3 business days.',
  },
  {
    q: 'Which trading platforms and devices are supported?',
    a: 'SwisDex offers a fast web platform accessible from any modern browser, plus dedicated iOS and Android mobile apps. All platforms sync to a single account, so your positions, alerts, and watchlists stay in sync across every device.',
  },
  {
    q: 'What is AI-POWERED STAKING PROGRAM?',
    a: 'AI-POWERED STAKING PROGRAM is a capital-protected investment product where you lock your principal for a defined tenure (Month, Quarter, Half-Year, Year, or 2 Year) and earn a known, AI-POWERED STAKING PROGRAM paid at maturity. Returns scale with deposit size and tenure — from 1% per month on a $1K Monthly plan to 7% on a $50K+ 2-Year plan. Your principal is held in a segregated trust account and returned in full at maturity. See the Products → AI-POWERED STAKING PROGRAM page for the full rate matrix.',
  },
  {
    q: 'How does the Decentralized Exchange work?',
    a: 'SwisDex DEX lets you trade directly from your own wallet with non-custodial, on-chain execution. You keep your private keys, your funds never leave your wallet, and every order is settled through smart contracts — no counterparty risk, no withdrawal queues. Connect MetaMask, WalletConnect, or any EVM-compatible wallet, sign the trade, and the swap clears on-chain in seconds.',
  },
  {
    q: 'How do I insure my trades?',
    a: 'Trade Insurance is built into every position on SwisDex. Each open trade is policy-backed by on-chain insurance up to the policy limit. If the market moves against you beyond the defined threshold, the insured amount is paid out automatically by the smart-contract underwriter. The insurance does not cover market loss within the policy threshold, so always size positions to your own risk tolerance.',
  },
  {
    q: 'How do I apply for the IB program?',
    a: 'Visit Products → IB Referral and fill out the short partner application (name, country, email, phone, and a brief note about your audience). Our partner team reviews and activates accounts within 24 hours. Once approved you receive a unique referral link plus a marketing kit, and you start earning weekly per-lot commissions (up to $7 / lot at Platinum tier) on every trade your referrals place — for life.',
  },
] as const;

export const CTA = {
  headline: 'Ready to Start Your Investment Journey?',
  sub: 'Join SwisDex today and receive a 100% Welcome Bonus on your first deposit.',
  primary: 'Create Free Account',
  secondary: 'How It Works',
  href: SIGNUP_HREF,
  secondaryHref: '/how-it-works',
};

export const FOOTER_QUICK_LINKS = [
  { label: 'Home',         href: '/' },
  { label: 'About Us',     href: '/company/about' },
  { label: 'Markets',      href: '/markets' },
  { label: 'Accounts',     href: '/account-types' },
  { label: 'How it Works', href: '/how-it-works' },
  { label: 'Contact',      href: '/company/contact' },
];

export const FOOTER_SERVICES = [
  { label: 'AI Auto Trading',       href: '/services/ai-auto-trading' },
  { label: 'Portfolio Management',  href: '/services/portfolio-management' },
  { label: 'Market Research',       href: '/services/market-research' },
  { label: 'Educational Resources', href: '/services/education' },
  { label: 'Automated Profit',      href: '/services/automated-profit' },
  { label: 'ICO Investments',       href: '/services/ico-coming-soon' },
];

/* Legal links are now surfaced via the Legal dropdown in NAV_ITEMS.
   FOOTER_LINKS kept empty so we don't double-list the same routes
   on the home-page footer bottom bar. */
export const FOOTER_LINKS: { label: string; href: string }[] = [
  // intentionally empty — legal nav now lives in the Legal dropdown
];

export const COPYRIGHT = `© ${new Date().getFullYear()} SwisDex. All Rights Reserved. · Founded in 2010`;

export const RISK_DISCLAIMER =
  'Trading cryptocurrencies and forex involves significant risk. Past performance is not indicative of future results. Invest only what you can afford to lose.';
