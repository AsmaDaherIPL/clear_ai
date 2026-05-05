#!/usr/bin/env python3
"""Render an .excalidraw file to PNG via a hand-rolled SVG composer.

Only handles roughness=0 elements: rectangle, ellipse, line, arrow, text.
Bypasses @excalidraw/utils entirely because its v0.1.2 SVG export crashes
on multi-line text in headless Chromium."""

import json
import sys
import asyncio
import html
from pathlib import Path
from playwright.async_api import async_playwright


def svg_for(data: dict) -> str:
    bg = data.get("appState", {}).get("viewBackgroundColor", "#ffffff")
    elements = [e for e in data["elements"] if not e.get("isDeleted")]
    if not elements:
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" style="background:{bg}"/>'

    pad = 40
    minx = min(e["x"] for e in elements)
    miny = min(e["y"] for e in elements)
    maxx = max(e["x"] + e.get("width", 0) for e in elements)
    maxy = max(e["y"] + e.get("height", 0) for e in elements)
    w = int(maxx - minx + 2 * pad)
    h = int(maxy - miny + 2 * pad)

    # Resolve container x/y for text-with-container so we can place text inside
    by_id = {e["id"]: e for e in elements}

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="background:{bg}; font-family: Helvetica, Arial, sans-serif;">'
    ]
    parts.append(f'<rect width="{w}" height="{h}" fill="{bg}"/>')
    parts.append(f'<g transform="translate({pad - minx},{pad - miny})">')

    # 1) shapes first
    for e in elements:
        t = e["type"]
        if t == "rectangle":
            rx = 8 if e.get("roundness") else 0
            parts.append(
                f'<rect x="{e["x"]}" y="{e["y"]}" width="{e["width"]}" height="{e["height"]}" '
                f'rx="{rx}" ry="{rx}" '
                f'fill="{e.get("backgroundColor", "transparent")}" '
                f'stroke="{e.get("strokeColor", "#000")}" stroke-width="{e.get("strokeWidth", 1)}"/>'
            )
        elif t == "ellipse":
            cx = e["x"] + e["width"] / 2
            cy = e["y"] + e["height"] / 2
            rx = e["width"] / 2
            ry = e["height"] / 2
            parts.append(
                f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" '
                f'fill="{e.get("backgroundColor", "transparent")}" '
                f'stroke="{e.get("strokeColor", "#000")}" stroke-width="{e.get("strokeWidth", 1)}"/>'
            )
        elif t == "diamond":
            x, y, ww, hh = e["x"], e["y"], e["width"], e["height"]
            pts = f"{x + ww/2},{y} {x + ww},{y + hh/2} {x + ww/2},{y + hh} {x},{y + hh/2}"
            parts.append(
                f'<polygon points="{pts}" fill="{e.get("backgroundColor", "transparent")}" '
                f'stroke="{e.get("strokeColor", "#000")}" stroke-width="{e.get("strokeWidth", 1)}"/>'
            )

    # 2) lines and arrows
    arrow_marker_added = set()
    for e in elements:
        t = e["type"]
        if t in ("line", "arrow"):
            color = e.get("strokeColor", "#000")
            sw = e.get("strokeWidth", 1)
            # build absolute polyline from points + element x/y
            pts = e.get("points", [])
            if not pts:
                continue
            abs_pts = [(e["x"] + p[0], e["y"] + p[1]) for p in pts]
            d = "M " + " L ".join(f"{x},{y}" for x, y in abs_pts)
            marker = ""
            if t == "arrow" and e.get("endArrowhead") == "triangle":
                mid = f"m{abs(hash(color)) % 100000}"
                if mid not in arrow_marker_added:
                    parts.append(
                        f'<defs><marker id="{mid}" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto"><polygon points="0 0, 10 5, 0 10" fill="{color}"/></marker></defs>'
                    )
                    arrow_marker_added.add(mid)
                marker = f' marker-end="url(#{mid})"'
            parts.append(
                f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"{marker}/>'
            )

    # 3) text elements (drawn last so they sit on top)
    for e in elements:
        if e["type"] != "text":
            continue
        text = e.get("text", "")
        x = e["x"]
        y = e["y"]
        # if container, center text within the container
        cid = e.get("containerId")
        if cid and cid in by_id:
            c = by_id[cid]
            x = c["x"] + c["width"] / 2
            anchor = "middle"
        else:
            anchor = {"left": "start", "center": "middle", "right": "end"}.get(e.get("textAlign", "left"), "start")
            if anchor == "middle":
                x = x + e["width"] / 2
            elif anchor == "end":
                x = x + e["width"]

        font_size = e.get("fontSize", 16)
        line_h = e.get("lineHeight", 1.2)
        line_dy = font_size * line_h
        color = e.get("strokeColor", "#000")
        # font-family: 1=Virgil hand-drawn (skip), 2=Helvetica, 3=Cascadia mono
        ff = e.get("fontFamily", 2)
        if ff == 3:
            family = "'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace"
        else:
            family = "Helvetica, Arial, sans-serif"

        lines = text.split("\n")
        # vertical centering for container-bound text
        if cid and cid in by_id:
            c = by_id[cid]
            total_h = line_dy * len(lines)
            start_y = c["y"] + (c["height"] - total_h) / 2 + font_size * 0.85
        else:
            start_y = y + font_size * 0.95

        parts.append(
            f'<text x="{x}" y="{start_y}" fill="{color}" font-size="{font_size}" font-family="{family}" text-anchor="{anchor}">'
        )
        for i, line in enumerate(lines):
            dy = 0 if i == 0 else line_dy
            parts.append(
                f'<tspan x="{x}" dy="{dy}" xml:space="preserve">{html.escape(line)}</tspan>'
            )
        parts.append("</text>")

    parts.append("</g></svg>")
    return "".join(parts)


HTML_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; background: #fafaf9; }
  #host { display: inline-block; }
  #host svg { display: block; }
</style>
</head>
<body>
<div id="host">__SVG__</div>
</body>
</html>
"""


async def render(path: Path, out: Path, scale: int = 2):
    data = json.loads(path.read_text())
    svg = svg_for(data)
    # Persist the SVG too so it can be inspected
    path.with_suffix(".svg").write_text(svg)
    html_doc = HTML_TEMPLATE.replace("__SVG__", svg)

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 2400, "height": 2400}, device_scale_factor=scale)
        page = await ctx.new_page()
        page.on("pageerror", lambda e: print(f"[pageerror] {e}", file=sys.stderr))
        await page.set_content(html_doc, wait_until="domcontentloaded")
        await page.evaluate("() => document.fonts.ready")
        bb = await page.evaluate(
            """() => { const s = document.querySelector('#host svg'); const r = s.getBoundingClientRect(); return {w: Math.ceil(r.width), h: Math.ceil(r.height)}; }"""
        )
        await page.set_viewport_size({"width": bb["w"] + 40, "height": bb["h"] + 40})
        host = await page.query_selector("#host")
        await host.screenshot(path=str(out), omit_background=False)
        await browser.close()
        print(f"wrote {out} ({bb['w']}x{bb['h']})")


if __name__ == "__main__":
    src = Path(sys.argv[1]).resolve()
    dst = src.with_suffix(".png")
    asyncio.run(render(src, dst))
