'use client';

import { motion } from 'motion/react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { useRef } from 'react';
import { BubbleText } from '../ui/BubbleText';
import { Button } from '../ui/Button';
import { TypewriterText } from './TypewriterText';
import { LiveTickerBar } from './LiveTickerBar';
import LineWaves from './LineWaves';
import { HERO } from '../data';

export function Hero() {
  const heroRef = useRef<HTMLElement>(null);
  return (
    <section ref={heroRef} className="relative h-screen bg-background">
      <div className="relative h-screen w-full overflow-hidden">
        {/* Animated WebGL shader background */}
        <div
          className="absolute inset-0 z-[1]"
          style={{ background: '#000', minHeight: '400px', opacity: 0.55 }}
          aria-hidden
        >
          <LineWaves
            speed={0.3}
            innerLineCount={32}
            outerLineCount={36}
            warpIntensity={1}
            rotation={-45}
            edgeFadeWidth={0}
            colorCycleSpeed={1.4}
            brightness={0.22}
            color1="#d00000"
            color2="#55a630"
            color3="#ffffff"
            enableMouseInteraction
            mouseInfluence={2}
          />
        </div>

        <p className="sr-only">
          SwisDex hero — AI-powered cryptocurrency and forex investment platform.
        </p>

        <div className="absolute inset-0 z-[2] bg-black/30 pointer-events-none" />
        <div className="absolute inset-0 z-[3] bg-[radial-gradient(55%_45%_at_50%_50%,rgba(0,0,0,0.7)_0%,rgba(0,0,0,0.2)_60%,transparent_100%)] pointer-events-none" />
        <div className="absolute bottom-0 inset-x-0 h-[40vh] z-[4] gradient-fade-b pointer-events-none" />

        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-center px-6 pointer-events-none">
          <motion.div
            initial={{ filter: 'blur(10px)', opacity: 0, y: 16 }}
            animate={{ filter: 'blur(0px)', opacity: 1, y: 0 }}
            transition={{ delay: 0.15, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto"
          >
            <h1 className="font-display uppercase text-[clamp(21px,5.8vw,60px)] leading-[1.05] tracking-[-0.02em] text-foreground font-bold px-2 mx-auto whitespace-nowrap">
              <BubbleText text="Trade Smarter Grow Faster" as="span" />
            </h1>
          </motion.div>

          <motion.h3
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.55, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="mt-4 font-display uppercase tracking-[0.18em] text-sm sm:text-lg md:text-xl text-foreground/85 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pointer-events-auto"
          >
            <span>Decentralized Exchange</span>
            <span aria-hidden className="text-primary">:</span>
            <span>Insured Trades</span>
            <span aria-hidden className="text-primary">:</span>
            <span>AI-POWERED STAKING</span>
          </motion.h3>

          <TypewriterText
            text={HERO.sub}
            duration={6}
            holdDuration={5}
            eraseDuration={2.5}
            pauseDuration={1.5}
            startDelay={0.9}
            className="mt-6 font-body text-sm sm:text-base md:text-xl text-foreground/70 max-w-2xl leading-relaxed min-h-[3em]"
          />

          {/* Secondary CTA — primary "Details" button removed per client
              request (the Details link now lives inside the bonus pill below). */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.4, duration: 0.6 }}
            className="mt-8 flex items-center gap-3 flex-wrap justify-center pointer-events-auto"
          >
            <Button variant="heroGlass" asChild>
              <Link href={HERO.ctaSecondaryHref}>{HERO.ctaSecondary}</Link>
            </Button>
          </motion.div>

          {/* Bonus offer pill — moved BELOW the CTAs per client request */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.6, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="mt-8 inline-flex items-center gap-2.5 rounded-full px-3 py-1.5 pointer-events-auto"
            style={{
              background: 'rgba(85,166,48,0.18)',
              border: '1px solid rgba(85,166,48,0.45)',
              backdropFilter: 'blur(8px)',
            }}
          >
            <span className="relative inline-flex items-center justify-center" aria-hidden>
              <span className="absolute size-2 rounded-full bg-primary opacity-75 animate-ping" />
              <span className="relative size-2 rounded-full bg-primary" />
            </span>
            <span className="text-[12px] sm:text-sm font-semibold text-foreground uppercase tracking-[0.14em]">
              100% Bonus on Your First Deposit
            </span>
            <Link
              href="/bonus"
              className="inline-flex items-center gap-1 text-[12px] sm:text-sm font-bold text-primary hover:text-foreground transition-colors uppercase tracking-[0.14em] pl-2 border-l border-primary/40"
            >
              Details
              <ArrowUpRight className="size-3.5" />
            </Link>
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.6, duration: 0.7 }}
          className="absolute bottom-0 inset-x-0 z-20"
        >
          <LiveTickerBar />
        </motion.div>
      </div>
    </section>
  );
}
