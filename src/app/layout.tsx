import type { Metadata } from "next";
import "./globals.css";
import DownloadManager from "@/components/DownloadManager";
import NavLink from "@/components/NavLink";
import ConsentModal from "@/components/ConsentModal";
import MonitorBadge from "@/components/MonitorBadge";

export const metadata: Metadata = {
  title: "Universal Freebie",
  description: "A sleek game launcher and downloader",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-screen overflow-hidden flex flex-col bg-blue-950 text-slate-100">
        <header className="flex items-center justify-between px-8 py-4 border-b border-white/10 bg-blue-950/50 backdrop-blur-md sticky top-0 z-50 drag-region">
          <div className="flex items-center gap-6">
            <a
              href="/"
              className="text-xl font-bold bg-gradient-to-r from-orange-400 via-yellow-400 to-blue-400 bg-clip-text text-transparent no-drag"
            >
              Universal Freebie
            </a>
            <nav className="flex items-center gap-4 no-drag">
              <NavLink href="/library">Library</NavLink>
              <NavLink href="/games">Download Games</NavLink>
              <NavLink href="/mods">Download Mods</NavLink>
              <a
                href="/settings"
                className="text-sm font-medium text-slate-400 hover:text-white transition-colors ml-4"
                title="Settings"
              >
                ⚙️
              </a>
            </nav>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto flex flex-col relative">
          {children}
        </main>
        <DownloadManager />
        <MonitorBadge />
        <ConsentModal />
      </body>
    </html>
  );
}
