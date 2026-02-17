# SDI Lead Discovery - Complete Application Flow

## Overview

This document describes the complete flow that happens when you click the "Start" button in the SDI Lead Discovery application, from user input to verified leads.

---

## Complete Flow When You Click "Start"

### **1. Frontend → API (Immediate)**
**File:** [app/page.tsx](app/page.tsx)

When the Start button is clicked:
- `startRun()` function sends **POST** request to `/api/runs` with:
  - `searchIndustry` (e.g., "Building maintenance")
  - `searchLocation` (e.g., "Zürich / CH")
  - `searchDetailedCtx` (optional URLs or context)
  - `customChecksRaw` (optional custom checks)
  - `targetLeadCount` (default: 25)
- Opens **Server-Sent Events (SSE)** stream at `/api/runs/${runId}/events`
- SSE receives:
  - **Log events** - appended to live log display (keeps last 500)
  - **Tick events** - triggers refresh of run status and leads

### **2. API Creates Job (< 1 second)**
**File:** [app/api/runs/route.ts](app/api/runs/route.ts)

API endpoint processing:
1. Validates input with Zod schema
2. Parses custom checks using [src/server/customChecks.ts](src/server/customChecks.ts)
3. Creates `Run` record in PostgreSQL via Prisma:
   - Status: `QUEUED`
   - Stores all search parameters
4. **Adds job to BullMQ queue** (`leadQueue`) with payload `{runId}`
5. Returns `runId` to frontend

### **3. Queue Infrastructure**
**Files:** [src/lib/queue.ts](src/lib/queue.ts), [src/lib/redis.ts](src/lib/redis.ts)

Architecture:
- **BullMQ** queue named `"lead-discovery"` backed by **Redis**
- Redis connection via `REDIS_URL` environment variable
- Handles job persistence, retry logic, and worker communication
- Enables horizontal scaling and fault tolerance

### **4. Worker Picks Up Job**
**File:** [worker/worker.ts](worker/worker.ts)

Separate Node.js process:
- Listens to `"lead-discovery"` queue continuously
- Receives job → extracts `runId` → calls `runLeadDiscovery(runId)`
- Handles errors by updating Run status to `FAILED` and logging
- Runs independently from the Next.js web server

### **5. Core Pipeline - Discovery Phase**
**File:** [src/server/pipeline.ts](src/server/pipeline.ts)

#### Main Function: `runLeadDiscovery(runId)`

**Stage 1: Discovery** (Lines 18-48)
1. Updates Run status to `RUNNING`
2. Calls `discoverCandidates()` from [src/server/connectors/discovery.ts](src/server/connectors/discovery.ts)
3. Discovery strategies (prioritized):

   **Option 1 - URL Seeds** (Priority 1):
   - Extracts URLs from `searchDetailedCtx` using [src/server/urlSeeds.ts](src/server/urlSeeds.ts)
   - Creates candidates with website = seed URL
   - Company name derived from domain

   **Option 2 - Google Places API** (Priority 2):
   - Uses [src/server/connectors/googlePlacesNew.ts](src/server/connectors/googlePlacesNew.ts)
   - Text search: `"{industry} in {location}"`
   - **Phase A:** Get place IDs (cost-efficient field mask)
   - **Phase B:** Get place details (name, website, phone, address)
   - Handles pagination with `nextPageToken`

   **Option 3 - Mock Registry** (Priority 3):
   - Uses [src/server/connectors/mockRegistry.ts](src/server/connectors/mockRegistry.ts)
   - Development fallback with synthetic Swiss companies

4. Creates initial `Lead` records in database with discovered data

### **6. Core Pipeline - Enrichment Phase**
**File:** [src/server/pipeline.ts](src/server/pipeline.ts)

**Stage 2: Enrichment** (Lines 82-125)
- Processes all leads **concurrently** with `p-limit` (default: 3 concurrent)
- For each lead, calls `enrichOne(runId, leadId)`
- Checks `run.stopRequested` flag before each enrichment (enables user stop)
- Tracks progress and logs failures

---

## Lead Enrichment Process

### **enrichOne() Function** - Multi-Phase Enrichment

#### **Phase A: Core Website Crawl**
**File:** [src/server/crawl/crawler.ts](src/server/crawl/crawler.ts)

**Function:** `crawlCompanyWebsite()`

