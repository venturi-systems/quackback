/**
 * Anonymous users are created by the Better Auth anonymous plugin, which
 * requires a unique non-null email per user and so mints a synthetic
 * placeholder ("temp-<id>@anon.quackback.io"). That address is never real — it
 * must never be displayed, emailed, returned via the API, or counted as the
 * user "having an email". Treat it as null everywhere it surfaces.
 *
 * ANON_EMAIL_DOMAIN / isSyntheticAnonEmail are owned by @quackback/email (the
 * transport guards against delivering there); re-exported here so the auth
 * plugin config and realEmail() share that single definition.
 */
import { ANON_EMAIL_DOMAIN, isSyntheticAnonEmail } from '@quackback/email/anon'

export { ANON_EMAIL_DOMAIN, isSyntheticAnonEmail }

/** The email if it's a real (deliverable) address, otherwise null. */
export function realEmail(email: string | null | undefined): string | null {
  return !email || isSyntheticAnonEmail(email) ? null : email
}
