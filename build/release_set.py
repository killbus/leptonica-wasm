#!/usr/bin/env python3
"""Source-owned public release-set projection and opaque target resolver."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from generate_xor import ConfigError, VariantConfig, load_config, parse_config

SCHEMA_VERSION = 1
TRANSPORT_PROFILE = "envelope-v1"
EXPECTED_OUTPUTS = ("leptonica.wasm", "leptonica.mjs", "build-info.json")
SOURCE_REVISION_RE = re.compile(r"[0-9a-f]{40}\Z")
RELEASE_ID_RE = re.compile(r"release-v1-[0-9a-f]{64}\Z")
TARGET_ID_RE = re.compile(r"target-v1-[0-9a-f]{64}\Z")
PUBLIC_MANIFEST_FIELDS = {"schema_version", "release_id", "source_revision", "targets"}
PUBLIC_TARGET_FIELDS = {"target_id", "build_role", "outputs", "transport_profile"}
FORBIDDEN_PUBLIC_FIELDS = {
    "build_variant",
    "customer",
    "description",
    "domain",
    "product_lock",
    "source_repository",
    "target_seed",
    "variant",
}


class ReleaseSetError(ValueError):
    """Raised when a release-set contract is malformed or inconsistent."""


@dataclass(frozen=True)
class ResolvedReleaseSet:
    manifest: dict[str, object]
    private_targets: dict[str, VariantConfig]


def canonical_json(value: object) -> str:
    """Return the schema-v1 canonical JSON encoding used for identities."""
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _sha256_id(prefix: str, domain: bytes, payload: bytes) -> str:
    digest = hashlib.sha256(domain + b"\0" + payload).hexdigest()
    return f"{prefix}{digest}"


def validate_source_revision(source_revision: str) -> None:
    if not SOURCE_REVISION_RE.fullmatch(source_revision):
        raise ReleaseSetError("source_revision must be a lowercase 40-character Git SHA")


def derive_target_id(source_revision: str, target_seed: str) -> str:
    validate_source_revision(source_revision)
    return _sha256_id(
        "target-v1-",
        b"leptonica-release-target-v1",
        source_revision.encode("ascii") + b"\0" + bytes.fromhex(target_seed),
    )


def derive_release_id(public_projection: dict[str, object]) -> str:
    return _sha256_id(
        "release-v1-",
        b"leptonica-release-set-v1",
        canonical_json(public_projection).encode("ascii"),
    )


def _run_git(repo_root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo_root), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise ReleaseSetError("unable to read the pinned source repository state")
    return result.stdout.strip()


def current_source_revision(repo_root: Path) -> str:
    revision = _run_git(repo_root, "rev-parse", "HEAD")
    validate_source_revision(revision)
    return revision


def committed_variant_paths(
    repo_root: Path, source_revision: str = "HEAD"
) -> list[Path]:
    output = _run_git(
        repo_root, "ls-tree", "-r", "--name-only", "-z", source_revision, "--", "variants"
    )
    paths: list[Path] = []
    for relative_text in output.split("\0"):
        if not relative_text:
            continue
        relative = Path(relative_text)
        if relative.parent.as_posix() == "variants" and relative.suffix == ".json":
            paths.append(repo_root / relative)
    paths.sort(key=lambda path: path.name)
    if not paths:
        raise ReleaseSetError("the committed release set contains no variant configs")
    return paths


def _read_committed_variant(
    repo_root: Path, source_revision: str, path: Path
) -> VariantConfig:
    try:
        relative_path = path.relative_to(repo_root).as_posix()
    except ValueError as error:
        raise ReleaseSetError("committed variant path is outside the repository") from error
    result = subprocess.run(
        ["git", "-C", str(repo_root), "show", f"{source_revision}:{relative_path}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise ReleaseSetError("unable to read a committed variant configuration")
    try:
        return parse_config(json.loads(result.stdout), path.stem)
    except (ConfigError, json.JSONDecodeError) as error:
        raise ReleaseSetError("committed variant configuration is invalid") from error


def _validate_private_configs(
    configs: Sequence[VariantConfig],
) -> list[VariantConfig]:
    validated: list[VariantConfig] = []
    seen_variants: set[str] = set()
    seen_seeds: set[str] = set()
    for config in configs:
        if config.variant in seen_variants:
            raise ReleaseSetError("the committed release set contains duplicate variants")
        if config.target_seed in seen_seeds:
            raise ReleaseSetError("the committed release set contains duplicate target seeds")
        seen_variants.add(config.variant)
        seen_seeds.add(config.target_seed)
        validated.append(config)

    dev_count = sum(config.product_lock == 0 for config in validated)
    prod_count = sum(config.product_lock == 1 for config in validated)
    if dev_count != 1:
        raise ReleaseSetError("the release set must contain exactly one dev target")
    if prod_count < 1:
        raise ReleaseSetError("the release set must contain at least one prod target")
    return validated


def _load_committed_private_configs(
    repo_root: Path, source_revision: str, paths: Sequence[Path]
) -> list[VariantConfig]:
    return _validate_private_configs(
        [_read_committed_variant(repo_root, source_revision, path) for path in paths]
    )


def _load_private_configs(paths: Sequence[Path]) -> list[VariantConfig]:
    configs: list[VariantConfig] = []
    for index, path in enumerate(paths, start=1):
        try:
            config = load_config(str(path), path.stem)
        except (ConfigError, json.JSONDecodeError, OSError) as error:
            raise ReleaseSetError(
                f"committed variant configuration {index} is invalid"
            ) from error
        configs.append(config)
    return _validate_private_configs(configs)


def _public_target(source_revision: str, config: VariantConfig) -> dict[str, object]:
    return {
        "target_id": derive_target_id(source_revision, config.target_seed),
        "build_role": "dev" if config.product_lock == 0 else "prod",
        "outputs": list(EXPECTED_OUTPUTS),
        "transport_profile": TRANSPORT_PROFILE,
    }


def create_release_set(
    repo_root: Path,
    source_revision: str,
    *,
    variant_paths: Sequence[Path] | None = None,
) -> ResolvedReleaseSet:
    validate_source_revision(source_revision)
    if variant_paths is None:
        paths = committed_variant_paths(repo_root, source_revision)
        configs = _load_committed_private_configs(repo_root, source_revision, paths)
    else:
        paths = sorted(variant_paths, key=lambda path: path.name)
        configs = _load_private_configs(paths)

    target_pairs = [(_public_target(source_revision, config), config) for config in configs]
    target_pairs.sort(key=lambda pair: str(pair[0]["target_id"]))
    targets = [target for target, _config in target_pairs]
    if len({target["target_id"] for target in targets}) != len(targets):
        raise ReleaseSetError("the committed release set contains duplicate target identities")

    projection: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "source_revision": source_revision,
        "targets": targets,
    }
    manifest = dict(projection)
    manifest["release_id"] = derive_release_id(projection)
    private_targets = {
        str(target["target_id"]): config for target, config in target_pairs
    }
    validate_public_manifest(manifest, configs)
    return ResolvedReleaseSet(manifest=manifest, private_targets=private_targets)


def _walk_public(
    value: object, path: tuple[str, ...] = ()
) -> list[tuple[tuple[str, ...], object]]:
    entries = [(path, value)]
    if isinstance(value, dict):
        for key, child in value.items():
            entries.extend(_walk_public(child, (*path, str(key))))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            entries.extend(_walk_public(child, (*path, str(index))))
    return entries


def validate_public_manifest(
    manifest: object, private_configs: Sequence[VariantConfig] = ()
) -> None:
    if not isinstance(manifest, dict):
        raise ReleaseSetError("public manifest must be a JSON object")
    if set(manifest) != PUBLIC_MANIFEST_FIELDS:
        raise ReleaseSetError("public manifest fields do not match schema version 1")
    if type(manifest.get("schema_version")) is not int:
        raise ReleaseSetError("public manifest schema_version must be an integer")
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ReleaseSetError("unsupported public manifest schema_version")

    source_revision = manifest.get("source_revision")
    release_id = manifest.get("release_id")
    targets = manifest.get("targets")
    if not isinstance(source_revision, str):
        raise ReleaseSetError("public manifest source_revision must be a string")
    validate_source_revision(source_revision)
    if not isinstance(release_id, str) or not RELEASE_ID_RE.fullmatch(release_id):
        raise ReleaseSetError("public manifest release_id is malformed")
    if not isinstance(targets, list) or not targets:
        raise ReleaseSetError("public manifest targets must be a non-empty array")

    target_ids: list[str] = []
    build_roles: list[str] = []
    for target in targets:
        if not isinstance(target, dict) or set(target) != PUBLIC_TARGET_FIELDS:
            raise ReleaseSetError("public target fields do not match schema version 1")
        target_id = target.get("target_id")
        build_role = target.get("build_role")
        if not isinstance(target_id, str) or not TARGET_ID_RE.fullmatch(target_id):
            raise ReleaseSetError("public target_id is malformed")
        if build_role not in ("dev", "prod"):
            raise ReleaseSetError("public target build_role is unsupported")
        if target.get("outputs") != list(EXPECTED_OUTPUTS):
            raise ReleaseSetError("public target outputs do not match the contract")
        if target.get("transport_profile") != TRANSPORT_PROFILE:
            raise ReleaseSetError("public target transport_profile is unsupported")
        target_ids.append(target_id)
        build_roles.append(str(build_role))
    if target_ids != sorted(target_ids):
        raise ReleaseSetError("public targets are not in canonical order")
    if len(set(target_ids)) != len(target_ids):
        raise ReleaseSetError("public manifest contains duplicate targets")
    if build_roles.count("dev") != 1 or build_roles.count("prod") < 1:
        raise ReleaseSetError("public manifest must contain one dev and at least one prod target")

    projection = {key: manifest[key] for key in manifest if key != "release_id"}
    if derive_release_id(projection) != release_id:
        raise ReleaseSetError("public manifest release_id does not match its content")

    forbidden_values = {
        value.casefold()
        for config in private_configs
        for value in (
            config.variant,
            config.domain,
            config.description,
            config.target_seed,
        )
        if isinstance(value, str) and value
    }
    for path, value in _walk_public(manifest):
        if path and path[-1].casefold() in FORBIDDEN_PUBLIC_FIELDS:
            raise ReleaseSetError("public manifest contains a forbidden private field")
        if isinstance(value, str) and value.casefold() in forbidden_values:
            raise ReleaseSetError("public manifest contains a forbidden private value")


def verify_manifest(
    manifest: object,
    expected: ResolvedReleaseSet,
    *,
    release_id: str | None = None,
    target_id: str | None = None,
) -> None:
    validate_public_manifest(manifest, tuple(expected.private_targets.values()))
    if canonical_json(manifest) != canonical_json(expected.manifest):
        raise ReleaseSetError("public manifest does not match the pinned source revision")
    actual_release_id = str(expected.manifest["release_id"])
    if release_id is not None and release_id != actual_release_id:
        raise ReleaseSetError("unknown release_id for the pinned source revision")
    if target_id is not None and target_id not in expected.private_targets:
        raise ReleaseSetError("unknown target_id for the pinned release")


def resolve_public_target(
    release_set: ResolvedReleaseSet, release_id: str, target_id: str
) -> dict[str, object]:
    if release_id != release_set.manifest["release_id"]:
        raise ReleaseSetError("unknown release_id for the pinned source revision")
    if target_id not in release_set.private_targets:
        raise ReleaseSetError("unknown target_id for the pinned release")
    targets = release_set.manifest["targets"]
    assert isinstance(targets, list)
    return next(target for target in targets if target["target_id"] == target_id)


def _publication_identity(
    source_revision: str, target_id: str, build_role: str
) -> dict[str, str]:
    """Return the private publication identity for an operator lookup."""
    source_short = source_revision[:7]
    if build_role == "dev":
        version = f"1.0.0-{source_short}-dev"
        return {
            "branch": "release-dev",
            "tag": f"v{version}",
            "version": version,
        }
    if build_role == "prod":
        target_digest = target_id.removeprefix("target-v1-")
        version = f"1.0.0-{source_short}.{target_digest}"
        return {
            "branch": f"release/{target_id}",
            "tag": f"v{version}",
            "version": version,
        }
    raise ReleaseSetError("unknown build role in private release mapping")


def inspect_release_set(
    release_set: ResolvedReleaseSet,
    *,
    variant: str | None = None,
    target_id: str | None = None,
) -> dict[str, object]:
    """Return the private variant-to-publication projection for operators."""
    if variant is not None and target_id is not None:
        raise ReleaseSetError("inspect accepts either --variant or --target-id")

    source_revision = str(release_set.manifest["source_revision"])
    targets = release_set.manifest["targets"]
    assert isinstance(targets, list)
    mappings: list[dict[str, object]] = []
    for public_target in targets:
        assert isinstance(public_target, dict)
        current_target_id = str(public_target["target_id"])
        config = release_set.private_targets[current_target_id]
        if target_id is not None and current_target_id != target_id:
            continue
        if variant is not None and config.variant != variant:
            continue
        mappings.append(
            {
                "build_role": public_target["build_role"],
                "domain": config.domain,
                "product_lock": config.product_lock,
                "publication": _publication_identity(
                    source_revision,
                    current_target_id,
                    str(public_target["build_role"]),
                ),
                "target_id": current_target_id,
                "variant": config.variant,
            }
        )

    if target_id is not None and target_id not in release_set.private_targets:
        raise ReleaseSetError("unknown target_id for the pinned release")
    if variant is not None and not mappings:
        raise ReleaseSetError("unknown variant for the pinned release")
    return {
        "release_id": release_set.manifest["release_id"],
        "source_revision": source_revision,
        "targets": mappings,
    }


def invoke_target_build(
    repo_root: Path,
    release_set: ResolvedReleaseSet,
    release_id: str,
    target_id: str,
    *,
    runner: Callable[..., subprocess.CompletedProcess[object]] = subprocess.run,
) -> int:
    public_target = resolve_public_target(release_set, release_id, target_id)
    for forbidden_input in ("BUILD_VARIANT", "PRODUCT_LOCK", "BUILD_TYPE"):
        if forbidden_input in os.environ:
            raise ReleaseSetError(
                f"{forbidden_input} is not accepted by the opaque target build command"
            )

    private_config = release_set.private_targets[target_id]
    environment = os.environ.copy()
    environment.update(
        {
            "SOURCE_RELEASE_TARGET": "1",
            "SOURCE_RELEASE_ID": release_id,
            "SOURCE_TARGET_ID": target_id,
            "SOURCE_REVISION": str(release_set.manifest["source_revision"]),
            "SOURCE_BUILD_ROLE": str(public_target["build_role"]),
            "SOURCE_TRANSPORT_PROFILE": str(public_target["transport_profile"]),
        }
    )
    result = runner(
        [
            "node",
            str(repo_root / "scripts" / "build.mjs"),
            "--variant",
            private_config.variant,
        ],
        cwd=repo_root,
        env=environment,
        check=False,
    )
    return result.returncode


def _write_json(value: object, output: str | None) -> None:
    content = canonical_json(value) + "\n"
    if output is None or output == "-":
        sys.stdout.write(content)
        return
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{output_path.name}.", dir=output_path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="ascii", newline="\n") as file:
            file.write(content)
        os.replace(temporary, output_path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def _resolve_cli_revision(repo_root: Path, requested: str | None) -> str:
    actual = current_source_revision(repo_root)
    if requested is not None and requested != actual:
        raise ReleaseSetError("requested source_revision does not match checked-out HEAD")
    return actual


def _resolve_historical_cli_revision(repo_root: Path, requested: str | None) -> str:
    if requested is None:
        raise ReleaseSetError("inspect requires an exact source_revision")
    validate_source_revision(requested)
    actual = _run_git(repo_root, "rev-parse", "--verify", f"{requested}^{{commit}}")
    if actual != requested:
        raise ReleaseSetError("source_revision must identify an exact committed revision")
    return actual


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root", type=Path, default=Path(__file__).resolve().parent.parent
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    manifest = subparsers.add_parser("manifest", help="emit the canonical public manifest")
    manifest.add_argument("--source-revision")
    manifest.add_argument("--output")

    verify = subparsers.add_parser("verify", help="verify a public manifest")
    verify.add_argument("--manifest", required=True, type=Path)
    verify.add_argument("--source-revision")
    verify.add_argument("--release-id")
    verify.add_argument("--target-id")

    target = subparsers.add_parser("target", help="emit one public target record")
    target.add_argument("--source-revision")
    target.add_argument("--release-id", required=True)
    target.add_argument("--target-id", required=True)
    target.add_argument("--output")

    build = subparsers.add_parser("build", help="build one opaque release target")
    build.add_argument("--source-revision")
    build.add_argument("--release-id", required=True)
    build.add_argument("--target-id", required=True)

    inspect = subparsers.add_parser(
        "inspect", help="privately resolve variants to publication identities"
    )
    inspect.add_argument("--source-revision", required=True)
    inspect_filters = inspect.add_mutually_exclusive_group()
    inspect_filters.add_argument("--variant")
    inspect_filters.add_argument("--target-id")
    inspect.add_argument("--output")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    repo_root = args.repo_root.resolve()
    try:
        if args.command == "inspect":
            source_revision = _resolve_historical_cli_revision(
                repo_root, args.source_revision
            )
        else:
            source_revision = _resolve_cli_revision(repo_root, args.source_revision)
        release_set = create_release_set(repo_root, source_revision)
        if args.command == "manifest":
            _write_json(release_set.manifest, args.output)
        elif args.command == "verify":
            manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
            verify_manifest(
                manifest,
                release_set,
                release_id=args.release_id,
                target_id=args.target_id,
            )
        elif args.command == "target":
            target = resolve_public_target(release_set, args.release_id, args.target_id)
            _write_json(target, args.output)
        elif args.command == "build":
            return invoke_target_build(
                repo_root, release_set, args.release_id, args.target_id
            )
        elif args.command == "inspect":
            _write_json(
                inspect_release_set(
                    release_set,
                    variant=args.variant,
                    target_id=args.target_id,
                ),
                args.output,
            )
        else:
            raise AssertionError(f"unhandled command: {args.command}")
    except (ReleaseSetError, json.JSONDecodeError, OSError) as error:
        print(f"release-set error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
