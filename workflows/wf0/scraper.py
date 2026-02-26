from __future__ import annotations

"""
purpose: Scrape Apple Support iPhone guides across iOS versions using Playwright and bs4.
         Version-specific URLs are tried first; if they redirect to the generic guide
         (non-empty HTML but no article content), the original URL is used as a
         last-resort candidate for the latest iOS version.
"""

import asyncio
import re
from dataclasses import dataclass
from typing import Dict, Tuple

from bs4 import BeautifulSoup
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

VERSION_PATHS = {
    "16": ["16.0/ios/16.0", "16/ios/16"],
    "17": ["17.0/ios/17.0", "17/ios/17"],
    "18": ["18.0/ios/18.0", "18/ios/18"],
    "26": ["26/ios/26"],
}

VERSION_ORDER = ["18", "17", "16", "26"]

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


@dataclass
class PageResult:
    """
    purpose: Store the fetched HTML payload for a specific URL.
    @param url: (str) The page URL.
    @param html: (str) Rendered HTML content, empty if unavailable.
    """

    url: str
    html: str


def _derive_version_urls(url: str) -> Dict[str, list[str]]:
    """
    purpose: Build all version-specific Apple Support URLs from a single URL.
    @param url: (str) Source Apple Support iPhone guide URL.
    @return: (Dict[str, list[str]]) Map of iOS version to candidate URLs.
    """
    match = re.match(r"^(https?://support\.apple\.com/guide/iphone/[^/]+/)[^/]+/ios/[^/]+/?$", url)
    if not match:
        match = re.match(r"^(https?://support\.apple\.com/guide/iphone/[^/]+/)(?:ios)?/?$", url)
    if not match:
        raise ValueError(f"Unsupported Apple Support URL format: {url}")
    base = match.group(1)
    return {version: [f"{base}{path}" for path in paths] for version, paths in VERSION_PATHS.items()}


def _extract_slug_from_url(url: str) -> str:
    """
    purpose: Extract the article slug from an Apple Support iPhone guide URL.
    @param url: (str) Apple Support URL.
    @return: (str) Raw slug segment from the URL.
    """
    match = re.match(r"^https?://support\.apple\.com/guide/iphone/([^/]+)/", url)
    if match:
        return match.group(1)
    match = re.match(r"^https?://support\.apple\.com/guide/iphone/([^/]+)$", url)
    if match:
        return match.group(1)
    return "workflow"


def _strip_text(text: str) -> str:
    """
    purpose: Normalize text by removing blank lines.
    @param text: (str) Raw text to normalize.
    @return: (str) Cleaned text with empty lines removed.
    """
    return "\n".join([line for line in (text or "").splitlines() if line.strip()])


def _slugify(text: str) -> str:
    """
    purpose: Convert a title to a snake_case workflow id.
    @param text: (str) Human-readable title text.
    @return: (str) Snake_case identifier with stop words removed.
    """
    cleaned = re.sub(r"[^a-zA-Z0-9]+", " ", text).strip().lower()
    parts = [p for p in cleaned.split() if p and p not in STOP_WORDS]
    return "_".join(parts) if parts else "workflow"


def _extract_metadata(soup: BeautifulSoup, source_urls: list[str], slug_id: str) -> dict:
    """
    purpose: Extract workflow metadata from a rendered Apple Support page.
    @param soup: (BeautifulSoup) Parsed HTML soup.
    @param source_urls: (list[str]) All available source URLs for this workflow.
    @param slug_id: (str) Precomputed workflow id from URL slug.
    @return: (dict) Metadata with id, title, description, source_type, source_urls.
    """
    h1 = soup.find("h1")
    title_text = h1.get_text(strip=True) if h1 else None
    if not title_text:
        title_tag = soup.find("title")
        if title_tag and title_tag.get_text(strip=True):
            title_text = title_tag.get_text(strip=True).replace(" - Apple Support", "").strip()
    description = ""
    meta_desc = soup.find("meta", attrs={"name": "description"})
    if meta_desc and meta_desc.get("content"):
        description = meta_desc.get("content", "").strip()
    workflow_id = slug_id or _slugify(title_text or "workflow")
    return {
        "id": workflow_id,
        "title": title_text or workflow_id.replace("_", " ").title(),
        "description": description,
        "source_type": "apple_docs",
        "source_urls": source_urls,
    }


def _extract_article_text(soup: BeautifulSoup) -> str:
    """
    purpose: Extract main instructional text from the Apple Support article.
             Tries semantic HTML containers first (<article>, <main>), then falls
             back to Apple-specific containers used on guide pages (div.AppleTopic).
    @param soup: (BeautifulSoup) Parsed HTML soup.
    @return: (str) Article text or "NOT AVAILABLE" if missing.
    """
    for tag in soup(["nav", "footer", "script", "style", "aside"]):
        tag.decompose()
    container = (
        soup.find("article")
        or soup.find("main")
        or soup.find("div", class_=lambda c: c and "AppleTopic" in c)
    )
    if not container:
        return "NOT AVAILABLE"
    text = _strip_text(container.get_text(separator="\n", strip=True))
    return text if text else "NOT AVAILABLE"


