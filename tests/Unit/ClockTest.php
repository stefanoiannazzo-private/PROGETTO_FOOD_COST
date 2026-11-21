<?php

namespace Tests\Unit;

use App\Support\Clock;
use PHPUnit\Framework\TestCase;

class ClockTest extends TestCase
{
    public function test_plus_seconds_rispetta_il_segno(): void
    {
        $now = strtotime(Clock::now().' UTC');
        $this->assertEqualsWithDelta($now - 600, strtotime(Clock::plusSeconds(-600).' UTC'), 2);
        $this->assertEqualsWithDelta($now + 3600, strtotime(Clock::plusSeconds(3600).' UTC'), 2);
        $this->assertEqualsWithDelta($now - 30 * 86400, strtotime(Clock::plusSeconds(-30 * 86400).' UTC'), 2);
    }
}
