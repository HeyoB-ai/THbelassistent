import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Personeelsaantal doorgeven",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl">
      <body>{children}</body>
    </html>
  );
}