Process:
1. **Robots.txt Check** - Uses [src/server/crawl/robots.ts](src/server/crawl/robots.ts) to verify crawl permission
2. **Fetches HTML** with timeout (default: 8s per page via `CRAWL_FETCH_TIMEOUT_MS`)
3. **Extracts Signals** via `extractSignals()`:
   - **Emails:**
     - Finds `mailto:` links
     - Regex matches in visible text
     - Handles obfuscation: `(at)`, `[at]`, `(dot)` patterns
   - **Phones:**
     - Regex: `(\+?\d[\d\s().-]{7,}\d)`
     - Filters: excludes dates, must be 8-15 digits
   - **Contact Forms:** Detects `<form>` elements
   - **Booking Calendars:** Patterns for Calendly, Simplybook, Doctena, etc.
   - **Tech Stack:** Detects Shopify, WordPress, Wix, Webflow, etc.
   - **Decision Makers:** Calls `extractPersons()` (see below)

4. **Finds Next Links** - Prioritizes pages containing: "team", "contact", "about", "management"
5. **Crawls Documents:**
   - **vCards (.vcf):** Parses vCard format, extracts name/role/email (confidence: 92)
   - **PDFs:** Uses `pdf-parse` to extract text, finds name+email pairs (confidence: 85)
6. **Evidence Tracking:** Records source URL, snippet, and timestamp for each finding
7. Continues until `CRAWL_MAX_PAGES` reached (default: 4) or queue empty

#### **Phase B: Extra Sources Crawl**
**File:** [src/server/pipeline.ts](src/server/pipeline.ts)

Process:
1. Loads [crawl-sources.json](crawl-sources.json) configuration
2. Expands URL templates with variables:
   - `{website}`
   - `{company_name}`
   - `{location}`
   - `{industry}`
3. Crawls up to 8 additional URLs:
   - LinkedIn company pages
   - Yellow Pages
   - Business directories
   - Social media profiles
4. Merges signals into main crawl data with deduplication

#### **Phase C: Browser Automation Recipes**
**File:** [src/server/crawl/browserRecipeRunner.ts](src/server/crawl/browserRecipeRunner.ts)

Process (if `ENABLE_BROWSER_CRAWL=1`):
1. Loads [crawl-recipes.json](crawl-recipes.json)
2. Runs up to 3 browser recipes using headless browser
3. Each recipe can perform:
   - Page navigation
   - Click actions
   - Scroll behaviors
   - Wait conditions
   - Element selection
4. Extracts additional contact data from dynamic content
5. Merges signals with main crawl data

#### **Phase D: Data Consolidation**
**File:** [src/server/pipeline.ts](src/server/pipeline.ts)

Process:
1. **Email Selection:**
   - Picks best company email matching website domain
   - Prefers same-origin evidence

2. **Phone Selection:**
   - Picks phone from same-origin pages
   - Validates format (9-15 digits)

3. **Evidence Collection:**
   - Builds evidence array with:
     - Source URLs
     - Text snippets
     - Timestamps
   - Enables manual review and trust scoring

4. **Decision Makers:**
   - Persists all found persons to `DecisionMaker` table
   - Links to Lead via foreign key

5. **Top Decision Maker:**
   - If confidence ≥55:
     - Updates lead with top DM info
     - Only if email looks personal (matches name pattern)

#### **Phase E: Database Update & Verification**
**File:** [src/server/pipeline.ts](src/server/pipeline.ts)

Process:
1. Updates Lead with enriched data:
   - Emails, phones
   - Contact form presence
   - Booking calendar presence
   - Tech stack
   - Decision maker details
2. Stores evidence JSON
3. Calls `verifyLead()` to determine quality status
4. Updates `quality_status` and `quality_reasons`

---

## Person/Decision Maker Extraction

### **extractPersons() Function**
**File:** [src/server/crawl/personExtract.ts](src/server/crawl/personExtract.ts)

**Multi-Strategy Approach:**

#### **Strategy 1: JSON-LD Schema.org** (Lines 130-167)
- Parses `<script type="application/ld+json">` tags
- Looks for `@type: "Person"`
- Extracts:
  - `name`
  - `jobTitle`
  - `email`
- Confidence: name score + role score + 20

#### **Strategy 2: HTML Element Analysis** (Lines 169-300)
- Scans elements: `<a>`, `<p>`, `<li>`, `<div>`, team sections

**Name Detection:**
- Must be 2-5 words
- Proper capitalization (First Last)
- Filters blacklist: login, menu, cookie, privacy, etc.
- Strips titles: Dr., Prof., Med., Dent.

