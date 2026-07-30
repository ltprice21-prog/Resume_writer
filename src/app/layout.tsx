import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Resume Writer",
  description:
    "Paste a job description, get a tailored, ATS-friendly resume PDF built from your master resume.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-black/10 bg-white/70 backdrop-blur dark:border-white/10 dark:bg-white/5">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              Resume Writer
            </Link>
            <nav className="flex gap-5 text-sm text-black/60 dark:text-white/60">
              <Link href="/" className="hover:text-black dark:hover:text-white">
                Tailor
              </Link>
              <Link
                href="/master"
                className="hover:text-black dark:hover:text-white"
              >
                Master resume
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
