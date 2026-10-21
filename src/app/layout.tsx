import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "./mobile.css";
import "./readability.css";
import "./workspace.css";

const inter = localFont({
  src: "./fonts/inter.woff2",
  variable: "--font-inter",
  display: "swap",
  weight: "100 900",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#ffffff",
};
export const metadata: Metadata = {
  title: { default: "Mandat — Il tuo Radar appalti", template: "%s · Mandat" },
  description:
    "Le opportunità pubblicate che possono interessare alla tua ditta, in un posto solo.",
  icons: {
    icon: { url: "/favicon.png?v=9122eac4", type: "image/png", sizes: "40x40" },
  },
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
