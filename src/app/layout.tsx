import type { Metadata } from "next";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/manrope";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "Mandat — Il tuo Radar appalti", template: "%s · Mandat" },
  description:
    "Le opportunità pubblicate che possono interessare alla tua ditta, in un posto solo.",
  icons: {
    icon: { url: "/favicon.png", type: "image/png", sizes: "40x40" },
  },
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