**Role Detection:**
- Keywords (multilingual):
  - CEO, CTO, CFO
  - Geschäftsführer, Geschäftsführerin
  - Zahnarzt, Zahnärztin
  - Praxismanager, Praxismanagerin
  - Owner, Founder, Director
- Normalizes to standard forms

**Contact Extraction:**
1. mailto/tel links in same element
2. Falls back to container search (table row, list item)
3. Inline regex matching as last resort

#### **Confidence Scoring:**
- **Name quality:** 25 points
- **Role importance:**
  - CEO/Geschäftsführer: 40 points
  - Director/Manager: 20 points
  - Other roles: 10-15 points
- **Email found:** +20 points
- **Phone found:** +15 points

#### **Deduplication:**
- Uses key: `name|role|email|phone`
- Prevents duplicate entries

**Returns:** Top 10 candidates sorted by confidence score

---

## Lead Verification

### **verifyLead() Function**
**File:** [src/server/verify/verify.ts](src/server/verify/verify.ts)

**Quality Classification System:**

#### Requirements Checked:
- ✅ Website exists and valid
- ✅ Company name exists (>2 chars, not "Seed Company")
- ✅ Email found with evidence
- ✅ Phone found with evidence (9-15 digits, not dates/IDs)
- ✅ Personal decision maker email (matches name pattern, has evidence)
- ✅ Email domain matches website domain

#### Quality Levels:

**1. VERIFIED** (Strict - aim for 100% usable)
- ✅ All requirements met
- ✅ Domain-matching email
- ✅ Both email and phone evidence
- ✅ Personal DM email with evidence
- **Use case:** Ready for immediate outreach

**2. NEEDS_REVIEW** (Usable but incomplete)
- ✅ Website exists
- ✅ At least email OR phone
- ❌ Missing one or more verification requirements
- **Use case:** Manual review recommended before outreach

**3. INCOMPLETE** (Not usable)
- ❌ Missing website OR no contacts
- **Use case:** Discard or needs more enrichment

**Returns:** `{status, reasons}` with detailed failure reasons for debugging

---

## Live Updates via SSE

### **Server-Sent Events Stream**
**File:** [app/api/runs/[runId]/events/route.ts](app/api/runs/[runId]/events/route.ts)

**Process:**
1. Creates `ReadableStream` with infinite loop
2. Every 1.2 seconds:
   - Queries `LogEvent` table for new events (`createdAt > lastCreatedAt`)
   - Streams events as: `data: {type: "event", payload: {...}}\n\n`
   - Sends periodic tick: `data: {type: "tick", payload: {t: ...}}\n\n`

3. Frontend receives:
   - **Events:** Appends to log display (keeps last 500)
   - **Ticks:** Triggers refresh of run status and leads

### **Logging System**
**File:** [src/lib/log.ts](src/lib/log.ts)

**Function:** `logEvent()`
- Creates records in `LogEvent` table
- Fields:
  - `runId` - links to Run
  - `level` - info/warn/error
  - `stage` - discovery/qualification/enrichment/export/system
  - `message` - human-readable text
  - `data` - JSON with additional context
- Enables real-time progress tracking and debugging

---

## Data Retrieval

### **GET /api/runs/:runId**
**File:** [app/api/runs/[runId]/route.ts](app/api/runs/[runId]/route.ts)

**Process:**
1. Fetches Run record with all metadata
2. Fetches associated Leads with selected fields:
   - `id`
   - `company_name`
   - `company_website`
   - `company_email`
   - `company_phone`
   - `quality_status`
3. Returns `{run, leads}` for frontend display

**Called by:**
- Initial load after job creation
- Periodic refresh triggered by SSE ticks
- Manual refresh by user

---

## Database Schema

### **Key Models**
**File:** [prisma/schema.prisma](prisma/schema.prisma)

#### **1. Run**
Campaign metadata and status tracking:
- `id` - unique identifier
- `status` - QUEUED, RUNNING, COMPLETED, FAILED
- `searchIndustry`, `searchLocation`, `searchDetailedCtx`
- `targetLeadCount`
- `customChecksSchema` - JSON array of custom checks
- `stopRequested` - boolean flag for graceful stop
- Timestamps: `createdAt`, `startedAt`, `completedAt`

#### **2. Lead**
Full lead data with 40+ fields:
- **Search context:** industry, location
- **Company info:** name, address, website, UID
- **Decision maker:** name, role, email, phone (with evidence)
- **Quality signals:** contact form, booking calendar, tech stack
- **Verification:** status (enum), reasons (array)
- **Evidence:** JSON with source URLs and snippets
- **Metadata:** discovery source, confidence scores

