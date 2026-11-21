<?php

declare(strict_types=1);

namespace App\Http\Requests;

use App\Support\Validation\S;
use App\Support\Validation\Schema;

/** Schemi condivisi tra le richieste (port di apps/api/src/http/schemas.ts). */
final class Schemas
{
    public static function listQuery(array $extra = []): Schema
    {
        return S::object([
            'q' => S::string()->trim()->max(100)->optional(),
            'page' => S::coerceInt(1)->default(1),
            'pageSize' => S::coerceInt(1, 100)->default(25),
            'sort' => S::string()->max(40)->optional(),
            'dir' => S::enum(['asc', 'desc'])->default('asc'),
            'archived' => S::enum(['0', '1', 'all'])->default('0'),
            'category' => S::string()->trim()->max(100)->optional(),
            ...$extra,
        ]);
    }

    public static function dateQuery(): Schema
    {
        return S::object(['date' => S::isoDate()->optional()]);
    }
}
