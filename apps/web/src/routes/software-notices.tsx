import { createFileRoute } from '@tanstack/react-router'
import { PublicPageFrame } from '@/components/public/shell/public-page-frame'
import { sourceCodeUrl } from '@/lib/shared/venturi-identity'

export const Route = createFileRoute('/software-notices')({
  head: () => ({
    meta: [{ title: 'Software notices | Venturi Feedback' }],
    links: [{ rel: 'icon', type: 'image/svg+xml', href: '/venturi-mark.svg' }],
  }),
  component: SoftwareNotices,
})

/** Public outside the portal gate so every remote user can access the source offer. */
function SoftwareNotices() {
  const commit =
    typeof __GIT_COMMIT__ === 'string' && /^[0-9a-f]{7,40}$/.test(__GIT_COMMIT__)
      ? __GIT_COMMIT__
      : null
  return (
    <PublicPageFrame className="software-notices">
      <div className="max-w-3xl space-y-6 [&_p]:text-balance [&_a]:text-balance">
        <h1 className="text-3xl">Software notices</h1>
        {commit && (
          <p className="text-muted-foreground" data-testid="software-version">
            Running version <code>{commit.slice(0, 12)}</code>
          </p>
        )}
        <p>
          Venturi Feedback includes Quackback, licensed under the GNU Affero General Public License,
          version 3. You can inspect and download the corresponding source for the software running
          this portal,{' '}
          <span className="inline-block max-w-full text-balance">
            including Venturi modifications, at no charge.
          </span>
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
    </PublicPageFrame>
  )
}
