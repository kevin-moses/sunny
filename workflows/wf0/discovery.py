from __future__ import annotations

"""
purpose: Discover Apple Support iPhone guide URLs from the sitemap.
"""

import re
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx
import yaml
from playwright.sync_api import sync_playwright

STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "how",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
    "your",
}


def _slugify(text: str) -> str:
    """
    purpose: Convert raw text to a snake_case identifier.
    @param text: (str) Input text to normalize.
    @return: (str) Snake_case slug.
    """
    cleaned = re.sub(r"[^a-zA-Z0-9]+", " ", text).strip().lower()
    parts = [p for p in cleaned.split() if p and p not in STOP_WORDS]
    return "_".join(parts) if parts else "workflow"


def _titleize(slug: str) -> str:
    """
    purpose: Turn a slug into a title-cased string.
    @param slug: (str) Slug text.
    @return: (str) Title-cased string.
    """
    words = re.sub(r"[^a-zA-Z0-9]+", " ", slug).strip().split()
    return " ".join([w.capitalize() for w in words])


def _read_text(url: str) -> str:
    """
    purpose: Fetch text content from a URL with redirects enabled.
    @param url: (str) URL to fetch.
    @return: (str) Response text.
    """
    response = httpx.get(url, timeout=30, follow_redirects=True)
    response.raise_for_status()
    return response.text


def _extract_sitemaps_from_robots() -> list[str]:
    """
    purpose: Extract sitemap URLs from robots.txt if present.
    @return: (list[str]) Sitemap URLs.
    """
    robots_url = "https://support.apple.com/robots.txt"
    try:
        text = _read_text(robots_url)
    except Exception:
        return []
    urls: list[str] = []
    for line in text.splitlines():
        if line.lower().startswith("sitemap:"):
            urls.append(line.split(":", 1)[1].strip())
    return urls


def _iter_sitemap_urls(sitemap_url: str, seen: set[str]) -> list[str]:
    """
    purpose: Collect URL entries from a sitemap or sitemap index.
    @param sitemap_url: (str) Sitemap URL to parse.
    @param seen: (set[str]) Already-visited sitemap URLs.
    @return: (list[str]) URL entries from sitemap(s).
    """
    if sitemap_url in seen:
        return []
    seen.add(sitemap_url)
    try:
        xml_text = _read_text(sitemap_url)
    except Exception:
        return []
    root = ET.fromstring(xml_text)
    tag = root.tag.split("}")[-1]
    urls: list[str] = []
    if tag == "sitemapindex":
        for loc in root.iter():
            if loc.tag.split("}")[-1] == "loc" and loc.text:
                urls.extend(_iter_sitemap_urls(loc.text.strip(), seen))
    else:
        for loc in root.iter():
            if loc.tag.split("}")[-1] == "loc" and loc.text:
                urls.append(loc.text.strip())
    return urls


def _discover_from_toc() -> list[str]:
    """
    purpose: Fallback discovery by scraping the iPhone User Guide table of contents.
    @return: (list[str]) Apple Support iPhone guide URLs.
    """
    toc_url = "https://support.apple.com/guide/iphone/welcome/ios"
    urls: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.goto(toc_url, wait_until="networkidle", timeout=30_000)
            urls = page.evaluate(
                """
                () => Array.from(document.querySelectorAll("a[href]"))
                    .map(a => a.href)
                """
            )
        finally:
            browser.close()
    cleaned: list[str] = []
    for href in urls:
        if href.startswith("/guide/iphone/"):
            href = f"https://support.apple.com{href}"
        if not href.startswith("https://support.apple.com/guide/iphone/"):
            continue
        if "/ios" not in href:
            continue
        cleaned.append(href)
    return cleaned


def discover(output_path: Path = Path("manifest.yaml")) -> int:
    """
    purpose: Build a manifest of Apple Support iPhone guides from the sitemap.
    @param output_path: (Path) Path to write manifest YAML.
    @return: (int) Number of discovered articles.
    """
    sitemap_candidates = []
    robots_sitemaps = _extract_sitemaps_from_robots()
    preferred = [s for s in robots_sitemaps if "/en-us/" in s]
    if preferred:
        sitemap_candidates.extend(preferred)
    if not sitemap_candidates:
        sitemap_candidates.append("https://support.apple.com/guide/iphone/sitemap.xml")
    sitemap_candidates.extend([s for s in robots_sitemaps if s not in sitemap_candidates])

    urls: list[str] = []
    seen: set[str] = set()
    for sitemap_url in sitemap_candidates:
        urls.extend(_iter_sitemap_urls(sitemap_url, seen))

    urls = [url for url in urls if url.startswith("https://support.apple.com/guide/iphone/")]
    urls = [url for url in urls if "/ios" in url]

    if not urls:
        urls = _discover_from_toc()

    deduped: dict[str, str] = {}
    for url in urls:
        match = re.match(r"https?://support\.apple\.com/guide/iphone/([^/]+)/", url)
        if not match:
            continue
        slug = match.group(1)
        if slug not in deduped:
            deduped[slug] = url

    manifest = {
        "workflows": []
    }
    for slug, url in sorted(deduped.items()):
        suggested_id = _slugify(slug)
        suggested_title = _titleize(slug)
        manifest["workflows"].append({
            "source_url": url,
            "suggested_id": suggested_id,
            "suggested_title": suggested_title,
            "skip": False,
        })

    header = "# Auto-generated by discovery.py -- edit before running batch\n# Set skip: true to exclude an article\n"
    yaml_body = yaml.safe_dump(manifest, sort_keys=False)
    output_path.write_text(header + yaml_body, encoding="utf-8")
    return len(manifest["workflows"])
