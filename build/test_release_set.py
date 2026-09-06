#!/usr/bin/env python3
"""Contract tests for the source-owned release-set manifest."""

import copy
import json
import os
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

from release_set import (
    ReleaseSetError,
    canonical_json,
    committed_variant_paths,
    create_release_set,
    derive_target_id,
    inspect_release_set,
    invoke_target_build,
    main,
    resolve_public_target,
    validate_public_manifest,
    verify_manifest,
)

REVISION_A = "a" * 40
REVISION_B = "b" * 40


def target_seed(offset: int) -> str:
    return bytes((offset + index) % 256 for index in range(32)).hex()


def write_variant(
    directory: Path,
    variant: str,
    domain: str | None,
    product_lock: int,
    seed: str,
) -> Path:
    path = directory / f"{variant}.json"
    path.write_text(
        json.dumps(
            {
                "variant": variant,
                "domain": domain,
                "product_lock": product_lock,
                "description": f"Private description for {variant}",
                "target_seed": seed,
            }
        ),
        encoding="utf-8",
    )
    return path


def fixture_variants(directory: Path) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    return [
        write_variant(directory, "p0", None, 0, target_seed(0)),
        write_variant(directory, "p1", "pdfstart.com", 1, target_seed(32)),
        write_variant(directory, "p2", "xiaopdf.com", 1, target_seed(64)),
    ]


def assert_raises(expected: type[BaseException], callback: object) -> None:
    try:
        callback()  # type: ignore[operator]
    except expected:
        return
    raise AssertionError(f"expected {expected.__name__}")


def test_manifest_is_deterministic_and_public_safe() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        paths = fixture_variants(root / "variants")
        first = create_release_set(root, REVISION_A, variant_paths=paths)
        second = create_release_set(root, REVISION_A, variant_paths=list(reversed(paths)))

        assert canonical_json(first.manifest) == canonical_json(second.manifest)
        assert first.manifest["schema_version"] == 1
        assert first.manifest["source_revision"] == REVISION_A
        targets = first.manifest["targets"]
        assert isinstance(targets, list)
        assert [target["target_id"] for target in targets] == sorted(
            target["target_id"] for target in targets
        )
        assert sorted(target["build_role"] for target in targets) == [
            "dev",
            "prod",
            "prod",
        ]
        assert all(
            target["outputs"]
            == ["leptonica.wasm", "leptonica.mjs", "build-info.json"]
            for target in targets
        )

        public_json = canonical_json(first.manifest)
        private_markers = [
            "p0",
            "p1",
            "p2",
            "pdfstart.com",
            "xiaopdf.com",
            "product_lock",
            "target_seed",
            "variant",
            *[target_seed(offset) for offset in (0, 32, 64)],
        ]
        for marker in private_markers:
            assert marker not in public_json


def test_identity_changes_with_revision_and_seed() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        paths = fixture_variants(root / "variants")
        original = create_release_set(root, REVISION_A, variant_paths=paths)
        new_revision = create_release_set(root, REVISION_B, variant_paths=paths)
        assert original.manifest["release_id"] != new_revision.manifest["release_id"]
        assert set(original.private_targets) != set(new_revision.private_targets)

        write_variant(paths[1].parent, "p1", "pdfstart.com", 1, target_seed(96))
        rotated = create_release_set(root, REVISION_A, variant_paths=paths)
        assert original.manifest["release_id"] != rotated.manifest["release_id"]
        assert set(original.private_targets) != set(rotated.private_targets)


def test_release_membership_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        variants = root / "variants"
        variants.mkdir()
        duplicate_seed = [
            write_variant(variants, "p0", None, 0, target_seed(0)),
            write_variant(variants, "p1", "pdfstart.com", 1, target_seed(0)),
        ]
        assert_raises(
            ReleaseSetError,
            lambda: create_release_set(root, REVISION_A, variant_paths=duplicate_seed),
        )

        only_dev = [write_variant(variants, "p0", None, 0, target_seed(1))]
        assert_raises(
            ReleaseSetError,
            lambda: create_release_set(root, REVISION_A, variant_paths=only_dev),
        )

        only_prod = [
            write_variant(variants, "p1", "pdfstart.com", 1, target_seed(2))
        ]
        assert_raises(
            ReleaseSetError,
            lambda: create_release_set(root, REVISION_A, variant_paths=only_prod),
        )