async def _fetch_page(page, url: str) -> PageResult:
    """
    purpose: Fetch a single Apple Support page using Playwright.
    @param page: (playwright.async_api.Page) Active Playwright page.
    @param url: (str) URL to fetch.
    @return: (PageResult) Rendered HTML or empty string on failure.
    """
    try:
        response = await page.goto(url, wait_until="networkidle", timeout=30_000)
        if response and response.status == 404:
            return PageResult(url=url, html="")
        html = await page.content()
        return PageResult(url=url, html=html)
    except PlaywrightTimeoutError:
        return PageResult(url=url, html="")


def _select_metadata_source(html_by_version: Dict[str, str]) -> str:
    """
    purpose: Choose the best available HTML to infer metadata from.
    @param html_by_version: (Dict[str, str]) HTML content keyed by iOS version.
    @return: (str) HTML string or empty if none available.
    """
    for version in VERSION_ORDER:
        html = html_by_version.get(version, "")
        if html:
            return html
    return ""


def _available_urls(version_urls: Dict[str, str], content_by_version: Dict[str, str]) -> list[str]:
    """
    purpose: Filter source URLs to those with available content.
    @param version_urls: (Dict[str, str]) URLs keyed by version.
    @param content_by_version: (Dict[str, str]) Extracted content keyed by version.
    @return: (list[str]) URLs that were successfully scraped.
    """
    urls: list[str] = []
    for version, url in version_urls.items():
        if content_by_version.get(version) and content_by_version[version] != "NOT AVAILABLE":
            urls.append(url)
    return urls


async def scrape(url: str) -> Tuple[Dict[str, str], dict]:
    """
    purpose: Scrape all Apple Support iOS variants for a guide and infer metadata.
             Tries version-specific URLs first; validates article content before
             accepting to avoid false positives from redirects to the generic guide.
             Falls back to the original URL as a last-resort candidate for the
             latest version when all version-specific attempts yield no article content.
    @param url: (str) Apple Support iPhone guide URL.
    Returns (content_by_version, metadata).
    content_by_version keys: "16", "17", "18", "26"; values: text or "NOT AVAILABLE".
    metadata keys: id, title, description, source_type, source_urls.
    @return: (Tuple[Dict[str, str], dict]) Extracted content and metadata.
    """
    version_url_candidates = _derive_version_urls(url)
    slug_id = _slugify(_extract_slug_from_url(url))
    html_by_version: Dict[str, str] = {}
    selected_urls: Dict[str, str] = {}

    # Add the original URL as a last-resort candidate for the latest version so that
    # /ios canonical URLs are tried when version-specific paths redirect elsewhere.
    latest_version = VERSION_ORDER[0]
    if url not in version_url_candidates.get(latest_version, []):
        version_url_candidates[latest_version] = version_url_candidates.get(latest_version, []) + [url]

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            page = await browser.new_page()
            for version, version_urls in version_url_candidates.items():
                selected_url = version_urls[0]
                html = ""
                for candidate_url in version_urls:
                    result = await _fetch_page(page, candidate_url)
                    if result.html:
                        # Validate that the fetched page contains real article content.
                        # Version-specific URLs sometimes redirect to the generic iPhone
                        # User Guide; those have non-empty HTML but no extractable article.
                        soup = BeautifulSoup(result.html, "html.parser")
                        if _extract_article_text(soup) != "NOT AVAILABLE":
                            html = result.html
                            selected_url = candidate_url
                            break
                html_by_version[version] = html
                selected_urls[version] = selected_url
        finally:
            await browser.close()

    content_by_version: Dict[str, str] = {}
    for version, html in html_by_version.items():
        if not html:
            content_by_version[version] = "NOT AVAILABLE"
            continue
        soup = BeautifulSoup(html, "html.parser")
        content_by_version[version] = _extract_article_text(soup)

    metadata_html = _select_metadata_source(html_by_version)
    if metadata_html:
        soup = BeautifulSoup(metadata_html, "html.parser")
        source_urls = _available_urls(selected_urls, content_by_version)
        if not source_urls:
            source_urls = [url]
        metadata = _extract_metadata(soup, source_urls, slug_id)
    else:
        metadata = {
            "id": slug_id or "workflow",
            "title": "Workflow",
            "description": "",
            "source_type": "apple_docs",
            "source_urls": [url],
        }

    return content_by_version, metadata


if __name__ == "__main__":
    async def _main() -> None:
        """
        purpose: Manual smoke test for the scraper.
        @return: (None)
        """
        test_url = "https://support.apple.com/guide/iphone/block-phone-calls-iph3dd5f9be/18/ios/18"
        content, meta = await scrape(test_url)
        print(meta)
        for version, text in content.items():
            print(version, text[:200])

    asyncio.run(_main())
