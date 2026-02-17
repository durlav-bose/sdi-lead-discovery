import "./globals.css";

export const metadata = {
  title: "SDI Lead Discovery",
  description: "Local dev pipeline for lead discovery"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
