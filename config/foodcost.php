<?php

/** Configurazione specifica di FOOD COST (equivalente di apps/api/src/env.ts). */
return [
    'tz' => env('APP_TZ', 'Europe/Rome'),
    'app_url' => rtrim((string) env('APP_URL', 'http://localhost:8000'), '/'),
    'cookie_secure' => (bool) env('COOKIE_SECURE', false),
    'session_days' => (int) env('SESSION_DAYS', 14),
    'allowed_origins' => array_values(array_filter(array_map('trim', explode(',', (string) env('ALLOWED_ORIGINS', env('APP_URL', 'http://localhost:8000')))))),
    'import_max_bytes' => (int) env('IMPORT_MAX_BYTES', 10 * 1024 * 1024),
    'import_max_rows' => (int) env('IMPORT_MAX_ROWS', 20000),
    'import_retention_days' => (int) env('IMPORT_RETENTION_DAYS', 30),
    // secondi di lavoro per ogni passo delle importazioni (sotto il max_execution_time dell'hosting)
    'job_slice_seconds' => (float) env('JOB_SLICE_SECONDS', 4),
    // solo sviluppo: espone i link di reset/invito nella risposta (mai in produzione)
    'dev_expose_tokens' => env('APP_ENV') !== 'production' && (bool) env('DEV_EXPOSE_TOKENS', false),
    'login_rate_limit' => (int) env('LOGIN_RATE_LIMIT', 10),
    'rate_limit_in_tests' => false,
    // chiave per l'indirizzo del cron dell'hosting (/api/cron?k=...); vuota = indirizzo disattivato
    'cron_key' => (string) env('CRON_KEY', ''),
];
