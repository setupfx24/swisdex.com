import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Suspense } from 'react';
import { Toaster } from 'react-hot-toast';
import { ThemeProvider } from '@/components/ThemeProvider';
import NumberInputWheelGuard from '@/components/util/NumberInputWheelGuard';
import MobileBottomNav from '@/components/layout/MobileBottomNav';
import { AuthProvider } from '@/components/providers/AuthProvider';
import GoogleAuthProvider from '@/components/providers/GoogleAuthProvider';
import NotificationListener from '@/components/NotificationListener';
import ProfileCompleteGate from '@/components/profile/ProfileCompleteGate';
import TopLoader from '@/components/TopLoader';
import GoogleTranslate from '@/components/GoogleTranslate';
import SplashScreen from '@/components/SplashScreen';
import { CookieConsent } from '@/swisdex/components/CookieConsent';

export const metadata: Metadata = {
  title: 'SwisDex',
  description: 'SwisDex — professional forex and CFD trading platform',
  /* Favicons are served via Next.js file conventions:
     src/app/icon.png and src/app/apple-icon.png. Adding manual
     metadata.icons here would override that — leave them out. */
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var L='swisdex-ui',N='swisdex-ui';var o=localStorage.getItem(L),n=localStorage.getItem(N);if(o&&!n){localStorage.setItem(N,o);localStorage.removeItem(L);}var s=localStorage.getItem(N);var t='dark';if(s){var j=JSON.parse(s);t=(j&&j.state&&j.state.theme)||(j&&j.theme)||'dark';}var d=document.documentElement;d.setAttribute('data-theme',t);d.classList.add(t==='light'?'theme-light':'theme-dark');if(t==='light'){d.style.backgroundColor='#ffffff';d.style.color='#111827';}else{d.style.backgroundColor='#0a0a0a';d.style.color='#ffffff';}}catch(e){document.documentElement.setAttribute('data-theme','light');document.documentElement.style.backgroundColor='#ffffff';document.documentElement.style.color='#111827';}})();`,
          }}
        />

      </head>
      <body className="min-h-full" suppressHydrationWarning>
        {/* Branded splash — full-page logo overlay that fades on first paint
            of every full page load / refresh. Client component; auto-unmounts
            after ~650 ms so it never blocks clicks. */}
        <SplashScreen />
        {/* GDPR-style cookie banner + settings modal. Shows once on first
            visit; preferences persist in localStorage. Re-open the modal
            via openCookieSettings() exported from the same component. */}
        <CookieConsent />
        {/* Google Translate — loaded client-side after hydration to avoid DOM mismatch */}
        <GoogleTranslate />
        <Suspense fallback={null}>
          <TopLoader />
        </Suspense>
        <ThemeProvider>
          <AuthProvider>
            <GoogleAuthProvider>
            <NotificationListener />
            <ProfileCompleteGate />
            <NumberInputWheelGuard />
            {children}
            <Suspense fallback={null}>
              <MobileBottomNav />
            </Suspense>
            <Toaster
              position="top-center"
              containerClassName="swisdex-toaster"
              gutter={10}
              // Drop the stack below the sticky app header (~64px) so toasts
              // don't overlap the Bonus / Affiliates / wallet pills up top.
              containerStyle={{ top: 76, zIndex: 99999 }}
              toastOptions={{
                duration: 2500,
                className: 'swisdex-hot-toast',
                style: {
                  background: 'var(--toast-bg)',
                  color: 'var(--toast-fg)',
                  border: '1px solid var(--toast-border)',
                },
                success: {
                  duration: 2200,
                  className: 'swisdex-hot-toast',
                  // White check on a gold disc reads as "good" instantly on
                  // dark surface without losing the brand accent.
                  iconTheme: { primary: '#55a630', secondary: '#1a1408' },
                },
                error: {
                  duration: 4000,
                  className: 'swisdex-hot-toast',
                  // White X on a saturated red disc — high contrast on the
                  // dark toast background, no fade-out into the BG colour.
                  iconTheme: { primary: '#ef4444', secondary: '#ffffff' },
                },
                loading: {
                  duration: Infinity,
                  className: 'swisdex-hot-toast',
                  iconTheme: { primary: '#55a630', secondary: 'var(--toast-bg)' },
                },
              }}
            />
            </GoogleAuthProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
