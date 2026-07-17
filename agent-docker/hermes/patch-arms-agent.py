#!/usr/bin/env python3
"""
Patch ARMS Python agent _arms_load.py for xtrace (CMS 2.0) compatibility.

Fixes:
  1. Add x-arms-project / x-cms-workspace headers (from env vars)
  2. Disable Snappy compression (xtrace doesn't support it)
  3. Monkey-patch get_full_trace_url to use ARMS_ENDPOINT env var
  4. Add genai resource attributes for APM dashboard

Usage: patch-arms-agent.py <path-to-_arms_load.py>
"""
import sys
import os
import shutil

PATCH_MARKER = "# HERMES_XTRACE_PATCHED"


def apply_patch(content, old, new, description):
    """Apply a single str.replace patch. Returns (new_content, warning_or_None)."""
    result = content.replace(old, new, 1)
    if result == content:
        return content, f"Patch '{description}' - target text not found, skipped"
    return result, None


def main():
    if len(sys.argv) < 2:
        print("[patch] Usage: patch-arms-agent.py <path>", file=sys.stderr)
        return 1

    path = sys.argv[1]
    if not os.path.isfile(path):
        print(f"[patch] File not found: {path}", file=sys.stderr)
        return 0  # Don't block startup

    with open(path, "r") as f:
        content = f.read()

    # Idempotent: skip if already patched
    if PATCH_MARKER in content:
        print("[patch] Already patched, skipping.")
        return 0

    warnings = []

    # =========================================================================
    # Patch 1: Add x-arms-project / x-cms-workspace headers and change encoding
    # Support both ARMS 2.10.3 ("licenseKey") and 2.10.1 ("x-arms-license-key")
    # =========================================================================
    new_header = '''\
    header = {
        "Content-Type": "application/x-protobuf",
        "x-arms-license-key": ArmsEnv.instance().licenseKey,
        "x-arms-project": os.environ.get("ARMS_PROJECT", ""),
        "x-cms-workspace": os.environ.get("ARMS_WORKSPACE", ""),
        "content.type": "span",
        "X-ARMS-Encoding": "none",
        "data.type": "",
    }'''

    # Try 2.10.3 format first ("licenseKey" key)
    old_header_2103 = '''\
    header = {
        "Content-Type": "application/x-protobuf",
        "licenseKey": ArmsEnv.instance().licenseKey,
        "content.type": "span",
        "X-ARMS-Encoding": "snappy",
        "data.type": "",
    }'''

    content, warn = apply_patch(content, old_header_2103, new_header, "add headers & change encoding (2.10.3)")
    if warn:
        # Fallback: try 2.10.1 format ("x-arms-license-key" key)
        old_header_2101 = '''\
    header = {
        "Content-Type": "application/x-protobuf",
        "x-arms-license-key": ArmsEnv.instance().licenseKey,
        "content.type": "span",
        "X-ARMS-Encoding": "snappy",
        "data.type": "",
    }'''

        content, warn2 = apply_patch(content, old_header_2101, new_header, "add headers & change encoding (2.10.1)")
        if warn2:
            warnings.append("Patch 'add headers & change encoding' - neither 2.10.3 nor 2.10.1 format found, skipped")

    # =========================================================================
    # Patch 2: Change compression from Snappy to None
    # =========================================================================
    old_compression = "compression=Compression.Snappy"
    new_compression = "compression=None"

    content, warn = apply_patch(content, old_compression, new_compression, "disable Snappy compression")
    if warn:
        warnings.append(warn)

    # =========================================================================
    # Patch 3: Monkey-patch get_full_trace_url after exporter creation
    # =========================================================================
    old_exporter = "exporter = OTLPSpanExporter("
    # Find the full exporter line(s) to anchor after - we insert after the closing paren
    # Strategy: find "exporter = OTLPSpanExporter(" and locate the end of that statement,
    # then insert the monkey-patch line after it.
    # Since the exporter creation may span multiple lines, we anchor on a known pattern
    # that appears right after the exporter assignment completes.
    # We'll look for the line containing "exporter = OTLPSpanExporter(" and add after
    # the next line that closes it.

    # Use a more targeted approach: find the exporter assignment block and append after it
    exporter_idx = content.find(old_exporter)
    if exporter_idx == -1:
        warnings.append("Patch 'monkey-patch get_full_trace_url' - 'exporter = OTLPSpanExporter(' not found, skipped")
    else:
        # Find the closing parenthesis of the OTLPSpanExporter(...) call
        # We need to find the matching ')' considering nested parens
        paren_start = content.index("(", exporter_idx)
        depth = 0
        i = paren_start
        while i < len(content):
            if content[i] == "(":
                depth += 1
            elif content[i] == ")":
                depth -= 1
                if depth == 0:
                    break
            i += 1

        if i >= len(content):
            warnings.append("Patch 'monkey-patch get_full_trace_url' - could not find closing paren of OTLPSpanExporter(), skipped")
        else:
            # Find the end of the line containing the closing paren
            end_of_line = content.index("\n", i)
            monkey_patch_line = '\n    global_arms_endpoints_state.get_full_trace_url = lambda: os.environ.get("ARMS_ENDPOINT", "") + "/v1/traces"'
            content = content[:end_of_line] + monkey_patch_line + content[end_of_line:]

    # =========================================================================
    # Patch 4: Add genai resource attributes
    # Support both ARMS 2.10.3 (no trailing comma) and 2.10.1 (trailing comma)
    # =========================================================================
    new_resource_with_comma = '''ARMS_SERVICE_ID_KEY_IN_SPAN: ArmsEnv.instance().service_id,
        "acs.arms.service.feature": "genai_app",
        "gen_ai.agent.system": "hermes",'''

    # Try 2.10.3 format first (no trailing comma — last item in dict)
    old_resource_no_comma = "ARMS_SERVICE_ID_KEY_IN_SPAN: ArmsEnv.instance().service_id"
    # Ensure we don't accidentally match the version WITH trailing comma
    # by checking the no-comma version doesn't have a comma after it
    if old_resource_no_comma in content:
        # Check if there is a trailing comma right after the match
        idx = content.find(old_resource_no_comma)
        after_match = content[idx + len(old_resource_no_comma):idx + len(old_resource_no_comma) + 1]
        if after_match == ",":
            # It's actually the 2.10.1 format (has comma), use that
            old_resource_with_comma = "ARMS_SERVICE_ID_KEY_IN_SPAN: ArmsEnv.instance().service_id,"
            content, warn = apply_patch(content, old_resource_with_comma, new_resource_with_comma, "add genai resource attributes (2.10.1)")
            if warn:
                warnings.append(warn)
        else:
            # It's 2.10.3 format (no comma), add comma in replacement
            new_resource_no_comma = '''ARMS_SERVICE_ID_KEY_IN_SPAN: ArmsEnv.instance().service_id,
        "acs.arms.service.feature": "genai_app",
        "gen_ai.agent.system": "hermes",'''
            content, warn = apply_patch(content, old_resource_no_comma, new_resource_no_comma, "add genai resource attributes (2.10.3)")
            if warn:
                warnings.append(warn)
    else:
        warnings.append("Patch 'add genai resource attributes' - ARMS_SERVICE_ID_KEY_IN_SPAN not found, skipped")

    # =========================================================================
    # Backup original and write patched content
    # =========================================================================
    shutil.copy2(path, path + ".bak")
    content += f"\n{PATCH_MARKER}\n"
    with open(path, "w") as f:
        f.write(content)

    # Clear .pyc bytecode cache to ensure patched source is used
    cache_dir = os.path.join(os.path.dirname(path), "__pycache__")
    if os.path.isdir(cache_dir):
        import glob
        for pyc in glob.glob(os.path.join(cache_dir, "_arms_load*.pyc")):
            os.remove(pyc)
            print(f"[patch] Removed bytecode cache: {pyc}")

    print(f"[patch] _arms_load.py patched successfully ({len(warnings)} warnings)")
    for w in warnings:
        print(f"[patch] WARNING: {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
