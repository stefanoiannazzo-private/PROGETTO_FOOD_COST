<?php

namespace Tests\Feature;

use Tests\TestCase;

/** NUOVO — guida del primo accesso: /auth/me espone tourDone, POST /auth/tour lo registra. */
class TourTest extends TestCase
{
    public function test_la_guida_si_segna_come_vista_e_si_puo_riattivare(): void
    {
        $c = $this->createCompany('Trattoria Guida');
        $this->addMember($c, $this->createUser('a@guida.test', 'A'), 'admin');
        $a = $this->loginAs('a@guida.test');
        $this->assertFalse($this->ok($a->get('/api/auth/me'))['tourDone']);
        $this->ok($a->post('/api/auth/tour', ['done' => true]));
        $this->assertTrue($this->ok($a->get('/api/auth/me'))['tourDone']);
        $this->ok($a->post('/api/auth/tour', ['done' => false]));
        $this->assertFalse($this->ok($a->get('/api/auth/me'))['tourDone']);
    }
}
