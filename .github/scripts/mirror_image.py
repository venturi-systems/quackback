#!/usr/bin/env python3
"""Verify an existing signed image and mirror its unchanged index to ECR."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SOURCE = "ghcr.io/venturi-systems/quackback"
SOURCE_URL = "https://github.com/venturi-systems/quackback"
SIGNER = SOURCE_URL + "/.github/workflows/docker.yml@refs/heads/main"
ISSUER = "https://token.actions.githubusercontent.com"
ROLE_NAME = "venturi-feedback-image-publisher"
REPOSITORY = "venturi/quackback"
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def inputs(env: dict[str, str]) -> dict[str, str]:
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Manual dispatch required")
    require(env.get("GITHUB_REPOSITORY") == "venturi-systems/quackback", "Wrong repository")
    require(env.get("GITHUB_REF") == "refs/heads/main", "Protected main branch required")
    sha, digest = env.get("INPUT_SHA", ""), env.get("INPUT_DIGEST", "")
    role, region = env.get("INPUT_ROLE_ARN", ""), env.get("INPUT_AWS_REGION", "")
    require(re.fullmatch(r"[0-9a-f]{40}", sha) is not None, "Full lowercase source SHA required")
    require(DIGEST.fullmatch(digest) is not None, "Immutable SHA-256 image digest required")
    match = re.fullmatch(r"arn:aws:iam::([0-9]{12}):role/" + ROLE_NAME, role)
    require(match is not None, "Unexpected mirror role ARN")
    require(re.fullmatch(r"[a-z]{2}-[a-z]+-[1-9][0-9]*", region) is not None, "Invalid commercial AWS region")
    require(env.get("INPUT_PUBLISH") in {"true", "false"}, "Explicit publish mode required")
    account = match.group(1)
    registry = f"{account}.dkr.ecr.{region}.amazonaws.com"
    return {
        "source_sha": sha, "source_digest": digest, "role_arn": role,
        "aws_region": region, "account_id": account, "registry": registry,
        "image_tag": "sha-" + sha[:7], "destination": registry + "/" + REPOSITORY,
        "publish": env["INPUT_PUBLISH"],
    }


def run(args: list[str], *, data: bytes | None = None, check: bool = True, timeout: int = 120):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout, check=False)
    if check and result.returncode:
        # Authentication responses and credential-bearing command output are never logged.
        raise RuntimeError(f"{args[0]} {args[1]} failed with exit {result.returncode}")
    return result


def guard_source(plan: dict[str, str], runner=run) -> None:
    sha = plan["source_sha"]
    runner(["git", "cat-file", "-e", sha + "^{commit}"])
    runner(["git", "merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"])


def inspect_image(image: str, plan: dict[str, str], runner=run) -> dict:
    raw = runner(["skopeo", "inspect", "--raw", "docker://" + image + "@" + plan["source_digest"]]).stdout
    require("sha256:" + hashlib.sha256(raw).hexdigest() == plan["source_digest"], "Registry index digest changed")
    document = json.loads(raw)
    require(document.get("mediaType") in INDEX_TYPES, "A complete multi-architecture index is required")
    children = document.get("manifests", [])
    require(isinstance(children, list) and 2 <= len(children) <= 32, "Invalid index manifest count")
    platforms = []
    for child in children:
        digest = child.get("digest", "")
        require(DIGEST.fullmatch(digest) is not None, "Invalid child digest")
        platform = child.get("platform", {})
        os_name, architecture = platform.get("os"), platform.get("architecture")
        if (os_name, architecture) == ("unknown", "unknown"):
            require(child.get("annotations", {}).get("vnd.docker.reference.type") == "attestation-manifest",
                    "Unknown platform is not a build attestation")
            continue
        require(os_name == "linux" and architecture in {"amd64", "arm64"}, "Unexpected runnable platform")
        require(architecture not in platforms, "Duplicate runnable platform")
        config = json.loads(runner(["skopeo", "inspect", "--config", "docker://" + image + "@" + digest]).stdout)
        require(config.get("os") == os_name and config.get("architecture") == architecture, "Platform/config mismatch")
        labels = config.get("config", {}).get("Labels", {})
        expected = {
            "org.opencontainers.image.source": SOURCE_URL,
            "org.opencontainers.image.url": SOURCE_URL,
            "org.opencontainers.image.revision": plan["source_sha"],
            "org.opencontainers.image.version": plan["image_tag"],
        }
        require(all(labels.get(key) == value for key, value in expected.items()), "Image/source provenance mismatch")
        platforms.append(architecture)
    require(set(platforms) == {"amd64", "arm64"}, "Both published Linux architectures are required")
    return {"digest": plan["source_digest"], "platforms": sorted(platforms), "manifest_count": len(children)}


def verify(plan: dict[str, str], directory: Path, runner=run) -> dict:
    guard_source(plan, runner)
    signatures = json.loads(runner([
        "cosign", "verify", "--certificate-identity", SIGNER,
        "--certificate-oidc-issuer", ISSUER, SOURCE + "@" + plan["source_digest"],
    ]).stdout)
    require(isinstance(signatures, list) and len(signatures) > 0, "No verified signatures")
    require(all(s.get("critical", {}).get("image", {}).get("docker-manifest-digest") == plan["source_digest"]
                for s in signatures), "Signature digest mismatch")
    index = inspect_image(SOURCE, plan, runner)
    evidence = {**plan, **index, "signer": SIGNER, "issuer": ISSUER, "source_verified": True, "mirrored": False}
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "verified-signatures.json").write_text(json.dumps(signatures, indent=2) + "\n")
    (directory / "mirror-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    return evidence


def aws(plan: dict[str, str], *args: str) -> list[str]:
    return ["aws", "--region", plan["aws_region"], *args, "--output", "json", "--no-cli-pager"]


def existing_digest(plan: dict[str, str], runner=run) -> str | None:
    result = runner(aws(plan, "ecr", "describe-images", "--registry-id", plan["account_id"],
                        "--repository-name", REPOSITORY, "--image-ids", "imageTag=" + plan["image_tag"]), check=False)
    if result.returncode:
        if b"(ImageNotFoundException)" in result.stderr:
            return None
        raise RuntimeError("ECR tag inspection failed; no copy attempted")
    details = json.loads(result.stdout).get("imageDetails", [])
    require(len(details) == 1, "Unexpected ECR tag inspection result")
    digest = details[0].get("imageDigest", "")
    require(DIGEST.fullmatch(digest) is not None, "Invalid ECR image digest")
    return digest


def publish(plan: dict[str, str], directory: Path, authfile: str, runner=run) -> dict:
    require(plan["publish"] == "true", "Publish was not explicitly requested")
    evidence = json.loads((directory / "mirror-evidence.json").read_text())
    require(evidence.get("source_verified") is True and all(evidence.get(key) == value for key, value in plan.items()),
            "Publication must match the verified plan")
    caller = json.loads(runner(aws(plan, "sts", "get-caller-identity")).stdout)
    require(caller.get("Account") == plan["account_id"], "STS account mismatch")
    require(re.fullmatch("arn:aws:sts::" + plan["account_id"] + ":assumed-role/" + ROLE_NAME + r"/[A-Za-z0-9_+=,.@-]+",
                         caller.get("Arn", "")) is not None, "STS role mismatch")
    repos = json.loads(runner(aws(plan, "ecr", "describe-repositories", "--registry-id", plan["account_id"],
                                  "--repository-names", REPOSITORY)).stdout).get("repositories", [])
    require(len(repos) == 1 and repos[0].get("repositoryUri") == plan["destination"]
            and repos[0].get("registryId") == plan["account_id"]
            and repos[0].get("imageTagMutability") == "IMMUTABLE"
            and not repos[0].get("imageTagMutabilityExclusionFilters"), "Exact immutable ECR repository required")
    previous = existing_digest(plan, runner)
    require(previous in {None, plan["source_digest"]}, "Immutable destination tag already names a different digest")
    # Password is passed only through a pipe, never through process arguments or logs.
    password = runner(["aws", "--region", plan["aws_region"], "ecr", "get-login-password", "--no-cli-pager"]).stdout
    runner(["skopeo", "login", "--authfile", authfile, "--username", "AWS", "--password-stdin", plan["registry"]], data=password)
    if previous is None:
        try:
            copied = runner(["skopeo", "copy", "--all", "--preserve-digests", "--retry-times", "2",
                             "--authfile", authfile, "docker://" + SOURCE + "@" + plan["source_digest"],
                             "docker://" + plan["destination"] + ":" + plan["image_tag"]], check=False, timeout=600)
            uncertain_response = copied.returncode != 0
        except subprocess.TimeoutExpired:
            # The subprocess is stopped, but the registry may have committed its tag.
            uncertain_response = True
        # A lost response after the immutable tag was committed is recoverable by readback.
        observed = existing_digest(plan, runner)
        require(observed == plan["source_digest"], "Mirror did not produce the exact verified index")
        if uncertain_response:
            evidence["copy_response_recovered"] = True
    else:
        evidence["already_present"] = True
    inspect_image(plan["destination"], plan, runner)
    evidence["mirrored"] = True
    (directory / "mirror-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    return evidence


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    require(mode in {"guard", "verify", "publish"}, "Expected guard, verify, or publish")
    plan = inputs(dict(os.environ))
    if mode == "guard":
        guard_source(plan)
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
            output.write("account_id=" + plan["account_id"] + "\n")
        return
    directory = Path(os.environ["MIRROR_EVIDENCE_DIR"])
    evidence = verify(plan, directory) if mode == "verify" else publish(plan, directory, os.environ["REGISTRY_AUTH_FILE"])
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as summary:
        summary.write(f"Image source: {SOURCE}@{plan['source_digest']}\n\n"
                      f"Source commit: {plan['source_sha']}\n\n"
                      f"Target: {plan['destination']}:{plan['image_tag']}\n\n"
                      f"Verified amd64 + arm64 index; mirrored: {evidence['mirrored']}.\n\n"
                      "No image was rebuilt or deployed. Source Sigstore verification and unchanged digest are recorded in the artifact.\n")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"Image mirror refused: {error}", file=sys.stderr)
        sys.exit(1)
