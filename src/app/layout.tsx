import type { Metadata } from "next";
import "./globals.css";
import DownloadManager from "@/components/DownloadManager";
import SidebarNav from "@/components/SidebarNav";
import UpdatePrompt from "@/components/UpdatePrompt";

export const metadata: Metadata = {
  title: "Universal Freebie | Gaming Launcher",
  description: "Next-generation gaming launcher and high-speed multi-source downloader",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased dark">
      <body className="h-screen overflow-hidden flex bg-[#06070a] text-slate-100 selection:bg-red-500/30 selection:text-white">
        {/* Fixed Left Sidebar */}
        <SidebarNav />

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden ml-[130px]">
          <main className="flex-1 overflow-y-auto flex flex-col relative gaming-grid-bg">
            {children}
          </main>

          {/* Persistent Bottom Floating Download Dock */}
          <DownloadManager />
        </div>
        <UpdatePrompt />
      </body>
    </html>
  );
}
