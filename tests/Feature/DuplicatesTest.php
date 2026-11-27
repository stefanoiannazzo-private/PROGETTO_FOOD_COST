<?php

namespace Tests\Feature;

use App\Services\Imports\PriceList;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** NUOVO — stesso articolo dello stesso fornitore scritto in modi diversi: riconosciuto e unito. */
class DuplicatesTest extends TestCase
{
    public function test_chiave_larga(): void
    {
        $k = PriceList::looseKey('FRUTTI DEL CAPPERO in aceto');
        foreach (['FRUTTI DI CAPPERO in aceto vt1700', 'FRUTTI del CAPPERO in aceto v/1700', 'FRUTTI DI CAPPERO in aceto v1700'] as $n) {
            $this->assertSame($k, PriceList::looseKey($n));
        }
        $this->assertSame(PriceList::looseKey('ALBICOCCHE Cat.1'), PriceList::looseKey('IT ALBICOCCHE Cat.'));
        $this->assertNotSame(PriceList::looseKey('Acqua Sparea Nat 1,5l Pet'), PriceList::looseKey('Acqua Sparea Nat 50cl Pet'), 'i formati veri restano diversi');
        $this->assertNotSame(PriceList::looseKey('PEPE NERO in grani'), PriceList::looseKey('PEPE NERO macinato'));
        $this->assertSame(PriceList::looseKey('COSCE DI POLLO'), PriceList::looseKey('Coscia pollo'));
        $this->assertSame(PriceList::looseKey('COSCE DI POLLO'), PriceList::looseKey('COSCE DI POLLO SV'));
        $this->assertNotSame(PriceList::looseKey('COSCE DI POLLO'), PriceList::looseKey('COSTE DI POLLO SV'));
        $st = fn ($n) => PriceList::stems($n);
        $this->assertTrue(\App\Services\Duplicates::similar($st('ali di pollo'), $st('ALI DI POLLO bbq')), 'simile: da verificare');
        $this->assertTrue(\App\Services\Duplicates::similar($st('CIOCC. FONDENTE EXTRA ZAINI 1kg'), $st('CIOCCOLATO FONDENTE EXTRA ZAINI 1kg')));
        $this->assertFalse(\App\Services\Duplicates::similar($st('FILETTI ALICI 720GR'), $st('FILETTI ALICI 270GR')), 'formati diversi');
        $this->assertFalse(\App\Services\Duplicates::similar($st('CONFETTURA ALBICOCCA 120% 1,5k'), $st('CONFETTURA FRAGOLA 120% 1,5k')));
        $this->assertFalse(\App\Services\Duplicates::similar($st('COSCE DI POLLO'), $st('COSTE DI POLLO')));
    }

    public function test_trova_e_unisce(): void
    {
        $c = $this->createCompany('Momy');
        $this->addMember($c, $this->createUser('a@dup.test', 'A'), 'admin');
        $a = $this->loginAs('a@dup.test');
        $mk = fn (string $code, string $name, string $date, string $price, string $sup = 'NOVAL SRL') => $this->ok($a->post('/api/ingredients', [
            'code' => $code, 'name' => $name, 'category' => 'Conserve', 'supplier' => $sup, 'purchaseUnit' => 'pezzo', 'packageContent' => '1', 'packageUnit' => 'pz', 'usageUnit' => 'pz',
            'initialPrice' => ['packagePrice' => $price, 'validFrom' => $date],
        ]))['id'];
        $k = $mk('ING-0068', 'FRUTTI DEL CAPPERO in aceto vt1700', '2026-11-24', '14.49');
        $x = $mk('ING-00588', 'FRUTTI DEL CAPPERO in aceto', '2026-10-01', '13.90');
        $y = $mk('ING-00592', 'FRUTTI DI CAPPERO in aceto', '2026-11-24', '14.49');
        $mk('ING-00700', 'FRUTTI DI CAPPERO in aceto', '2026-11-24', '14.49', 'Altro fornitore'); // altro fornitore: non è un doppione

        $bbq = $mk('ING-00800', 'FRUTTI DI CAPPERO in aceto bbq', '2026-11-24', '14.49');
        $groups = $this->ok($a->get('/api/ingredients/duplicates'))['data'];
        $this->assertCount(1, $groups);
        $this->assertCount(4, $groups[0]['items']);
        $this->assertFalse($groups[0]['sure']);
        $flags = collect($groups[0]['items'])->mapWithKeys(fn ($i) => [$i['id'] => $i['same']]);
        $this->assertTrue($flags[$x]);
        $this->assertFalse($flags[$bbq], 'descrizione solo simile: non proposta');

        $r = $this->ok($a->post('/api/ingredients/merge', ['groups' => [['keepId' => $k, 'mergeIds' => [$x, $y], 'separateIds' => [$bbq]]]]));
        $this->assertSame([1, 2, 1], [$r['groups'], $r['merged'], $r['prices']]);
        $this->assertSame(2, DB::table('ingredient_prices')->where('ingredient_id', $k)->count(), 'ottobre spostato, il 24/11 non raddoppia');
        $this->assertNotNull(DB::table('ingredients')->where('id', $x)->value('archived_at'));
        $this->assertStringContainsString('Unito in ING-0068', (string) DB::table('ingredients')->where('id', $y)->value('notes'));
        $this->assertSame([], $this->ok($a->get('/api/ingredients/duplicates'))['data']);
        $this->addMember($c, $this->createUser('o@dup.test', 'O'), 'operator');
        $this->assertSame(403, $this->loginAs('o@dup.test')->get('/api/ingredients/duplicates')->status);
    }
}
