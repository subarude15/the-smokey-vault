# Current task

**Status: idle**

PR144 complete — Keeper large-video upload path (Guest 150 MB vs env-tunable Keeper `KEEPER_GALLERY_MAX_VIDEO_MB` ceiling resolved server-side; large videos stream to a temp file and finalize with an atomic rename through one shared persistence core with no full-file Buffer; partial/failed uploads leave no temp file or DB row; PR143 posters, magic-byte validation, dedup, and reference-aware cleanup preserved; oversized uploads return 413 with human-readable copy).

Next planned product work: **PR145 — Gallery comments + up/down voting**.
