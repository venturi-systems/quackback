import { createFileRoute } from '@tanstack/react-router'
import { VenturiSiteHeader } from '@/components/public/shell/venturi-site-header'
import { VenturiSiteFooter } from '@/components/public/shell/venturi-site-footer'
import { sourceCodeUrl } from '@/lib/shared/venturi-identity'

export const Route = createFileRoute('/software-notices')({
  head: () => ({ meta: [{ title: 'Software notices | Venturi Feedback' }] }),
  component: SoftwareNotices,
})

/** Public outside the portal gate so every remote user can access the source offer. */
function SoftwareNotices() {
  const commit = typeof __GIT_COMMIT__ === 'string' ? __GIT_COMMIT__ : null
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <VenturiSiteHeader />
      <main id="main-content" className="portal-shell flex-1 py-10">
        <div className="max-w-3xl space-y-6">
          <h1 className="text-3xl font-semibold">Software notices</h1>
          <p>
            Venturi Feedback includes Quackback, licensed under the GNU Affero General Public
            License, version 3. You can inspect and download the corresponding source for the
            software running this portal, including Venturi modifications, at no charge.
          </p>
          <p>
            <a
              className="inline-flex min-h-11 items-center underline underline-offset-4"
              href={sourceCodeUrl(commit)}
            >
              View the source for this version
            </a>
          </p>
          <p>
            <a
              className="inline-flex min-h-11 items-center underline underline-offset-4"
              href="https://www.gnu.org/licenses/agpl-3.0.html"
            >
              Read the GNU Affero General Public License
            </a>
          </p>
          <p className="text-muted-foreground">
            Copyright and attribution notices are included in the corresponding source.
          </p>
          <a className="inline-flex min-h-11 items-center underline underline-offset-4" href="/">
            Return to the feedback portal
          </a>
        </div>
      </main>
      <VenturiSiteFooter />
    </div>
  )
}
