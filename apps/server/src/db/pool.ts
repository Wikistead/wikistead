import postgres from 'postgres'

// Runtime pool — connects as the restricted 'app' role (NOSUPERUSER, NOBYPASSRLS).
// RLS policies apply to every query on this pool. Never use DATABASE_ADMIN_URL here.
export const pool = postgres(process.env.DATABASE_URL!, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
})
