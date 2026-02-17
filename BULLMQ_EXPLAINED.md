# BullMQ Queue System - Complete Guide

## Table of Contents
1. [What is BullMQ?](#what-is-bullmq)
2. [Why Use BullMQ?](#why-use-bullmq)
3. [Complete Code Flow](#complete-code-flow)
4. [Understanding the Components](#understanding-the-components)
5. [Logging and Debugging](#logging-and-debugging)
6. [Common Issues](#common-issues)

---

## What is BullMQ?

**BullMQ** is a Node.js library for handling background jobs using **Redis** as a message broker.

### Key Concepts:

**Queue** - A list of jobs waiting to be processed (stored in Redis)
**Job** - A unit of work with a name and data payload
**Worker** - A separate process that picks jobs from the queue and executes them
**Redis** - In-memory database that stores the queue

### Analogy:
Think of it like a restaurant:
- **Queue** = Order tickets on the kitchen board
- **Job** = Individual order with details
- **Worker** = Chef picking orders and cooking them
- **Redis** = The board where orders are posted

---

## Why Use BullMQ?

### **Problem Without BullMQ:**

```typescript
// BAD: API endpoint that blocks for 5 minutes
export async function POST(req: Request) {
  const run = await createRun(req.body);
  
  // This takes 5+ minutes! 😱
  await discoverLeads(run.id);
  await enrichLeads(run.id);
  await verifyLeads(run.id);
  
  return json({ success: true }); // Browser times out!
}
```

**Problems:**
- ❌ Browser timeout (most browsers timeout after 30-120 seconds)
- ❌ If server crashes, all progress lost
- ❌ Can't scale (all work happens in API process)
- ❌ No retry on failures
- ❌ User has to wait with loading spinner

---

### **Solution With BullMQ:**

```typescript
// GOOD: API endpoint returns immediately
export async function POST(req: Request) {
  const run = await createRun(req.body);
  
  // Add job to queue (takes ~1ms)
  await queue.add("discover", { runId: run.id });
  
  return json({ success: true }); // Returns in <1 second ✅
}
```

**Benefits:**
- ✅ API returns immediately (< 1 second)
- ✅ Work happens in background worker
- ✅ Jobs persist in Redis (survive crashes)
- ✅ Automatic retries on failure
- ✅ Can scale (multiple workers)
- ✅ User sees real-time progress via SSE

---

## Complete Code Flow

### **Step 1: User Clicks "Start" Button**

**File:** [app/page.tsx](app/page.tsx)

```typescript
async function startRun() {
  setLoading(true);
  
  // POST to API endpoint
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      searchIndustry: "Building maintenance",
      searchLocation: "Zürich",
      targetLeadCount: 25
    })
  });
  
  const data = await res.json();
  // data = { success: true, runId: "cm5xyz123" }
  
  // Open SSE stream for live updates
  startSse(data.runId);
  
  setLoading(false);
}
```

**What happens:**
1. User fills form and clicks "Start"
2. Frontend sends POST request to `/api/runs`
3. Frontend waits for response (~1 second)
4. Frontend opens SSE stream for real-time updates

---

### **Step 2: API Creates Run and Queues Job**

**File:** [app/api/runs/route.ts](app/api/runs/route.ts)

```typescript
import { prisma } from "@/lib/prisma";
import { leadQueue } from "@/lib/queue";

export async function POST(req: Request) {
  // 1. Parse request body
  const body = await req.json();
  const {
    searchIndustry,
    searchLocation,
    searchDetailedCtx,
    customChecksRaw,
    targetLeadCount
  } = body;

  // 2. Create Run record in PostgreSQL
  const run = await prisma.run.create({
    data: {
      status: "QUEUED",              // Initial status
      searchIndustry: searchIndustry,
      searchLocation: searchLocation,
      searchDetailedCtx: searchDetailedCtx || "",
      customChecksRaw: customChecksRaw || "",
      targetLeadCount: targetLeadCount,
      stopRequested: false
    }
  });
  
  // run.id = "cm5xyz123" (auto-generated)

  // 3. Add job to BullMQ queue
  await leadQueue.add(
    "discover",              // Job name/type
    { runId: run.id },      // Job payload (data for worker)
    { 
      removeOnComplete: true,  // Delete job after success
      removeOnFail: 100,       // Keep last 100 failed jobs
      attempts: 3,             // Retry 3 times on failure
      backoff: {
        type: "exponential",   // Wait 1s, 2s, 4s between retries
        delay: 1000
      }
    }
  );

  // 4. Return immediately (don't wait for job to finish)
  return NextResponse.json({ 
    success: true, 
    runId: run.id 
  });
}
```

**What happens:**
1. API validates input
2. API creates `Run` record in PostgreSQL with status `QUEUED`
3. API adds job to Redis queue with payload `{ runId: "cm5xyz123" }`
4. API returns immediately (total time: ~50-200ms)
5. Job sits in Redis queue waiting for worker

**What gets stored in Redis:**
```json
{
  "id": "1",
  "name": "discover",
  "data": {
    "runId": "cm5xyz123"
  },
  "opts": {
    "removeOnComplete": true,
    "removeOnFail": 100,
    "attempts": 3
  },
  "timestamp": 1708185600000,
  "attemptsMade": 0
}
```

---

### **Step 3: Queue Setup**

**File:** [src/lib/queue.ts](src/lib/queue.ts)

```typescript
import { Queue } from "bullmq";
import { redisConnection } from "./redis";

// Create a queue named "discovery"
export const leadQueue = new Queue(
  "discovery",           // Queue name
  { 
    connection: redisConnection  // Redis connection config
  }
);
```

**File:** [src/lib/redis.ts](src/lib/redis.ts)

```typescript
import { env } from "./env";

// Redis connection configuration
export const redisConnection = {
  host: "localhost",
  port: 6379,
  // Or parse from REDIS_URL: "redis://localhost:6379"
};
```

**What this does:**
- Creates a queue named `"discovery"` in Redis
- All jobs added to this queue are stored under Redis keys like:
  - `bull:discovery:waiting`
  - `bull:discovery:active`
  - `bull:discovery:completed`
  - `bull:discovery:failed`

---

### **Step 4: Worker Picks Up Job**

**File:** [worker/worker.ts](worker/worker.ts)

```typescript
import { Worker } from "bullmq";
import { redisConnection } from "@/lib/redis";
import { runLeadDiscovery } from "@/server/pipeline";
import { prisma } from "@/lib/prisma";

// Create a Worker that processes jobs from "discovery" queue
const worker = new Worker(
  "discovery",           // Queue name (must match queue)
  
  // Job processor function
  async (job) => {
    console.log(`[Worker] Started job: ${job.id}`);
    console.log(`[Worker] Job name: ${job.name}`);
    console.log(`[Worker] Job data:`, job.data);
    
    // Extract runId from job payload
    const { runId } = job.data;
    
    try {
      // Call main pipeline function
      await runLeadDiscovery(runId);
      
      console.log(`[Worker] Completed job: ${job.id}`);
      
    } catch (error) {
      console.error(`[Worker] Job failed:`, error);
      
      // Update Run status to FAILED
      await prisma.run.update({
        where: { id: runId },
        data: { status: "FAILED" }
      });
      
      throw error; // Re-throw so BullMQ marks job as failed
    }
  },
  
  // Worker options
  {
    connection: redisConnection,
    concurrency: 1  // Process 1 job at a time
  }
);

// Event handlers
worker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed successfully`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err.message);
});

worker.on("error", (err) => {
  console.error(`⚠️ Worker error:`, err);
});

console.log("🚀 Worker started, waiting for jobs...");
```

**How to run:**
```bash
# Terminal 1: Next.js dev server
npm run dev

# Terminal 2: Worker process (SEPARATE TERMINAL!)
npm run worker
```

**What happens:**
1. Worker connects to Redis and polls `bull:discovery:waiting` queue
2. When it finds a job, it:
   - Moves job from `waiting` to `active` list
   - Calls processor function with `job.data = { runId: "cm5xyz123" }`
   - Waits for processor to complete
3. If successful:
   - Moves job to `completed` list
   - Deletes job (because `removeOnComplete: true`)
4. If failed:
   - Moves job to `failed` list
   - Retries up to 3 times
   - Keeps last 100 failed jobs

---

### **Step 5: Pipeline Execution**

**File:** [src/server/pipeline.ts](src/server/pipeline.ts)

```typescript
import { prisma } from "@/lib/prisma";
import { logEvent } from "@/lib/log";
import { discoverCandidates } from "./connectors/discovery";
import pLimit from "p-limit";
import { env } from "@/lib/env";

export async function runLeadDiscovery(runId: string) {
  console.log(`[Pipeline] Starting discovery for run: ${runId}`);
  
  // ============================================
  // 1. LOAD RUN FROM DATABASE
  // ============================================
  const run = await prisma.run.findUnique({ 
    where: { id: runId } 
  });
  
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  // ============================================
  // 2. UPDATE STATUS TO RUNNING
  // ============================================
  await prisma.run.update({ 
    where: { id: runId }, 
    data: { status: "RUNNING" } 
  });
  
  await logEvent({
    runId,
    level: "info",
    stage: "system",
    message: "Run started",
    data: { at: new Date().toISOString() }
  });

  // ============================================
  // 3. DISCOVERY PHASE - Find companies
  // ============================================
  console.log(`[Pipeline] Discovering candidates...`);
  
  const { source, candidates } = await discoverCandidates({
    industry: run.searchIndustry,      // e.g., "Building maintenance"
    location: run.searchLocation,      // e.g., "Zürich"
    detailedContext: run.searchDetailedCtx,
    limit: run.targetLeadCount         // e.g., 25
  });
  
  console.log(`[Pipeline] Discovery completed: ${source}, ${candidates.length} candidates`);

  await logEvent({
    runId,
    level: "info",
    stage: "discovery",
    message: `Discovery completed (${source})`,
    data: { count: candidates.length }
  });

  // ============================================
  // 4. CREATE LEAD RECORDS
  // ============================================
  const leadIds: string[] = [];
  
  for (const c of candidates) {
    const lead = await prisma.lead.create({
      data: {
        runId,
        search_industry: run.searchIndustry,
        search_location: run.searchLocation,
        company_name: c.company_name,
        company_website: c.company_website ?? null,
        company_email: c.company_email ?? null,
        company_phone: c.company_phone ?? null,
        address_street: c.address_street ?? null,
        address_city: c.address_city ?? null,
        address_postcode: c.address_postcode ?? null,
        address_country: c.address_country ?? null,
        quality_status: "INCOMPLETE"  // Initial status
      }
    });
    
    leadIds.push(lead.id);
  }
  
  console.log(`[Pipeline] Created ${leadIds.length} lead records`);

  await logEvent({
    runId,
    level: "info",
    stage: "qualification",
    message: "Leads created, starting enrichment",
    data: { leads: leadIds.length }
  });

  // ============================================
  // 5. ENRICHMENT PHASE - Process leads
  // ============================================
  console.log(`[Pipeline] Starting enrichment (concurrency: ${env.ENRICH_CONCURRENCY})...`);
  
  // Create concurrency limiter (max 3 at once)
  const limit = pLimit(env.ENRICH_CONCURRENCY);  // Default: 3
  
  let processed = 0;
  let failed = 0;

  // Process all leads with concurrency limit
  await Promise.all(
    leadIds.map((leadId) =>
      limit(async () => {  // Only 3 will run at once
        
        // Check if user clicked "Stop"
        const r = await prisma.run.findUnique({ 
          where: { id: runId }, 
          select: { stopRequested: true } 
        });
        
        if (r?.stopRequested) {
          console.log(`[Pipeline] Stop requested, skipping lead ${leadId}`);
          return;
        }

        try {
          console.log(`[Pipeline] Enriching lead ${leadId}...`);
          
          // Enrich this lead (crawl website, extract data, etc.)
          await enrichOne(runId, leadId);
          
          console.log(`[Pipeline] Lead ${leadId} enriched successfully`);
          
        } catch (e: any) {
          failed += 1;
          console.error(`[Pipeline] Lead ${leadId} failed:`, e.message);
          
          await logEvent({
            runId,
            level: "error",
            stage: "enrichment",
            message: "Lead enrichment failed",
            data: { leadId, error: String(e?.message ?? e) }
          });

          // Mark lead as INCOMPLETE on error
          const lead = await prisma.lead.findUnique({ where: { id: leadId } });
          if (lead) {
            const vr = verifyLead(lead);
            await prisma.lead.update({
              where: { id: leadId },
              data: {
                quality_status: vr.status,
                quality_reasons: [...vr.reasons, "enrichment_error"]
              }
            });
          }
        }

        processed += 1;
        
        // Log progress
        await logEvent({
          runId,
          level: "info",
          stage: "enrichment",
          message: `Processed ${processed}/${leadIds.length}`,
          data: { leadId, failed }
        });
      })
    )
  );

  console.log(`[Pipeline] Enrichment completed: ${processed} processed, ${failed} failed`);

  // ============================================
  // 6. CHECK IF USER STOPPED
  // ============================================
  const r2 = await prisma.run.findUnique({ 
    where: { id: runId }, 
    select: { stopRequested: true } 
  });

  if (r2?.stopRequested) {
    await prisma.run.update({ 
      where: { id: runId }, 
      data: { status: "COMPLETED" } 
    });
    
    await logEvent({
      runId,
      level: "warn",
      stage: "system",
      message: "Run stopped by user",
      data: { at: new Date().toISOString() }
    });
    
    console.log(`[Pipeline] Run stopped by user`);
    return;
  }

  // ============================================
  // 7. MARK RUN AS COMPLETED
  // ============================================
  await prisma.run.update({ 
    where: { id: runId }, 
    data: { status: "COMPLETED" } 
  });
  
  await logEvent({
    runId,
    level: "info",
    stage: "system",
    message: "Run completed",
    data: { at: new Date().toISOString() }
  });
  
  console.log(`[Pipeline] Run completed successfully`);
}
```

**What happens:**
1. Loads Run from database
2. Updates status to `RUNNING`
3. Discovers 25 companies via Google Places API
4. Creates 25 Lead records in database
5. Enriches leads **3 at a time** (parallel)
6. Each enrichment: crawls website, extracts emails/phones
7. Updates Run status to `COMPLETED`

---

### **Step 6: Discovery Connector**

**File:** [src/server/connectors/discovery.ts](src/server/connectors/discovery.ts)

```typescript
import { env } from "@/lib/env";
import { googlePlacesNewDiscover } from "./googlePlacesNew";
import { mockRegistryDiscover } from "./mockRegistry";

export async function discoverCandidates(params: {
  industry: string;
  location: string;
  detailedContext: string;
  limit: number;
}) {
  // Log to worker terminal
  console.log(`[Discovery] Starting discovery...`);
  console.log(`[Discovery] Industry: ${params.industry}`);
  console.log(`[Discovery] Location: ${params.location}`);
  console.log(`[Discovery] Limit: ${params.limit}`);
  console.log(`[Discovery] Google API Key: ${env.GOOGLE_MAPS_API_KEY ? "YES" : "NO"}`);

  // Option 1: Google Places API (if key configured)
  if (env.GOOGLE_MAPS_API_KEY) {
    console.log(`[Discovery] Using Google Places API...`);
    
    const candidates = await googlePlacesNewDiscover({
      industry: params.industry,
      location: params.location,
      limit: params.limit,
      apiKey: env.GOOGLE_MAPS_API_KEY,
      regionCode: env.GOOGLE_PLACES_REGION,
      languageCode: env.GOOGLE_PLACES_LANGUAGE,
    });

    console.log(`[Discovery] Discovered ${candidates.length} candidates from Google Places`);

    return { source: "google_places", candidates };
  }

  // Option 2: Mock registry (dev mode)
  console.log(`[Discovery] Using mock registry (no Google API key)...`);
  
  const candidates = mockRegistryDiscover({ 
    industry: params.industry, 
    location: params.location, 
    limit: params.limit 
  });
  
  console.log(`[Discovery] Discovered ${candidates.length} candidates from mock registry`);

  return { source: "mock_registry", candidates };
}
```

---

## Understanding the Components

### **Redis Keys Structure**

When BullMQ creates jobs, it stores them in Redis with these keys:

```
bull:discovery:id                 → Auto-incrementing job ID counter
bull:discovery:waiting            → List of job IDs waiting to be processed
bull:discovery:active             → List of job IDs currently being processed
bull:discovery:completed          → List of completed job IDs (auto-deleted)
bull:discovery:failed             → List of failed job IDs (keeps last 100)
bull:discovery:paused             → List of paused jobs
bull:discovery:delayed            → Sorted set of delayed jobs
bull:discovery:stalled-check      → Timestamp of last stalled check

bull:discovery:1                  → Job data for job ID 1
bull:discovery:2                  → Job data for job ID 2
```

**Inspect Redis:**
```bash
# Connect to Redis CLI
redis-cli

# List waiting jobs
LRANGE bull:discovery:waiting 0 -1

# List active jobs
LRANGE bull:discovery:active 0 -1

# Get job data
GET bull:discovery:1

# See all keys
KEYS bull:discovery:*
```

---

### **Job Lifecycle**

```
1. Job Created
   ↓
   [Queue: waiting]
   ↓
2. Worker picks job
   ↓
   [Queue: active]
   ↓
3. Processing...
   ↓
4a. Success              4b. Failure
    ↓                        ↓
    [Queue: completed]       [Queue: failed]
    ↓                        ↓
    Auto-deleted            Retry (3x)
                            ↓
                            Keep last 100
```

---

### **Job Options Explained**

```typescript
await leadQueue.add(
  "discover",
  { runId: run.id },
  {
    // Delete job from Redis after successful completion
    removeOnComplete: true,
    
    // Keep last 100 failed jobs for debugging
    removeOnFail: 100,
    
    // Retry failed jobs up to 3 times
    attempts: 3,
    
    // Exponential backoff: wait 1s, 2s, 4s between retries
    backoff: {
      type: "exponential",
      delay: 1000
    },
    
    // Job priority (lower = higher priority)
    priority: 1,
    
    // Delay job execution by X milliseconds
    delay: 0,
    
    // Job timeout (fail if exceeds this)
    timeout: 300000  // 5 minutes
  }
);
```

---

### **Concurrency Limiting with pLimit**

```typescript
import pLimit from "p-limit";

// Create limiter (max 3 concurrent)
const limit = pLimit(3);

const leadIds = ["lead1", "lead2", "lead3", ..., "lead25"];

// Map all to promises
await Promise.all(
  leadIds.map((leadId) =>
    limit(async () => {     // ← This enforces max 3 concurrent
      await enrichLead(leadId);  // Takes 30 seconds each
    })
  )
);
```

**Without pLimit:**
```
All 25 leads start at once → overwhelm server → crashes
```

**With pLimit(3):**
```
T+0s:   Lead 1, 2, 3 start
T+30s:  Lead 1 done → Lead 4 starts
T+31s:  Lead 2 done → Lead 5 starts
T+32s:  Lead 3 done → Lead 6 starts
...
```

---

## Logging and Debugging

### **Two Types of Logs**

#### **1. Console Logs (Worker Terminal)**

These appear in the **worker terminal** (`npm run worker`):

```typescript
console.log(`[Pipeline] Starting discovery...`);
console.log(`[Discovery] Using Google Places API...`);
console.log(`[Crawler] Crawling https://example.com...`);
```

**Where to see:**
```bash
# Terminal 2 (worker)
npm run worker

# Output:
[Pipeline] Starting discovery for run: cm5xyz123
[Discovery] Using Google Places API...
[Discovery] Discovered 25 candidates from Google Places
[Pipeline] Created 25 lead records
...
```

#### **2. Database Logs (UI Live Log)**

These appear in the **frontend UI** via SSE:

```typescript
await logEvent({
  runId,
  level: "info",         // info | warn | error
  stage: "discovery",    // discovery | enrichment | system
  message: "Discovery completed (google_places)",
  data: { count: 25 }
});
```

**Where to see:**
- Browser UI at `http://localhost:3000`
- Live log panel shows real-time events
- Also stored in `LogEvent` table in PostgreSQL

---

### **Where Logs Appear - Visual Guide**

```
┌─────────────────────────────────────────────────────────────┐
│ Terminal 1: npm run dev                                     │
├─────────────────────────────────────────────────────────────┤
│ ✓ Ready on http://localhost:3000                            │
│ ○ Compiling /api/runs ...                                   │
│ ✓ Compiled /api/runs in 234ms                               │
│                                                              │
│ (NO pipeline logs here!)                                    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Terminal 2: npm run worker                                  │
├─────────────────────────────────────────────────────────────┤
│ 🚀 Worker started, waiting for jobs...                      │
│ [Worker] Started job: 1                                     │
│ [Pipeline] Starting discovery for run: cm5xyz123            │
│ [Discovery] Industry: Building maintenance                  │
│ [Discovery] Location: Zürich                                │
│ [Discovery] Google API Key: YES                             │
│ [Discovery] Using Google Places API...                      │
│ [Discovery] Discovered 25 candidates from Google Places     │
│ [Pipeline] Created 25 lead records                          │
│ [Pipeline] Starting enrichment (concurrency: 3)...          │
│ [Pipeline] Enriching lead abc...                            │
│ [Crawler] Crawling https://example.com...                   │
│ ...                                                          │
│                                                              │
│ (ALL pipeline logs appear here!)                            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Browser: http://localhost:3000                              │
├─────────────────────────────────────────────────────────────┤
│ SDI Lead Discovery                                          │
│                                                              │
│ [Industry: Building maintenance] [Location: Zürich]         │
│ [Start] [Stop]                                              │
│                                                              │
│ Run: cm5xyz123 | Status: RUNNING                            │
│                                                              │
│ Live log (SSE):                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ [14:32:01] INFO system: Run started                     │ │
│ │ [14:32:05] INFO discovery: Discovery completed (goog... │ │
│ │ [14:32:06] INFO qualification: Leads created, starti... │ │
│ │ [14:32:45] INFO enrichment: Processed 1/25              │ │
│ │ [14:33:12] INFO enrichment: Processed 2/25              │ │
│ │ ...                                                     │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                              │
│ (logEvent() entries appear here via SSE!)                   │
└─────────────────────────────────────────────────────────────┘
```

---

### **How to Add Logs**

#### **For Worker Terminal (Debugging):**

```typescript
// Any file in src/server/
console.log(`[YourComponent] Your message here`);
console.error(`[YourComponent] Error:`, error);
```

**Appears in:** Terminal 2 (`npm run worker`)

#### **For UI Live Log (User-Visible):**

```typescript
import { logEvent } from "@/lib/log";

await logEvent({
  runId: runId,              // Required
  level: "info",             // "info" | "warn" | "error"
  stage: "discovery",        // "discovery" | "enrichment" | "system" | etc.
  message: "Found 25 companies",
  data: { count: 25 }        // Optional JSON data
});
```

**Appears in:**
- Browser UI (live log panel)
- PostgreSQL `LogEvent` table
- Worker terminal (if you console.log it)

---

## Common Issues

### **Issue 1: "Worker Not Picking Up Jobs"**

**Symptoms:**
- Frontend shows status `QUEUED` forever
- Worker terminal shows no activity

**Solutions:**

1. **Check if worker is running:**
   ```bash
   # Terminal 2
   npm run worker
   
   # Should show:
   # 🚀 Worker started, waiting for jobs...
   ```

2. **Check Redis connection:**
   ```bash
   redis-cli ping
   # Should return: PONG
   ```

3. **Check queue names match:**
   ```typescript
   // In queue.ts
   export const leadQueue = new Queue("discovery", ...);
   
   // In worker.ts
   const worker = new Worker("discovery", ...);
   //                         ^^^^^^^^^^^ Must match!
   ```

---

### **Issue 2: "Can't See Console Logs"**

**Problem:**
```typescript
console.log(`googleMapsKey=${env.GOOGLE_MAPS_API_KEY ? "YES" : "NO"}`);
```
Not appearing anywhere!

**Solution:**
Logs from `src/server/` code appear in **worker terminal**, not dev server terminal.

**Check:**
```bash
# Terminal 2 (worker)
npm run worker

# Logs appear here ↑
```

---

### **Issue 3: "Job Keeps Failing and Retrying"**

**Symptoms:**
- Worker logs show same error 3 times
- Run status stuck on `RUNNING`

**Solutions:**

1. **Check error message:**
   ```bash
   # Worker terminal
   ❌ Job 1 failed: Error: Run not found: cm5xyz123
   ```

2. **Check database:**
   ```sql
   SELECT id, status FROM "Run" WHERE id = 'cm5xyz123';
   ```

3. **Check job options:**
   ```typescript
   await leadQueue.add("discover", { runId }, {
     attempts: 3,  // ← Reduce to 1 for faster debugging
   });
   ```

---

### **Issue 4: "Redis Connection Refused"**

**Symptoms:**
```
Error: connect ECONNREFUSED 127.0.0.1:6379
```

**Solutions:**

1. **Start Redis (Docker):**
   ```bash
   docker-compose up -d redis
   ```

2. **Start Redis (Local):**
   ```bash
   # Windows (WSL)
   sudo service redis-server start
   
   # Mac
   brew services start redis
   
   # Linux
   sudo systemctl start redis
   ```

3. **Check Redis is running:**
   ```bash
   redis-cli ping
   # Should return: PONG
   ```

---

### **Issue 5: "Job Stuck in Active State"**

**Symptoms:**
- Worker crashed mid-job
- Job never moves to completed/failed

**Solutions:**

1. **Restart worker:**
   ```bash
   # Ctrl+C to stop
   npm run worker
   ```

2. **BullMQ automatically detects stalled jobs:**
   - After 30 seconds, moves job back to waiting
   - Worker picks it up again

3. **Manually clean Redis:**
   ```bash
   redis-cli
   > DEL bull:discovery:active
   > DEL bull:discovery:1
   ```

---

## Redis CLI Debugging Commands

```bash
# Connect to Redis
redis-cli

# List all BullMQ keys
KEYS bull:discovery:*

# Check waiting jobs
LRANGE bull:discovery:waiting 0 -1
# Returns: ["1", "2", "3"]

# Check active jobs
LRANGE bull:discovery:active 0 -1
# Returns: ["4"]

# Get job data
GET bull:discovery:1
# Returns: JSON with job details

# Count jobs in each state
LLEN bull:discovery:waiting
LLEN bull:discovery:active
LLEN bull:discovery:completed
LLEN bull:discovery:failed

# Delete all jobs (CAREFUL!)
DEL bull:discovery:waiting
DEL bull:discovery:active
DEL bull:discovery:completed
DEL bull:discovery:failed

# Delete specific job
DEL bull:discovery:1

# Flush all Redis data (NUCLEAR OPTION!)
FLUSHALL
```

---

## Timeline Example

**Complete flow from start to finish:**

```
T+0ms:     User clicks "Start" button
           
T+50ms:    Frontend POST /api/runs
           
T+100ms:   API creates Run (QUEUED) in PostgreSQL
           Run ID: cm5xyz123
           
T+150ms:   API adds job to Redis queue
           Job ID: 1
           Job name: "discover"
           Job data: { runId: "cm5xyz123" }
           
T+200ms:   API returns to frontend
           Response: { success: true, runId: "cm5xyz123" }
           
T+250ms:   Frontend opens SSE stream
           GET /api/runs/cm5xyz123/events
           
           ─────────────────────────────────────
           
T+300ms:   Worker polls Redis queue
           Finds job ID: 1
           Moves job to "active"
           
T+350ms:   Worker calls runLeadDiscovery("cm5xyz123")
           
T+400ms:   Pipeline updates Run.status = "RUNNING"
           
T+450ms:   Pipeline logs: "Run started"
           → SSE sends to frontend
           → Frontend shows in live log
           
T+500ms:   Pipeline calls discoverCandidates()
           
T+600ms:   Discovery calls Google Places API
           Query: "Building maintenance in Zürich"
           
T+5s:      Google Places returns 25 results
           
T+5.1s:    Pipeline creates 25 Lead records
           
T+5.2s:    Pipeline logs: "Discovery completed (google_places)"
           → SSE sends to frontend
           
T+5.3s:    Pipeline starts enrichment (3 concurrent)
           
T+5.4s:    Lead 1, 2, 3 start enriching
           
T+35s:     Lead 1 done → Lead 4 starts
           Pipeline logs: "Processed 1/25"
           
T+36s:     Lead 2 done → Lead 5 starts
           Pipeline logs: "Processed 2/25"
           
T+37s:     Lead 3 done → Lead 6 starts
           Pipeline logs: "Processed 3/25"
           
...
           
T+4min:    All 25 leads enriched
           
T+4min:    Pipeline updates Run.status = "COMPLETED"
           
T+4min:    Pipeline logs: "Run completed"
           → SSE sends to frontend
           → Frontend shows downloads
           
T+4min:    Worker marks job as completed
           Redis deletes job (removeOnComplete: true)
           
T+4min:    Worker logs: "✅ Job 1 completed successfully"
```

---

## Package.json Scripts

```json
{
  "scripts": {
    "dev": "next dev",              // Next.js dev server (Terminal 1)
    "worker": "tsx worker/worker.ts", // Worker process (Terminal 2)
    "build": "next build",
    "start": "next start"
  }
}
```

**Running in production:**
```bash
# Terminal 1: Web server
npm run build
npm run start

# Terminal 2: Worker (or use PM2, systemd, etc.)
npm run worker
```

**Using PM2 (process manager):**
```bash
pm2 start npm --name "web" -- run start
pm2 start npm --name "worker" -- run worker
pm2 logs
```

---

## Summary

### **Key Takeaways:**

1. **BullMQ separates API from long-running work**
   - API returns in <1 second
   - Worker processes job in background

2. **Redis stores job queue**
   - Jobs persist across crashes
   - Automatic retries on failure

3. **Two separate processes:**
   - Terminal 1: `npm run dev` (Next.js API)
   - Terminal 2: `npm run worker` (Job processor)

4. **Logs appear in different places:**
   - `console.log()` → Worker terminal
   - `logEvent()` → Frontend UI + Database

5. **Job lifecycle:**
   - Created → Waiting → Active → Completed/Failed

6. **Concurrency control with pLimit:**
   - Prevents overwhelming servers
   - Processes 3 leads at once (configurable)

---

*Last updated: February 17, 2026*
