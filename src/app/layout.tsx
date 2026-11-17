import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LegCo Monitor · 香港立法會會議、文件及質詢監察",
  description:
    "Real-time monitoring dashboard for HK LegCo meetings, agenda diffs, hidden submissions, documents, and 質詢.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-HK">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
