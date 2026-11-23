<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** NUOVO — selettore di stato nella scheda ricetta: bozza ↔ attiva. */
class RecipeStatusTest extends TestCase
{
    public function test_attiva_e_riporta_in_bozza(): void
    {
        $c = $this->createCompany('Osteria Stati');
        $this->addMember($c, $this->createUser('a@stati.test', 'A'), 'admin');
        $this->addMember($c, $this->createUser('o@stati.test', 'O'), 'operator');
        $a = $this->loginAs('a@stati.test');
        $id = $this->ok($a->post('/api/recipes', ['code' => 'RAG', 'title' => 'Ragù', 'revision' => ['portions' => '15', 'finalWeightKg' => '1.2']]))['id'];
        $this->assertSame('draft', DB::table('recipes')->where('id', $id)->value('status'));
        $this->ok($a->post("/api/recipes/{$id}/activate"));
        $this->assertSame('active', DB::table('recipes')->where('id', $id)->value('status'));
        $this->ok($a->post("/api/recipes/{$id}/draft"));
        $this->assertSame('draft', DB::table('recipes')->where('id', $id)->value('status'));
        $this->assertSame(403, $this->loginAs('o@stati.test')->post("/api/recipes/{$id}/activate")->status);
    }
}
