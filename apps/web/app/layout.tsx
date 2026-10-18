import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { Providers } from "@/components/providers";
import { parseTheme, themeAttribute, THEME_COOKIE } from "@/lib/theme";

export const metadata: Metadata = {
  title: { default: "Hermes", template: "%s · Hermes" },
  description: "Give Hermes a software idea. A team of AI agents builds, tests and releases it.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const choice = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={themeAttribute(choice)}>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-on-primary"
        >
          Skip to the main content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
