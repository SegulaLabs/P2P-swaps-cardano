import type { Metadata } from "next";
import Link from "next/link";
import { NetworkBadge } from "@/components/NetworkBadge";
import { WalletConnect } from "@/components/WalletConnect";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Beacon DEX — P2P trading on Cardano preprod",
  description:
    "Non-custodial P2P order-book trading on Cardano preprod — beacon-token protocol MVP",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="site-header">
            <nav className="nav">
              <Link href="/" className="brand">
                <span className="brand-dot" />
                Beacon DEX
              </Link>
              <Link href="/">Trade</Link>
              <Link href="/arbitrage">Arbitrage</Link>
              <Link href="/orders">My orders</Link>
            </nav>
            <div className="header-right">
              <NetworkBadge />
              <Link href="/settings" className="icon-btn settings-btn" title="Settings" aria-label="Settings">
                ⚙
              </Link>
              <WalletConnect />
            </div>
          </header>
          <main className="main">{children}</main>
          <footer className="site-footer">
            Beacon DEX v{process.env.NEXT_PUBLIC_APP_VERSION} —
            Experimental MVP — Cardano <strong>preprod only</strong>, not
            audited, never use mainnet funds. Non-custodial: your wallet signs
            everything; the backend never sees a key. Settlement rules are
            enforced by the on-chain validators, not by this website.
          </footer>
        </Providers>
      </body>
    </html>
  );
}
