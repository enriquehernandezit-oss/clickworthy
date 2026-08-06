import type { Metadata } from "next";
import { Geist, Geist_Mono, Space_Grotesk, Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Admin console fonts (only applied inside `.console`, so the public site is
// untouched). Defining the CSS vars here loads them once for the whole app.
const spaceGrotesk = Space_Grotesk({ variable: "--font-display", subsets: ["latin"], weight: ["500", "600", "700"] });
const inter = Inter({ variable: "--font-body", subsets: ["latin"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-mono-label", subsets: ["latin"], weight: ["500", "600"] });

export const metadata: Metadata = {
  title: "Clickworthy — Professional Photo Enhancement for Restaurants",
  description:
    "Upload the dish photos you already have and get them back professionally enhanced — ready for your website, Google Business Profile, Instagram, and Yelp. Your real dishes, from $1.80 a photo.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} ${inter.variable} ${plexMono.variable} h-full scroll-smooth antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
