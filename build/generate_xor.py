#!/usr/bin/env python3
"""Validate private variants and generate an obfuscated domain include."""

import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass

XOR_KEY = 0x5A
VARIANT_RE = re.compile(r"p(?:0|[1-9][0-9]*)\Z")
DOMAIN_RE = re.compile(
    r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z"
)
TARGET_SEED_RE = re.compile(r"[0-9a-f]{64}\Z")
VARIANT_FIELDS = {
    "variant",
    "domain",
    "product_lock",
    "description",
    "target_seed",
}


class ConfigError(ValueError):
    """Raised when a build variant config is unsafe or inconsistent."""


@dataclass(frozen=True)
class VariantConfig:
    variant: str
    domain: str | None
    product_lock: int
    description: str
    target_seed: str


def encode(domain: str) -> list[str]:
    encoded = [byte ^ XOR_KEY for byte in domain.encode("ascii")]
    if 0 in encoded:
        raise ConfigError("domain cannot be safely represented by the XOR string format")
    return [f"0x{byte:02X}" for byte in encoded]


def parse_config(
    raw_config: object, expected_variant: str | None = None
) -> VariantConfig:
    """Validate one decoded private variant configuration."""
    if not isinstance(raw_config, dict):
        raise ConfigError("variant config must be a JSON object")

    unknown_fields = set(raw_config) - VARIANT_FIELDS
    missing_fields = VARIANT_FIELDS - set(raw_config)
    if unknown_fields:
        raise ConfigError(
            f"variant config contains unknown fields: {sorted(unknown_fields)}"
        )
    if missing_fields:
        raise ConfigError(
            f"variant config is missing required fields: {sorted(missing_fields)}"
        )

    variant = raw_config.get("variant")
    domain = raw_config.get("domain")
    product_lock = raw_config.get("product_lock")
    description = raw_config.get("description")
    target_seed = raw_config.get("target_seed")

    if not isinstance(variant, str) or not VARIANT_RE.fullmatch(variant):
        raise ConfigError("variant must match p0 or pN without leading zeroes")
    if expected_variant is not None and variant != expected_variant:
        raise ConfigError(
            f"variant mismatch: selected {expected_variant!r}, config declares {variant!r}"
        )
    if isinstance(product_lock, bool) or product_lock not in (0, 1):
        raise ConfigError("product_lock must be the integer 0 or 1")
    if not isinstance(description, str) or not description.strip():
        raise ConfigError("description must be a non-empty string")
    if not isinstance(target_seed, str) or not TARGET_SEED_RE.fullmatch(target_seed):
        raise ConfigError("target_seed must be 32 bytes encoded as lowercase hex")
    seed_bytes = bytes.fromhex(target_seed)
    if len(set(seed_bytes)) < 16:
        raise ConfigError("target_seed does not meet the minimum diversity policy")

    if product_lock == 0:
        if variant != "p0" or domain is not None:
            raise ConfigError("the unlocked config must be p0 with a null domain")
    else:
        if variant == "p0":
            raise ConfigError("p0 cannot enable product_lock")
        if not isinstance(domain, str) or not DOMAIN_RE.fullmatch(domain):
            raise ConfigError(
                "locked domains must be normalized lowercase ASCII hostnames"
            )

    return VariantConfig(variant, domain, product_lock, description, target_seed)


def load_config(variant_file: str, expected_variant: str | None = None) -> VariantConfig:
    with open(variant_file, encoding="utf-8") as file:
        raw_config = json.load(file)
    return parse_config(raw_config, expected_variant)


def generate(
    variant_file: str, output: str, expected_variant: str | None = None
) -> VariantConfig:
    config = load_config(variant_file, expected_variant)
    output_dir = os.path.dirname(os.path.abspath(output))
    os.makedirs(output_dir, exist_ok=True)

    if config.domain is None:
        lines = [
            "// No domain lock (development build).\n",
            "unsigned char x_domain[] = { 0x00 };\n",
            "unsigned char x_dot_domain[] = { 0x00 };\n",
        ]
    else:
        domain_encoded = encode(config.domain)
        dot_domain_encoded = encode(f".{config.domain}")
        lines = [
            "// Generated domain lock. Do not commit or publish this file.\n",
            f'unsigned char x_domain[] = {{ {", ".join(domain_encoded)}, 0x00 }};\n',
            f'unsigned char x_dot_domain[] = {{ {", ".join(dot_domain_encoded)}, 0x00 }};\n',
        ]

    descriptor, temporary_output = tempfile.mkstemp(
        prefix=".generated-domain-", dir=output_dir
    )
    try:
        with os.fdopen(descriptor, "w", encoding="ascii", newline="\n") as file:
            file.writelines(lines)
        os.replace(temporary_output, output)
    except BaseException:
        if os.path.exists(temporary_output):
            os.unlink(temporary_output)
        raise

    return config


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        print(
            f"Usage: {sys.argv[0]} <variant.json> <output.inc> [expected-variant]",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        selected_config = generate(
            sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None
        )
    except (ConfigError, json.JSONDecodeError, OSError) as error:
        print(f"Variant config error: {error}", file=sys.stderr)
        sys.exit(2)

    print(selected_config.product_lock)