#### **3. DecisionMaker**
Separate table for all extracted persons:
- `leadId` - foreign key to Lead
- `name`, `role`, `email`, `phone`
- `confidence` - score 0-100
- `foundAt` - source URL
- `snippet` - evidence text

#### **4. LogEvent**
Real-time activity log for SSE:
- `runId` - foreign key to Run
- `level` - info/warn/error
- `stage` - discovery/enrichment/etc.
- `message` - human-readable
- `data` - JSON context
- `createdAt` - timestamp for ordering

#### **5. HttpCacheEntry**
Optional HTTP response cache:
- `url` - cache key
- `html` - response body
- `statusCode`, `headers`
- `createdAt` - for TTL

### **Relationships:**
- Run → Leads (1:many, cascade delete)
- Run → LogEvents (1:many, cascade delete)
- Lead → DecisionMakers (1:many, cascade delete)

---

## Architectural Patterns

### **1. Queue-Based Processing (BullMQ + Redis)**
**Benefits:**
- Decouples API from long-running work
- Enables horizontal scaling of workers
- Automatic retry and failure handling
- Job persistence across restarts
- Priority and delayed job support

**Implementation:**
- Queue: `"lead-discovery"`
- Job name: `"discover"`
- Payload: `{runId: string}`

### **2. Server-Sent Events (SSE)**
**Benefits:**
- Real-time unidirectional updates from server to client
- No WebSocket complexity
- Automatic browser reconnection
- Simple HTTP-based protocol

**Implementation:**
- Endpoint: `/api/runs/${runId}/events`
- Message types: `event`, `tick`
- Polling interval: 1.2 seconds

### **3. Concurrent Enrichment with Limits**
**Benefits:**
- Faster processing via parallelism
- Prevents overwhelming external sites
- Respects rate limits
- Enables graceful stop

**Implementation:**
- Uses `p-limit` library
- Default concurrency: 3 (configurable via `ENRICH_CONCURRENCY`)
- Checks `stopRequested` flag before each lead

### **4. Multi-Source Data Aggregation**
**Benefits:**
- Higher data completeness
- Cross-validation of information
- Fallback when primary source fails

**Implementation:**
- Website crawl (4 pages)
- Extra sources (8 URLs from config)
- Browser automation (3 recipes)
- Document parsing (vCards, PDFs)

### **5. Evidence-Based Verification**
**Benefits:**
- Tracks source URL and snippet for every data point
- Enables manual review and trust scoring
- Debugging and quality assurance
- Compliance and transparency

**Implementation:**
- Evidence stored as JSON array
- Each item: `{url, snippet, foundAt}`
- Strict verification requires evidence presence

### **6. Person Extraction Confidence Scoring**
**Benefits:**
- Multi-strategy approach for robustness
- Weighted scoring based on data quality
- Filters generic emails and validates name patterns
- Prioritizes high-value contacts

**Implementation:**
- Strategy 1: JSON-LD Schema.org
- Strategy 2: HTML structure analysis
- Scoring: 0-100 scale
- Threshold: 55 for top DM selection

---

## Configuration & Environment Variables

### **Environment Configuration**
**File:** [src/lib/env.ts](src/lib/env.ts)

#### **Required Variables:**
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string

#### **Optional Variables:**

**API Keys:**
- `GOOGLE_MAPS_API_KEY` - Enables Google Places discovery (empty = mock mode)

**Crawl Settings:**
- `CRAWL_MAX_PAGES` - Pages per website (1-30, default: 4)
- `CRAWL_FETCH_TIMEOUT_MS` - HTTP timeout per page (1000-60000ms, default: 8000ms)
- `ENABLE_BROWSER_CRAWL` - Enable browser automation ("1" or "0", default: "1")

**Enrichment Settings:**
- `ENRICH_CONCURRENCY` - Parallel lead processing (1-10, default: 3)
- `ENRICH_LEAD_TIMEOUT_MS` - Total timeout per lead (1000-300000ms, default: 30000ms)

**LLM Settings (Optional):**
- `ENABLE_LLM` - Enable AI features ("1" or "0", default: "0")
- `LLM_PROVIDER` - AI provider name
- `LLM_API_KEY` - AI API key

**Regional Settings:**
- `GOOGLE_PLACES_REGION` - Country code (default: "ch")
- `GOOGLE_PLACES_LANGUAGE` - Language code (default: "de")
- `APP_BASE_URL` - Base URL for internal links (default: "http://localhost:3000")

