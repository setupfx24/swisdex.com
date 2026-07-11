import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AI Powered Staking Program | Capital-Protected Yield Plans | SwisDex',
  description: 'Capital-protected, AI powered staking program yield plans for risk-averse investors. 6, 12, or 24 month tenures. From 6.5% to 10% annualised.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
