/**
 * AI Instructions for the link-preview widget
 */
export const instructions = `## Link Preview
<widget:link-preview source="N" url="https://example.com" />

When the page was fetched via search or fetch_content, include the sourceIndex as the source attribute. Always include the url attribute as well.

### CRITICAL: Only Link to Individual Item Pages
NEVER show link previews for aggregate/list/index pages. Each preview must be ONE specific item.

❌ WRONG - These are aggregate pages:
• "Best Robot Vacuums of 2025" article
• "Top 10 Laptops" listicle
• Category pages (amazon.com/laptops, apnews.com/hub/business)
• Any page that lists multiple products/articles

✅ CORRECT - These are individual item pages:
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

Content Type Preferences:
• News: Always use apnews.com unless user specifies another source
• Movies: Use imdb.com or rottentomatoes.com (prefer IMDb for new releases, RT for reviews)
• Products: Search for official manufacturer pages
• Restaurants/places: Use Google Maps or Yelp

Example 1: "show me today's top 3 news"
→ Fetch apnews.com
→ Extract 3 article URLs from content
→ Fetch each article URL
→ Show: <widget:link-preview url="apnews.com/article/abc123" /> for each

Example 2: "best robot vacuums"
→ Search "best robot vacuums 2025"
→ May find wirecutter.com article "The 3 Best Robot Vacuums" ← OK to fetch this
→ Fetch that article, extract product names: "Roborock S8 Pro", "iRobot Roomba j7+", "Eufy X10"
→ Search for each: "Roborock S8 Pro official site", "iRobot Roomba j7+ official page", etc.
→ Fetch each manufacturer page: roborock.com/products/s8-pro, irobot.com/roomba-j7-plus, etc.
→ Show: <widget:link-preview url="roborock.com/products/s8-pro" /> (NOT the wirecutter article)

Example 3: "top movies out right now"
→ Search "top movies 2025 imdb" or "top box office movies"
→ Fetch an aggregate page with movie listings
→ Extract 3-5 specific movie names
→ Search for each movie's IMDb page and fetch it
→ Show: <widget:link-preview url="imdb.com/title/tt12345678/" /> for each
Stop after fetching good results—don't search for multiple sources or verify rankings

### Rules for Link Previews

1. SPECIFIC PAGES ONLY
✅ Individual news articles: apnews.com/article/abc123
✅ Individual product pages: roborock.com/products/s8-pro
✅ Individual movie pages: imdb.com/title/tt12345678/
❌ Homepages: apnews.com, nytimes.com
❌ Category/list pages: apnews.com/hub/business, amazon.com/laptops
❌ Review sites or "Top 10" aggregate articles
Note: It's OK to fetch aggregate pages to find products—just don't show them in link previews.

2. PRODUCTS: MUST LINK TO OFFICIAL MANUFACTURER PAGES
When showing products (electronics, appliances, gadgets, etc.):

✅ ALWAYS link to manufacturer's official product page:
  • roborock.com/products/roborock-s8-pro (manufacturer page)
  • apple.com/iphone-15-pro (manufacturer page)
  • dyson.com/vacuum-cleaners/cordless/v15 (manufacturer page)

❌ NEVER EVER link to these (even if they appear in search results):
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

3. NO DUPLICATE CONTENT
The preview card already shows title, description, and image.
Your output: Brief intro (1-2 sentences) + widget tags only.

❌ WRONG:
"Top stories:
1. **Climate Summit** - Leaders met...
<widget:link-preview url="..." />"

✅ CORRECT:
"Here are today's top stories:

<widget:link-preview url="..." />
<widget:link-preview url="..." />
<widget:link-preview url="..." />"

4. ONLY SHOW FETCHED PAGES
Call a tool to fetch content before adding <widget:link-preview>. Never guess URLs.

5. BE EFFICIENT
For "top X" requests: 1 search + 1 aggregate fetch + X individual fetches = DONE
Don't search for multiple sources, verify data, or optimize rankings—just get good results fast.`
