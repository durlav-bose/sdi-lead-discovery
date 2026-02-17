# Database Logs and RunId - Complete Guide

## Table of Contents
1. [What is RunId?](#what-is-runid)
2. [Database Logs Explained](#database-logs-explained)
3. [Why Store Logs in Database?](#why-store-logs-in-database)
4. [Complete Flow with RunId](#complete-flow-with-runid)
5. [LogEvent Table Structure](#logevent-table-structure)
6. [How SSE Uses Database Logs](#how-sse-uses-database-logs)
7. [Practical Examples](#practical-examples)

---

## What is RunId?

### **Simple Explanation:**

`runId` is a **unique identifier** for each lead discovery campaign that a user starts.

**Analogy:**
- Think of it like an **order number** at a restaurant
- When you place an order, you get a receipt with order #123
- You can check the status of order #123 anytime
- The kitchen knows which items belong to order #123

### **In Our Application:**

```typescript
// User clicks "Start" button
// ↓
// System creates a new Run record
const run = await prisma.run.create({
  data: {
    status: "QUEUED",
    searchIndustry: "Building maintenance",
    searchLocation: "Zürich",
    targetLeadCount: 25
  }
});

// run.id = "cm5xyz123abc"  ← This is the runId!
```

### **What Does RunId Link Together?**

```
RunId: "cm5xyz123abc"
    ↓
    ├─ Run Record (1)
    │   ├─ status: "RUNNING"
    │   ├─ searchIndustry: "Building maintenance"
    │   ├─ searchLocation: "Zürich"
    │   └─ targetLeadCount: 25
    │
    ├─ Lead Records (25)
    │   ├─ Lead 1: ABC Cleaning GmbH
    │   ├─ Lead 2: XYZ Services AG
    │   ├─ Lead 3: ...
    │   └─ Lead 25: ...
    │
    └─ LogEvent Records (100+)
        ├─ "Run started"
        ├─ "Discovery completed (google_places)"
        ├─ "Processed 1/25"
        ├─ "Processed 2/25"
        └─ "Run completed"
```

**All related to the same campaign!**

---

## Database Schema

### **Run Table**

```typescript
model Run {
  id                    String   @id @default(cuid())  // ← This is the runId!
  status                String   // QUEUED, RUNNING, COMPLETED, FAILED
  searchIndustry        String
  searchLocation        String
  searchDetailedCtx     String
  targetLeadCount       Int
  stopRequested         Boolean  @default(false)
  customChecksRaw       String
  customChecksJson      Json?
  createdAt             DateTime @default(now())
  startedAt             DateTime?
  completedAt           DateTime?

  // Relationships
  leads                 Lead[]      @relation("RunToLead")
  logEvents             LogEvent[]  @relation("RunToLogEvent")
}
```

**Key points:**
- `id` is auto-generated using `cuid()` → `"cm5xyz123abc"`
- This `id` becomes the `runId` used everywhere
- When you create a Run, you get back `run.id`

### **Lead Table**

```typescript
model Lead {
  id                    String   @id @default(cuid())
  runId                 String   // ← Foreign key to Run.id
  
  company_name          String?
  company_website       String?
  company_email         String?
  company_phone         String?
  quality_status        String   // VERIFIED, NEEDS_REVIEW, INCOMPLETE
  
  // ... 40+ other fields

  run                   Run      @relation("RunToLead", fields: [runId], references: [id], onDelete: Cascade)
}
```

**Key points:**
- Each Lead has a `runId` field
- This links the Lead to its parent Run
- If Run is deleted, all related Leads are deleted (cascade)

### **LogEvent Table**

```typescript
model LogEvent {
  id                    String   @id @default(cuid())
  runId                 String   // ← Foreign key to Run.id
  
  level                 String   // info, warn, error
  stage                 String   // discovery, enrichment, system, export
  message               String   // Human-readable message
  data                  Json?    // Optional structured data
  
  createdAt             DateTime @default(now())

  run                   Run      @relation("RunToLogEvent", fields: [runId], references: [id], onDelete: Cascade)
}
```

**Key points:**
- Each LogEvent has a `runId` field
- This links the log to its parent Run
- Logs are ordered by `createdAt` for timeline

---

## Database Logs Explained

### **What Are Database Logs?**

Instead of just using `console.log()` that disappears after the program runs, we **save logs to the database** using the `LogEvent` table.

### **Example:**

```typescript
// ❌ Console log (disappears, only in terminal)
console.log("Discovery completed");

// ✅ Database log (persisted, visible in UI)
await logEvent({
  runId: "cm5xyz123abc",
  level: "info",
  stage: "discovery",
  message: "Discovery completed (google_places)",
  data: { count: 25 }
});
```

This creates a record in PostgreSQL:

```sql
INSERT INTO "LogEvent" (id, runId, level, stage, message, data, createdAt)
VALUES (
  'log_abc123',
  'cm5xyz123abc',
  'info',
  'discovery',
  'Discovery completed (google_places)',
  '{"count": 25}',
  '2026-02-17T14:32:05.123Z'
);
```

---

## Why Store Logs in Database?

### **Problem Without Database Logs:**

```
User clicks Start → Worker processes job
    ↓
Worker terminal shows:
[Pipeline] Starting discovery...
[Discovery] Found 25 companies...
[Enrichment] Processing lead 1...
...
    ↓
User can't see any of this! 😞
```

**Issues:**
- ❌ User has no idea what's happening
- ❌ Logs disappear when worker restarts
- ❌ Can't track history of past runs
- ❌ No audit trail
- ❌ Can't debug issues after the fact

### **Solution With Database Logs:**

```
User clicks Start → Worker processes job
    ↓
Worker saves logs to PostgreSQL
    ↓
SSE stream sends logs to browser in real-time
    ↓
User sees live progress in UI! ✅
```

**Benefits:**
- ✅ User sees real-time progress
- ✅ Logs persist forever (or until Run deleted)
- ✅ Can view logs of past runs
- ✅ Full audit trail for compliance
- ✅ Debug issues even days later
- ✅ Multiple users can view same run's logs

---

## Why Database Logs Instead of Just Console Logs?

| Feature | Console Logs | Database Logs |
|---------|--------------|---------------|
| **Visible to user** | ❌ No (only in terminal) | ✅ Yes (shown in UI) |
| **Persist after restart** | ❌ No | ✅ Yes |
| **Real-time updates** | ❌ No | ✅ Yes (via SSE) |
| **Historical access** | ❌ No | ✅ Yes |
| **Searchable** | ❌ No | ✅ Yes (SQL queries) |
| **Structured data** | ❌ Limited | ✅ JSON support |
| **Multi-user access** | ❌ No | ✅ Yes |
| **Debugging** | ✅ Good for dev | ✅ Good for production |

---

## Complete Flow with RunId

### **1. User Clicks "Start"**

```typescript
// Frontend: app/page.tsx
async function startRun() {
  const res = await fetch("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      searchIndustry: "Building maintenance",
      searchLocation: "Zürich",
      targetLeadCount: 25
    })
  });
  
  const data = await res.json();
  // data = { success: true, runId: "cm5xyz123abc" }
  
  setRun({ id: data.runId, status: "QUEUED" });
  
  // Open SSE stream to receive logs for THIS runId
  startSse(data.runId);
}
```

### **2. API Creates Run and Returns RunId**

```typescript
// Backend: app/api/runs/route.ts
export async function POST(req: Request) {
  const body = await req.json();
  
  // Create Run record in database
  const run = await prisma.run.create({
    data: {
      status: "QUEUED",
      searchIndustry: body.searchIndustry,
      searchLocation: body.searchLocation,
      targetLeadCount: body.targetLeadCount
    }
  });
  
  // run.id = "cm5xyz123abc" ← Generated by Prisma
  
  // Add job to queue with runId
  await leadQueue.add("discover", { 
    runId: run.id  // ← Pass runId to worker
  });
  
  // Return runId to frontend
  return NextResponse.json({ 
    success: true, 
    runId: run.id  // ← Frontend stores this
  });
}
```

### **3. Worker Receives RunId and Starts Processing**

```typescript
// worker/worker.ts
const worker = new Worker("discovery", async (job) => {
  // Extract runId from job payload
  const { runId } = job.data;
  // runId = "cm5xyz123abc"
  
  console.log(`[Worker] Processing run: ${runId}`);
  
  // Call main pipeline with runId
  await runLeadDiscovery(runId);
});
```

### **4. Pipeline Logs Events with RunId**

```typescript
// src/server/pipeline.ts
export async function runLeadDiscovery(runId: string) {
  // runId = "cm5xyz123abc"
  
  // Load the Run record
  const run = await prisma.run.findUnique({ 
    where: { id: runId } 
  });
  
  // Update Run status
  await prisma.run.update({ 
    where: { id: runId }, 
    data: { status: "RUNNING" } 
  });
  
  // ✅ Log to database with runId
  await logEvent({
    runId: runId,  // ← Links log to this specific run
    level: "info",
    stage: "system",
    message: "Run started",
    data: { at: new Date().toISOString() }
  });
  
  // Discover companies
  const { candidates } = await discoverCandidates({...});
  
  // ✅ Log discovery completion with runId
  await logEvent({
    runId: runId,  // ← Same runId
    level: "info",
    stage: "discovery",
    message: "Discovery completed",
    data: { count: candidates.length }
  });
  
  // Create leads with runId
  for (const c of candidates) {
    await prisma.lead.create({
      data: {
        runId: runId,  // ← Links lead to this run
        company_name: c.company_name,
        // ...
      }
    });
  }
  
  // ✅ Log enrichment progress with runId
  await logEvent({
    runId: runId,  // ← Same runId
    level: "info",
    stage: "enrichment",
    message: "Processed 1/25",
    data: { leadId: "lead_abc" }
  });
  
  // ... more logs ...
  
  // ✅ Log completion with runId
  await logEvent({
    runId: runId,  // ← Same runId
    level: "info",
    stage: "system",
    message: "Run completed"
  });
}
```

### **5. SSE Stream Sends Logs to Frontend**

```typescript
// app/api/runs/[runId]/events/route.ts
export async function GET(
  req: Request,
  { params }: { params: { runId: string } }
) {
  const runId = params.runId;  // "cm5xyz123abc"
  
  const stream = new ReadableStream({
    async start(controller) {
      let lastCreatedAt = new Date(0);
      
      while (true) {
        // Query logs for THIS specific runId
        const newEvents = await prisma.logEvent.findMany({
          where: {
            runId: runId,  // ← Only logs for this run!
            createdAt: { gt: lastCreatedAt }
          },
          orderBy: { createdAt: "asc" },
          take: 100
        });
        
        // Send new events to browser
        for (const event of newEvents) {
          const data = JSON.stringify({
            type: "event",
            payload: event
          });
          controller.enqueue(`data: ${data}\n\n`);
          lastCreatedAt = event.createdAt;
        }
        
        // Send tick for refresh
        controller.enqueue(`data: ${JSON.stringify({ type: "tick" })}\n\n`);
        
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }
  });
  
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}
```

### **6. Frontend Displays Logs**

```typescript
// app/page.tsx
function startSse(runId: string) {
  const es = new EventSource(`/api/runs/${runId}/events`);
  
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    
    if (msg.type === "event") {
      // msg.payload = LogEvent record from database
      setLogs(prev => [...prev, msg.payload]);
    }
    
    if (msg.type === "tick") {
      // Refresh run status and leads
      refresh(runId);
    }
  };
}
```

---

## LogEvent Table Structure

### **Complete Schema:**

```typescript
model LogEvent {
  id                    String   @id @default(cuid())
  runId                 String
  level                 String   // "info" | "warn" | "error"
  stage                 String   // "discovery" | "enrichment" | "system" | "export"
  message               String   // Human-readable message
  data                  Json?    // Optional structured data (JSON)
  createdAt             DateTime @default(now())

  run                   Run      @relation("RunToLogEvent", fields: [runId], references: [id], onDelete: Cascade)
  
  @@index([runId, createdAt])  // Fast queries for SSE
}
```

### **Fields Explained:**

#### **1. id** (Primary Key)
```typescript
id: "logevt_abc123xyz"
```
- Unique identifier for this log entry
- Auto-generated by Prisma

#### **2. runId** (Foreign Key)
```typescript
runId: "cm5xyz123abc"
```
- Links this log to a specific Run
- **This is the most important field!**
- Allows us to query "all logs for run cm5xyz123abc"

#### **3. level** (Log Level)
```typescript
level: "info" | "warn" | "error"
```
- **info**: Normal operation (discovery completed, lead processed)
- **warn**: Something unusual (user stopped run, API rate limit)
- **error**: Something failed (enrichment error, API error)

#### **4. stage** (Pipeline Stage)
```typescript
stage: "discovery" | "enrichment" | "system" | "export" | "qualification"
```
- **discovery**: Finding companies via Google Places API
- **qualification**: Filtering/validating discovered companies
- **enrichment**: Crawling websites, extracting data
- **export**: Generating CSV files
- **system**: Starting/stopping runs, errors

#### **5. message** (Human-Readable)
```typescript
message: "Discovery completed (google_places)"
```
- What happened in plain English
- Shown directly to user in UI

#### **6. data** (Structured Data - JSON)
```typescript
data: {
  count: 25,
  source: "google_places",
  industry: "Building maintenance",
  location: "Zürich"
}
```
- Optional extra context
- Stored as JSON (can be complex objects)
- Used for debugging or analytics

#### **7. createdAt** (Timestamp)
```typescript
createdAt: "2026-02-17T14:32:05.123Z"
```
- When this log was created
- Auto-set by Prisma
- Used for ordering logs chronologically
- Used by SSE to get only new logs

---

## How SSE Uses Database Logs

### **The Problem:**

Worker is processing the job in a **separate process** from the Next.js API server. How do we send real-time updates to the browser?

### **The Solution: Server-Sent Events (SSE) + Database Logs**

```
Worker Process              Database              Next.js API          Browser
    │                          │                        │                 │
    ├─ logEvent()             →│                        │                 │
    │  (save to DB)            │                        │                 │
    │                          │                        │                 │
    │                          │←─ SELECT LogEvent     ─┤                 │
    │                          │   WHERE runId = ...    │                 │
    │                          │   AND createdAt > ...  │                 │
    │                          │                        │                 │
    │                          ├─ Return new logs      →│                 │
    │                          │                        │                 │
    │                          │                        ├─ SSE: data: {..}→│
    │                          │                        │                 │
    │                          │                        │                 ├─ Display log
    │                          │                        │                 │
    ├─ logEvent()             →│                        │                 │
    │  (another log)           │                        │                 │
    │                          │                        │                 │
    │                          │←─ SELECT LogEvent     ─┤                 │
    │                          ├─ Return new logs      →│                 │
    │                          │                        ├─ SSE: data: {..}→│
    │                          │                        │                 ├─ Display log
```

**Key Insight:**
- Worker writes logs to **database** (shared storage)
- SSE endpoint reads logs from **database**
- Database acts as a **message queue** between processes

### **SSE Code with Comments:**

```typescript
// app/api/runs/[runId]/events/route.ts
export async function GET(
  req: Request,
  { params }: { params: { runId: string } }
) {
  const runId = params.runId;
  
  const stream = new ReadableStream({
    async start(controller) {
      // Track last log timestamp we've seen
      let lastCreatedAt = new Date(0);  // Start from beginning
      
      // Infinite loop (SSE stays open)
      while (true) {
        // Query database for NEW logs only
        const newEvents = await prisma.logEvent.findMany({
          where: {
            runId: runId,                      // Only this run's logs
            createdAt: { gt: lastCreatedAt }   // Only logs after last check
          },
          orderBy: { createdAt: "asc" },       // Chronological order
          take: 100                            // Max 100 at a time
        });
        
        // Send each new log to browser
        for (const event of newEvents) {
          const message = JSON.stringify({
            type: "event",
            payload: {
              id: event.id,
              level: event.level,
              stage: event.stage,
              message: event.message,
              data: event.data,
              createdAt: event.createdAt
            }
          });
          
          // SSE format: "data: {json}\n\n"
          controller.enqueue(`data: ${message}\n\n`);
          
          // Update last seen timestamp
          lastCreatedAt = event.createdAt;
        }
        
        // Send periodic "tick" to trigger refresh
        const tick = JSON.stringify({ 
          type: "tick", 
          payload: { t: Date.now() } 
        });
        controller.enqueue(`data: ${tick}\n\n`);
        
        // Wait 1.2 seconds before next check
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }
  });
  
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}
```

**What this does:**
1. Browser opens SSE connection: `GET /api/runs/cm5xyz123abc/events`
2. Server enters infinite loop
3. Every 1.2 seconds:
   - Query database for new LogEvents where `runId = cm5xyz123abc` and `createdAt > lastTimestamp`
   - Send new logs to browser via SSE
   - Send "tick" message
4. Browser receives logs in real-time and displays them
5. Connection stays open until browser closes tab

---

## Practical Examples

### **Example 1: Logging Discovery**

```typescript
// src/server/connectors/discovery.ts
export async function discoverCandidates(params: {
  industry: string;
  location: string;
  limit: number;
  runId: string;  // ← Add runId parameter
}) {
  // Log what we're doing
  await logEvent({
    runId: params.runId,
    level: "info",
    stage: "discovery",
    message: `Starting discovery for "${params.industry}" in "${params.location}"`,
    data: { 
      industry: params.industry, 
      location: params.location,
      limit: params.limit 
    }
  });
  
  if (env.GOOGLE_MAPS_API_KEY) {
    // Log API call
    await logEvent({
      runId: params.runId,
      level: "info",
      stage: "discovery",
      message: "Using Google Places API",
      data: { apiKey: "***" + env.GOOGLE_MAPS_API_KEY.slice(-4) }
    });
    
    const candidates = await googlePlacesNewDiscover({...});
    
    // Log results
    await logEvent({
      runId: params.runId,
      level: "info",
      stage: "discovery",
      message: `Found ${candidates.length} companies`,
      data: { 
        count: candidates.length,
        source: "google_places",
        companies: candidates.slice(0, 5).map(c => c.company_name)  // First 5
      }
    });
    
    return { source: "google_places", candidates };
  }
  
  // Log fallback
  await logEvent({
    runId: params.runId,
    level: "warn",
    stage: "discovery",
    message: "No Google API key, using mock data",
    data: { reason: "GOOGLE_MAPS_API_KEY not set" }
  });
  
  return { source: "mock_registry", candidates: mockData };
}
```

**Result in UI:**
```
[14:32:01] INFO discovery: Starting discovery for "Building maintenance" in "Zürich"
[14:32:02] INFO discovery: Using Google Places API
[14:32:05] INFO discovery: Found 25 companies
```

### **Example 2: Logging Enrichment Progress**

```typescript
// src/server/pipeline.ts
await Promise.all(
  leadIds.map((leadId) =>
    limit(async () => {
      try {
        // Log start
        await logEvent({
          runId,
          level: "info",
          stage: "enrichment",
          message: `Enriching lead ${processed + 1}/${leadIds.length}`,
          data: { leadId }
        });
        
        await enrichOne(runId, leadId);
        
        processed += 1;
        
        // Log success
        await logEvent({
          runId,
          level: "info",
          stage: "enrichment",
          message: `Processed ${processed}/${leadIds.length}`,
          data: { leadId, status: "success" }
        });
        
      } catch (e: any) {
        failed += 1;
        
        // Log error
        await logEvent({
          runId,
          level: "error",
          stage: "enrichment",
          message: `Lead enrichment failed: ${e.message}`,
          data: { 
            leadId, 
            error: e.message, 
            stack: e.stack 
          }
        });
      }
    })
  )
);
```

**Result in UI:**
```
[14:32:10] INFO enrichment: Enriching lead 1/25
[14:32:35] INFO enrichment: Processed 1/25
[14:32:36] INFO enrichment: Enriching lead 2/25
[14:33:01] INFO enrichment: Processed 2/25
[14:33:02] INFO enrichment: Enriching lead 3/25
[14:33:15] ERROR enrichment: Lead enrichment failed: Timeout
[14:33:16] INFO enrichment: Enriching lead 4/25
...
```

### **Example 3: Logging API Errors**

```typescript
// src/server/connectors/googlePlacesNew.ts
try {
  const response = await fetch(
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey
      },
      body: JSON.stringify({ textQuery })
    }
  );
  
  if (!response.ok) {
    // Log API error
    await logEvent({
      runId,
      level: "error",
      stage: "discovery",
      message: `Google Places API error: ${response.status}`,
      data: { 
        status: response.status,
        statusText: response.statusText,
        url: response.url
      }
    });
    
    throw new Error(`Google Places API returned ${response.status}`);
  }
  
  const data = await response.json();
  return data.places;
  
} catch (error: any) {
  // Log exception
  await logEvent({
    runId,
    level: "error",
    stage: "discovery",
    message: `Discovery failed: ${error.message}`,
    data: { error: error.message }
  });
  
  throw error;
}
```

**Result in UI:**
```
[14:32:02] ERROR discovery: Google Places API error: 429
[14:32:03] ERROR discovery: Discovery failed: Google Places API returned 429
```

---

## Database Queries for Logs

### **Get All Logs for a Run**

```sql
SELECT * FROM "LogEvent" 
WHERE "runId" = 'cm5xyz123abc' 
ORDER BY "createdAt" ASC;
```

### **Get Only Error Logs**

```sql
SELECT * FROM "LogEvent" 
WHERE "runId" = 'cm5xyz123abc' 
  AND "level" = 'error' 
ORDER BY "createdAt" DESC;
```

### **Get Logs by Stage**

```sql
SELECT * FROM "LogEvent" 
WHERE "runId" = 'cm5xyz123abc' 
  AND "stage" = 'enrichment' 
ORDER BY "createdAt" ASC;
```

### **Count Logs by Level**

```sql
SELECT level, COUNT(*) as count 
FROM "LogEvent" 
WHERE "runId" = 'cm5xyz123abc' 
GROUP BY level;

-- Result:
-- | level | count |
-- |-------|-------|
-- | info  |   150 |
-- | warn  |     3 |
-- | error |     2 |
```

### **Get Latest 10 Logs**

```sql
SELECT * FROM "LogEvent" 
WHERE "runId" = 'cm5xyz123abc' 
ORDER BY "createdAt" DESC 
LIMIT 10;
```

---

## Summary

### **RunId:**
- ✅ Unique identifier for each lead discovery campaign
- ✅ Links together: Run, Leads, and LogEvents
- ✅ Passed through entire pipeline: API → Queue → Worker → Functions
- ✅ Used to query specific run's data: leads, logs, status

### **Database Logs:**
- ✅ Persistent (survive restarts)
- ✅ Real-time (streamed via SSE)
- ✅ User-visible (shown in UI)
- ✅ Structured (JSON data field)
- ✅ Queryable (SQL analytics)
- ✅ Audit trail (compliance)

### **Why Both Console + Database Logs?**

**Console Logs:**
- For **developers** debugging in terminal
- Immediate feedback during development
- No database overhead

**Database Logs:**
- For **users** tracking progress in UI
- Historical record
- Production monitoring

### **Key Takeaway:**

RunId is the "thread" that ties everything together:
```
User → Run (runId) → Job (runId) → Worker (runId) → Logs (runId) → SSE (runId) → UI
```

Every component knows which campaign it's working on because of the runId!

---

*Last updated: February 17, 2026*
