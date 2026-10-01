# Retained OpenSSL packages

These are unmodified upstream Alpine v3.22 packages for OpenSSL 3.5.9-r0,
retained so the digest-pinned Bun runner builds after Alpine removes an older
package revision from its index. All six packages are signed by Alpine and
verified during installation using the selected base image's trusted keys.
`SHA256SUMS` additionally binds the reviewed bytes. Never use
`--allow-untrusted` or fetch packages during the runner build.

The runner supports Linux amd64 (`x86_64`) and arm64 (`aarch64`). The packages
require only the matching musl SONAME already in the respective pinned base.
The Dockerfile rejects a different Alpine release branch and selects packages
with `apk --print-arch`. It also rejects a base containing newer OpenSSL packages
to prevent downgrading a future security update. The read-only BuildKit mount excludes the archives from
the resulting image layers.

## Provenance and license

Captured on 2026-10-01 from:

- https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/
- https://dl-cdn.alpinelinux.org/alpine/v3.22/main/aarch64/

Each directory supplied `libcrypto3-3.5.9-r0.apk`, `libssl3-3.5.9-r0.apk` and
`openssl-3.5.9-r0.apk`. Their package metadata identifies Alpine source commit
`b6d0d5c5639c0034e9073c39e9ff139e28e71818`:
https://gitlab.alpinelinux.org/alpine/aports/-/tree/b6d0d5c5639c0034e9073c39e9ff139e28e71818/main/openssl

OpenSSL is licensed under Apache-2.0. `LICENSE.txt` is the unmodified upstream
license from https://github.com/openssl/openssl/blob/openssl-3.5.9/LICENSE.txt.

## Updating the retained set

These packages are deliberately fixed, not automatically security-updated.
Dependabot updates the Docker base digest but does not refresh APK files. A base
image or OpenSSL security update must review this directory together with the
Dockerfile; do not infer package freshness from a passing application test.

On VSH or a cloud runner, use the reviewed digest-pinned Bun image to fetch the
new package set into an empty temporary directory mounted at `/packages`. For
each supported architecture, run the following inside that image, replacing
`<architecture>` with `x86_64` or `aarch64` and `<version>` with the reviewed
Alpine revision. `/usr/share/apk/keys` is the base image's installed collection
of Alpine public keys, including the keys for both architectures.

```sh
apk --arch <architecture> --keys-dir /usr/share/apk/keys --no-cache \
  fetch --output /packages/<architecture> libcrypto3 libssl3 openssl
apk --keys-dir /usr/share/apk/keys verify \
  /packages/<architecture>/libcrypto3-<version>.apk \
  /packages/<architecture>/libssl3-<version>.apk \
  /packages/<architecture>/openssl-<version>.apk
```

`apk fetch` downloads the current signed package revision. Require the expected
versioned filenames and inspect their `.PKGINFO` before replacing the retained
set. Confirm all dependencies exist in both pinned base images. Replace all
three packages for both architectures together; update the Dockerfile version,
source commit, capture date, license if changed, `SHA256SUMS`, and the expected
versions in the CI runtime smoke check in the same PR.
Generate the manifest from `docker/openssl` with:

```sh
sha256sum x86_64/*.apk aarch64/*.apk > SHA256SUMS
```

Exercise the network-disabled package layer with:

```sh
docker build --target runner-base -f apps/web/Dockerfile .
```

The CI runner-package matrix executes this exact target natively on amd64 and
arm64 when its inputs change; its result is required by `portability-gate`. The
existing signed-in render job builds the complete image. The Docker publication
matrix also builds the complete image on both native architectures. No scheduled
job or package source is introduced.
