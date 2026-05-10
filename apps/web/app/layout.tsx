import type { ReactNode } from 'react'

export const metadata = {
  title: 'Spleed',
  description: 'AI co-founder for founder-led sales. Lives in your iMessage.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
