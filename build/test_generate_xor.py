#!/usr/bin/env python3
"""Unit tests for variant validation and XOR header generation."""

import json
import os
import tempfile
from pathlib import Path

from generate_xor import ConfigError, XOR_KEY, generate, load_config

TEST_SEED = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
EXPECTED_VARIANTS = {
    "p0": (None, 0),
    "p1": ("pdfstart.com", 1),
    "p2": ("xiaopdf.com", 1),
}


def variant_config(
    variant: str = "p1",
    domain: str | None = "pdfstart.com",
    product_lock: int = 1,
    *,
    description: str = "Test variant",
    target_seed: str = TEST_SEED,
) -> dict[str, object]:
    return {
        "variant": variant,
        "domain": domain,
        "product_lock": product_lock,
        "description": description,
        "target_seed": target_seed,
    }


def write_config(directory: str, config: object) -> str:
    path = os.path.join(directory, "variant.json")
    with open(path, "w", encoding="utf-8") as file:
        json.dump(config, file)
    return path


def parse_bytes(content: str, name: str) -> list[int]:
    line = next(line for line in content.splitlines() if line.startswith(name))
    body = line[line.index("{") + 1 : line.index("}")]
    return [int(value.strip(), 16) for value in body.split(",") if value.strip()]


def test_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as directory:
        variant_file = write_config(directory, variant_config())
        output = os.path.join(directory, "nested", "generated_domain.inc")
        config = generate(variant_file, output, "p1")
        assert config.product_lock == 1
        assert config.target_seed == TEST_SEED
        content = Path(output).read_text(encoding="ascii")
        domain_bytes = parse_bytes(content, "unsigned char x_domain")
        domain = bytes(value ^ XOR_KEY for value in domain_bytes[:-1])
        dot_domain_bytes = parse_bytes(content, "unsigned char x_dot_domain")
        dot_domain = bytes(value ^ XOR_KEY for value in dot_domain_bytes[:-1])
        assert domain == b"pdfstart.com"
        assert dot_domain == b".pdfstart.com"
        assert "pdfstart.com" not in content


def test_dev_build() -> None:
    with tempfile.TemporaryDirectory() as directory:
        variant_file = write_config(
            directory, variant_config("p0", None, 0, description="Dev test variant")
        )
        output = os.path.join(directory, "generated_domain.inc")
        config = generate(variant_file, output, "p0")
        assert config.product_lock == 0
        assert "x_domain[] = { 0x00 }" in Path(output).read_text(encoding="ascii")


def test_invalid_configs_fail_closed() -> None:
    invalid = [
        variant_config(domain=None),
        variant_config("p0", "example.com", 0),
        variant_config(domain="Example.com"),
        variant_config(product_lock=2),
        variant_config(description=""),
        variant_config(target_seed="00" * 32),
        {key: value for key, value in variant_config().items() if key != "target_seed"},
        {**variant_config(), "enabled": True},
        ["not", "an", "object"],
    ]
    with tempfile.TemporaryDirectory() as directory:
        for index, config in enumerate(invalid):
            variant_file = write_config(directory, config)
            try:
                generate(variant_file, os.path.join(directory, f"{index}.inc"))
            except ConfigError:
                continue
            raise AssertionError(f"invalid config accepted: {config}")


def test_variant_mismatch_fails() -> None:
    with tempfile.TemporaryDirectory() as directory:
        variant_file = write_config(directory, variant_config())
        try:
            generate(variant_file, os.path.join(directory, "out.inc"), "p2")
        except ConfigError:
            return
        raise AssertionError("selected variant mismatch was accepted")


def test_repository_variant_configs() -> None:
    variants_dir = Path(__file__).resolve().parent.parent / "variants"
    variant_files = {path.stem: path for path in variants_dir.glob("*.json")}
    assert set(variant_files) == set(EXPECTED_VARIANTS), (
        f"unexpected repository variants: {sorted(variant_files)}"
    )

    seen_seeds: set[str] = set()
    with tempfile.TemporaryDirectory() as directory:
        for variant, (expected_domain, expected_lock) in EXPECTED_VARIANTS.items():
            variant_file = variant_files[variant]
            config = load_config(str(variant_file), variant)
            assert config.domain == expected_domain
            assert config.product_lock == expected_lock
            assert config.target_seed not in seen_seeds
            seen_seeds.add(config.target_seed)

            output = os.path.join(directory, f"{variant}.inc")
            generate(str(variant_file), output, variant)
            content = Path(output).read_text(encoding="ascii")
            if expected_domain is not None:
                assert expected_domain not in content


def test_locked_binding_gate_runs_before_exports() -> None:
    bindings = (Path(__file__).resolve().parent.parent / "cpp" / "bindings.cpp").read_text(
        encoding="utf-8"
    )
    assert "#ifdef PRODUCT_LOCK" in bindings
    assert 'processObject.release.name === "node"' in bindings
    assert 'typeof processObject.versions.node === "string"' in bindings
    assert "locationObject.hostname" in bindings
    body = bindings.split("EMSCRIPTEN_BINDINGS(leptonica_wasm) {", 1)[1]
    assert body.index("enforceAuthorizedHost();") < body.index("emscripten::class_<PIX>")


if __name__ == "__main__":
    test_roundtrip()
    test_dev_build()
    test_invalid_configs_fail_closed()
    test_variant_mismatch_fails()
    test_repository_variant_configs()
    test_locked_binding_gate_runs_before_exports()
    print("All variant generator tests passed.")
