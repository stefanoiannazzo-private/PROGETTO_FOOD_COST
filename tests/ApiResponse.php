<?php

namespace Tests;

final class ApiResponse
{
    public function __construct(public readonly int $status, public readonly mixed $body, public readonly mixed $raw = null)
    {
    }
}