---

## Data Flow Summary

```
┌─────────────────────────────────────────────────────────────────┐
│ User Input (Industry, Location, Count)                         │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Frontend POST /api/runs                                         │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Create Run (QUEUED) + Add BullMQ Job                            │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Worker picks job → runLeadDiscovery()                           │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Discovery (Google Places / Seeds / Mock)                        │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Create Lead records (initial data)                              │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Parallel Enrichment (3 concurrent):                             │
│   ├─ Crawl website (4 pages)                                    │
│   ├─ Crawl extra sources (LinkedIn, etc.)                       │
│   └─ Run browser recipes (if enabled)                           │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Extract: emails, phones, forms, booking, tech, people           │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Consolidate evidence with source URLs                           │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Verify lead → VERIFIED / NEEDS_REVIEW / INCOMPLETE              │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Update Lead in database                                         │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ SSE streams LogEvents to frontend                               │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Frontend polls GET /api/runs/:runId on tick                     │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Display updated leads in table (filtered by quality_status)     │
└────────────────────────┬────────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ User downloads CSV export                                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Performance & Timing Estimates

### **Time Estimates:**

**Discovery Phase:**
- URL seeds: 1-2 seconds
- Google Places API: 5-30 seconds (depends on API response time)
- Mock registry: < 1 second

**Enrichment Phase (per lead):**
- Website crawl (4 pages): 8-30 seconds
- Extra sources (8 URLs): 5-20 seconds
- Browser automation (3 recipes): 10-30 seconds
- **Total per lead:** 10-45 seconds (depending on site responsiveness)

**For 25 leads at 3 concurrent:**
- Best case: ~3 minutes (fast sites, no browser automation)
- Typical case: ~4-5 minutes (average sites, browser enabled)
- Worst case: ~6-8 minutes (slow sites, timeouts, retries)

### **Scalability:**

**Horizontal Scaling:**
- Add more worker processes to process more jobs concurrently
- Redis queue handles distribution automatically
- Each worker can process leads independently

**Vertical Scaling:**
- Increase `ENRICH_CONCURRENCY` for more parallel leads per worker
- Increase `CRAWL_MAX_PAGES` for deeper crawls (more data, slower)
- Adjust timeouts based on network conditions

**Cost Optimization:**
- Google Places API: ~$0.017 per text search + $0.017 per place details
- For 25 leads: ~$0.50-$1.00 (depends on pagination)
- Use URL seeds or mock mode for development to avoid API costs

---

## Error Handling & Recovery

### **Job-Level Errors:**
- Worker catches all errors in `runLeadDiscovery()`
- Updates Run status to `FAILED`
- Logs error details to `LogEvent`
- BullMQ can retry failed jobs (configurable)

### **Lead-Level Errors:**
- Individual lead enrichment failures logged but don't stop run
- Lead remains in last valid state
- Error details in log events for debugging

### **Graceful Stop:**
- User clicks "Stop" → sets `run.stopRequested = true`
- Worker checks flag before each lead enrichment
- Completes current enrichments, then marks run `COMPLETED`
- Preserves all data collected so far

### **Timeout Protection:**
- Per-page fetch timeout: `CRAWL_FETCH_TIMEOUT_MS`
- Per-lead total timeout: `ENRICH_LEAD_TIMEOUT_MS`
- Prevents infinite hangs on unresponsive sites

---

## Export Functionality

### **CSV Export**
**File:** [src/server/export/csv.ts](src/server/export/csv.ts)

**Endpoints:**
- `/api/runs/${runId}/export?type=verified`
- `/api/runs/${runId}/export?type=needs_review`

**Process:**
1. Queries leads filtered by `quality_status`
2. Formats data as CSV with columns:
   - Company name, website, email, phone
   - Decision maker info
   - Address components
   - Quality signals (contact form, booking, tech)
   - Evidence URLs
3. Streams response with `Content-Disposition: attachment`

**Use Case:**
- Download verified leads for immediate outreach
- Download needs_review leads for manual QA

---

## Testing & Development

### **Development Mode:**
- Set `GOOGLE_MAPS_API_KEY=""` (empty) to use mock registry
- Mock registry generates synthetic Swiss companies
- No API costs, instant discovery

### **URL Seeds Mode:**
- Paste URLs in "Detailed target context" field
- System uses pasted URLs as discovery seeds
- Useful for testing enrichment on specific companies

### **Logging:**
- All stages log events to database
- SSE streams logs to frontend in real-time
- Log levels: info, warn, error
- Stages: discovery, qualification, enrichment, export, system

---

## Future Enhancements

### **Potential Improvements:**

**1. Custom Checks:**
- Currently defined but not fully implemented
- Could run LLM-based validation on crawled content
- Example: "Has booking calendar (boolean)" → verify via LLM

**2. Multi-Region Support:**
- Currently optimized for Swiss market (UIDs, address formats)
- Could extend to other countries with region-specific extractors

**3. Caching Layer:**
- `HttpCacheEntry` model exists but not actively used
- Could cache crawl results to avoid re-crawling same sites

**4. Advanced Person Extraction:**
- Could use computer vision for org charts
- Could parse LinkedIn profiles more deeply
- Could cross-reference multiple sources

**5. Quality Scoring:**
- Beyond VERIFIED/NEEDS_REVIEW/INCOMPLETE
- Numerical score (0-100) based on multiple factors
- ML-based lead scoring

---

## Troubleshooting

### **Common Issues:**

**1. "String must contain at least 1 character(s)" - GOOGLE_MAPS_API_KEY**
- **Solution:** Remove `GOOGLE_MAPS_API_KEY=""` from `.env` or set to actual key
- **Note:** Fixed in `src/lib/env.ts` with `z.preprocess`

**2. Worker not picking up jobs**
- **Check:** Worker process running (`npm run worker`)
- **Check:** Redis connection via `REDIS_URL`
- **Check:** Queue name matches (`"lead-discovery"`)

**3. No leads found**
- **Check:** Google Places API key valid and has quota
- **Alternative:** Use URL seeds mode by pasting URLs in detailed context
- **Fallback:** Mock registry should work without any API key

**4. Crawl timeouts**
- **Increase:** `CRAWL_FETCH_TIMEOUT_MS` for slow sites
- **Increase:** `ENRICH_LEAD_TIMEOUT_MS` for overall lead timeout
- **Check:** Network connectivity and DNS resolution

**5. SSE connection drops**
- **Browser:** Automatic reconnection should happen
- **Server:** Check for memory issues or process crashes
- **Workaround:** Manual refresh updates data

---

## File Reference Index

### **Frontend:**
- [app/page.tsx](app/page.tsx) - Main UI component
- [app/layout.tsx](app/layout.tsx) - Root layout
- [app/globals.css](app/globals.css) - Styles

### **API Routes:**
- [app/api/runs/route.ts](app/api/runs/route.ts) - Create run
- [app/api/runs/[runId]/route.ts](app/api/runs/[runId]/route.ts) - Get run details
- [app/api/runs/[runId]/events/route.ts](app/api/runs/[runId]/events/route.ts) - SSE stream
- [app/api/runs/[runId]/stop/route.ts](app/api/runs/[runId]/stop/route.ts) - Stop run
- [app/api/runs/[runId]/export/route.ts](app/api/runs/[runId]/export/route.ts) - CSV export

### **Core Logic:**
- [src/server/pipeline.ts](src/server/pipeline.ts) - Main pipeline orchestration
- [src/server/crawl/crawler.ts](src/server/crawl/crawler.ts) - Website crawling
- [src/server/crawl/personExtract.ts](src/server/crawl/personExtract.ts) - Person extraction
- [src/server/verify/verify.ts](src/server/verify/verify.ts) - Lead verification

### **Connectors:**
- [src/server/connectors/discovery.ts](src/server/connectors/discovery.ts) - Discovery orchestration
- [src/server/connectors/googlePlacesNew.ts](src/server/connectors/googlePlacesNew.ts) - Google Places API
- [src/server/connectors/mockRegistry.ts](src/server/connectors/mockRegistry.ts) - Mock data

### **Infrastructure:**
- [src/lib/queue.ts](src/lib/queue.ts) - BullMQ queue setup
- [src/lib/redis.ts](src/lib/redis.ts) - Redis client
- [src/lib/prisma.ts](src/lib/prisma.ts) - Prisma client
- [src/lib/log.ts](src/lib/log.ts) - Logging utilities
- [src/lib/env.ts](src/lib/env.ts) - Environment validation

### **Worker:**
- [worker/worker.ts](worker/worker.ts) - Background job processor

### **Configuration:**
- [crawl-recipes.json](crawl-recipes.json) - Browser automation recipes
- [crawl-sources.json](crawl-sources.json) - Extra source URLs
- [prisma/schema.prisma](prisma/schema.prisma) - Database schema

---

*Last updated: February 17, 2026*