def test_manifest_validation_and_lookup_fail_closed() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        release_set = create_release_set(
            root, REVISION_A, variant_paths=fixture_variants(root / "variants")
        )
        release_id = str(release_set.manifest["release_id"])
        target_id = next(iter(release_set.private_targets))

        verify_manifest(
            copy.deepcopy(release_set.manifest),
            release_set,
            release_id=release_id,
            target_id=target_id,
        )
        resolve_public_target(release_set, release_id, target_id)
        assert_raises(
            ReleaseSetError,
            lambda: resolve_public_target(
                release_set, "release-v1-" + "0" * 64, target_id
            ),
        )
        assert_raises(
            ReleaseSetError,
            lambda: resolve_public_target(
                release_set, release_id, "target-v1-" + "0" * 64
            ),
        )

        forbidden = copy.deepcopy(release_set.manifest)
        forbidden["targets"][0]["domain"] = "example.com"  # type: ignore[index]
        assert_raises(ReleaseSetError, lambda: validate_public_manifest(forbidden))

        repository_leak = copy.deepcopy(release_set.manifest)
        repository_leak["source_repository"] = "private-owner/private-source"
        assert_raises(
            ReleaseSetError, lambda: validate_public_manifest(repository_leak)
        )

        duplicate = copy.deepcopy(release_set.manifest)
        duplicate["targets"].append(  # type: ignore[union-attr]
            copy.deepcopy(duplicate["targets"][0])  # type: ignore[index]
        )
        assert_raises(ReleaseSetError, lambda: validate_public_manifest(duplicate))

        inconsistent = copy.deepcopy(release_set.manifest)
        inconsistent["source_revision"] = REVISION_B
        assert_raises(ReleaseSetError, lambda: validate_public_manifest(inconsistent))


