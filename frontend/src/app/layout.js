import { Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppLayout } from "./layoutapp";

const geistMono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata = {
    title: "Squeezarr",
    description: "Self-hosted video transcoding manager",
};

export default function RootLayout({ children }) {
    return (
        <html lang="en" className={`dark h-full ${geistMono.variable}`}>
            <body className="h-full bg-background text-foreground antialiased font-mono overflow-auto">
                <AppLayout>{children}</AppLayout>
            </body>
        </html>
    );
}
