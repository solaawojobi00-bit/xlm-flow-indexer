import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'xlm-flow-indexer — index status',
  description: 'Coverage and asset activity from a live xlm-flow-indexer database.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