def test_only_committed_variant_files_are_discovered() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        variants = root / "variants"
        variants.mkdir()
        tracked = write_variant(variants, "p0", None, 0, target_seed(0))
        write_variant(variants, "p1", "pdfstart.com", 1, target_seed(32))
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(["git", "-C", str(root), "add", "variants/p0.json"], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "-c",
                "user.name=Release Set Test",
                "-c",
                "user.email=release-set@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        write_variant(variants, "p2", "xiaopdf.com", 1, target_seed(64))
        assert committed_variant_paths(root) == [tracked]


def test_committed_variant_content_is_revision_pinned() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        variants = root / "variants"
        variants.mkdir()
        committed_seed = target_seed(0)
        write_variant(variants, "p0", None, 0, committed_seed)
        write_variant(variants, "p1", "pdfstart.com", 1, target_seed(32))
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(["git", "-C", str(root), "add", "variants"], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "-c",
                "user.name=Release Set Test",
                "-c",
                "user.email=release-set@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        revision = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

        write_variant(variants, "p0", None, 0, target_seed(64))
        release_set = create_release_set(root, revision)
        assert derive_target_id(revision, committed_seed) in release_set.private_targets


def test_private_inspect_maps_variants_and_historical_revisions() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        variants = root / "variants"
        fixture_variants(variants)
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(["git", "-C", str(root), "add", "variants"], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(root),
                "-c",
                "user.name=Release Set Test",
                "-c",
                "user.email=release-set@example.invalid",
                "commit",
                "-qm",
                "historical fixture",
            ],
            check=True,
        )
        revision = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        release_set = create_release_set(root, revision)
        inspection = inspect_release_set(release_set, variant="p2")
        assert inspection["source_revision"] == revision
        targets = inspection["targets"]
        assert isinstance(targets, list) and len(targets) == 1
        target = targets[0]
        assert target["domain"] == "xiaopdf.com"
        assert target["build_role"] == "prod"
        assert str(target["publication"]["branch"]).startswith("release/target-v1-")  # type: ignore[index]

        output = root / "inspection.json"
        assert (
            main(
                [
                    "--repo-root",
                    str(root),
                    "inspect",
                    "--source-revision",
                    revision,
                    "--target-id",
                    str(target["target_id"]),
                    "--output",
                    str(output),
                ]
            )
            == 0
        )
        assert json.loads(output.read_text(encoding="ascii"))["targets"] == targets


def test_source_workflow_uses_only_public_release_set_inputs() -> None:
    workflow = (
        Path(__file__).resolve().parent.parent / ".github" / "workflows" / "ci.yml"
    ).read_text(encoding="utf-8")
    dispatch = workflow.split("  dispatch-builder:\n", 1)[1]
    assert "github.event_name == 'push'" in dispatch
    assert "github.ref == 'refs/heads/main'" in dispatch
    assert "needs: [release-set, compare]" in dispatch
    assert 'event_type: "source-release-set-v1"' in dispatch
    assert "contract_version: 1" in dispatch
    assert "source_revision: $source_revision" in dispatch
    assert "release_id: $release_id" in dispatch
    assert "manifest: $manifest" in dispatch
    assert "source_repository" not in dispatch
    assert "GITHUB_REPOSITORY" not in dispatch
    assert "BUILD_VARIANT:" not in dispatch
    assert "PRODUCT_LOCK:" not in dispatch


def test_opaque_build_command_resolves_private_selector_internally() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        release_set = create_release_set(
            root, REVISION_A, variant_paths=fixture_variants(root / "variants")
        )
        release_id = str(release_set.manifest["release_id"])
        target_id = next(iter(release_set.private_targets))
        variant = release_set.private_targets[target_id].variant
        captured: dict[str, object] = {}

        def runner(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[object]:
            captured["command"] = command
            captured["environment"] = kwargs["env"]
            return subprocess.CompletedProcess(command, 0)

        with patch.dict(os.environ, {}, clear=True):
            result = invoke_target_build(
                root, release_set, release_id, target_id, runner=runner
            )
        assert result == 0
        assert captured["command"] == [
            "node",
            str(root / "scripts" / "build.mjs"),
            "--variant",
            variant,
        ]
        environment = captured["environment"]
        assert isinstance(environment, dict)
        assert environment["SOURCE_RELEASE_ID"] == release_id
        assert environment["SOURCE_TARGET_ID"] == target_id
        assert environment["SOURCE_REVISION"] == REVISION_A
        assert environment["SOURCE_RELEASE_TARGET"] == "1"
        assert environment["SOURCE_BUILD_ROLE"] in ("dev", "prod")
        assert "BUILD_VARIANT" not in environment
        assert "PRODUCT_LOCK" not in environment

        for forbidden_input in ("BUILD_VARIANT", "PRODUCT_LOCK", "BUILD_TYPE"):
            with patch.dict(os.environ, {forbidden_input: ""}, clear=True):
                assert_raises(
                    ReleaseSetError,
                    lambda: invoke_target_build(
                        root, release_set, release_id, target_id
                    ),
                )


if __name__ == "__main__":
    test_manifest_is_deterministic_and_public_safe()
    test_identity_changes_with_revision_and_seed()
    test_release_membership_fails_closed()
    test_manifest_validation_and_lookup_fail_closed()
    test_only_committed_variant_files_are_discovered()
    test_committed_variant_content_is_revision_pinned()
    test_private_inspect_maps_variants_and_historical_revisions()
    test_source_workflow_uses_only_public_release_set_inputs()
    test_opaque_build_command_resolves_private_selector_internally()
    print("All release-set contract tests passed.")
