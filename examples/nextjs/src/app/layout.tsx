export const metadata = { title: "connectd + Next.js" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }}>{children}</body>
    </html>
  );
}
