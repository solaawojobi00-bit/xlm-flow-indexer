import type { Metadata } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

/**
 * Archivo for structure and prose: a technical grotesque, close enough to DIN to
 * read as instrumentation without tipping into pastiche.
 *
 * IBM Plex Mono for every figure on the page. Its lineage is industrial and
 * enterprise computing, which is the right register for a ledger readout, and
 * fixed advance width is what keeps columns of numbers scannable.
 *
 * Both ship with `next` via next/font, which self-hosts them at build time — no
 * new package, and no request to a font CDN at runtime.
 */
const archivo = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'xlm-flow-indexer — index readout',
  description:
    'Coverage and asset activity from a running Stellar ledger indexer, read from its Postgres database.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
