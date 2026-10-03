"""Fault tests for the release boundary; no registry or AWS calls are made."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import subprocess
import unittest

SPEC = importlib.util.spec_from_file_location("mirror_image", Path(__file__).with_name("mirror_image.py"))
mirror = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mirror)


def document():
    return {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [
            {"digest": "sha256:" + digit * 64, "platform": {"os": "linux", "architecture": arch}}
            for digit, arch in [("1", "amd64"), ("2", "arm64")]
        ],
    }


def environment(raw):
    return {
        "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": "venturi-systems/quackback",
        "GITHUB_REF": "refs/heads/main", "INPUT_SHA": "a" * 40,
        "INPUT_DIGEST": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "INPUT_ROLE_ARN": "arn:aws:iam::123456789012:role/venturi-feedback-image-publisher",
        "INPUT_AWS_REGION": "us-west-2", "INPUT_PUBLISH": "true",
    }


class Registry:
    def __init__(self, doc=None):
        self.raw = json.dumps(doc or document()).encode()
        self.plan = mirror.inputs(environment(self.raw))
        self.calls = []
        self.tag_digest = None
        self.copy_exit = 0
        self.copy_timeout = False
        self.copy_commits = True
        self.mutable = False
        self.wrong_account = False
        self.wrong_revision = False
        self.signature_failure = False
        self.image_error = None

    def __call__(self, args, **kwargs):
        self.calls.append((args, kwargs))
        result = SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        if args[0] == "git":
            return result
        if args[0] == "cosign":
            if self.signature_failure:
                raise RuntimeError("Signature verification failed")
            result.stdout = json.dumps([{"critical": {"image": {"docker-manifest-digest": self.plan["source_digest"]}}}]).encode()
        elif args[:3] == ["skopeo", "inspect", "--raw"]:
            result.stdout = self.raw
        elif args[:3] == ["skopeo", "inspect", "--config"]:
            architecture = "amd64" if args[-1].endswith("1" * 64) else "arm64"
            result.stdout = json.dumps({
                "os": "linux", "architecture": architecture, "config": {"Labels": {
                    "org.opencontainers.image.source": mirror.SOURCE_URL,
                    "org.opencontainers.image.url": mirror.SOURCE_URL,
                    "org.opencontainers.image.revision": "b" * 40 if self.wrong_revision else self.plan["source_sha"],
                    "org.opencontainers.image.version": self.plan["image_tag"],
                }},
            }).encode()
        elif "get-caller-identity" in args:
            result.stdout = json.dumps({"Account": "999999999999" if self.wrong_account else self.plan["account_id"],
                "Arn": "arn:aws:sts::123456789012:assumed-role/venturi-feedback-image-publisher/test"}).encode()
        elif "describe-repositories" in args:
            result.stdout = json.dumps({"repositories": [{
                "registryId": self.plan["account_id"], "repositoryUri": self.plan["destination"],
                "imageTagMutability": "MUTABLE" if self.mutable else "IMMUTABLE",
            }]}).encode()
        elif "describe-images" in args:
            if self.image_error or self.tag_digest is None:
                result.returncode = 254
                result.stderr = self.image_error or b"An error occurred (ImageNotFoundException)"
            else:
                result.stdout = json.dumps({"imageDetails": [{"imageDigest": self.tag_digest}]}).encode()
        elif "get-login-password" in args:
            result.stdout = b"ephemeral-test-password"
        elif args[:2] == ["skopeo", "copy"]:
            result.returncode = self.copy_exit
            if self.copy_commits:
                self.tag_digest = self.plan["source_digest"]
            if self.copy_timeout:
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])
        elif args[:2] != ["skopeo", "login"]:
            raise AssertionError(args)
        return result

    def copied(self):
        return [args for args, _ in self.calls if args[:2] == ["skopeo", "copy"]]


class MirrorBoundaryTests(unittest.TestCase):
    def test_dispatch_guards_reject_wrong_authority_and_injection(self):
        raw = json.dumps(document()).encode()
        valid = environment(raw)
        for key, value in [
            ("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REF", "refs/heads/unreviewed"),
            ("GITHUB_REPOSITORY", "other/quackback"), ("INPUT_SHA", "$(touch nope)"),
            ("INPUT_DIGEST", "latest"), ("INPUT_ROLE_ARN", "arn:aws:iam::123456789012:role/Admin"),
            ("INPUT_AWS_REGION", "us-west-2; echo nope"), ("INPUT_PUBLISH", "yes"),
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                mirror.inputs({**valid, key: value})

    def test_signature_and_every_architecture_are_bound_to_source(self):
        registry = Registry()
        with tempfile.TemporaryDirectory() as temporary:
            evidence = mirror.verify(registry.plan, Path(temporary), registry)
            self.assertEqual(evidence["platforms"], ["amd64", "arm64"])
            self.assertFalse(evidence["mirrored"])
            signature_call = next(args for args, _ in registry.calls if args[0] == "cosign")
            self.assertIn(mirror.SIGNER, signature_call)
            self.assertIn(mirror.ISSUER, signature_call)
            self.assertFalse(any(args[0] == "aws" for args, _ in registry.calls))

    def test_bad_signature_or_wrong_revision_cannot_produce_verified_plan(self):
        for flag in ["signature_failure", "wrong_revision"]:
            registry = Registry()
            setattr(registry, flag, True)
            with tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises((ValueError, RuntimeError)):
                    mirror.verify(registry.plan, Path(temporary), registry)
                self.assertFalse((Path(temporary) / "mirror-evidence.json").exists())

    def test_missing_or_unrecognized_platform_is_refused(self):
        for mode in ["missing", "unknown", "duplicate"]:
            doc = document()
            if mode == "missing":
                doc["manifests"] = doc["manifests"][:1]
            elif mode == "unknown":
                doc["manifests"].append({"digest": "sha256:" + "3" * 64, "platform": {"os": "unknown", "architecture": "unknown"}})
            else:
                doc["manifests"].append(copy.deepcopy(doc["manifests"][0]))
            registry = Registry(doc)
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                mirror.inspect_image(mirror.SOURCE, registry.plan, registry)

    def test_index_digest_is_checked_from_actual_bytes(self):
        registry = Registry()
        registry.raw += b" "
        with self.assertRaisesRegex(ValueError, "digest changed"):
            mirror.inspect_image(mirror.SOURCE, registry.plan, registry)

    def test_copy_preserves_all_manifests_and_has_no_credential_arguments_or_artifacts(self):
        registry = Registry()
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            mirror.verify(registry.plan, directory, registry)
            result = mirror.publish(registry.plan, directory, "private-auth.json", registry)
            self.assertTrue(result["mirrored"])
            self.assertEqual(len(registry.copied()), 1)
            self.assertIn("--all", registry.copied()[0])
            self.assertIn("--preserve-digests", registry.copied()[0])
            self.assertNotIn("ephemeral-test-password", json.dumps(registry.copied()))
            self.assertNotIn("ephemeral-test-password", (directory / "mirror-evidence.json").read_text())
            login = next(kwargs for args, kwargs in registry.calls if args[:2] == ["skopeo", "login"])
            self.assertEqual(login["data"], b"ephemeral-test-password")

    def test_existing_exact_digest_is_an_idempotent_readback(self):
        registry = Registry()
        registry.tag_digest = registry.plan["source_digest"]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            mirror.verify(registry.plan, directory, registry)
            self.assertTrue(mirror.publish(registry.plan, directory, "private-auth.json", registry)["already_present"])
            self.assertFalse(registry.copied())

    def test_wrong_identity_mutable_repository_and_tag_collision_fail_before_copy(self):
        for flag in ["wrong_account", "mutable", "tag_digest"]:
            registry = Registry()
            setattr(registry, flag, "sha256:" + "b" * 64 if flag == "tag_digest" else True)
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                mirror.verify(registry.plan, directory, registry)
                with self.subTest(flag=flag), self.assertRaises(ValueError):
                    mirror.publish(registry.plan, directory, "private-auth.json", registry)
                self.assertFalse(registry.copied())

    def test_unauthorized_tag_lookup_is_not_treated_as_absence(self):
        registry = Registry()
        registry.image_error = b"An error occurred (AccessDeniedException)"
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            mirror.verify(registry.plan, directory, registry)
            with self.assertRaisesRegex(RuntimeError, "inspection failed"):
                mirror.publish(registry.plan, directory, "private-auth.json", registry)
            self.assertFalse(registry.copied())

    def test_lost_copy_response_is_recovered_only_by_exact_readback(self):
        for committed in [True, False]:
            registry = Registry()
            registry.copy_exit, registry.copy_commits = 1, committed
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                mirror.verify(registry.plan, directory, registry)
                if committed:
                    self.assertTrue(mirror.publish(registry.plan, directory, "private-auth.json", registry)["copy_response_recovered"])
                else:
                    with self.assertRaises(ValueError):
                        mirror.publish(registry.plan, directory, "private-auth.json", registry)

    def test_copy_timeout_is_recovered_only_after_verified_destination_readback(self):
        for committed in [True, False]:
            registry = Registry()
            registry.copy_timeout, registry.copy_commits = True, committed
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                mirror.verify(registry.plan, directory, registry)
                if committed:
                    evidence = mirror.publish(registry.plan, directory, "private-auth.json", registry)
                    self.assertTrue(evidence["mirrored"])
                    self.assertTrue(evidence["copy_response_recovered"])
                    reads = [args[-1] for args, _ in registry.calls if args[:2] == ["skopeo", "inspect"]
                             and args[-1].startswith("docker://" + registry.plan["destination"] + "@")]
                    self.assertEqual(len(reads), 3)  # Exact index and both architecture configs.
                else:
                    with self.assertRaisesRegex(ValueError, "exact verified index"):
                        mirror.publish(registry.plan, directory, "private-auth.json", registry)
                    self.assertFalse(json.loads((directory / "mirror-evidence.json").read_text())["mirrored"])
                self.assertEqual(len(registry.copied()), 1)

    def test_changed_plan_and_dry_run_never_copy(self):
        for change in [{"publish": "false"}, {"source_sha": "c" * 40}]:
            registry = Registry()
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                mirror.verify(registry.plan, directory, registry)
                with self.assertRaises(ValueError):
                    mirror.publish({**registry.plan, **change}, directory, "private-auth.json", registry)
                self.assertFalse(registry.copied())


if __name__ == "__main__":
    unittest.main()
