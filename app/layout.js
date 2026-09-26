import './globals.css';

export const metadata = {
  title: 'ChatApp',
  description: 'A WhatsApp-style chat app',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
