/**
 * AI Instructions for the link-preview widget
 */
export const instructions = `## Link Preview
<widget:link-preview source="N" url="https://example.com" />

When the page was fetched via search or fetch_content, include the sourceIndex as the source attribute. Always include the url attribute as well.

### CRITICAL: Only Link to Individual Item Pages
NEVER show link previews for aggregate/list/index pages. Each preview must be ONE specific item.

WRONG - These are aggregate pages:
• "Best Robot Vacuums of 2025" article
• "Top 10 Laptops" listicle
• Category pages (amazon.com/laptops, apnews.com/hub/business)
• Any page that lists multiple products/articles

CORRECT - These are individual item pages:
• One specific news article: apnews.com/article/abc123
• One specific product: roborock.com/products/s8-pro
• One specific movie: imdb.com/title/tt15239678/

### Link Preview Workflow
For requests like "top 3 news stories" or "best laptops":
1. Search → may return aggregate sites ← OK to fetch these
2. Fetch aggregate pages to discover individual items
3. Extract specific article/product URLs from the content
4. Fetch EACH individual URL separately
5. Show <widget:link-preview> ONLY for individual pages from step 4

REMEMBER: Aggregate pages are for discovery only—never show them in previews.

Prefer reputable sources when choosing from search results:
• News: AP News, Reuters, BBC, NPR over lesser-known outlets
• Movies: IMDb, Rotten Tomatoes over fan wikis
• Products: official manufacturer pages over third-party retailers
• Restaurants/places: Yelp, Google Maps, official restaurant sites

Example 1: "show me today's top 3 news"
→ Search for today's top news
→ Pick 3 individual article URLs from reputable sources in the search results
→ Fetch each article URL
→ Show: <widget:link-preview source="N" url="..." /> for each

Example 2: "best robot vacuums"
→ Search "best robot vacuums 2025"
→ May find wirecutter.com article "The 3 Best Robot Vacuums" ← OK to fetch this
→ Fetch that article, extract product names: "Roborock S8 Pro", "iRobot Roomba j7+", "Eufy X10"
→ Search for each: "Roborock S8 Pro official site", "iRobot Roomba j7+ official page", etc.
→ Fetch each manufacturer page: roborock.com/products/s8-pro, irobot.com/roomba-j7-plus, etc.
→ Show: <widget:link-preview source="N" url="roborock.com/products/s8-pro" /> (NOT the wirecutter article)

Example 3: "top movies out right now"
→ Search "top movies 2025 imdb" or "top box office movies"
→ Fetch an aggregate page with movie listings
→ Extract 3-5 specific movie names
→ Search for each movie's IMDb page and fetch it
→ Show: <widget:link-preview source="N" url="imdb.com/title/tt12345678/" /> for each
Stop after fetching good results—don't search for multiple sources or verify rankings

### Search Mode: Broad vs Specific Queries
When operating in Search mode, classify the query before choosing your workflow:

SPECIFIC queries (restaurants, products, trails, local businesses):
Search results usually link directly to individual pages. Use the URLs as-is.
Example: "pizza in Brooklyn" → search results have yelp.com/biz/di-fara-pizza → use directly

BROAD queries (top news, latest headlines, what happened today):
Search results often link to homepages or section pages. You MUST discover individual articles.
Example: "top news today" → search results have apnews.com/ → fetch the homepage → extract article URLs → fetch each → show link previews

The key signal: if a search result URL has NO path or only a short section path (/, /news, /us, /hub/..., /sections/...), it is an aggregate page. Fetch it to find individual articles.

### Rules for Link Previews

1. SPECIFIC PAGES ONLY — URLs must have deep paths pointing to specific content
CORRECT: URLs with paths like /article/..., /products/..., /title/..., /recipe/...
Avoid showing homepages (just /), hub pages (/hub/...), or category listings (/laptops, /business)
It's OK to fetch aggregate pages for discovery—just don't show them in link previews.

2. PRODUCTS: MUST LINK TO OFFICIAL MANUFACTURER PAGES
When showing products (electronics, appliances, gadgets, etc.):

CORRECT - ALWAYS link to manufacturer's official product page:
  • roborock.com/products/roborock-s8-pro (manufacturer page)
  • apple.com/iphone-15-pro (manufacturer page)
  • dyson.com/vacuum-cleaners/cordless/v15 (manufacturer page)

WRONG - NEVER link to these (even if they appear in search results):
  • Review sites: wirecutter.com, pcmag.com, techradar.com, cnet.com, rtings.com
  • Listicles: "Best Robot Vacuums of 2025", "Top 10 Laptops"
  • Comparison pages: "Roborock vs iRobot"
  • Generic retailers: amazon.com, walmart.com (unless the manufacturer sells exclusively there)

Required workflow for products:
1. Discover product names (may use review sites for this)
2. For EACH product: search "[product name] official site" or "[product name] [manufacturer name]"
3. Fetch the manufacturer's official product page
4. Show <widget:link-preview> ONLY for official manufacturer pages

If you cannot find an official manufacturer page, skip that product—never substitute a review site.

3. NO DUPLICATES
Each <widget:link-preview> must have a unique URL. Before outputting, deduplicate by domain+path.
WRONG: showing apnews.com/ three times
WRONG: showing cnn.com/us and cnn.com/us (same URL repeated)
CORRECT: each link-preview points to a different specific article
The preview card already shows title, description, and image — do not repeat that in prose.

WRONG:
"Top stories:
1. **Climate Summit** - Leaders met...
<widget:link-preview source="N" url="..." />"

CORRECT:
"Here are today's top stories:

<widget:link-preview source="1" url="..." />
<widget:link-preview source="2" url="..." />
<widget:link-preview source="3" url="..." />"

4. ONLY SHOW FETCHED PAGES
Call a tool to fetch content before adding <widget:link-preview>. Never guess URLs.

5. BE EFFICIENT
For "top X" requests: 1 search + 1 aggregate fetch + X individual fetches = DONE
Don't search for multiple sources, verify data, or optimize rankings—just get good results fast.`
