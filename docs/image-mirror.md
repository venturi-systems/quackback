# Manual Signed Image Mirror

The release owner can dispatch `mirror-image.yml` from protected `main` to copy an existing signed Quackback image index from GHCR to the deployment ECR repository. Feedback's infrastructure repository owns the AWS role, image pin, deployment, and rollback.

| Input        | Meaning                                                    |
| ------------ | ---------------------------------------------------------- |
| `sha`        | Full source commit reachable from protected main           |
| `digest`     | Exact signed GHCR index digest                             |
| `role_arn`   | Reviewed account's `venturi-feedback-image-publisher` role |
| `aws_region` | Reviewed commercial AWS region                             |
| `publish`    | Defaults to false; true authorizes the registry copy       |

The workflow checks the exact main-branch Docker workflow's Sigstore identity, issuer, index digest, and both Linux architecture configs. Source labels must match the requested commit and its `sha-<short>` image version. Tag-triggered signatures require a separately reviewed extension; this workflow accepts images signed by the main-branch workflow.

After verification, publishing obtains a 15-minute AWS role session through GitHub OIDC. Trust must require audience `sts.amazonaws.com` and subject `repo:venturi-systems/quackback:ref:refs/heads/main`. The role needs authorization-token access plus push, pull, DescribeImages, and DescribeRepositories permissions scoped to the existing `venturi/quackback` ECR repository. It needs no application secrets or GitHub App key access. The GitHub token has package read permission only.

The target registry account derives from the validated role ARN, and STS must report the same account and role. The ECR repository must enforce immutable tags. An existing `sha-<short>` tag is accepted only when its digest already matches. Skopeo copies every manifest and preserves digests; the workflow reads back the index and both image configs before reporting success. A lost copy response can succeed only through an exact digest readback.

The artifact records the GHCR signature verification and identical ECR digest. Credentials pass through environment variables or pipes into a private temporary auth file, which cleanup removes. The artifact contains no credential values. No image build or application deployment runs here.

Run the offline failure tests with `python3 -m unittest discover -s .github/scripts -p 'test_mirror_image.py'`. CI includes this check. It covers authority/input rejection, signature and source failures, missing platforms, account mismatch, mutable repositories, tag collisions, denied reads, and uncertain-copy recovery. Live registry mirroring remains a separate release verification step.
