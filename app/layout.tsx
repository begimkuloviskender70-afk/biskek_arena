import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bishkek Arena — твоя команда, твой город",
  description: "Собери команду CS2, найди соперника в Бишкеке и договорись о матче.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
