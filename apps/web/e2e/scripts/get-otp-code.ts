/**
 * CLI: get the most recent live email-OTP sign-in code for an email.
 * Used by e2e tests.
 *
 * Better-auth's emailOTP plugin stores rows in the verification table as
 *   { identifier: 'sign-in-otp-<email>', value: '<code>:<attempts>' }
 * (get-magic-link-token.ts documents and excludes these same rows).
 *
 * Usage: bun get-otp-code.ts <email>
 */
import postgres from 'postgres'

const email = process.argv[2]

if (!email) {
  console.error('Usage: bun get-otp-code.ts <email>')
  process.exit(1)
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required')
  process.exit(1)
}

const sql = postgres(connectionString)

async function getOtpCode(): Promise<string> {
  const result = await sql`
    SELECT value
    FROM verification
    WHERE identifier = ${'sign-in-otp-' + email}
      AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1
  `

  if (result.length === 0) {
    throw new Error(`No live sign-in OTP row found for email: ${email}`)
  }

  // value is '<code>:<attempts>' — the code is the part before the colon
  const code = String(result[0].value).split(':')[0]
  if (!/^\d{6}$/.test(code)) {
    throw new Error(`Unexpected OTP value format for email: ${email}`)
  }

  return code
}

try {
  const code = await getOtpCode()
  console.log(code)
  await sql.end()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  await sql.end()
  process.exit(1)
}
