@echo off
cd /d "C:\aigamma.com"
if errorlevel 1 (
    echo Failed to change to C:\aigamma.com
    pause
    exit /b 1
)
REM Set RAG_DRY_RUN=1 to chunk + hash without writing to Supabase (preview mode).
REM Set RAG_DRY_RUN=0 (or remove the line) to actually upsert chunks.
set RAG_DRY_RUN=0
REM Batch size of 1 avoids WORKER_RESOURCE_LIMIT 546 errors on Supabase's
REM gte-small Edge Function (the embedding model runs out of compute on
REM larger batches). Slower (~2-5 min vs 30 s for a typical full corpus pass)
REM but reliably ships every chunk; idempotent on content_hash so unchanged
REM chunks skip the embed round-trip on re-runs.
set RAG_BATCH_SIZE=1
node --env-file=.env scripts/rag/ingest.mjs
echo.
echo Done. Press any key to close this window.
pause >nul