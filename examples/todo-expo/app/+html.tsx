import { ScrollViewStyleReset, useServerDocumentContext } from 'expo-router/html'

// MARK: - Root HTML

/** Configures the root HTML document Expo Router renders for every web page, including the tab title and favicons; native builds never read this file. */
export default function Root({ children }: { children: React.ReactNode }) {
  const { bodyAttributes, bodyNodes, htmlAttributes, headNodes } = useServerDocumentContext()

  return (
    <html lang="en" {...htmlAttributes}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />
        <title>Todo example (Expo) · Kizuna Sync</title>
        <link rel="icon" type="image/svg+xml" href="/favicon-light.svg" media="(prefers-color-scheme: light)" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" media="(prefers-color-scheme: dark)" />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-light-32.png"
          media="(prefers-color-scheme: light)"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-dark-32.png"
          media="(prefers-color-scheme: dark)"
        />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <ScrollViewStyleReset />
        {headNodes}
      </head>
      <body {...bodyAttributes}>
        {children}
        {bodyNodes}
      </body>
    </html>
  )
}
