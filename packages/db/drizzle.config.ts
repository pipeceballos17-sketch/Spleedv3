import { defineConfig } from 'drizzle-kit'

// drizzle-kit sets cwd to the config file's directory before reading,
// so plain relative paths resolve against packages/db/.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
})
